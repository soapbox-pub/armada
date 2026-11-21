/**
 * Cameras and shared screens over a voice Channel's peer-to-peer links, interoperable with
 * Vector's (`calls/voice/video.rs`): each picture is encoded once with WebCodecs and each
 * frame goes to every member who asked for it, one stream per frame; a viewer that falls
 * behind or loses a frame waits for a keyframe instead of holding the rest back. What a peer
 * sends us is decoded onto a canvas whose capture stream is the tile's track.
 */
import {
  chooseCodec,
  packControlStream,
  packFrameStream,
  parseStream,
  VIDEO_KINDS,
  type Tracks,
  type VideoCodec,
  type VideoControl,
  type VideoFrame as WireFrame,
  type VideoKind,
} from "@/concord/lib/irohVideo";

/** What the engine sends whole streams through (`IrohVoiceCall.sendStream`). */
export interface VideoLinks {
  sendStream(id: string, bytes: Uint8Array, priority: number, staleMs: number): Promise<boolean>;
}

interface Rung {
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

/** One rung each, near the middle of Vector's ladders (`rate.rs`). */
const RUNGS: Record<VideoKind, Rung> = {
  camera: { width: 1280, height: 720, fps: 24, kbps: 1200 },
  screen: { width: 1920, height: 1080, fps: 15, kbps: 2500 },
};
/** Frames a viewer may have in flight before it skips to the next keyframe (Vector `IN_FLIGHT_MIN` and slack). */
const MAX_IN_FLIGHT = 6;
/** How long a frame may take to land, keyframes longer (Vector `STALE_MIN`, `STALE_KEY_MIN`). */
const STALE_MS = 400;
const STALE_KEY_MS = 2000;
/** Keyframes are forced, and asked of a sender, at most this often (Vector `KEY_GAP`). */
const KEY_GAP_MS = 1000;
/** A keyframe anyway this often, so a viewer that missed a request still recovers. */
const KEY_EVERY_MS = 4000;
/** Vector's decode profile: constrained baseline at the top level, which decoders take for any size. */
const H264_DECODE = "avc1.42E033";

function h264Codec(width: number, height: number): string {
  const px = width * height;
  if (px <= 921_600) return "avc1.42E01F";
  if (px <= 2_097_152) return "avc1.42E028";
  return "avc1.42E033";
}

/** The size a captured frame is sent at: inside the rung, even, never upscaled. */
export function targetSize(width: number, height: number, rung: Pick<Rung, "width" | "height">): [number, number] {
  const [maxW, maxH] = height > width ? [rung.height, rung.width] : [rung.width, rung.height];
  const s = Math.min(1, maxW / width, maxH / height);
  return [Math.max(2, Math.round(width * s) & ~1), Math.max(2, Math.round(height * s) & ~1)];
}

interface Viewer {
  want: Tracks;
  needKey: Record<VideoKind, boolean>;
  inFlight: Record<VideoKind, number>;
  lastKeyAsk: number;
}

interface Sender {
  kind: VideoKind;
  track: MediaStreamTrack;
  stop: () => void;
  encoder?: VideoEncoder;
  configured?: { codec: VideoCodec; width: number; height: number };
  canvas?: OffscreenCanvas;
  seq: number;
  forceKey: boolean;
  lastKey: number;
  lastForced: number;
  lastFrame: number;
}

interface Receiver {
  decoder?: VideoDecoder;
  codec?: VideoCodec;
  needKey: boolean;
  errors: number;
  lastKeyAsk: number;
  canvas?: HTMLCanvasElement;
  track?: MediaStreamTrack;
}

export class IrohVideo {
  private readonly viewers = new Map<string, Viewer>();
  private readonly watching = new Map<string, Tracks>();
  private readonly senders = new Map<VideoKind, Sender>();
  private readonly receivers = new Map<string, Receiver>();
  private readonly listeners = new Set<() => void>();
  private encodable: VideoCodec[] = [];
  private refused: VideoCodec[] = [];
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(private readonly links: VideoLinks) {
    this.ready = this.probe();
  }

  /** What a peer is sending us of the pictures we watch, as tracks a `<video>` can show. */
  remoteTrack(id: string, kind: VideoKind): MediaStreamTrack | undefined {
    return this.receivers.get(`${id}|${kind}`)?.track;
  }

