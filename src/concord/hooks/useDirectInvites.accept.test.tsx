/** Accepting a parked catch-up: a verdict no click may override is refused here too. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCatchUpVerdict } from "@/concord/lib/catchUpVerdicts";
import type { InviteBundle } from "@/concord/lib/invite";

const CID = "ab".repeat(32);
const updateList = vi.fn(async () => undefined);

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "cc".repeat(32) } }) }));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityList: () => ({ data: undefined }),
  useUpdateCommunityList: () => ({ mutateAsync: updateList }),
}));
vi.mock("@/concord/hooks/useCommunityActions", () => ({
  assertNotBanned: async () => undefined,
  assertNotBlocked: async () => undefined,
  assertNotDissolved: async () => undefined,
  bundleToEntry: (b: InviteBundle) => ({ community_id: b.community_id, current: b }),
}));
vi.mock("@/concord/lib/communityList", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/communityList")>()),
  rehydrateCommunity: () => undefined,
}));

import { useAcceptDirectInvite, type ParkedInvite } from "@/concord/hooks/useDirectInvites";

function catchUp(wrapId: string): ParkedInvite {
  const bundle = {
    community_id: CID,
    community_root: "11".repeat(32),
    control_pk: "22".repeat(32),
    root_epoch: 0,
    channels: [{ id: "ee".repeat(32), key: "3".repeat(64), epoch: 1, name: "x" }],
    relays: [],
    name: "Crew",
  } as unknown as InviteBundle;
  return { wrapId, sender: "dd".repeat(32), bundle, communityId: CID, name: "Crew", receivedAt: 1000, catchUp: true } as ParkedInvite;
}

function accept() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useAcceptDirectInvite(), { wrapper }).result;
}

beforeEach(() => updateList.mockClear());

describe("useAcceptDirectInvite on a catch-up", () => {
  it.each(["sender-banned", "implausible-epoch", "key-mismatch", "banned"] as const)("refuses one judged %s and writes nothing", async (verdict) => {
    setCatchUpVerdict(`wrap-${verdict}`, verdict);
    const result = accept();
    await act(async () => {
      await expect(result.current.mutateAsync({ invite: catchUp(`wrap-${verdict}`) })).rejects.toThrow("These channel keys can't be accepted.");
    });
    expect(updateList).not.toHaveBeenCalled();
  });

  it("still accepts one left to the member's click", async () => {
    setCatchUpVerdict("wrap-manual", "sender-unauthorized");
    const result = accept();
    await act(async () => {
      await result.current.mutateAsync({ invite: catchUp("wrap-manual") });
    });
    expect(updateList).toHaveBeenCalledWith({ type: "add", entry: expect.objectContaining({ community_id: CID }) });
  });
});
