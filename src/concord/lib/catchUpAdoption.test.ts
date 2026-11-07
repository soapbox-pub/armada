import { describe, expect, it } from "vitest";

import { judgeCatchUp, judgeCatchUpChannels, MAX_VEND_EPOCH_LEAD, type CatchUpFold } from "./catchUpAdoption";
import type { HeldMembership } from "./directInvite";
import { Permissions, type CommunityRoles, type Role } from "./roles";

const OWNER = "aa".repeat(32);
const ADMIN = "bb".repeat(32);
const ME = "cc".repeat(32);
const PEER = "dd".repeat(32);
const ROOT = "11".repeat(32);
const CPK = "22".repeat(32);
const CH = "ee".repeat(32);
const OTHER_CH = "ff".repeat(32);

const accessRole = (channelId: string, roleId = `access-${channelId.slice(0, 4)}`): Role => ({
  roleId,
  name: "Testers",
  position: 9,
  permissions: 0n,
  scope: { kind: "channel", channelId },
  color: 0,
});

const staffRole: Role = {
  roleId: "staff",
  name: "Admin",
  position: 1,
  permissions: Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS,
  scope: { kind: "server" },
  color: 0,
};

/** A read-only role with no Control-writing bit: its holder is NOT staff. */
const peerRole: Role = {
  roleId: "peer",
  name: "Helper",
  position: 5,
  permissions: Permissions.PIN_MESSAGES & 0n, // deliberately zero
  scope: { kind: "server" },
  color: 0,
};

const priv = (isPrivate = true, deleted = false) => ({ isPrivate, deleted });

function fold(
  over: { banned?: Set<string>; roster?: Partial<CommunityRoles>; channels?: CatchUpFold["channels"] } = {},
): CatchUpFold {
  return {
    ownerHex: OWNER,
    banned: over.banned ?? new Set(),
    channels: over.channels ?? new Map([[CH, priv()], [OTHER_CH, priv()]]),
    roster: {
      roles: over.roster?.roles ?? [accessRole(CH), staffRole, peerRole],
      grants: over.roster?.grants ?? [
        { member: ME, roleIds: [`access-${CH.slice(0, 4)}`] },
        { member: ADMIN, roleIds: ["staff"] },
        { member: PEER, roleIds: ["peer", `access-${CH.slice(0, 4)}`] },
      ],
    },
  };
}

function held(over: Partial<HeldMembership> = {}): HeldMembership {
  return {
    rootEpoch: 0,
    communityRoot: ROOT,
    controlPk: CPK,
    channelEpochs: new Map(),
    ...over,
  };
}

const bundle = (channels: Array<{ id: string; epoch?: number }>) => ({
  root_epoch: 0,
  community_root: ROOT,
  control_pk: CPK,
  channels: channels.map((c) => ({ id: c.id, epoch: c.epoch ?? 0, key: "3".repeat(64), name: "ch" })),
});

