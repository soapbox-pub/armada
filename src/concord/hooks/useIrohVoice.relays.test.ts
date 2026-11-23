/**
 * Whether a call can run peer to peer is decided by its relays as a LiveKit call's is by its
 * brokers: the Community's list replaces the deployment's (`CONCORD_IROH_RELAYS`, else the
 * shipped iroh release's), and with neither there is nothing to home on (CORD-07 §8).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  configured: undefined as string[] | undefined,
  shipped: ["https://euc1-1.relay.n0.iroh.link/"] as string[] | undefined,
}));

vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  get CONCORD_IROH_RELAYS() {
    return h.configured;
  },
}));
vi.mock("@/lib/realtimeTransport", () => ({
  voiceNodeBinder: async () => (h.shipped ? async () => ({}) : undefined),
  irohDefaultRelays: async () => h.shipped,
}));
vi.mock("@/lib/irohVoice/audio", () => ({ irohAudioSupported: () => true, IrohVoiceAudio: class {} }));

const { peerToPeerAvailable } = await import("./useIrohVoice");

describe("whether a call can run peer to peer", () => {
  beforeEach(() => {
    h.configured = undefined;
    h.shipped = ["https://euc1-1.relay.n0.iroh.link/"];
  });

  it("homes on iroh's defaults when neither the deployment nor the Community names relays", async () => {
    expect(await peerToPeerAvailable([])).toBe(true);
  });

  it("starts nothing when the deployment emptied its relays and the Community lists none", async () => {
    h.configured = [];
    expect(await peerToPeerAvailable([])).toBe(false);
    expect(await peerToPeerAvailable(["https://relay.community.example"])).toBe(true);
  });

  it("is off in a build without the iroh module", async () => {
    h.shipped = undefined;
    expect(await peerToPeerAvailable(["https://relay.community.example"])).toBe(false);
  });
});
