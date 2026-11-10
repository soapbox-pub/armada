/**
 * Webxdc realtime wire contracts (DM and Concord), interop with Vector
 * (`crates/vector-core/src/webxdc.rs`, `src-tauri/src/miniapps/realtime.rs`).
 * Every constant must match exactly: a near-match silently puts clients in
 * different gossip rooms.
 */

import { sha256 } from "@noble/hashes/sha2.js";

import { clockNowMs } from "@/lib/relayClock";

/** RFC 4648 base32, no padding — the alphabet Vector encodes topic ids with. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A topic id is 32 bytes, so its base32 form is always this long. */
export const TOPIC_ID_CHARS = 52;

/** `seq[4 LE] || sender_pubkey[32]` appended to every realtime frame. */
export const TRAILER_LEN = 36;

/** Vector's cap on a peer-advertised address; anything longer is not an address. */
export const MAX_NODE_ADDR_CHARS = 2048;

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buf >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 0x1f];
  return out;
}

export function base32Decode(encoded: string): Uint8Array | undefined {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of encoded) {
    const v = B32.indexOf(ch.toUpperCase());
    if (v < 0) return undefined;
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Vector's receive-side check: exactly 52 uppercase base32 chars (others are silently dropped). */
export function isTopicId(value: string | undefined | null): value is string {
  if (!value || value.length !== TOPIC_ID_CHARS) return false;
  for (const c of value) {
    if (!((c >= "A" && c <= "Z") || (c >= "2" && c <= "7"))) return false;
  }
  return true;
}

/**
 * Mint the topic for an outbound `.xdc`, once, carried on the file event
 * (derived topics are asymmetric in DMs). Only the output shape is a contract;
 * random salt avoids Vector's same-tick collision issue.
 */
export function mintTopicId(fileHash: string, senderHex: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const head = enc.encode(`webxdc-realtime-v1:${fileHash}:${senderHex}:`);
  const buf = new Uint8Array(head.length + salt.length);
  buf.set(head, 0);
  buf.set(salt, head.length);
  return base32Encode(sha256(buf));
}

/**
 * Fallback for file events without a topic tag; byte-identical to Vector's
 * `derive_topic_id`. The first input is the manifest NAME (what Vector's call sites pass).
 */
export function deriveTopicId(app: string, chatId: string, messageId: string): string {
  return base32Encode(sha256(new TextEncoder().encode(`webxdc-realtime-v1:${app}:${chatId}:${messageId}`)));
}

/**
 * Topic for a Mini App shared as a bare URL; byte-identical to Vector's
 * `derive_url_topic_id`. Keyed on the message id so every recipient derives
 * the same session; the URL is truncated at `.xdc` as Vector's regex does.
 */
export function deriveUrlTopicId(url: string, messageId: string): string {
  url = urlTopicSource(url);
  return base32Encode(sha256(new TextEncoder().encode(`webxdc-url-realtime-v1:${url}:${messageId}`)));
}

/** The `.xdc` link up to and including the extension — exactly what Vector's regex matches. */
export function urlTopicSource(url: string): string {
  const lower = url.toLowerCase();
  // Vector's greedy match runs to the LAST `.xdc` followed by a delimiter
  // (e.g. `https://cdn.xdc.io/game.xdc`).
  for (let at = lower.lastIndexOf(".xdc"); at > 0; at = lower.lastIndexOf(".xdc", at - 1)) {
    const next = url[at + 4];
    if (next === undefined || next === "?" || next === "#" || /\s/.test(next)) {
      return url.slice(0, at + 4);
    }
  }
  return url;
}

/** Append Vector's trailer: the payload, then `seq[4 LE] || sender[32]`. */
export function frame(payload: Uint8Array, seq: number, senderKey: Uint8Array): Uint8Array {
  if (senderKey.length !== 32) throw new Error("sender key must be 32 bytes");
  const out = new Uint8Array(payload.length + TRAILER_LEN);
  out.set(payload, 0);
  new DataView(out.buffer).setUint32(payload.length, seq >>> 0, true);
  out.set(senderKey, payload.length + 4);
  return out;
}

export interface Unframed {
  payload: Uint8Array;
  seq: number;
  /** The 32-byte sender key the frame claims, lowercase hex. */
  sender: string;
}

/** Strip the trailer; frames shorter than it are dropped, as Vector does. */
export function unframe(content: Uint8Array): Unframed | undefined {
  if (content.length < TRAILER_LEN) return undefined;
  const cut = content.length - TRAILER_LEN;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let sender = "";
  for (let i = cut + 4; i < content.length; i++) sender += content[i].toString(16).padStart(2, "0");
  return { payload: content.slice(0, cut), seq: view.getUint32(cut, true), sender };
}

/** A peer signal as it rides a Concord channel (kind 3310, sealed). */
export type PeerSignal =
  | { op: "ad"; topic: string; addr: string }
  | { op: "left"; topic: string };

/** Vector's `peer_signal_content`: the JSON body of a Concord peer signal. */
export function peerSignalContent(topic: string, nodeAddr?: string): string {
  return nodeAddr === undefined
    ? JSON.stringify({ op: "left", topic })
    : JSON.stringify({ op: "ad", topic, addr: nodeAddr });
}

/** Parse an untrusted 3310 peer signal; malformed bodies return undefined. */
export function parsePeerSignal(content: string): PeerSignal | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.topic !== "string" || !isTopicId(o.topic)) return undefined;
  if (o.op === "left") return { op: "left", topic: o.topic };
  if (o.op === "ad" && typeof o.addr === "string" && o.addr.length > 0) {
    // Bounded as Vector does; any member can publish these.
    if (o.addr.length > MAX_NODE_ADDR_CHARS) return undefined;
    return { op: "ad", topic: o.topic, addr: o.addr };
  }
  return undefined;
}

