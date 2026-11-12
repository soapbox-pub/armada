import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FoldedControl } from "@/concord/lib/control";
import type { Community } from "@/concord/lib/types";

const h = vi.hoisted(() => ({ rev: 0, reads: 0, timeouts: [] as { pk: string; fromSecs: number; until: number }[], now: 1_000_000 }));

vi.mock("@/concord/lib/rumorStore", () => ({
  planeRevision: () => h.rev,
  queryPlane: async () => {
    h.reads++;
    return [];
  },
  withGuestbookStreams: async (_c: unknown, stored: unknown) => stored,
}));
vi.mock("@/concord/lib/channelJudges", () => ({
  runningTimeouts: () => h.timeouts,
  communityNicknames: () => ({}),
}));
vi.mock("@/concord/lib/guestbook", () => ({
  GUESTBOOK_MAX_FUTURE_MS: 3_600_000,
  currentGuestbookGroup: () => ({ pk: "live" }),
}));
vi.mock("@/lib/relayClock", () => ({ clockNowMs: () => h.now }));

const { clearGuestbookExtrasMemory, storedGuestbookExtras } = await import("@/concord/lib/guestbookExtras");

const community = { idHex: "c".repeat(64), id: new Uint8Array(32), rootEpoch: 0n, heldRoots: [] } as unknown as Community;
const control = {} as FoldedControl;

describe("storedGuestbookExtras", () => {
  beforeEach(() => {
    clearGuestbookExtrasMemory();
    h.rev = 0;
    h.reads = 0;
    h.timeouts = [];
    h.now = 1_000_000;
  });

  it("answers again from memory until the planes, the Roster or a Timeout's end move it", async () => {
    h.timeouts = [{ pk: "a", fromSecs: 0, until: 2_000 }];
    await storedGuestbookExtras(community, control);
    await storedGuestbookExtras(community, control);
    expect(h.reads).toBe(1);

    h.rev = 1;
    await storedGuestbookExtras(community, control);
    expect(h.reads).toBe(2);

    await storedGuestbookExtras(community, {} as FoldedControl);
    expect(h.reads).toBe(3);
  });

  it("folds again once a running Timeout ends", async () => {
    h.timeouts = [{ pk: "a", fromSecs: 0, until: 2_000 }];
    await storedGuestbookExtras(community, control);
    h.now = 2_000_000;
    await storedGuestbookExtras(community, control);
    expect(h.reads).toBe(2);
  });
});
