/**
 * The audio of a voice Channel's peer-to-peer links: one microphone encoded once
 * and sent to every peer, every peer's frames decoded and mixed for playout.
 * Opus goes through WebCodecs, as the call recorder's does, 48 kHz mono in 20 ms
 * frames — what Vector's engines send and expect (`vector-calls`, `FRAME_MS`).
 *
 * The microphone is the call's own track (LiveKit's, with its RNNoise processor
 * and capture constraints), so a peer hears what the SFU does.
 */
import tapUrl from "@/lib/callRecording/tap.worklet.ts?worker&url";
import { FLAG_MUTED, FLAG_SHARE, packFrame, unpackFrame } from "@/concord/lib/irohVoice";

export const RATE = 48_000;
export const FRAME = 960;
/** What a voice call's microphone sends, as Vector's (`VOICE_KBPS`). */
const BITRATE = 32_000;
/** How far ahead of now the first frame after a gap is scheduled: room for jitter. */
export const TARGET_DELAY_S = 0.08;
/** A peer queued further ahead than this has a backlog; it's dropped back to the target. */
export const MAX_DELAY_S = 0.4;

/** Whether this runtime can carry a peer-to-peer call's audio. */
export function irohAudioSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof AudioDecoder !== "undefined"
  );
}

/**
 * Where a peer's next frame plays: right after the last one, or the target delay
 * from now after a gap or a backlog. Sequences only move forward, so a datagram
 * overtaken in flight is dropped rather than played out of order.
 */
export class Playhead {
  private at = 0;
  private lastSeq: number | undefined;

  /** Whether `seq` is new (forward of the last one heard, modulo 2^16). */
  accept(seq: number): boolean {
    if (this.lastSeq === undefined) {
      this.lastSeq = seq;
      return true;
    }
    const ahead = (seq - this.lastSeq + 0x10000) & 0xffff;
    if (ahead === 0 || ahead >= 0x8000) return false;
    this.lastSeq = seq;
    return true;
  }

  /** When a frame of `duration` seconds arriving at `now` starts. */
  place(now: number, duration: number): number {
    if (this.at < now || this.at > now + MAX_DELAY_S) this.at = now + TARGET_DELAY_S;
    const start = this.at;
    this.at += duration;
    return start;
  }
}

interface Peer {
  decoder: AudioDecoder;
  gain: GainNode;
  playhead: Playhead;
  audible: boolean;
  volume: number;
  level: number;
  levelAt: number;
}

/** What the engine sends each encoded or silent frame through. */
export type SendDatagram = (datagram: Uint8Array) => void;

export class IrohVoiceAudio {
  private readonly ctx: AudioContext;
  private readonly mix: GainNode;
  private readonly out: MediaStreamAudioDestinationNode;
  private readonly element: HTMLAudioElement;
  private readonly peers = new Map<string, Peer>();
  private tap: AudioWorkletNode | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private track: MediaStreamTrack | undefined;
  private encoder: AudioEncoder | undefined;
  private ready: Promise<void>;
  private seq = 0;
  private readonly started = performance.now();
  private muted = false;
  private deafened = false;
  private closed = false;

  constructor(private readonly send: SendDatagram) {
    this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    this.mix = new GainNode(this.ctx);
    // Played through a media element, which can pick the speaker on more browsers than
    // AudioContext.setSinkId, and which the platform treats as call audio.
    this.out = new MediaStreamAudioDestinationNode(this.ctx, { channelCount: 1 });
    this.mix.connect(this.out);
    this.element = new Audio();
    this.element.autoplay = true;
    this.element.srcObject = this.out.stream;
    this.ready = this.ctx.audioWorklet.addModule(tapUrl);
    void this.ctx.resume().catch(() => undefined);
  }

  /** Play through the chosen speaker, where the browser lets a page choose. */
  async setSpeaker(deviceId: string | undefined): Promise<void> {
    const el = this.element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (deviceId && el.setSinkId) await el.setSinkId(deviceId).catch(() => undefined);
  }

