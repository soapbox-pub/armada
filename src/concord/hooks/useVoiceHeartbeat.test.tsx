/**
 * The presence a call announces (CORD-07 §4, §8): one `joined` naming the SFU identity and
 * the iroh endpoint while on LiveKit, and the endpoint alone once LiveKit has failed — with no
 * `left` between, which Vector reads as leaving the call and unlinks.
 */
import { act, renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { channelGroupKey, random32 } from "@/concord/lib/derive";
import { KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";
import { openWrap } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import type { IrohAddress } from "@/concord/lib/voice";

import { useVoiceHeartbeat } from "./useVoice";

const h = vi.hoisted(() => ({
  sent: [] as NostrEvent[],
  user: undefined as { pubkey: string; signer: unknown } | undefined,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { relay: () => ({ event: async (e: NostrEvent) => void h.sent.push(e) }) } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
// An open Channel: presence rides its read address (CORD-03 §1).
vi.mock("@/concord/hooks/useControlPlane", async (orig) => ({
  ...(await orig<typeof import("@/concord/hooks/useControlPlane")>()),
  useControlFold: () => ({ data: undefined }),
}));

const CHANNEL = random32();
const group = channelGroupKey(random32(), CHANNEL, 0);
const channel = {
  id: CHANNEL,
  idHex: Buffer.from(CHANNEL).toString("hex"),
  isPrivate: false,
  current: { epoch: 0n, group },
  streams: [{ epoch: 0n, group }],
} as unknown as Channel;
const community = { idHex: "c".repeat(64), relays: ["wss://relay.test"] } as unknown as Community;
const IROH: IrohAddress = { endpoint: "e".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link/" };
const MEDIA = { muted: false, screen: false, camera: false };

const presences = () =>
  h.sent
    .map((w) => openWrap(w, group))
    .filter((o) => o.kind === KIND_VOICE_PRESENCE)
    .map((o) => ({ content: o.content, identity: o.tags.find((t) => t[0] === "identity")?.[1], endpoint: o.tags.find((t) => t[0] === "endpoint")?.[1] }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

describe("the call's presence heartbeat", () => {
  beforeEach(() => {
    h.sent = [];
    const sk = generateSecretKey();
    h.user = { pubkey: getPublicKey(sk), signer: { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) } };
  });

  it("names the SFU identity and the endpoint together, then the endpoint alone with no left between", async () => {
    type P = { identity?: string; broker?: string; alone: boolean };
    const { rerender, unmount } = renderHook(
      ({ identity, broker, alone }: P) => useVoiceHeartbeat(community, channel, identity, broker, false, [], false, MEDIA, IROH, alone),
      { initialProps: { identity: "id-1", broker: "https://av.test", alone: false } as P },
    );
    await settle();
    expect(presences()[0]).toEqual({ content: "joined", identity: "id-1", endpoint: IROH.endpoint });

    h.sent = [];
    rerender({ identity: undefined, broker: undefined, alone: true });
    await settle();
    expect(presences().map((p) => p.content)).not.toContain("left");
    expect(presences().at(-1)).toEqual({ content: "joined", identity: undefined, endpoint: IROH.endpoint });

    h.sent = [];
    unmount();
    await settle();
    expect(presences().map((p) => p.content)).toEqual(["left"]);
  });

  it("sends no left when LiveKit fails before the endpoint is bound, and announces the endpoint once it is", async () => {
    type P = { identity?: string; broker?: string; alone: boolean; iroh?: IrohAddress };
    const { rerender } = renderHook(
      ({ identity, broker, alone, iroh }: P) => useVoiceHeartbeat(community, channel, identity, broker, false, [], false, MEDIA, iroh, alone),
      { initialProps: { identity: "id-1", broker: "https://av.test", alone: false } as P },
    );
    await settle();
    expect(presences()[0]).toEqual({ content: "joined", identity: "id-1", endpoint: undefined });

    h.sent = [];
    rerender({ identity: undefined, broker: undefined, alone: true });
    await settle();
    expect(presences(), "nothing to announce yet, and no left").toEqual([]);

    rerender({ identity: undefined, broker: undefined, alone: true, iroh: IROH });
    await settle();
    expect(presences()).toEqual([{ content: "joined", identity: undefined, endpoint: IROH.endpoint }]);
  });

  it("announces nothing before LiveKit hands out an identity, unless the call is peer to peer alone", async () => {
    renderHook(() => useVoiceHeartbeat(community, channel, undefined, undefined, false, [], false, MEDIA, IROH, false));
    await settle();
    expect(presences()).toEqual([]);
    renderHook(() => useVoiceHeartbeat(community, channel, undefined, undefined, false, [], false, MEDIA, IROH, true));
    await settle();
    expect(presences()).toEqual([{ content: "joined", identity: undefined, endpoint: IROH.endpoint }]);
  });
});
