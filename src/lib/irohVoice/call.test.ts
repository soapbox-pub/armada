import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { P2pTarget } from "@/concord/lib/irohVoice";
import type { VoiceTransport } from "@/lib/realtimeTransport";
import { IrohVoiceCall, PRESENCE_GRACE_MS, type LinkAudio } from "@/lib/irohVoice/call";

const MINE = "5".repeat(64);
const LOWER = "2".repeat(64);
const HIGHER = "9".repeat(64);
const RELAY = "https://euc1-1.relay.n0.iroh.link/";

function harness() {
  const cb = {} as {
    link: (id: string, inbound: boolean) => void;
    datagram: (id: string, b: Uint8Array) => void;
    closed: (id: string) => void;
    stream: (id: string, b: Uint8Array | undefined) => void;
  };
  const sent: [string, number][] = [];
  const node: VoiceTransport = {
    endpointHex: () => MINE,
    relayUrl: () => RELAY,
    dial: vi.fn(async (id: string) => cb.link(id, false)),
    send: vi.fn((id: string, d: Uint8Array) => {
      sent.push([id, d[0]]);
      return true;
    }),
    sendStream: vi.fn(async () => true),
    rttMs: () => 0,
    unlink: vi.fn((id: string) => cb.closed(id)),
    close: vi.fn(async () => undefined),
  };
  const audio: LinkAudio = { addPeer: vi.fn(), removePeer: vi.fn(), receive: vi.fn(), setPeerGain: vi.fn(), close: vi.fn(async () => undefined) };
  let send: (d: Uint8Array) => void = () => undefined;
  const start = () =>
    IrohVoiceCall.start(
      async (_relays, onLink, onDatagram, onClosed, onStream) => {
        Object.assign(cb, { link: onLink, datagram: onDatagram, closed: onClosed, stream: onStream });
        return node;
      },
      [],
      (s) => {
        send = s;
        return audio;
      },
    );
  return { cb, node, audio, sent, start, send: (d: Uint8Array) => send(d) };
}

const target = (author: string, endpoint: string, dial: boolean): P2pTarget => ({ author, endpoint, relay: RELAY, dial });

describe("the peer-to-peer links", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("names its endpoint and relay for presence", async () => {
    const h = harness();
    const call = await h.start();
    expect(call.address()).toEqual({ endpoint: MINE, relay: RELAY });
  });

  it("dials the targets it is its turn to dial, and sends audio only over adopted links", async () => {
    const h = harness();
    const call = await h.start();
    call.setTargets([target("v", HIGHER, true), target("l", LOWER, false)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.node.dial).toHaveBeenCalledTimes(1);
    expect(h.node.dial).toHaveBeenCalledWith(HIGHER, RELAY);
    expect(call.linked()).toEqual([{ author: "v", endpoint: HIGHER }]);
    h.send(new Uint8Array([42]));
    expect(h.sent).toEqual([[HIGHER, 42]]);
  });

  it("holds an inbound link until a presence names it, then adopts it", async () => {
    const h = harness();
    const call = await h.start();
    h.cb.link(LOWER, true);
    h.cb.datagram(LOWER, new Uint8Array([1]));
    expect(h.audio.receive).not.toHaveBeenCalled();
    expect(call.linked()).toEqual([]);
    call.setTargets([target("l", LOWER, false)]);
    expect(call.linked()).toEqual([{ author: "l", endpoint: LOWER }]);
    h.cb.datagram(LOWER, new Uint8Array([1]));
    expect(h.audio.receive).toHaveBeenCalledWith(LOWER, new Uint8Array([1]));
  });

  it("drops an inbound link nobody's presence names within the grace", async () => {
    const h = harness();
    await h.start();
    h.cb.link(LOWER, true);
    await vi.advanceTimersByTimeAsync(PRESENCE_GRACE_MS + 3_000);
    expect(h.node.unlink).toHaveBeenCalledWith(LOWER, "not in this call");
  });

  it("refuses an inbound link from the side that should have waited", async () => {
    const h = harness();
    const call = await h.start();
    call.setTargets([target("v", HIGHER, false)]);
    h.cb.link(HIGHER, true);
    expect(call.linked()).toEqual([]);
  });

  it("drops a link whose member is no longer a target, as when they join the SFU", async () => {
    const h = harness();
    const call = await h.start();
    call.setTargets([target("v", HIGHER, true)]);
    await vi.advanceTimersByTimeAsync(0);
    call.setTargets([]);
    expect(h.node.unlink).toHaveBeenCalledWith(HIGHER, "not in this call");
    expect(h.audio.removePeer).toHaveBeenCalledWith(HIGHER);
    expect(call.linked()).toEqual([]);
  });

  it("applies each member's gain as it links and when the gate changes", async () => {
    const h = harness();
    const call = await h.start();
    call.setGain((a) => ({ audible: a !== "v", volume: 1.5 }));
    call.setTargets([target("v", HIGHER, true)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.audio.setPeerGain).toHaveBeenLastCalledWith(HIGHER, false, 1.5);
    call.setGain(() => ({ audible: true, volume: 1 }));
    expect(h.audio.setPeerGain).toHaveBeenLastCalledWith(HIGHER, true, 1);
  });

  it("hands only adopted peers' streams to the video sink, and sends streams only to them", async () => {
    const h = harness();
    const call = await h.start();
    const sink = vi.fn();
    const links = vi.fn();
    call.setStreamSink(sink, links);
    h.cb.link(LOWER, true);
    h.cb.stream(LOWER, new Uint8Array([2]));
    expect(sink).not.toHaveBeenCalled();
    expect(await call.sendStream(LOWER, new Uint8Array([1]), 0, 400)).toBe(false);
    call.setTargets([target("l", LOWER, false)]);
    expect(links).toHaveBeenCalledWith(LOWER, true);
    h.cb.stream(LOWER, new Uint8Array([2]));
    h.cb.stream(LOWER, undefined);
    expect(sink.mock.calls).toEqual([[LOWER, new Uint8Array([2])], [LOWER, undefined]]);
    expect(await call.sendStream(LOWER, new Uint8Array([1]), 0, 400)).toBe(true);
    expect(h.node.sendStream).toHaveBeenCalledWith(LOWER, new Uint8Array([1]), 0, 400);
    h.cb.closed(LOWER);
    expect(links).toHaveBeenLastCalledWith(LOWER, false);
  });

  it("closes the audio and the endpoint on stop", async () => {
    const h = harness();
    const call = await h.start();
    await call.stop();
    expect(h.audio.close).toHaveBeenCalled();
    expect(h.node.close).toHaveBeenCalled();
  });
});