  /** The microphone to send, or none. Rebinds on a new track (a device switch, RNNoise toggled). */
  async setTrack(track: MediaStreamTrack | undefined): Promise<void> {
    if (track === this.track) return;
    this.track = track;
    this.source?.disconnect();
    this.source = undefined;
    if (!track || this.closed) return;
    await this.ready;
    if (this.closed || this.track !== track) return;
    if (!this.tap) this.tap = this.makeTap();
    this.source = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: new MediaStream([track]) });
    this.source.connect(this.tap);
  }

  /** Our own mute: silent frames go out instead, which keep each peer's sequence moving. */
  setMuted(on: boolean): void {
    this.muted = on;
  }

  /** Deafened hears nothing, and is muted too. */
  setDeafened(on: boolean): void {
    this.deafened = on;
    this.mix.gain.value = on ? 0 : 1;
  }

  addPeer(id: string): void {
    if (this.peers.has(id) || this.closed) return;
    const gain = new GainNode(this.ctx);
    gain.connect(this.mix);
    const peer: Peer = { gain, playhead: new Playhead(), audible: true, volume: 1, level: 0, levelAt: 0, decoder: undefined as unknown as AudioDecoder };
    peer.decoder = new AudioDecoder({
      output: (data) => this.play(peer, data),
      error: (e) => console.warn("[iroh voice] decoder failed", e),
    });
    peer.decoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1 });
    this.peers.set(id, peer);
  }

  removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.decoder.state !== "closed") peer.decoder.close();
    peer.gain.disconnect();
  }

  /** Whether a peer plays at all (SPEAK, a Timeout, a moderator's mute), and how loud. */
  setPeerGain(id: string, audible: boolean, volume: number): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.audible = audible;
    peer.volume = volume;
    peer.gain.gain.value = audible ? volume : 0;
  }

  /** How loud a peer was lately, 0 to 1, for the speaking ring. */
  levelOf(id: string): number {
    const peer = this.peers.get(id);
    return peer && performance.now() - peer.levelAt < 250 ? peer.level : 0;
  }

  receive(id: string, datagram: Uint8Array): void {
    const peer = this.peers.get(id);
    const frame = unpackFrame(datagram);
    if (!peer || !frame || frame.flags & FLAG_SHARE) return;
    if (!peer.playhead.accept(frame.seq)) return;
    if (frame.flags & FLAG_MUTED || frame.payload.length === 0) {
      peer.level = 0;
      return;
    }
    if (peer.decoder.state !== "configured") return;
    try {
      peer.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: frame.tsMs * 1000, data: frame.payload }));
    } catch (e) {
      console.warn("[iroh voice] undecodable frame", e);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.source?.disconnect();
    this.tap?.port.postMessage({ flush: true });
    this.tap?.disconnect();
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    this.element.srcObject = null;
    await this.ctx.close().catch(() => undefined);
  }

  private play(peer: Peer, data: AudioData): void {
    try {
      if (this.closed) return;
      const frames = data.numberOfFrames;
      const pcm = new Float32Array(frames);
      data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
      let peak = 0;
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(pcm[i]));
      peer.level = peak;
      peer.levelAt = performance.now();
      const buffer = new AudioBuffer({ length: frames, numberOfChannels: 1, sampleRate: data.sampleRate });
      buffer.copyToChannel(pcm, 0);
      const node = new AudioBufferSourceNode(this.ctx, { buffer });
      node.connect(peer.gain);
      node.start(peer.playhead.place(this.ctx.currentTime, frames / data.sampleRate));
    } finally {
      data.close();
    }
  }

  private makeTap(): AudioWorkletNode {
    const tap = new AudioWorkletNode(this.ctx, "armada-record-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { batch: FRAME },
    });
    // A worklet runs only while it reaches the destination; this path carries silence.
    const sink = new GainNode(this.ctx, { gain: 0 });
    tap.connect(sink).connect(this.ctx.destination);
    const channel = new MessageChannel();
    channel.port2.onmessage = (event: MessageEvent<{ d?: Float32Array<ArrayBuffer> }>) => {
      if (event.data.d) this.captured(event.data.d);
    };
    tap.port.postMessage({ port: channel.port1 }, [channel.port1]);
    return tap;
  }

  private captured(pcm: Float32Array<ArrayBuffer>): void {
    if (this.closed || pcm.length !== FRAME) return;
    if (this.muted || this.deafened) {
      this.send(packFrame(this.seq++, this.elapsed(), FLAG_MUTED, new Uint8Array()));
      return;
    }
    const encoder = this.encoder ?? this.makeEncoder();
    if (encoder.state !== "configured") return;
    const data = new AudioData({ format: "f32-planar", sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: this.elapsed() * 1000, data: pcm });
    try {
      encoder.encode(data);
    } finally {
      data.close();
    }
  }

  private makeEncoder(): AudioEncoder {
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        this.send(packFrame(this.seq++, this.elapsed(), 0, payload));
      },
      error: (e) => {
        console.warn("[iroh voice] encoder failed", e);
        this.encoder = undefined;
      },
    });
    encoder.configure({
      codec: "opus",
      sampleRate: RATE,
      numberOfChannels: 1,
      bitrate: BITRATE,
      opus: { frameDuration: 20_000, application: "voip", useinbandfec: true },
    } as AudioEncoderConfig);
    this.encoder = encoder;
    return encoder;
  }

  private elapsed(): number {
    return Math.floor(performance.now() - this.started);
  }
}