/** A peer we have seen advertise on a realtime topic. */
export interface RealtimePeer {
  /** The advertiser's pubkey, hex. */
  pubkey: string;
  /** Their iroh endpoint address, opaque to us and passed to the transport. */
  addr: string;
  /** When they last advertised, ms. */
  ms: number;
}

/** One peer signal as it came off a channel, before it is folded. */
export interface PeerSignalEvent {
  author: string;
  content: string;
  ms: number;
}

/**
 * Fold a channel's durable peer signals into who's playing `topic`: latest
 * signal per author by `ms` (not arrival), and a newer `left` removes them.
 */
export function foldPeerSignals(
  events: readonly PeerSignalEvent[],
  topic: string,
  /** Our own pubkey, so we never dial ourselves. */
  selfPubkey?: string,
): RealtimePeer[] {
  // Refuse future-dated signals (a forged far-future ad would outrank its
  // author's departures). Vector clamps at ingest, but a live fold would
  // re-clamp forever. An hour, not Vector's 5 min, tolerates skewed clocks.
  const ceiling = clockNowMs() + 60 * 60_000;
  const latest = new Map<string, { signal: PeerSignal; ms: number }>();
  for (const ev of events) {
    if (ev.ms > ceiling) continue;
    const signal = parsePeerSignal(ev.content);
    if (!signal || signal.topic !== topic) continue;
    if (selfPubkey && ev.author === selfPubkey) continue;
    const prev = latest.get(ev.author);
    // Ties go to the departure.
    if (prev && (prev.ms > ev.ms || (prev.ms === ev.ms && signal.op === "ad"))) continue;
    latest.set(ev.author, { signal, ms: ev.ms });
  }
  const out: RealtimePeer[] = [];
  for (const [pubkey, { signal, ms }] of latest) {
    if (signal.op === "ad") out.push({ pubkey, addr: signal.addr, ms });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/** Vector's DM peer-signal rumor kind (NIP-78 application-specific data). */
export const KIND_DM_PEER_SIGNAL = 30078;

/** The `d` tag Vector scopes its DM peer signals under. */
export const DM_PEER_SIGNAL_D = "vector-webxdc-peer";

/**
 * Tags of a DM peer signal as Vector builds them. Unused until Armada has a DM
 * Mini App surface; kept as a tested contract.
 */
export function dmPeerSignalTags(topic: string, nodeAddr?: string): string[][] {
  const tags = [
    ["d", DM_PEER_SIGNAL_D],
    ["webxdc-topic", topic],
  ];
  if (nodeAddr !== undefined) tags.push(["webxdc-node-addr", nodeAddr]);
  return tags;
}

/** The content of a DM peer signal: the operation is the body, not a field. */
export function dmPeerSignalContent(nodeAddr?: string): string {
  return nodeAddr === undefined ? "peer-left" : "peer-advertisement";
}

/** Read a DM peer signal; ads need both tags, as in Vector. */
export function parseDmPeerSignal(content: string, tags: string[][]): PeerSignal | undefined {
  const get = (name: string) => tags.find(([n]) => n === name)?.[1];
  const topic = get("webxdc-topic");
  if (!topic || !isTopicId(topic)) return undefined;
  if (content === "peer-left") return { op: "left", topic };
  if (content === "peer-advertisement") {
    const addr = get("webxdc-node-addr");
    if (addr) return { op: "ad", topic, addr };
  }
  return undefined;
}

/**
 * Node address on the wire: base32 of the JSON (Vector's `encode_node_addr`).
 * Paired with {@link decodeNodeAddr} so the directions can't drift.
 */
export function encodeNodeAddr(addrJson: string): string {
  return base32Encode(new TextEncoder().encode(addrJson));
}

/** Undo {@link encodeNodeAddr}; undefined if it is not base32 of valid JSON. */
export function decodeNodeAddr(encoded: string): string | undefined {
  const bytes = base32Decode(encoded);
  if (!bytes) return undefined;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(json);
    return json;
  } catch {
    return undefined;
  }
}
