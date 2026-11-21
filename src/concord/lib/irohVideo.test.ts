import { describe, expect, it } from "vitest";

import { chooseCodec, packControlStream, packFrameStream, parseStream, STREAM_CONTROL, STREAM_FRAME } from "@/concord/lib/irohVideo";

describe("Vector's video wire format (`wire.rs`, `voice/video.rs`)", () => {
  it("writes the 16-byte header exactly as Vector's own test vector", () => {
    const stream = packFrameStream({ seq: 70_000, tsUs: 2 ** 40, key: true, kind: "screen", codec: "vp8" }, new Uint8Array([9, 9, 9]));
    expect([...stream]).toEqual([STREAM_FRAME, 0, 1, 17, 112, 0, 0, 1, 0, 0, 0, 0, 0, 3, 2, 0, 0, 9, 9, 9]);
    const parsed = parseStream(stream);
    expect(parsed && "frame" in parsed && parsed.frame.header).toEqual({ seq: 70_000, tsUs: 2 ** 40, key: true, kind: "screen", codec: "vp8" });
    expect(parsed && "frame" in parsed && [...parsed.frame.data]).toEqual([9, 9, 9]);
  });

  it("refuses an unknown codec byte, a short header and an unknown stream type", () => {
    const stream = packFrameStream({ seq: 1, tsUs: 0, key: false, kind: "camera", codec: "h264" }, new Uint8Array([1]));
    stream[14] = 9;
    expect(parseStream(stream)).toBeNull();
    expect(parseStream(stream.subarray(0, 10))).toBeNull();
    expect(parseStream(new Uint8Array([7, 1, 2]))).toBeNull();
  });

  it("writes the controls as Vector serializes them, and reads Vector's", () => {
    const text = (b: Uint8Array) => [b[0], new TextDecoder().decode(b.subarray(1))];
    expect(text(packControlStream({ t: "watch", camera: true, screen: false }))).toEqual([STREAM_CONTROL, '{"t":"watch","camera":true,"screen":false}']);
    expect(text(packControlStream({ t: "key", kind: "camera" }))).toEqual([STREAM_CONTROL, '{"t":"key","kind":"camera"}']);
    const ctl = (json: string) => parseStream(new Uint8Array([STREAM_CONTROL, ...new TextEncoder().encode(json)]));
    // serde's `#[serde(default)]`: an absent picture is not asked for.
    expect(ctl('{"t":"watch","screen":true}')).toEqual({ control: { t: "watch", camera: false, screen: true } });
    expect(ctl('{"t":"unsupported","codec":"h264"}')).toEqual({ control: { t: "unsupported", codec: "h264" } });
    expect(ctl('{"t":"hologram"}')).toBeNull();
    expect(ctl("not json")).toBeNull();
  });

  it("prefers H.264, falls back to VP8 once a viewer refuses it", () => {
    expect(chooseCodec(["vp8", "h264"], [])).toBe("h264");
    expect(chooseCodec(["vp8", "h264"], ["h264"])).toBe("vp8");
    expect(chooseCodec(["h264"], ["h264"])).toBeUndefined();
  });
});