  /** How many members watch each of our pictures. */
  viewerCount(kind: VideoKind): number {
    return [...this.viewers.values()].filter((v) => v.want[kind]).length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ask a peer for its pictures, or stop; sent only on a change (Vector `watch`). */
  setWatched(id: string, want: Tracks): void {
    const before = this.watching.get(id) ?? { camera: false, screen: false };
    if (before.camera === want.camera && before.screen === want.screen) return;
    this.watching.set(id, want);
    for (const kind of VIDEO_KINDS) {
      if (want[kind] && !before[kind]) this.receiver(id, kind).needKey = true;
      if (!want[kind] && before[kind]) this.dropReceiver(id, kind);
    }
    this.control(id, { t: "watch", camera: want.camera, screen: want.screen });
  }

  /** A peer linked anew: what we watch of them is asked for on this link. */
  relinked(id: string): void {
    const want = this.watching.get(id);
    if (!want || (!want.camera && !want.screen)) return;
    for (const kind of VIDEO_KINDS) if (want[kind]) this.receiver(id, kind).needKey = true;
    this.control(id, { t: "watch", camera: want.camera, screen: want.screen });
  }

  removePeer(id: string): void {
    this.viewers.delete(id);
    this.watching.delete(id);
    for (const kind of VIDEO_KINDS) this.dropReceiver(id, kind);
  }

  /** One whole stream from a peer, or `undefined` for one that broke off mid-frame. */
  onStream(id: string, bytes: Uint8Array | undefined): void {
    if (this.closed) return;
    if (!bytes) {
      for (const kind of VIDEO_KINDS) if (this.watching.get(id)?.[kind]) this.lost(id, kind);
      return;
    }
    const parsed = parseStream(bytes);
    if (!parsed) return;
    if ("control" in parsed) this.onControl(id, parsed.control);
    else this.onFrame(id, parsed.frame);
  }

  /** Start, replace or stop sending one of our pictures. */
  async setSource(kind: VideoKind, track: MediaStreamTrack | undefined): Promise<void> {
    const current = this.senders.get(kind);
    if (current?.track === track) return;
    if (current) this.stopSender(current);
    if (!track || this.closed) return;
    await this.ready;
    if (this.closed || this.senders.has(kind)) return;
    const sender: Sender = { kind, track, stop: () => undefined, seq: 0, forceKey: true, lastKey: -Infinity, lastForced: -Infinity, lastFrame: -Infinity };
    this.senders.set(kind, sender);
    for (const v of this.viewers.values()) v.needKey[kind] = true;
    sender.stop = pumpFrames(track, RUNGS[kind].fps, (frame) => this.encode(sender, frame));
  }

  close(): void {
    this.closed = true;
    for (const s of [...this.senders.values()]) this.stopSender(s);
    for (const key of [...this.receivers.keys()]) {
      const [id, kind] = key.split("|") as [string, VideoKind];
      this.dropReceiver(id, kind);
    }
    this.viewers.clear();
    this.listeners.clear();
  }

  private async probe(): Promise<void> {
    if (typeof VideoEncoder === "undefined") return;
    const found: VideoCodec[] = [];
    for (const [codec, config] of [
      ["h264", { codec: "avc1.42E01F", avc: { format: "annexb" } }],
      ["vp8", { codec: "vp8" }],
    ] as const) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported({ ...config, width: 1280, height: 720, bitrate: 1_000_000, framerate: 30, latencyMode: "realtime" } as VideoEncoderConfig);
        if (supported) found.push(codec);
      } catch {
        /* not this one */
      }
    }
    this.encodable = found;
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private control(id: string, ctl: VideoControl): void {
    void this.links.sendStream(id, packControlStream(ctl), 1, 5000).catch(() => undefined);
  }

  // --- Receiving ---------------------------------------------------------------------

  private receiver(id: string, kind: VideoKind): Receiver {
    const key = `${id}|${kind}`;
    let r = this.receivers.get(key);
    if (!r) this.receivers.set(key, (r = { needKey: true, errors: 0, lastKeyAsk: -Infinity }));
    return r;
  }

  private dropReceiver(id: string, kind: VideoKind): void {
    const key = `${id}|${kind}`;
    const r = this.receivers.get(key);
    if (!r) return;
    this.receivers.delete(key);
    if (r.decoder && r.decoder.state !== "closed") r.decoder.close();
    r.track?.stop();
    if (r.track) this.changed();
  }

