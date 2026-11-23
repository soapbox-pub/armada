/**
 * A voice Channel's peer-to-peer half (CORD-07 §8), as Vector's `calls/voice.rs`
 * runs it: which members to link to over iroh, who dials, and the datagram each
 * audio frame rides in. The transport is `crates/webxdc-rt` (`VoiceNode`); the
 * audio engine is `src/lib/irohVoice/`.
 *
 * Armada is on the LiveKit call whenever it can be, so a link is opened only to
 * a member the SFU doesn't carry to us: a pair links when either side is off the
 * SFU, and never when both are on it.
 */
import { canonicalOrigin, type IrohAddress, type VoicePresenceFold } from "@/concord/lib/voice";
import type { CommunityMetadata } from "@/concord/lib/types";
import { CONCORD_IROH_RELAYS } from "@/lib/platform";
import { irohDefaultRelays } from "@/lib/realtimeTransport";

/** Vector's datagram header (`vector-calls` `wire.rs`): seq u16, sender ms u32, flags u16, big-endian. */
export const HEADER_LEN = 8;
/** A muted or silent frame: no payload, but it keeps the receiver's sequence moving. */
export const FLAG_MUTED = 1;
/** Shared screen audio, which this client doesn't play. */
export const FLAG_SHARE = 2;
/** Others in a call besides us: a full mesh carries voice to about fifteen (CORD-07 §8). */
export const MAX_PEERS = 14;
/** Vector's `MAX_VOICE_RELAYS` (CORD-02 §6). */
export const MAX_VOICE_RELAYS = 8;
const MAX_VOICE_RELAY_LEN = 256;

export interface Frame {
  seq: number;
  tsMs: number;
  flags: number;
  payload: Uint8Array;
}

export function packFrame(seq: number, tsMs: number, flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, seq & 0xffff);
  view.setUint32(2, tsMs >>> 0);
  view.setUint16(6, flags & 0xffff);
  out.set(payload, HEADER_LEN);
  return out;
}

export function unpackFrame(data: Uint8Array): Frame | null {
  if (data.length < HEADER_LEN) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { seq: view.getUint16(0), tsMs: view.getUint32(2), flags: view.getUint16(6), payload: data.subarray(HEADER_LEN) };
}

/** The lower EndpointId dials, so a pair never opens two connections (Vector `dials`). */
export function dials(me: string, them: string): boolean {
  return me.toLowerCase() < them.toLowerCase();
}

/** The Community's own iroh relays (Vector `voice_relays`): https URLs in metadata `voice_relays`. */
export function communityVoiceRelays(metadata: CommunityMetadata | undefined): string[] {
  const raw = metadata?.voice_relays;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u): u is string => typeof u === "string" && u.startsWith("https://") && u.length <= MAX_VOICE_RELAY_LEN)
    .slice(0, MAX_VOICE_RELAYS);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/\.$/, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** A typed relay address in the form `voice_relays` stores: an https origin, bare host accepted. */
export function voiceRelayUrl(input: string): string | null {
  const raw = input.trim();
  const origin = canonicalOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  return origin && origin.length <= MAX_VOICE_RELAY_LEN ? origin : null;
}

/** Whether an iroh relay answers its probe (`iroh-relay`'s `/ping`, served with CORS `*`). */
export async function probeVoiceRelay(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(new URL("/ping", url), {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * This deployment's iroh relays: `CONCORD_IROH_RELAYS`, else the shipped iroh release's.
 * Undefined in a build without iroh, where no peer-to-peer call can run at all.
 */
export async function deploymentIrohRelays(): Promise<string[] | undefined> {
  const shipped = await irohDefaultRelays();
  if (!shipped) return undefined;
  return CONCORD_IROH_RELAYS ?? shipped;
}

/** Where a call's endpoint homes, and which relays it dials peers through (CORD-07 §8). */
export interface IrohRelayPlan {
  home: string[];
  trusted: string[];
}

/**
 * As a Community's AV brokers replace members' own (CORD-07 §5), its `voice_relays` are
 * where its calls home when it lists any. `defaults` are this deployment's: the shipped
 * iroh release's unless `CONCORD_IROH_RELAYS` replaces them. Both stay dialable, since a
 * member on another client may still home on iroh's defaults.
 */
export function irohRelayPlan(community: readonly string[], defaults: readonly string[]): IrohRelayPlan {
  return { home: [...(community.length > 0 ? community : defaults)], trusted: [...defaults, ...community] };
}

/**
 * A relay a peer may be dialled through: one of `trusted` by host (Vector `allowed_relay`).
 * Anything else would let a member point us at a host of their choosing.
 */
export function allowedRelay(url: string, trusted: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return trusted.some((r) => hostOf(r) === host);
}

/** A member this client keeps a peer-to-peer link with. */
export interface P2pTarget extends IrohAddress {
  author: string;
  /** Ours to dial: our endpoint is the lower, and their relay is one we may use. */
  dial: boolean;
}

export interface P2pTopology {
  /** Whether this client is on the LiveKit call. */
  onSfu: boolean;
  /** Our own endpoint, hex. */
  endpoint: string;
  /** The relays we dial through (`irohRelayPlan`). */
  trustedRelays: readonly string[];
  /** Whether a member may be in this Channel's call at all (CONNECT, CORD-07 §7). */
  mayConnect?: (author: string) => boolean;
}

/**
 * Who to link to now. A member on the SFU as well as iroh is linked only while we
 * are off it; one on iroh alone always is, until their SFU presence arrives. An
 * endpoint two members claim is no one's (Vector `present`), and while someone
 * bridges iroh into the SFU we leave the iroh side to them, or each voice would
 * reach the other side twice.
 */
export function p2pTargets(fold: VoicePresenceFold, me: string, topo: P2pTopology): P2pTarget[] {
  const bridged = fold.present.some((p) => p.bridge === "iroh" && p.author !== me);
  if (topo.onSfu && bridged) return [];
  const candidates: { author: string; iroh: IrohAddress; onSfu: boolean }[] = [];
  for (const p of fold.otherTransport) if (p.transport === "iroh" && p.iroh) candidates.push({ author: p.author, iroh: p.iroh, onSfu: false });
  for (const p of fold.present) if (p.alsoOn === "iroh" && p.iroh) candidates.push({ author: p.author, iroh: p.iroh, onSfu: true });
  const claims = new Map<string, number>();
  for (const c of candidates) claims.set(c.iroh.endpoint, (claims.get(c.iroh.endpoint) ?? 0) + 1);
  const mine = topo.endpoint.toLowerCase();
  const out: P2pTarget[] = [];
  for (const c of candidates) {
    if (c.author === me || c.iroh.endpoint === mine || claims.get(c.iroh.endpoint) !== 1) continue;
    if (topo.onSfu && c.onSfu) continue;
    if (topo.mayConnect && !topo.mayConnect(c.author)) continue;
    const relay = c.iroh.relay;
    out.push({
      author: c.author,
      endpoint: c.iroh.endpoint,
      ...(relay ? { relay } : {}),
      dial: dials(mine, c.iroh.endpoint) && relay !== undefined && allowedRelay(relay, topo.trustedRelays),
    });
    if (out.length >= MAX_PEERS) break;
  }
  return out;
}

/**
 * Whether to keep a connection that dialled us: only from a member we link to, and
 * only from the side whose turn it is to dial (Vector `acceptor`).
 */
export function acceptsInbound(targets: readonly P2pTarget[], remote: string, myEndpoint: string): P2pTarget | undefined {
  if (!dials(remote, myEndpoint)) return undefined;
  return targets.find((t) => t.endpoint === remote.toLowerCase());
}
