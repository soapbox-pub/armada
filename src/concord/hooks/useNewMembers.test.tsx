import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoldedControl } from "@/concord/lib/control";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { REVIEW_WINDOW_MS } from "@/concord/lib/newMembers";
import type { Community } from "@/concord/lib/types";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const env = vi.hoisted(() => ({
  now: 0,
  coalesced: new Map<string, CoalescedMember>(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "f".repeat(64) } }) }));
vi.mock("@/lib/relayClock", async (orig) => ({ ...(await orig<typeof import("@/lib/relayClock")>()), clockNowMs: () => env.now }));
vi.mock("@/concord/hooks/useGuestbook", () => ({ useGuestbook: () => ({ coalesced: env.coalesced, data: [] }) }));
vi.mock("@/lib/db/kvCache", () => ({
  KvPrefixCache: class {
    get() {
      return undefined;
    }
    set() {}
    subscribe() {
      return () => undefined;
    }
    ready() {
      return Promise.resolve();
    }
  },
}));

const { useNewMembers } = await import("@/concord/hooks/useNewMembers");

const community = { idHex: "c".repeat(64) } as Community;
const folded = { banned: new Set(), bannedAt: new Map(), ownerHex: "0".repeat(64) } as unknown as FoldedControl;
const pk = (ch: string) => ch.repeat(64);

function joined(pubkey: string, ms: number, fromSnapshot = false): [string, CoalescedMember] {
  return [pubkey, { pubkey, state: "join", ms, rumorId: pubkey, fromSnapshot }];
}

beforeEach(() => {
  env.now = NOW;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useNewMembers", () => {
  it("queues a member waiting for approval whose Join a refounding carried over", () => {
    env.coalesced = new Map([joined(pk("a"), NOW - 60 * DAY, true), joined(pk("b"), NOW - DAY)]);
    const awaiting = new Set([pk("a"), pk("b")]);
    const { result } = renderHook(() => useNewMembers(community, folded, awaiting));
    expect(result.current.pending.map((m) => m.pubkey).sort()).toEqual([pk("a"), pk("b")]);
  });

  it("drops a join from the review list once it ages out, with the pane left open", () => {
    env.coalesced = new Map([joined(pk("a"), NOW - REVIEW_WINDOW_MS + 60_000)]);
    const { result } = renderHook(() => useNewMembers(community, folded));
    expect(result.current.members).toHaveLength(1);
    env.now = NOW + 2 * 60_000;
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current.members).toHaveLength(0);
  });
});