  /** A frame of that picture went missing: wait for a keyframe, and ask for one. */
  private lost(id: string, kind: VideoKind): void {
    const r = this.receiver(id, kind);
    r.needKey = true;
    const now = performance.now();
    if (now - r.lastKeyAsk < KEY_GAP_MS) return;
    r.lastKeyAsk = now;
    this.control(id, { t: "key", kind });
  }

  private onFrame(id: string, frame: WireFrame): void {
    const { header, data } = frame;
    if (!this.watching.get(id)?.[header.kind] || typeof VideoDecoder === "undefined") return;
    const r = this.receiver(id, header.kind);
    if (!r.decoder || r.codec !== header.codec) {
      if (!header.key) return this.lost(id, header.kind);
      if (r.decoder && r.decoder.state !== "closed") r.decoder.close();
      r.codec = header.codec;
      r.decoder = new VideoDecoder({
        output: (vf) => this.paint(id, header.kind, vf),
        error: () => {
          r.decoder = undefined;
          r.errors += 1;
          // Twice in a row: this browser can't take that codec, so the sender switches.
          if (r.errors >= 2 && r.codec) this.control(id, { t: "unsupported", codec: r.codec });
          else this.lost(id, header.kind);
        },
      });
      r.decoder.configure({ codec: header.codec === "h264" ? H264_DECODE : "vp8", optimizeForLatency: true });
    }
    if (r.needKey && !header.key) return this.lost(id, header.kind);
    r.needKey = false;
    try {
      r.decoder.decode(new EncodedVideoChunk({ type: header.key ? "key" : "delta", timestamp: header.tsUs, data }));
    } catch {
      this.lost(id, header.kind);
    }
  }

  private paint(id: string, kind: VideoKind, vf: VideoFrame): void {
    try {
      const r = this.receivers.get(`${id}|${kind}`);
      if (!r || this.closed) return;
      r.errors = 0;
      if (!r.canvas) {
        r.canvas = document.createElement("canvas");
        r.canvas.getContext("2d");
      }
      const canvas = r.canvas;
      if (canvas.width !== vf.displayWidth || canvas.height !== vf.displayHeight) {
        canvas.width = vf.displayWidth;
        canvas.height = vf.displayHeight;
      }
      canvas.getContext("2d")?.drawImage(vf, 0, 0);
      if (!r.track) {
        r.track = canvas.captureStream().getVideoTracks()[0];
        this.changed();
      }
    } finally {
      vf.close();
    }
  }

  // --- Sending -----------------------------------------------------------------------

  private onControl(id: string, ctl: VideoControl): void {
    if (ctl.t === "watch") {
      const v = this.viewers.get(id) ?? { want: { camera: false, screen: false }, needKey: { camera: true, screen: true }, inFlight: { camera: 0, screen: 0 }, lastKeyAsk: -Infinity };
      for (const kind of VIDEO_KINDS) {
        if (ctl[kind] && !v.want[kind]) {
          v.needKey[kind] = true;
          this.forceKey(kind, true);
        }
      }
      v.want = { camera: ctl.camera, screen: ctl.screen };
      if (v.want.camera || v.want.screen) this.viewers.set(id, v);
      else this.viewers.delete(id);
      this.changed();
    } else if (ctl.t === "key") {
      const v = this.viewers.get(id);
      if (!v?.want[ctl.kind]) return;
      v.needKey[ctl.kind] = true;
      this.forceKey(ctl.kind);
    } else if (ctl.t === "unsupported") {
      if (this.refused.includes(ctl.codec)) return;
      this.refused.push(ctl.codec);
      for (const s of this.senders.values()) {
        s.configured = undefined;
        s.forceKey = true;
      }
      for (const v of this.viewers.values()) v.needKey = { camera: true, screen: true };
    }
  }

  private forceKey(kind: VideoKind, now = false): void {
    const s = this.senders.get(kind);
    if (!s) return;
    const t = performance.now();
    if (!now && t - s.lastForced < KEY_GAP_MS) return;
    s.lastForced = t;
    s.forceKey = true;
  }

  private stopSender(s: Sender): void {
    s.stop();
    if (s.encoder && s.encoder.state !== "closed") s.encoder.close();
    this.senders.delete(s.kind);
  }

