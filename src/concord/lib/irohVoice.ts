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
import type { IrohAddress, VoicePresenceFold } from "@/concord/lib/voice";
import type { CommunityMetadata } from "@/concord/lib/types";

/** Vector's datagram header (`vector-calls` `wire.rs`): seq u16, sender ms u32, flags u16, big-endian. */
export const HEADER_LEN = 8;
/** A muted or silent frame: no payload, but it keeps the receiver's sequence moving. */
export const FLAG_MUTED = 1;
/** Shared screen audio, which this client doesn't play. */
export const FLAG_SHARE = 2;
/** Others in a call besides us: a full mesh carries voice to about fifteen (CORD-07 §8). */
export const MAX_PEERS = 14;
/** Vector's `MAX_VOICE_RELAYS`. */
const MAX_VOICE_RELAYS = 8;

/** iroh's default relays (`iroh::defaults::prod`), which any presence may name. */
export const DEFAULT_IROH_RELAY_HOSTS: readonly string[] = [
  "use1-1.relay.n0.iroh.link",
  "usw1-1.relay.n0.iroh.link",
  "euc1-1.relay.n0.iroh.link",
  "aps1-1.relay.n0.iroh.link",
];

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
    .filter((u): u is string => typeof u === "string" && u.startsWith("https://") && u.length <= 256)
    .slice(0, MAX_VOICE_RELAYS);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/\.$/, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A relay a peer may be dialled through: iroh's defaults, or one the Community lists
 * (Vector `allowed_relay`). Anything else would let a member point us at a host of
 * their choosing.
 */
export function allowedRelay(url: string, communityRelays: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return DEFAULT_IROH_RELAY_HOSTS.includes(host) || communityRelays.some((r) => hostOf(r) === host);
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
  communityRelays: readonly string[];
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
    const relay = c.iroh.relay;
    out.push({
      author: c.author,
      endpoint: c.iroh.endpoint,
      ...(relay ? { relay } : {}),
      dial: dials(mine, c.iroh.endpoint) && relay !== undefined && allowedRelay(relay, topo.communityRelays),
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
