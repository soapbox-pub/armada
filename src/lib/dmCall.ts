/**
 * DM voice calls — the CORD-07 blind-broker path applied to a 1:1 NIP-17
 * conversation.
 *
 *   - The CALLER mints a random 32-byte call secret; both sides derive the
 *     CORD-07 sub-keys ({@link dmCallKeys}): `room` (pk = SFU room name, sk
 *     signs the broker token grant) and `mediaKey`. The broker authorizes by
 *     key possession and learns nothing about who calls whom.
 *   - The secret travels in a sealed, gift-wrapped kind-23314 rumor; the invite
 *     IS the ring signal.
 *   - Media uses ONE shared per-call E2EE key: sound for two senders with a fresh
 *     random key, and needs no in-band identity exchange (unlike Concord's
 *     per-sender keys).
 *
 * Phases (rumor content): "offer" (secret + broker hint), "answer" (also stops
 * the callee's other devices), "decline", "end"; receipts "ringing" and "busy"
 * are sent only to callers the ring gate admits (no online-status leak). All
 * ride EPHEMERAL kind-21059 wraps (see `KIND_DM_CALL` in protocol.ts), so no
 * call is stored anywhere. The rumor's real `created_at` bounds ringing
 * ({@link DM_CALL_RING_MS}).
 */

import { sha256 } from "@noble/hashes/sha2.js";

import {
  bytesToHex,
  hex32,
  random32,
  voiceGroupKey,
  voiceMediaKey,
  type GroupKey,
} from "@/concord/lib/derive";
import { canonicalOrigin } from "@/concord/lib/voice";
import { KIND_DM_CALL, type OpenedDm } from "@/lib/nip17/protocol";
import { clockNowMs } from "@/lib/relayClock";

/** How long an offer rings before it counts as missed (both sides). */
export const DM_CALL_RING_MS = 45_000;

/**
 * Fixed 32-byte id slot for the CORD-07 derivations; only namespaces them away
 * from Concord (the per-call secret makes keys unique).
 */
const DM_CALL_ID = sha256(new TextEncoder().encode("armada/dm-call"));

export interface DmCallKeys {
  /** SFU room keypair: pk is the room name, sk signs token grants. */
  room: GroupKey;
  /** Raw 32-byte shared per-call E2EE frame-key material. */
  mediaKey: Uint8Array;
}

export function dmCallKeys(secretHex: string): DmCallKeys {
  const secret = hex32(secretHex);
  return {
    room: voiceGroupKey(secret, DM_CALL_ID, 0),
    mediaKey: voiceMediaKey(secret, DM_CALL_ID, 0),
  };
}

export function mintDmCall(): { secretHex: string; callId: string } {
  const secretHex = bytesToHex(random32());
  return { secretHex, callId: dmCallKeys(secretHex).room.pk };
}

export type DmCallPhase = "offer" | "answer" | "decline" | "end" | "ringing" | "busy";

const PHASES: ReadonlySet<string> = new Set<DmCallPhase>([
  "offer",
  "answer",
  "decline",
  "end",
  "ringing",
  "busy",
]);

/**
 * How long a collision WINNER waits for the loser to answer before joining the
 * loser's call instead, counted from our offer's delivery. Covers lost offers
 * and pre-collision-handling clients; generous so a mid-way switch doesn't
 * hang up both sides.
 */
export const DM_CALL_COLLISION_FALLBACK_MS = 15_000;

/**
 * Two people dialing each other: the LOWER pubkey's call survives, computed
 * identically on both sides. The loser joins and answers the winner's room.
 */
export function dmCallCollisionWinner(self: string, peer: string): "ours" | "theirs" {
  return self < peer ? "ours" : "theirs";
}

