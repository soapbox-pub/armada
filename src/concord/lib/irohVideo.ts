/**
 * Cameras and shared screens in a voice Channel's peer-to-peer call (CORD-07 §6, §8), in
 * Vector's wire format (`vector-calls` `wire.rs`, vector-core `calls/voice/video.rs`): every
 * frame on a unidirectional stream of its own behind a 16-byte header, and the controls a
 * viewer and a sender exchange as JSON on streams of their own. A sender sends a picture only
 * to the members who asked for it.
 */

/** A unidirectional stream's first byte: what it carries. */
export const STREAM_FRAME = 1;
export const STREAM_CONTROL = 2;
export const VIDEO_HEADER_LEN = 16;
export const VIDEO_KEY = 1;
export const VIDEO_SCREEN = 2;
/** Vector's `MAX_VIDEO_FRAME`: a bigger frame would sit in front of everything else on the link. */
export const MAX_VIDEO_FRAME = 1024 * 1024;
const MAX_CONTROL = 1024;

export type VideoKind = "camera" | "screen";
export type VideoCodec = "h264" | "vp8";
export const VIDEO_KINDS: readonly VideoKind[] = ["camera", "screen"];

/** The codec byte: a fixed table, so nothing off the wire reaches a decoder as a string. */
const CODEC_BYTE: Record<VideoCodec, number> = { h264: 1, vp8: 2 };
const CODEC_OF_BYTE: Record<number, VideoCodec> = { 1: "h264", 2: "vp8" };

export interface Tracks {
  camera: boolean;
  screen: boolean;
}

export interface VideoHeader {
  seq: number;
  /** Capture time in the sender's microseconds. */
  tsUs: number;
  key: boolean;
  kind: VideoKind;
  codec: VideoCodec;
}

export interface VideoFrame {
  header: VideoHeader;
  data: Uint8Array;
}

/** What a viewer and a sender say to each other (Vector `Ctl`). */
export type VideoControl =
  | { t: "watch"; camera: boolean; screen: boolean }
  | { t: "key"; kind: VideoKind }
  | { t: "unsupported"; codec: VideoCodec };

/** A frame's stream, whole: type byte, header, encoded picture. */
export function packFrameStream(header: VideoHeader, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + VIDEO_HEADER_LEN + data.length);
  const view = new DataView(out.buffer);
  out[0] = STREAM_FRAME;
  view.setUint32(1, header.seq >>> 0);
  view.setBigUint64(5, BigInt(Math.max(0, Math.floor(header.tsUs))));
  out[13] = (header.key ? VIDEO_KEY : 0) | (header.kind === "screen" ? VIDEO_SCREEN : 0);
  out[14] = CODEC_BYTE[header.codec];
  out.set(data, 1 + VIDEO_HEADER_LEN);
  return out;
}

export function packControlStream(ctl: VideoControl): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(ctl));
  const out = new Uint8Array(1 + body.length);
  out[0] = STREAM_CONTROL;
  out.set(body, 1);
  return out;
}

export type ParsedStream = { frame: VideoFrame } | { control: VideoControl } | null;

/** One whole stream from a peer; null for anything malformed, unknown, or too big. */
export function parseStream(bytes: Uint8Array): ParsedStream {
  if (bytes.length < 1) return null;
  if (bytes[0] === STREAM_FRAME) {
    if (bytes.length < 1 + VIDEO_HEADER_LEN || bytes.length > 1 + VIDEO_HEADER_LEN + MAX_VIDEO_FRAME) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const codec = CODEC_OF_BYTE[bytes[14]];
    if (!codec) return null;
    const flags = bytes[13];
    return {
      frame: {
        header: {
          seq: view.getUint32(1),
          // Safe-integer microseconds, as Vector's own decoder masks them.
          tsUs: Number(view.getBigUint64(5) & 0x1fffffffffffffn),
          key: (flags & VIDEO_KEY) !== 0,
          kind: flags & VIDEO_SCREEN ? "screen" : "camera",
          codec,
        },
        data: bytes.subarray(1 + VIDEO_HEADER_LEN),
      },
    };
  }
  if (bytes[0] === STREAM_CONTROL) {
    if (bytes.length > 1 + MAX_CONTROL) return null;
    try {
      const raw = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as Record<string, unknown>;
      if (raw.t === "watch") return { control: { t: "watch", camera: raw.camera === true, screen: raw.screen === true } };
      if (raw.t === "key" && (raw.kind === "camera" || raw.kind === "screen")) return { control: { t: "key", kind: raw.kind } };
      if (raw.t === "unsupported" && (raw.codec === "h264" || raw.codec === "vp8")) return { control: { t: "unsupported", codec: raw.codec } };
    } catch {
      /* not JSON */
    }
    return null;
  }
  return null;
}

/**
 * What our encoder sends, of what this browser can encode: H.264 first, as Vector prefers it,
 * unless a viewer refused it. VP8 decodes everywhere.
 */
export function chooseCodec(encodable: readonly VideoCodec[], refused: readonly VideoCodec[]): VideoCodec | undefined {
  return (["h264", "vp8"] as const).find((c) => encodable.includes(c) && !refused.includes(c));
}