describe("judgeCatchUp", () => {
  it("adopts a key the member's own role entitles them to, sent by staff", () => {
    expect(judgeCatchUp(fold(), ME, ADMIN, bundle([{ id: CH }]), held())).toBe("adopt");
  });

  it("adopts from the owner, who holds no Role but outranks everything", () => {
    expect(judgeCatchUp(fold(), ME, OWNER, bundle([{ id: CH }]), held())).toBe("adopt");
  });

  it("waits, rather than refusing, while the Control fold hasn't loaded", () => {
    // The Grant that entitles the member was published moments before the
    // key was sent; a client that reads this as a refusal parks the key for
    // good and reproduces the bug (role granted, channel never appears).
    expect(judgeCatchUp(undefined, ME, ADMIN, bundle([{ id: CH }]), held())).toBe("no-fold");
  });

  it("adopts from a vendor entitled to the channel, as Vector's judge does", () => {
    // An entitled vendor holds the real key: a wrong one costs isolation, never confidentiality.
    expect(judgeCatchUp(fold(), ME, PEER, bundle([{ id: CH }]), held())).toBe("adopt");
  });

  it("leaves a key from a vendor neither managing nor entitled to the channel to the manual Accept", () => {
    const f = fold({ roster: { grants: [{ member: ME, roleIds: [`access-${CH.slice(0, 4)}`] }, { member: PEER, roleIds: ["peer"] }] } });
    expect(judgeCatchUp(f, ME, PEER, bundle([{ id: CH }]), held())).toBe("sender-unauthorized");
  });

  it("leaves a key from a staff member who neither manages channels nor may read this one", () => {
    const pinner: Role = { ...staffRole, roleId: "pin", permissions: Permissions.PIN_MESSAGES };
    const f = fold({
      roster: {
        roles: [accessRole(CH), pinner],
        grants: [{ member: ME, roleIds: [`access-${CH.slice(0, 4)}`] }, { member: ADMIN, roleIds: ["pin"] }],
      },
    });
    expect(judgeCatchUp(f, ME, ADMIN, bundle([{ id: CH }]), held())).toBe("sender-unauthorized");
  });

  it("refuses a vendor the fold has banned", () => {
    expect(judgeCatchUp(fold({ banned: new Set([ADMIN]) }), ME, ADMIN, bundle([{ id: CH }]), held())).toBe("sender-banned");
  });

  it("waits for a channel the fold doesn't hold yet, even when the owner is the recipient", () => {
    // A vend may deliver a key, never define a channel.
    const f = fold({ channels: new Map() });
    expect(judgeCatchUp(f, ME, ADMIN, bundle([{ id: CH }]), held())).toBe("no-fold");
    expect(judgeCatchUp(f, OWNER, ADMIN, bundle([{ id: CH }]), held())).toBe("no-fold");
    expect(judgeCatchUp(fold({ channels: new Map([[CH, priv(true, true)]]) }), OWNER, ADMIN, bundle([{ id: CH }]), held())).toBe("no-fold");
  });

  it("ignores a channel the fold says is public, adopting the rest", () => {
    const f = fold({ channels: new Map([[CH, priv()], [OTHER_CH, priv(false)]]) });
    const j = judgeCatchUpChannels(f, ME, ADMIN, bundle([{ id: CH }, { id: OTHER_CH }]), held());
    expect(j).toEqual({ verdict: "adopt", adopt: [CH] });
    expect(judgeCatchUp(f, OWNER, ADMIN, bundle([{ id: OTHER_CH }]), held())).toBe("nothing-new");
  });

  it("refuses an epoch implausibly far past the one held", () => {
    expect(judgeCatchUp(fold(), ME, ADMIN, bundle([{ id: CH, epoch: MAX_VEND_EPOCH_LEAD + 1 }]), held())).toBe("implausible-epoch");
    expect(judgeCatchUp(fold(), ME, ADMIN, bundle([{ id: CH, epoch: MAX_VEND_EPOCH_LEAD }]), held())).toBe("adopt");
  });

  it("refuses when the recipient holds no role scoped to the channel", () => {
    const f = fold({ roster: { grants: [{ member: ADMIN, roleIds: ["staff"] }] } });
    expect(judgeCatchUp(f, ME, ADMIN, bundle([{ id: CH }]), held())).toBe("not-entitled");
  });

  it("adopts the owed key from a bundle that also carries one the member is not entitled to", () => {
    const f = fold({ roster: { roles: [accessRole(CH), accessRole(OTHER_CH), staffRole] } });
    expect(judgeCatchUpChannels(f, ME, ADMIN, bundle([{ id: CH }, { id: OTHER_CH }]), held())).toEqual({ verdict: "adopt", adopt: [CH] });
    expect(judgeCatchUp(f, ME, ADMIN, bundle([{ id: OTHER_CH }]), held())).toBe("not-entitled");
  });

  it("ignores a channel the member already holds when judging entitlement", () => {
    // OTHER_CH is already in the vault at the bundle's epoch, so the bundle
    // contributes nothing for it and entitlement to it is not in question.
    const f = fold({ roster: { roles: [accessRole(CH), accessRole(OTHER_CH), staffRole] } });
    const h = held({ channelEpochs: new Map([[OTHER_CH, 0]]) });
    expect(judgeCatchUp(f, ME, ADMIN, bundle([{ id: CH }, { id: OTHER_CH }]), h)).toBe("adopt");
  });

  it("refuses a banned recipient without a relay round-trip", () => {
    expect(judgeCatchUp(fold({ banned: new Set([ME]) }), ME, ADMIN, bundle([{ id: CH }]), held())).toBe("banned");
  });

  it("reports nothing to adopt when the bundle is not a catch-up on what is held", () => {
    expect(judgeCatchUp(fold(), ME, ADMIN, bundle([{ id: CH }]), undefined)).toBe("nothing-new");
    expect(judgeCatchUp(fold(), ME, ADMIN, bundle([{ id: CH }]), held({ channelEpochs: new Map([[CH, 0]]) }))).toBe(
      "nothing-new",
    );
    expect(judgeCatchUp(fold(), ME, ADMIN, { ...bundle([{ id: CH }]), community_root: "99".repeat(32) }, held())).toBe(
      "nothing-new",
    );
  });

  it("matches the channel id case-insensitively, as the classifier does", () => {
    expect(judgeCatchUp(fold(), ME, ADMIN, bundle([{ id: CH.toUpperCase() }]), held())).toBe("adopt");
  });
});
