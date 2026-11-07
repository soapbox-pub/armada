/**
 * The mass-moderation contract (CORD-04 §4/§6, CORD-06 §3):
 *
 *   - banMany: the WHOLE group rides ONE banlist edition (the list replaces
 *     entire) and, when severance is due, ONE Refounding excluding every
 *     target — never a rotation per target, which would force the community
 *     through N adoption rounds.
 *   - The durable read-cut intent is marked per target BEFORE the rotation
 *     attempt, all with the same keep-list, so a crashed rotation retries the
 *     whole batch.
 *   - kickMany: strip-then-directive per target, continuing past individual
 *     failures; a partial batch still invalidates.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex } from "@/concord/lib/derive";
import type { FoldedControl } from "@/concord/lib/control";
import type { NostrRumor } from "@/lib/nostrRumor";
import { VSK_BANLIST, VSK_GRANT } from "@/concord/lib/kinds";
import { adminRole, moderatorRole, type CommunityRoles, type Role } from "@/concord/lib/roles";

import { useModeration } from "./useModeration";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  folded: undefined as FoldedControl | undefined,
  canRefound: true,
  /** Chronological log of every side effect, for order assertions. */
  log: [] as Array<
    | { op: "edition"; vsk: string; rumor: NostrRumor }
    | { op: "kick"; target: string }
    | { op: "refound"; keep: string[]; exclude: string[] }
    | { op: "readcut-add"; target: string; keep: string[] }
    | { op: "readcut-clear" }
    | { op: "chrekey"; channelIdHex: string; keep: string[]; removed: string[] }
  >,
  canRekeyChannel: true,
  refoundError: undefined as Error | undefined,
  kickErrorFor: undefined as string | undefined,
  toasts: [] as string[],
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
  foldStoredControl: async () => h.folded,
  withControlWrite: (_id: string, run: () => Promise<unknown>) => run(),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async (_n: unknown, _c: unknown, _s: unknown, rumor: NostrRumor) => {
    const vsk = rumor.tags.find((t) => t[0] === "vsk")?.[1] ?? "?";
    h.log.push({ op: "edition", vsk, rumor });
  },
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbook: () => ({ data: [], coalesced: new Map(), timeouts: new Map(), nicknames: new Map() }),
  useGuestbookPublisher: () => ({
    mutateAsync: async (input: { type: string; target: string }) => {
      if (h.kickErrorFor === input.target) throw new Error("relay refused the kick");
      h.log.push({ op: "kick", target: input.target });
    },
  }),
}));
vi.mock("@/concord/hooks/useRekey", () => ({
  useRefound: () => ({
    canRefound: h.canRefound,
    refound: async ({ keep, exclude }: { keep: string[]; exclude: string[] }) => {
      if (h.refoundError) throw h.refoundError;
      h.log.push({ op: "refound", keep, exclude });
    },
  }),
  useChannelRekey: () => ({
    canRekeyChannel: h.canRekeyChannel,
    canSeverChannel: h.canRekeyChannel,
    rekeyChannel: async (input: { channelIdHex: string; keepRecipients: string[]; removedTargets: string[] }) => {
      h.log.push({ op: "chrekey", channelIdHex: input.channelIdHex, keep: input.keepRecipients, removed: input.removedTargets });
    },
  }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: (t: { title: string }) => h.toasts.push(t.title) }));
vi.mock("@/concord/lib/readCutPending", () => ({
  addReadCutPending: async (_me: string, _cid: string, target: string, keep: string[]) => {
    h.log.push({ op: "readcut-add", target, keep });
  },
  clearReadCutPending: () => {
    h.log.push({ op: "readcut-clear" });
  },
  readCutPending: () => undefined,
  readCutPendingReady: async () => undefined,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const owner = getPublicKey(generateSecretKey());
const targetA = getPublicKey(generateSecretKey());
const targetB = getPublicKey(generateSecretKey());
const bystander = getPublicKey(generateSecretKey());

const minted = mintCommunity("test", owner, ["wss://relay.test"]).community;

const adm = adminRole(bytesToHex(new Uint8Array(32).fill(7)));
const mod = moderatorRole(bytesToHex(new Uint8Array(32).fill(8)));
const secretId = new Uint8Array(32).fill(5);
const secretHex = bytesToHex(secretId);
const secretRole: Role = {
  roleId: "e".repeat(64),
  name: "Secret",
  position: 20,
  permissions: 0n,
  scope: { kind: "channel", channelId: secretHex },
  color: 0,
};
// The actor holds #secret's key, and the fold says it is a live Private Channel.
const community = { ...minted, privateChannels: [{ id: secretId, key: new Uint8Array(32).fill(6), epoch: 0n, name: "secret" }] };

function foldedWith(input: { grants?: CommunityRoles["grants"]; foreignLinks?: string[]; banned?: string[] }): FoldedControl {
  const registries = new Map<string, string[]>();
  for (const creator of input.foreignLinks ?? []) registries.set(creator, [bytesToHex(new Uint8Array(32).fill(9))]);
  return {
    roster: { roles: [adm, mod, secretRole], grants: input.grants ?? [] },
    ownerHex: owner,
    metadata: undefined,
    channels: new Map([
      [secretHex, { channelIdHex: secretHex, name: "secret", isPrivate: true, deleted: false, metadata: {} as never }],
    ]),
    banned: new Set(input.banned ?? []),
    liveInviteLinks: new Set(),
    registriesByCreator: registries,
    pinLists: new Map(),
    signals: new Map(),
    heads: new Map(),
    headEditions: new Map(),
    incomplete: [],
    bannedAt: new Map(),
  };
}

function mount(recipients: string[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  );
  return renderHook(() => useModeration(community, recipients), { wrapper });
}

beforeEach(() => {
  h.user = { pubkey: owner, signer: {} };
  h.folded = foldedWith({});
  h.canRefound = true;
  h.log = [];
  h.refoundError = undefined;
  h.kickErrorFor = undefined;
  h.canRekeyChannel = true;
  h.toasts = [];
});

const editions = (vsk: string) => h.log.filter((e) => e.op === "edition" && e.vsk === vsk);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("banMany", () => {
  it("bans the whole group with ONE banlist edition and ONE refounding", async () => {
    h.folded = foldedWith({ grants: [{ member: targetA, roleIds: [adm.roleId] }] });
    const { result } = mount([owner, targetA, targetB, bystander]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    const phases: string[] = [];
    const out = await result.current.banMany({ targets: [targetA, targetB], onPhase: (p) => phases.push(p) });

    expect(out).toMatchObject({ rekeyed: true, publicBan: false, banned: [targetA, targetB], skipped: [] });
    expect(phases).toEqual(["silence", "roles", "rekey"]);

    // ONE banlist edition, carrying BOTH targets.
    const banlists = editions(VSK_BANLIST);
    expect(banlists).toHaveLength(1);
    // Banlist content is the bare npub array, replaced entire.
    const listed = JSON.parse(banlists[0].op === "edition" ? banlists[0].rumor.content : "") as string[];
    expect(new Set(listed)).toEqual(new Set([targetA, targetB]));

    // One strip for the granted target only (best-effort, skip-if-roleless).
    expect(editions(VSK_GRANT)).toHaveLength(1);

    // ONE rotation excluding the whole group, keep-list minus every target.
    const refounds = h.log.filter((e) => e.op === "refound");
    expect(refounds).toHaveLength(1);
    expect(refounds[0]).toMatchObject({ keep: [owner, bystander], exclude: [targetA, targetB] });

    // Durable intent marked per target BEFORE the rotation, same keep-list.
    const adds = h.log.filter((e) => e.op === "readcut-add");
    expect(adds.map((a) => (a.op === "readcut-add" ? a.target : ""))).toEqual([targetA, targetB]);
    for (const a of adds) if (a.op === "readcut-add") expect(a.keep).toEqual([owner, bystander]);
    expect(h.log.findIndex((e) => e.op === "refound")).toBeGreaterThan(h.log.findIndex((e) => e.op === "readcut-add"));
    expect(h.log.some((e) => e.op === "readcut-clear")).toBe(true);

    // Order: silence (banlist) strictly before any strip.
    expect(h.log.findIndex((e) => e.op === "edition" && e.vsk === VSK_BANLIST)).toBeLessThan(
      h.log.findIndex((e) => e.op === "edition" && e.vsk === VSK_GRANT),
    );
  });

  it("a foreign live link makes the group ban banlist-only — no rotation", async () => {
    h.folded = foldedWith({ foreignLinks: [bystander] });
    const { result } = mount([owner, bystander]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    const out = await result.current.banMany({ targets: [targetA, targetB] });
    expect(out).toMatchObject({ rekeyed: false, publicBan: true });
    expect(h.log.filter((e) => e.op === "refound")).toHaveLength(0);
    expect(h.log.filter((e) => e.op === "readcut-add")).toHaveLength(0);
    expect(editions(VSK_BANLIST)).toHaveLength(1);
    expect(h.log.filter((e) => e.op === "chrekey"), "nobody read a private channel").toHaveLength(0);
  });

  it("a public ban still rotates the targets' private channels, keeping everyone else entitled", async () => {
    h.folded = foldedWith({
      foreignLinks: [bystander],
      grants: [
        { member: targetA, roleIds: [secretRole.roleId] },
        { member: bystander, roleIds: [secretRole.roleId] },
      ],
    });
    const { result } = mount([owner, targetA, bystander]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    const out = await result.current.banMany({ targets: [targetA] });
    expect(out).toMatchObject({ rekeyed: false, publicBan: true });
    expect(h.log.filter((e) => e.op === "refound")).toHaveLength(0);
    const rekeys = h.log.filter((e) => e.op === "chrekey");
    expect(rekeys).toMatchObject([{ channelIdHex: secretHex, removed: [targetA] }]);
    if (rekeys[0]?.op === "chrekey") expect(rekeys[0].keep.sort()).toEqual([owner, bystander].sort());
    expect(h.toasts).toEqual([]);
  });

  it("cuts the channel even when the banner can't strip the Grant that unlocks it", async () => {
    const moderator = getPublicKey(generateSecretKey());
    h.user = { pubkey: moderator, signer: {} };
    h.folded = foldedWith({
      foreignLinks: [bystander],
      grants: [
        { member: moderator, roleIds: [mod.roleId] },
        { member: targetA, roleIds: [secretRole.roleId] },
      ],
    });
    const { result } = mount([owner, moderator, targetA]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    await result.current.banMany({ targets: [targetA] });
    expect(editions(VSK_GRANT), "no Manage Roles, no strip").toHaveLength(0);
    expect(h.log.filter((e) => e.op === "chrekey")).toMatchObject([{ channelIdHex: secretHex, removed: [targetA] }]);
  });

  it("says so when a private channel can't be rotated", async () => {
    h.canRekeyChannel = false;
    h.folded = foldedWith({ foreignLinks: [bystander], grants: [{ member: targetA, roleIds: [secretRole.roleId] }] });
    const { result } = mount([owner, targetA]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    await result.current.banMany({ targets: [targetA] });
    expect(h.log.filter((e) => e.op === "chrekey")).toHaveLength(0);
    expect(h.toasts).toEqual(["Private channel keys not rotated"]);
  });

  it("banning every foreign link creator clears the way for the single rotation", async () => {
    h.folded = foldedWith({ foreignLinks: [targetA, targetB] });
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    const out = await result.current.banMany({ targets: [targetA, targetB] });
    expect(out.rekeyed).toBe(true);
    expect(h.log.filter((e) => e.op === "refound")).toHaveLength(1);
  });

  it("keeps the intent when the rotation fails, so the retry path owns the batch", async () => {
    h.refoundError = new Error("relay outage");
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    const out = await result.current.banMany({ targets: [targetA, targetB] });
    expect(out).toMatchObject({ rekeyed: false, publicBan: false });
    expect(h.log.filter((e) => e.op === "readcut-add")).toHaveLength(2);
    expect(h.log.some((e) => e.op === "readcut-clear"), "intent must survive the failure").toBe(false);
  });

  it("skips ineligible targets and reports them; throws only when nobody is bannable", async () => {
    // The owner can never be a target; a plain actor can't ban anyone.
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    const out = await result.current.banMany({ targets: [owner, targetA] });
    expect(out.banned).toEqual([targetA]);
    expect(out.skipped).toEqual([owner]);

    await expect(result.current.banMany({ targets: [owner] })).rejects.toThrow(/permission/);
  });

  it("fail-fast: a due rotation with no NIP-44 signer publishes NOTHING", async () => {
    h.canRefound = false;
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));

    await expect(result.current.banMany({ targets: [targetA] })).rejects.toThrow(/signer/);
    expect(h.log, "no banlist may land before the guard").toHaveLength(0);
  });

  it("ban() is the single-target delegate", async () => {
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canBan(targetA)).toBe(true));
    const out = await result.current.ban({ target: targetA });
    expect(out).toMatchObject({ rekeyed: true, banned: [targetA] });
    expect(editions(VSK_BANLIST)).toHaveLength(1);
  });
});

describe("rotateKeys", () => {
  it("is a Refounding with NOTHING excluded — no banlist, no strip, no read-cut intent", async () => {
    const { result } = mount([owner, targetA, bystander]);
    await waitFor(() => expect(result.current.canRotateKeys).toBe(true));

    await result.current.rotateKeys();

    const refounds = h.log.filter((e) => e.op === "refound");
    expect(refounds).toHaveLength(1);
    expect(refounds[0]).toMatchObject({ keep: [owner, targetA, bystander], exclude: [] });
    // Nothing is being removed, so none of the ban's other steps may fire —
    // and nothing is owed to the read-cut retry.
    expect(editions(VSK_BANLIST)).toHaveLength(0);
    expect(editions(VSK_GRANT)).toHaveLength(0);
    expect(h.log.filter((e) => e.op === "readcut-add")).toHaveLength(0);
  });

  it("a foreign live link does NOT veto it, unlike a ban's rotation", async () => {
    h.folded = foldedWith({ foreignLinks: [bystander] });
    const { result } = mount([owner, bystander]);
    await waitFor(() => expect(result.current.canRotateKeys).toBe(true));

    await result.current.rotateKeys();
    expect(h.log.filter((e) => e.op === "refound")).toHaveLength(1);
  });

  it("refuses without BAN authority, or without a NIP-44 signer", async () => {
    h.user = { pubkey: bystander, signer: {} };
    const unranked = mount([owner, bystander]);
    await waitFor(() => expect(unranked.result.current.canRotateKeys).toBe(false));
    await expect(unranked.result.current.rotateKeys()).rejects.toThrow(/permission/);

    h.user = { pubkey: owner, signer: {} };
    h.canRefound = false;
    const unsigned = mount([owner]);
    await waitFor(() => expect(unsigned.result.current.canRotateKeys).toBe(false));
    await expect(unsigned.result.current.rotateKeys()).rejects.toThrow(/signer/);

    expect(h.log).toHaveLength(0);
  });

  it("refuses on an unsettled fold rather than rotating to a thin keep-list", async () => {
    h.folded = undefined;
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canRotateKeys).toBe(false));
    await expect(result.current.rotateKeys()).rejects.toThrow(/syncing/);
    expect(h.log).toHaveLength(0);
  });
});

describe("kickMany", () => {
  it("strips before the directive for EACH target, and continues past a failure", async () => {
    h.folded = foldedWith({
      grants: [
        { member: targetA, roleIds: [adm.roleId] },
        { member: targetB, roleIds: [adm.roleId] },
      ],
    });
    h.kickErrorFor = targetA;
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canKick(targetA)).toBe(true));

    const progress: number[] = [];
    const out = await result.current.kickMany({ targets: [targetA, targetB], onProgress: (d) => progress.push(d) });

    expect(out.kicked).toEqual([targetB]);
    expect(out.failed).toMatchObject([{ target: targetA }]);
    expect(progress).toEqual([1, 2]);

    // Per-target order: B's strip lands before B's directive.
    const stripIdx = h.log.findIndex((e, i) => e.op === "edition" && e.vsk === VSK_GRANT && i > 0);
    const kickIdx = h.log.findIndex((e) => e.op === "kick" && e.target === targetB);
    expect(stripIdx).toBeGreaterThanOrEqual(0);
    expect(kickIdx).toBeGreaterThan(stripIdx);
  });

  it("throws when every kick fails, and when nobody is kickable", async () => {
    h.kickErrorFor = targetA;
    const { result } = mount([owner]);
    await waitFor(() => expect(result.current.canKick(targetA)).toBe(true));

    await expect(result.current.kickMany({ targets: [targetA] })).rejects.toThrow(/refused/);
    await expect(result.current.kickMany({ targets: [owner] })).rejects.toThrow(/permission/);
  });
});
