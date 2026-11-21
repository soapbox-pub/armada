/**
 * A voice Channel's peer-to-peer links, kept to what presence says (Vector
 * `calls/voice.rs` `dialer`/`acceptor`): dial the targets it is our turn to dial,
 * keep an inbound connection only once a fresh presence binds its endpoint to a
 * member we link to, and drop a link whose member left, lost Connect or joined
 * the SFU beside us. The QUIC handshake proves the endpoint; the presence, signed
 * and sealed under the Channel key, says whose it is.
 */
import { acceptsInbound, type P2pTarget } from "@/concord/lib/irohVoice";
import type { IrohAddress } from "@/concord/lib/voice";
import type { VoiceNodeBinder, VoiceTransport } from "@/lib/realtimeTransport";

const DIAL_EVERY_MS = 3_000;
/** How long an inbound link waits for the presence naming it: theirs can still be crossing the relays. */
export const PRESENCE_GRACE_MS = 15_000;

/** The slice of the audio engine the links drive. */
export interface LinkAudio {
  addPeer(id: string): void;
  removePeer(id: string): void;
  receive(id: string, datagram: Uint8Array): void;
  setPeerGain(id: string, audible: boolean, volume: number): void;
  close(): Promise<void>;
}

interface Link {
  /** The member it carries; undefined while an inbound link waits for its presence. */
  author?: string;
  since: number;
}

export interface LinkedPeer {
  author: string;
  endpoint: string;
}

export class IrohVoiceCall {
  private node!: VoiceTransport;
  private readonly links = new Map<string, Link>();
  private readonly dialing = new Set<string>();
  private targets: P2pTarget[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();
  private snapshot: LinkedPeer[] = [];
  private gain: (author: string) => { audible: boolean; volume: number } = () => ({ audible: true, volume: 1 });
  private streamSink?: (id: string, bytes: Uint8Array | undefined) => void;
  private linkSink?: (id: string, up: boolean) => void;
  private closed = false;

  private constructor(private readonly audio: LinkAudio, private readonly now: () => number) {}

  /** Bind a fresh endpoint for this call and start keeping its links. */
  static async start(
    bind: VoiceNodeBinder,
    relays: string[],
    audio: (send: (datagram: Uint8Array) => void) => LinkAudio,
    now: () => number = Date.now,
  ): Promise<IrohVoiceCall> {
    const ref: { call?: IrohVoiceCall } = {};
    const engine = audio((datagram) => ref.call?.broadcast(datagram));
    const c = (ref.call = new IrohVoiceCall(engine, now));
    try {
      c.node = await bind(
        relays,
        (id, inbound) => c.onLink(id, inbound),
        (id, bytes) => c.onDatagram(id, bytes),
        (id) => c.onClosed(id),
        (id, bytes) => c.onStream(id, bytes),
      );
    } catch (e) {
      await engine.close();
      throw e;
    }
    c.timer = setInterval(() => c.reconcile(), DIAL_EVERY_MS);
    return c;
  }

  /** What our presence names: our endpoint, and the relay we're reached through. */
  address(): IrohAddress {
    const relay = this.node.relayUrl();
    return { endpoint: this.node.endpointHex(), ...(relay ? { relay } : {}) };
  }

  /** Who to be linked to now (`p2pTargets`). */
  setTargets(targets: P2pTarget[]): void {
    this.targets = targets;
    this.reconcile();
  }

  /** Where each adopted peer's streams go (the video engine), and who hears of links coming and going. */
  setStreamSink(sink: (id: string, bytes: Uint8Array | undefined) => void, links: (id: string, up: boolean) => void): void {
    this.streamSink = sink;
    this.linkSink = links;
  }

  /** One whole stream to an adopted peer; false for anyone else, or a stream that didn't land. */
  sendStream(id: string, bytes: Uint8Array, priority: number, staleMs: number): Promise<boolean> {
    if (this.closed || !this.links.get(id)?.author) return Promise.resolve(false);
    return this.node.sendStream(id, bytes, priority, staleMs);
  }

  /** Whether each member is heard, and how loud, judged again on every change. */
  setGain(gain: (author: string) => { audible: boolean; volume: number }): void {
    this.gain = gain;
    for (const [id, link] of this.links) if (link.author) this.applyGain(id, link.author);
  }

  /** The members linked now, a stable array between changes. */
  linked(): LinkedPeer[] {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.links.clear();
    this.changed();
    await this.audio.close();
    await this.node.close();
  }

  private reconcile(): void {
    if (this.closed) return;
    const byEndpoint = new Map(this.targets.map((t) => [t.endpoint, t]));
    const mine = this.node.endpointHex();
    const now = this.now();
    for (const [id, link] of [...this.links]) {
      if (link.author) {
        if (byEndpoint.get(id)?.author !== link.author) this.node.unlink(id, "not in this call");
        continue;
      }
      // An inbound link still waiting for its presence.
      const target = acceptsInbound(this.targets, id, mine);
      if (target) this.adopt(id, target.author);
      else if (now - link.since >= PRESENCE_GRACE_MS) this.node.unlink(id, "not in this call");
    }
    for (const t of this.targets) {
      if (!t.dial || !t.relay || this.links.has(t.endpoint) || this.dialing.has(t.endpoint)) continue;
      this.dialing.add(t.endpoint);
      this.node
        .dial(t.endpoint, t.relay)
        .catch((e) => console.debug("[iroh voice] dial failed", e))
        .finally(() => this.dialing.delete(t.endpoint));
    }
  }

  private onLink(id: string, inbound: boolean): void {
    if (this.closed) return;
    this.links.set(id, { since: this.now() });
    const target = inbound ? acceptsInbound(this.targets, id, this.node.endpointHex()) : this.targets.find((t) => t.endpoint === id && t.dial);
    if (target) this.adopt(id, target.author);
    else if (!inbound) this.node.unlink(id, "not in this call");
  }

  private adopt(id: string, author: string): void {
    this.links.set(id, { author, since: this.now() });
    this.audio.addPeer(id);
    this.applyGain(id, author);
    this.linkSink?.(id, true);
    this.changed();
  }

  private applyGain(id: string, author: string): void {
    const { audible, volume } = this.gain(author);
    this.audio.setPeerGain(id, audible, volume);
  }

  private onStream(id: string, bytes: Uint8Array | undefined): void {
    if (this.links.get(id)?.author) this.streamSink?.(id, bytes);
  }

  private onDatagram(id: string, bytes: Uint8Array): void {
    if (this.links.get(id)?.author) this.audio.receive(id, bytes);
  }

  private onClosed(id: string): void {
    const link = this.links.get(id);
    this.links.delete(id);
    this.audio.removePeer(id);
    if (link?.author) {
      this.linkSink?.(id, false);
      this.changed();
    }
  }

  private broadcast(datagram: Uint8Array): void {
    if (this.closed) return;
    for (const [id, link] of this.links) if (link.author) this.node.send(id, datagram);
  }

  private changed(): void {
    this.snapshot = [...this.links].flatMap(([endpoint, l]) => (l.author ? [{ author: l.author, endpoint }] : []));
    for (const l of this.listeners) l();
  }
}
