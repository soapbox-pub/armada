/**
 * The grantee's side of a role-gated channel grant.
 *
 * An admin grants a role that carries a private channel; the key arrives as a
 * Direct Invite for a community the member is already in (a "catch-up"). The
 * member's Grant is in the folded Control Plane, so the key is one they are
 * owed — and the globally-mounted notifier is the only surface that sees it
 * arrive. This asserts that surface applies the key, rather than leaving it
 * behind a toast the member has to notice and an Accept they have to click.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InviteInboxItem } from "@/concord/hooks/useDirectInvites";
import type { InviteBundle } from "@/concord/lib/invite";
import { Permissions, type Role } from "@/concord/lib/roles";

const OWNER = "aa".repeat(32);
const ADMIN = "bb".repeat(32);
const ME = "cc".repeat(32);
const PEER = "dd".repeat(32);
const CID = "ab".repeat(32);
const ROOT = "11".repeat(32);
const CPK = "22".repeat(32);
const CH = "ee".repeat(32);

const updateList = vi.fn(async () => undefined);
const toast = vi.fn();

let items: InviteInboxItem[] = [];
let fold:
  | {
      roster: { roles: Role[]; grants: { member: string; roleIds: string[] }[] };
      ownerHex: string;
      banned: Set<string>;
      channels: Map<string, { isPrivate: boolean; deleted: boolean }>;
    }
  | undefined;

const entry = {
  community_id: CID,
  current: { community_id: CID, root_epoch: 0, community_root: ROOT, control_pk: CPK, channels: [] },
};
const community = { idHex: CID, rootEpoch: 0n } as const;

vi.mock("@/hooks/useToast", () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));
vi.mock("@/concord/hooks/useDirectInvites", () => ({
  useInviteInbox: () => ({ items, requests: [], unreadCount: items.filter((i) => i.unread).length, catchUps: items.filter((i) => i.invite.catchUp).map((i) => i.invite) }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => entry,
  useCommunity: () => community,
  useUpdateCommunityList: () => ({ mutateAsync: updateList }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: fold }),
  invalidateControl: () => undefined,
}));
const sweep = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/concord/lib/planeSync", () => ({ sweepControl: sweep }));
const dissolved = vi.hoisted(() => ({ value: false }));
vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/concord/hooks/useCommunityActions", () => {
  class DissolvedCommunityError extends Error {}
  return {
    bundleToEntry: (b: InviteBundle) => ({ community_id: b.community_id, current: b }),
    DissolvedCommunityError,
    assertNotDissolved: async () => {
      if (dissolved.value) throw new DissolvedCommunityError("dissolved");
    },
  };
});

import { DirectInviteNotifier } from "./DirectInviteNotifier";

const accessRole: Role = {
  roleId: "access",
  name: "Testers",
  position: 9,
  permissions: 0n,
  scope: { kind: "channel", channelId: CH },
  color: 0,
};
const staffRole: Role = {
  roleId: "staff",
  name: "Admin",
  position: 1,
  permissions: Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS,
  scope: { kind: "server" },
  color: 0,
};

function catchUpFrom(sender: string): InviteInboxItem {
  const bundle = {
    community_id: CID,
    owner: OWNER,
    owner_salt: "00".repeat(32),
    community_root: ROOT,
    control_pk: CPK,
    root_epoch: 0,
    channels: [{ id: CH, key: "3".repeat(64), epoch: 0, name: "testers" }],
    relays: [],
    name: "Crew",
  } as unknown as InviteBundle;
  return {
    unread: true,
    invite: { wrapId: `wrap-${sender.slice(0, 4)}`, sender, bundle, communityId: CID, name: "Crew", receivedAt: 1000, catchUp: true },
  };
}

function entitledFold() {
  return {
    roster: {
      roles: [accessRole, staffRole],
      grants: [
        { member: ME, roleIds: ["access"] },
        { member: ADMIN, roleIds: ["staff"] },
      ],
    },
    ownerHex: OWNER,
    banned: new Set<string>(),
    channels: new Map([[CH, { isPrivate: true, deleted: false }]]),
  };
}

function mount() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/c/x"]}>
        <DirectInviteNotifier />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const flush = () => act(async () => {});
/** Past the window in which a refusal is read as the Grant's fold lagging. */
const outlastGrace = () => act(async () => {
  await vi.advanceTimersByTimeAsync(20_000);
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  sweep.mockClear();
  updateList.mockClear();
  toast.mockClear();
  items = [];
  fold = undefined;
  dissolved.value = false;
});

