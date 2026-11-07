/**
 * The warm-up's persistence discipline: a control sweep that came up short
 * must not become the client's durable baseline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  truncated: false,
  writeFolded: vi.fn(async () => undefined),
  prune: vi.fn(async () => undefined),
}));

vi.mock("@/concord/lib/planeSync", () => ({
  controlSweepTruncated: () => h.truncated,
  sweepControl: async () => [],
  sweepGuestbook: async () => [],
  whenAuthSettled: async () => undefined,
}));
vi.mock("@/concord/lib/rumorStore", () => ({
  pruneControlSnapshots: h.prune,
  queryPlane: async () => [],
  writeRumors: async () => undefined,
}));
vi.mock("@/concord/lib/streamAuth", () => ({ registerStreamKeys: () => undefined }));
vi.mock("@/lib/foldedCache", () => ({ readFolded: async () => undefined, writeFolded: h.writeFolded }));
vi.mock("@/lib/syncActivity", () => ({
  beginSyncTask: () => ({ update: () => undefined, end: () => undefined }),
}));
vi.mock("@/wire/bus", () => ({ emitWireScopes: () => undefined }));
vi.mock("@/concord/lib/chat", () => ({ openChatBatch: async () => [] }));
vi.mock("@/concord/lib/community", () => ({ channelsView: () => [] }));
vi.mock("@/concord/lib/guestbook", () => ({ guestbookGroups: () => [] }));
vi.mock("@/concord/lib/control", () => ({
  controlFoldKey: (idHex: string) => `concord2-fold:${idHex}`,
  controlGroups: () => [{ pk: "aa".repeat(32) }],
  openControlEditions: () => [],
  foldControlState: () => ({ channels: new Map(), banned: new Set(), heads: new Map(), incomplete: [] }),
}));
vi.mock("@/concord/lib/communityList", () => ({
  rehydrateCommunity: () => ({ idHex: "cc".repeat(32), relays: ["wss://relay.test"] }),
}));

const { warmupCommunities } = await import("@/concord/lib/loginWarmup");

const nostr = { relay: () => ({ query: async () => [] }) };

describe("warmupCommunities persistence gate", () => {
  beforeEach(() => {
    h.truncated = false;
    h.writeFolded.mockClear();
    h.prune.mockClear();
  });

  it("persists the fold when the sweep ran its course", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmupCommunities(nostr as any, [{} as any]);
    expect(h.writeFolded).toHaveBeenCalled();
  });

  it("prunes retired control-snapshot sets for a sole logged-in account", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmupCommunities(nostr as any, [{} as any]);
    expect(h.prune).toHaveBeenCalled();
  });

  it("skips the prune when told other accounts share the device", async () => {
    // "Epochs this community no longer holds keys for" is judged from THIS
    // account's list entry; another logged-in account's entry for the same
    // community can hold different epochs, and pruning by the active account's
    // keys deletes the other account's fold anchor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmupCommunities(nostr as any, [{} as any], { pruneSnapshots: false });
    expect(h.prune).not.toHaveBeenCalled();
  });

  it("does not persist a fold from a sweep that hit its budget", async () => {
    // The reported ban-evasion: any member can inflate the control plane past
    // any budget, and a cold login folding under that flood would otherwise
    // freeze a ban-less roster on disk for every later launch. The fold still
    // renders this session — it just doesn't get to become the baseline.
    h.truncated = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmupCommunities(nostr as any, [{} as any]);
    expect(h.writeFolded).not.toHaveBeenCalled();
  });
});
