/**
 * Event verification that pays the Schnorr check ONCE per event id (relays
 * serve many duplicate copies). Sound because an id is the content's sha256:
 *  - The id is ALWAYS recomputed from the copy in hand first; that binds this
 *    copy to the memoized verdict.
 *  - Then the Schnorr verify may be skipped. A duplicate with a mangled sig is
 *    accepted deliberately — the content is authentic and stores strip `sig`.
 *  - FAILED verifies are never memoized, so forgeries can't poison an id.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getEventHash, validateEvent } from "nostr-tools/pure";

import { IdLog, type IdLogKV } from "@/lib/db/idLog";
import { perfCount } from "@/lib/perf";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The memo keys on the first 128 bits of the id; the full id is still checked
 * by {@link hashGate}, so reusing a verdict needs a 128-bit second preimage.
 */
const MEMO_KEY_CHARS = 32;
const memoKey = (id: string): string => id.slice(0, MEMO_KEY_CHARS);

/** Ids per persisted KV chunk (kept small: the open chunk is rewritten whole each flush), and chunks kept. */
const CHUNK_IDS = 256;
const KEEP_CHUNKS = 96;

/** Bounded FIFO, sized to what the persisted chunks can refill. */
const MAX_IDS = CHUNK_IDS * KEEP_CHUNKS;
const verified = new Set<string>();

/** The single insertion path (and eviction contract) for both sync and batched verifies. */
function rememberVerified(id: string): void {
  const key = memoKey(id);
  if (verified.has(key)) return;
  if (verified.size >= MAX_IDS) {
    const oldest = verified.keys().next();
    if (!oldest.done) verified.delete(oldest.value);
  }
  verified.add(key);
  persistence?.log.add(key);
}

// Verdicts persist across launches in an append-only KV log (IdLog). They're
// facts about content, so not account-scoped; purged with ArmadaDB.

let persistence: { log: IdLog; started: boolean } | undefined;

/**
 * Keep verdicts across launches in `kv`. Loaded lazily on the first verify and
 * merged in as they land.
 */
export function persistVerifiedIds(kv: () => IdLogKV): void {
  if (persistence) return;
  persistence = {
    log: new IdLog(kv, { prefix: "verified-ids:", idChars: MEMO_KEY_CHARS, chunkIds: CHUNK_IDS, keepChunks: KEEP_CHUNKS, flushMs: 10_000 }),
    started: false,
  };
}

function startPersistence(): void {
  if (!persistence || persistence.started) return;
  persistence.started = true;
  void persistence.log.load().then((saved) => {
    // Saved verdicts go first so the FIFO evicts previous sessions' before this one's.
    const session = [...verified];
    verified.clear();
    for (const key of saved) verified.add(key);
    for (const key of session) verified.add(key);
    while (verified.size > MAX_IDS) {
      const oldest = verified.keys().next();
      if (oldest.done) break;
      verified.delete(oldest.value);
    }
  });
}

type Hashed = Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">;

/**
 * Recent copies whose id was proven to be their hash. A relay copy whose hashed
 * fields all EQUAL a remembered copy has the same hash, so the comparison stands
 * in for the sha256 — each wrap arrives once per relay.
 */
// Sized for a plane: one access plane alone is thousands of wraps, each checked several
// times a pass, and a smaller FIFO evicted them before the next check, re-hashing each.
const HASHED_MAX = 16_384;
/** Max unbroken hashing in {@link verifyEventsOnce} before yielding. */
const HASH_SLICE_MS = 8;
const hashed = new Map<string, Hashed>();

function tagsEqual(a: string[][], b: string[][]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

/** Whether `event.id` is the NIP-01 hash of `event`; false for a malformed event. */
export function idIsHash(event: NostrEvent): boolean {
  const seen = hashed.get(event.id);
  if (
    seen &&
    seen.content === event.content &&
    seen.pubkey === event.pubkey &&
    seen.created_at === event.created_at &&
    seen.kind === event.kind &&
    tagsEqual(seen.tags, event.tags)
  ) {
    perfCount("crypto.idHash (copy hit)", 0, 1, "events");
    // Most recently used last, so eviction drops the coldest.
    hashed.delete(event.id);
    hashed.set(event.id, seen);
    return true;
  }
  let ok: boolean;
  try {
    // Malformed events make getEventHash THROW; they must read as unverified
    // (e.g. `openWrap` seals parsed from decrypted payloads).
    ok = getEventHash(event) === event.id;
  } catch {
    return false;
  }
  if (ok && !seen) rememberHashed(event);
  return ok;
}

function rememberHashed(event: NostrEvent): void {
  if (hashed.size >= HASHED_MAX) hashed.delete(hashed.keys().next().value!);
  // A snapshot: a caller may go on to mutate the object it passed.
  const { pubkey, created_at, kind, content } = event;
  hashed.set(event.id, { pubkey, created_at, kind, content, tags: event.tags.map((t) => [...t]) });
}

/**
 * Hash-check `events` with the browser's native SHA-256 ahead of {@link idIsHash},
 * remembering each whose id is its hash, so the synchronous checks that follow are
 * copy hits. Same answers, computed here, just not in JavaScript: a relay drain on a
 * phone hashed thousands of wraps a minute at ~0.3ms each. Anything it can't settle
 * (no WebCrypto, a malformed event, a mismatch) is left to {@link idIsHash}.
 */
export async function primeHashes(events: readonly NostrEvent[]): Promise<void> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) return;
  const todo = events.filter((e) => !hashed.has(e.id) && validateEvent(e));
  if (todo.length < PRIME_MIN) return;
  const encoder = new TextEncoder();
  await Promise.all(todo.map(async (event) => {
    // A snapshot of what is hashed, so a caller mutating the event meanwhile can't
    // pair one content with another's verdict.
    const copy: NostrEvent = { ...event, tags: event.tags.map((t) => [...t]) };
    try {
      const serialized = JSON.stringify([0, copy.pubkey, copy.created_at, copy.kind, copy.tags, copy.content]);
      const digest = new Uint8Array(await subtle.digest("SHA-256", encoder.encode(serialized)));
      if (bytesToHex(digest) === copy.id && !hashed.has(copy.id)) rememberHashed(copy);
    } catch {
      // left to idIsHash
    }
  }));
}