  private encode(s: Sender, frame: VideoFrame): void {
    try {
      const rung = RUNGS[s.kind];
      const now = performance.now();
      // Nobody watches: nothing is encoded, and the next watcher starts from a keyframe.
      if (this.viewerCount(s.kind) === 0 || now - s.lastFrame < 1000 / rung.fps - 4) {
        if (this.viewerCount(s.kind) === 0) s.forceKey = true;
        return;
      }
      const codec = chooseCodec(this.encodable, this.refused);
      if (!codec) return;
      s.lastFrame = now;
      const [width, height] = targetSize(frame.displayWidth, frame.displayHeight, rung);
      if (!s.encoder || s.encoder.state === "closed" || !s.configured || s.configured.codec !== codec || s.configured.width !== width || s.configured.height !== height) {
        if (s.encoder && s.encoder.state !== "closed") s.encoder.close();
        const encoder = new VideoEncoder({
          output: (chunk) => this.fanOut(s, codec, chunk),
          error: (e) => {
            console.warn("[iroh video] encoder failed", e);
            s.configured = undefined;
          },
        });
        encoder.configure({
          codec: codec === "h264" ? h264Codec(width, height) : "vp8",
          width,
          height,
          bitrate: rung.kbps * 1000,
          framerate: rung.fps,
          latencyMode: "realtime",
          ...(codec === "h264" ? { avc: { format: "annexb" } } : {}),
        } as VideoEncoderConfig);
        s.encoder = encoder;
        s.configured = { codec, width, height };
        s.forceKey = true;
      }
      let input = frame;
      if (width !== frame.displayWidth || height !== frame.displayHeight) {
        if (!s.canvas || s.canvas.width !== width || s.canvas.height !== height) s.canvas = new OffscreenCanvas(width, height);
        s.canvas.getContext("2d")?.drawImage(frame, 0, 0, width, height);
        input = new VideoFrame(s.canvas, { timestamp: frame.timestamp });
      }
      const keyFrame = s.forceKey || now - s.lastKey > KEY_EVERY_MS;
      if (keyFrame) {
        s.forceKey = false;
        s.lastKey = now;
      }
      if (s.encoder.encodeQueueSize < 3) s.encoder.encode(input, { keyFrame });
      if (input !== frame) input.close();
    } finally {
      frame.close();
    }
  }

  private fanOut(s: Sender, codec: VideoCodec, chunk: EncodedVideoChunk): void {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === "key";
    const bytes = packFrameStream({ seq: s.seq++, tsUs: chunk.timestamp, key, kind: s.kind, codec }, data);
    for (const [id, v] of this.viewers) {
      if (!v.want[s.kind]) continue;
      if (v.needKey[s.kind] && !key) {
        this.forceKey(s.kind);
        continue;
      }
      if (v.inFlight[s.kind] >= MAX_IN_FLIGHT) {
        v.needKey[s.kind] = true;
        this.forceKey(s.kind);
        continue;
      }
      v.needKey[s.kind] = false;
      v.inFlight[s.kind] += 1;
      void this.links
        .sendStream(id, bytes, key ? 1 : 0, key ? STALE_KEY_MS : STALE_MS)
        .catch(() => false)
        .then((ok) => {
          v.inFlight[s.kind] -= 1;
          if (!ok) {
            v.needKey[s.kind] = true;
            this.forceKey(s.kind);
          }
        });
    }
  }
}

/**
 * Hands each frame of a camera or screen track to `onFrame`, which closes it. Through
 * `MediaStreamTrackProcessor` where the browser has one; otherwise from a hidden `<video>`
 * on a timer. Returns the stop function.
 */
function pumpFrames(track: MediaStreamTrack, fps: number, onFrame: (frame: VideoFrame) => void): () => void {
  let stopped = false;
  const Processor = (globalThis as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
  if (Processor) {
    const reader = new Processor({ track }).readable.getReader();
    void (async () => {
      while (!stopped) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done || !value) break;
        if (stopped) value.close();
        else onFrame(value);
      }
    })();
    return () => {
      stopped = true;
      void reader.cancel().catch(() => undefined);
    };
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  void video.play().catch(() => undefined);
  const timer = setInterval(() => {
    if (stopped || video.readyState < 2 || !video.videoWidth) return;
    onFrame(new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) }));
  }, 1000 / fps);
  return () => {
    stopped = true;
    clearInterval(timer);
    video.srcObject = null;
  };
}