describe("DirectInviteNotifier: a granted channel key", () => {
  it("is applied to the vault when staff vend a key the member's role entitles them to", async () => {
    fold = entitledFold();
    items = [catchUpFrom(ADMIN)];
    mount();
    await flush();
    expect(updateList).toHaveBeenCalledWith({ type: "add", entry: expect.objectContaining({ community_id: CID }) });
    // The member is told the channel is theirs, not offered a decision.
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/added/i) }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "New channel keys offered" }));
  });

  it("seats only the judged key on the held entry, taking nothing else from the bundle", async () => {
    fold = entitledFold();
    const pub = "dd".repeat(32);
    fold.channels.set(pub, { isPrivate: false, deleted: false });
    const item = catchUpFrom(ADMIN);
    item.invite.bundle = {
      ...item.invite.bundle,
      relays: ["wss://elsewhere"],
      name: "Renamed",
      channels: [...item.invite.bundle.channels, { id: pub, key: "4".repeat(64), epoch: 0, name: "lobby" }],
    };
    items = [item];
    mount();
    await flush();
    expect(updateList).toHaveBeenCalledWith({
      type: "add",
      entry: { ...entry, current: { ...entry.current, channels: [{ id: CH, key: "3".repeat(64), epoch: 0, name: "testers" }] } },
    });
  });

  it("is applied once the Control fold catches up to the Grant", async () => {
    // The key arrives before the fold has the Grant that entitles the member.
    items = [catchUpFrom(ADMIN)];
    const view = mount();
    await flush();
    expect(updateList).not.toHaveBeenCalled();
    // Not announced as a decision either: the verdict isn't in yet.
    expect(toast).not.toHaveBeenCalled();

    fold = entitledFold();
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/c/x"]}>
          <DirectInviteNotifier />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();
    expect(updateList).toHaveBeenCalledTimes(1);
  });

  it("stays a manual Accept when the sender neither manages channels nor may read this one", async () => {
    fold = entitledFold();
    items = [catchUpFrom(PEER)];
    mount();
    await flush();
    expect(toast).not.toHaveBeenCalled();
    await outlastGrace();
    expect(updateList).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "New channel keys offered" }));
  });

  it("stays a manual Accept when the member holds no role scoped to the channel", async () => {
    fold = entitledFold();
    fold.roster.grants = [{ member: ADMIN, roleIds: ["staff"] }];
    items = [catchUpFrom(ADMIN)];
    mount();
    await flush();
    await outlastGrace();
    expect(updateList).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "New channel keys offered" }));
  });

  it("is applied silently when the fold has the community but not yet the member's Grant", async () => {
    // The admin's key outran the Grant it follows: the fold exists, but refuses.
    const stale = entitledFold();
    stale.roster.grants = [{ member: ADMIN, roleIds: ["staff"] }];
    fold = stale;
    items = [catchUpFrom(ADMIN)];
    const view = mount();
    await flush();
    expect(updateList).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    // The plane is re-read once for a Grant the live subscription missed.
    expect(sweep).toHaveBeenCalledTimes(1);

    fold = entitledFold();
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/c/x"]}>
          <DirectInviteNotifier />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();
    await outlastGrace();
    expect(updateList).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "New channel keys offered" }));
  });

  it("is applied at most once per wrap across re-renders", async () => {
    fold = entitledFold();
    items = [catchUpFrom(ADMIN)];
    const view = mount();
    await flush();
    items = [catchUpFrom(ADMIN)];
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/c/x"]}>
          <DirectInviteNotifier />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await flush();
    expect(updateList).toHaveBeenCalledTimes(1);
  });

  it("is not applied to a dissolved community", async () => {
    // Same refusal as the inbox's Accept and a link join: a dead community
    // takes no new keys, and the vault is not written.
    dissolved.value = true;
    fold = entitledFold();
    items = [catchUpFrom(ADMIN)];
    mount();
    await flush();
    expect(updateList).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/added/i) }));
  });

  it("still announces a fresh community invite as before", async () => {
    const join = catchUpFrom(ADMIN);
    join.invite.catchUp = false;
    items = [join];
    mount();
    await flush();
    expect(updateList).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "New community invite" }));
  });
});