/** A verified, parsed call signal as opened from a DM gift wrap. */
export interface DmCallSignal {
  phase: DmCallPhase;
  /** SFU room name (the call's stable id) — `dmCallKeys(secret).room.pk`. */
  callId: string;
  author: string;
  peer: string;
  /** Rumor timestamp, ms. */
  createdAtMs: number;
  rumorId: string;
  secretHex?: string;
  /** Offer only: canonicalized https broker origin. */
  broker?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Tags for a call rumor: peer `p`, `call`, and (offers) secret + broker. No
 * NIP-40 expiration: the envelope is ephemeral; freshness is `created_at`.
 */
export function dmCallTags(
  peer: string,
  callId: string,
  opts?: { secretHex?: string; broker?: string },
): string[][] {
  const tags: string[][] = [
    ["p", peer],
    ["call", callId],
  ];
  if (opts?.secretHex) tags.push(["secret", opts.secretHex]);
  if (opts?.broker) tags.push(["broker", opts.broker]);
  return tags;
}

/**
 * Parse an opened 1:1 DM rumor into a call signal, or null. An offer's secret
 * must derive its claimed call id, and it must carry a usable broker hint.
 */
export function parseDmCall(opened: OpenedDm): DmCallSignal | null {
  if (opened.kind !== KIND_DM_CALL) return null;
  if (!PHASES.has(opened.content)) return null;
  const phase = opened.content as DmCallPhase;
  if (opened.peers.length !== 1) return null;
      // Received: the author is the counterpart; own copy: the `p` tag names them.
  const peer = opened.peers[0];
  if (!HEX64.test(peer)) return null;
  const tag = (name: string) => opened.tags.find((t) => t[0] === name)?.[1];
  const callId = tag("call");
  if (typeof callId !== "string" || !HEX64.test(callId)) return null;

  let secretHex: string | undefined;
  let broker: string | undefined;
  if (phase === "offer") {
    const rawSecret = tag("secret");
    if (typeof rawSecret !== "string" || !HEX64.test(rawSecret)) return null;
    try {
      if (dmCallKeys(rawSecret).room.pk !== callId) return null;
    } catch {
      return null;
    }
    secretHex = rawSecret;
    const rawBroker = tag("broker");
    broker = typeof rawBroker === "string" && rawBroker.length <= 512
      ? canonicalOrigin(rawBroker) ?? undefined
      : undefined;
    if (!broker) return null;
  }

  return {
    phase,
    callId,
    author: opened.author,
    peer,
    createdAtMs: opened.createdAt * 1000,
    rumorId: opened.rumorId,
    secretHex,
    broker,
  };
}

/** Whether an offer is still inside its ring window (with future-skew guard). */
export function isDmOfferFresh(signal: DmCallSignal, nowMs = clockNowMs()): boolean {
  if (signal.phase !== "offer") return false;
  if (signal.createdAtMs > nowMs + 60_000) return false;
  return nowMs - signal.createdAtMs <= DM_CALL_RING_MS;
}

// Signal bus: call rumors are never stored, so DM ingest paths (useDm17.ts)
// hand them here and DmCallProvider reacts.

type DmCallListener = (signal: DmCallSignal) => void;

const listeners = new Set<DmCallListener>();
/** Rumor ids already dispatched (several ingest paths can open one wrap). */
const seenRumorIds = new Set<string>();

export function subscribeDmCallSignals(listener: DmCallListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Dispatch opened call rumors to listeners (deduped by rumor id). */
export function deliverDmCallRumors(rumors: readonly OpenedDm[]): void {
  for (const rumor of rumors) {
    if (seenRumorIds.has(rumor.rumorId)) continue;
    seenRumorIds.add(rumor.rumorId);
    // Bound the dedup memory (insertion order = oldest first).
    if (seenRumorIds.size > 512) {
      let drop = seenRumorIds.size - 256;
      for (const id of seenRumorIds) {
        if (drop-- <= 0) break;
        seenRumorIds.delete(id);
      }
    }
    const signal = parseDmCall(rumor);
    if (!signal) continue;
    for (const listener of [...listeners]) listener(signal);
  }
}

/** Test seam: forget listeners and the dedup memory. */
export function _resetDmCallBusForTests(): void {
  listeners.clear();
  seenRumorIds.clear();
}