/** Below this, the async round costs more than hashing inline. */
const PRIME_MIN = 4;

/**
 * Main-thread hash binding shared by both verify paths: `"decided"` (final
 * `result`) or `"needs-ec"` (hash-bound, not memoized — Schnorr must run).
 * Never moved to a worker: recomputing the hash here IS the security argument.
 */
function hashGate(event: NostrEvent): { state: "decided"; result: boolean } | { state: "needs-ec" } {
  startPersistence();
  if (!idIsHash(event)) return { state: "decided", result: false };
  if (verified.has(memoKey(event.id))) return { state: "decided", result: true };
  return { state: "needs-ec" };
}

/** Verify `event`, skipping the Schnorr check for an id already verified. */
export function verifyEventOnce(event: NostrEvent): boolean {
  const start = performance.now();

  const gate = hashGate(event);
  if (gate.state === "decided") {
    perfCount(
      gate.result ? "crypto.verifyEvent (memo hit)" : "crypto.verifyEvent",
      performance.now() - start,
      1,
      "events",
    );
    return gate.result;
  }

  let ok = false;
  try {
    ok = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    ok = false;
  }
  if (ok) rememberVerified(event.id);
  perfCount("crypto.verifyEvent", performance.now() - start, 1, "events");
  // Counts every Schnorr verify actually performed.
  perfCount("crypto.ec.verify (sync)", 0, 1, "verifies");
  return ok;
}

/** The three fields an out-of-process EC verifier needs, and nothing else. */
export interface VerifyTriple {
  sig: string;
  id: string;
  pubkey: string;
}

/**
 * Pluggable Schnorr batch verifier: one boolean per `(sig, id, pubkey)` triple,
 * in order. EC only — the hash bind and memo stay here. `verifyPool.ts`
 * supplies a worker-backed one.
 */
export type EcVerifyBatch = (triples: VerifyTriple[]) => Promise<boolean[]>;

/**
 * Batched, memoized verification: hash-bind and memo-check on THIS thread; only
 * the residue goes to `ecVerify`. One boolean per event in order; an `ecVerify`
 * failure reads as unverified, never throws.
 *
 * The residue dedupes by the WHOLE triple, not the id: keyed by id alone, a
 * keyholder-minted mangled-sig copy would pass its false verdict to the honest
 * copy, which `openChatBatch` then memoizes for the session.
 */
export async function verifyEventsOnce(
  events: NostrEvent[],
  ecVerify: EcVerifyBatch,
): Promise<boolean[]> {
  await primeHashes(events);
  const start = performance.now();
  const result = new Array<boolean>(events.length);
  const residue: VerifyTriple[] = [];
  // Result slots each residue triple answers (identical duplicates share one).
  const residueSlots: number[][] = [];
  const residueByTriple = new Map<string, number>();

  // The hashes are the main thread's to compute, ~0.3ms each on a phone: a plane
  // read first seen hands over thousands, which in one task froze the UI for a second.
  let sliceStart = start;
  let blocked = 0;
  for (let i = 0; i < events.length; i++) {
    if (performance.now() - sliceStart >= HASH_SLICE_MS) {
      blocked += performance.now() - sliceStart;
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
    const gate = hashGate(events[i]);
    if (gate.state === "decided") {
      result[i] = gate.result;
      continue;
    }
    const key = `${events[i].id}|${events[i].sig}|${events[i].pubkey}`;
    const at = residueByTriple.get(key);
    if (at !== undefined) {
      residueSlots[at].push(i);
      continue;
    }
    residueByTriple.set(key, residue.length);
    residue.push({ sig: events[i].sig, id: events[i].id, pubkey: events[i].pubkey });
    residueSlots.push([i]);
  }

  // Main-thread cost only; the EC verify may be off-thread.
  perfCount("crypto.verifyEvents", blocked + performance.now() - sliceStart, events.length, "events");

  if (residue.length > 0) {
    perfCount("crypto.ec.verify (batched)", 0, residue.length, "verifies");
    let oks: boolean[];
    try {
      oks = await ecVerify(residue);
    } catch {
      oks = residue.map(() => false);
    }
    for (let j = 0; j < residue.length; j++) {
      const ok = oks[j] === true;
      for (const slot of residueSlots[j]) result[slot] = ok;
      if (ok) rememberVerified(residue[j].id);
    }
  }

  return result;
}

/** Test seam: forget every verified id, and stop persisting. */
export function _resetVerifyCacheForTests(): void {
  verified.clear();
  hashed.clear();
  persistence = undefined;
}
