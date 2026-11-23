import { describe, expect, it, vi } from "vitest";

import { packControlStream, parseStream, type VideoControl } from "@/concord/lib/irohVideo";
import { IrohVideo, targetSize } from "@/lib/irohVoice/video";

function harness() {
  const sent: [string, VideoControl | "frame"][] = [];
  const links = {
    sendStream: vi.fn(async (id: string, bytes: Uint8Array) => {
      const parsed = parseStream(bytes);
      sent.push([id, parsed && "control" in parsed ? parsed.control : "frame"]);
      return true;
    }),
  };
  return { video: new IrohVideo(links), sent };
}

describe("video over the peer-to-peer links (Vector `voice/video.rs`)", () => {
  it("asks a peer for its pictures once per change, and again on a new link", () => {
    const { video, sent } = harness();
    video.setWatched("a", { camera: false, screen: true });
    video.setWatched("a", { camera: false, screen: true });
    video.setWatched("a", { camera: true, screen: true });
    video.relinked("a");
    video.setWatched("b", { camera: false, screen: false });
    expect(sent).toEqual([
      ["a", { t: "watch", camera: false, screen: true }],
      ["a", { t: "watch", camera: true, screen: true }],
      ["a", { t: "watch", camera: true, screen: true }],
    ]);
  });

  it("counts who watches our pictures from their controls, and forgets a peer that left", () => {
    const { video } = harness();
    const changed = vi.fn();
    video.subscribe(changed);
    video.onStream("a", packControlStream({ t: "watch", camera: true, screen: false }));
    video.onStream("b", packControlStream({ t: "watch", camera: true, screen: true }));
    expect([video.viewerCount("camera"), video.viewerCount("screen")]).toEqual([2, 1]);
    video.onStream("b", packControlStream({ t: "watch", camera: false, screen: false }));
    video.removePeer("a");
    expect([video.viewerCount("camera"), video.viewerCount("screen")]).toEqual([0, 0]);
    expect(changed).toHaveBeenCalled();
  });

  it("asks for a keyframe when a watched picture's stream breaks off, at most once a second", () => {
    const { video, sent } = harness();
    video.setWatched("a", { camera: true, screen: false });
    sent.length = 0;
    video.onStream("a", undefined);
    video.onStream("a", undefined);
    expect(sent).toEqual([["a", { t: "key", kind: "camera" }]]);
    video.onStream("z", undefined);
    expect(sent).toHaveLength(1);
  });

  it("still owes a keyframe when the encoder was too busy to take the frame it was asked of", async () => {
    const encoded: boolean[] = [];
    class FakeEncoder {
      static isConfigSupported = async () => ({ supported: true });
      state = "configured";
      encodeQueueSize = 0;
      configure() {}
      close() {
        this.state = "closed";
      }
      encode(_frame: unknown, opts: { keyFrame: boolean }) {
        encoded.push(opts.keyFrame);
      }
    }
    vi.stubGlobal("VideoEncoder", FakeEncoder);
    vi.stubGlobal("MediaStreamTrackProcessor", class { readable = new ReadableStream(); });
    let t = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const { video } = harness();
      video.onStream("a", packControlStream({ t: "watch", camera: true, screen: false }));
      await video.setSource("camera", {} as MediaStreamTrack);
      const internals = video as unknown as { senders: Map<string, { encoder?: FakeEncoder }>; encode(s: unknown, f: unknown): void };
      const sender = internals.senders.get("camera")!;
      const frame = () => ({ displayWidth: 1280, displayHeight: 720, timestamp: t * 1000, close: vi.fn() });

      internals.encode(sender, frame());
      expect(encoded).toEqual([true]);

      video.onStream("a", packControlStream({ t: "key", kind: "camera" }));
      t += 100;
      sender.encoder!.encodeQueueSize = 5;
      internals.encode(sender, frame());
      expect(encoded, "the busy encoder took nothing").toEqual([true]);

      t += 100;
      sender.encoder!.encodeQueueSize = 0;
      internals.encode(sender, frame());
      expect(encoded).toEqual([true, true]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("ignores what isn't a frame or a control", () => {
    const { video, sent } = harness();
    video.onStream("a", new Uint8Array([9, 1, 2]));
    expect(sent).toEqual([]);
  });

  it("sizes a picture inside its rung, even and never upscaled, held upright or not", () => {
    expect(targetSize(1920, 1080, { width: 1280, height: 720 })).toEqual([1280, 720]);
    expect(targetSize(640, 481, { width: 1280, height: 720 })).toEqual([640, 480]);
    expect(targetSize(1080, 1920, { width: 1280, height: 720 })).toEqual([720, 1280]);
    expect(targetSize(3840, 1600, { width: 1920, height: 1080 })).toEqual([1920, 800]);
  });
});
