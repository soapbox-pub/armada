/**
 * Worker pool behind {@link verifyCache}'s {@link EcVerifyBatch} seam and
 * {@link ecSignBatch} (NIP-42 stream-key signing in `streamAuth.ts`), moving
 * Schnorr verify/sign off the main thread. Workers only get pre-hashed inputs;
 * `hashGate` binds ids on the main thread.
 *
 * Failure never changes an ANSWER, only where it's computed: a worker that
 * errors, throws, or misses its deadline ({@link roundDeadlineMs}) is retired
 * and its chunk recomputed inline. A missing reply must not read as "forged" —
 * `openChatBatch` memoizes false verdicts for the session. No `Worker` (or
 * construction failure) pins the pool inline forever; small batches run inline
 * since the round trip dominates. Inline runs are time-sliced.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { EcVerifyBatch, VerifyTriple } from "./verifyCache";
import { decrypt as nip44Decrypt } from "nostr-tools/nip44";

import type { DecryptJob, SignJob, WorkerRequest, WorkerResponse } from "./verifyWorkerTypes";

/**
 * Main-thread time a verify batch may take inline before it goes to the pool. Measured,
 * not counted: a verify is ~1.8ms on a desktop and ~9ms on a low-end phone, where a
 * fixed count kept every relay drain on the UI thread.
 */
const VERIFY_INLINE_BUDGET_MS = 16;
const VERIFY_INLINE_MAX = 24;
/** Running average of one inline verify, seeded with a desktop's. */
let inlineVerifyMs = 1.8;

function verifyInlineThreshold(): number {
  // Rounded down: where one verify alone overruns the budget, even it goes to the pool.
  return Math.max(1, Math.min(VERIFY_INLINE_MAX, Math.floor(VERIFY_INLINE_BUDGET_MS / inlineVerifyMs)));
}

/** {@link verifyOneInline}, feeding the average the threshold is set by. */
function verifyOneTimed(t: VerifyTriple): boolean {
  const start = performance.now();
  const ok = verifyOneInline(t);
  inlineVerifyMs = inlineVerifyMs * 0.9 + (performance.now() - start) * 0.1;
  return ok;
}

/** Signing (~4ms incl. @noble's self-verify): two already beat the round trip. */
const SIGN_INLINE_THRESHOLD = 2;

/** Inline slice before yielding; matches `openChatBatch`'s decode slice. */
const INLINE_SLICE_MS = 5;

/**
 * Unanswered-round deadline: module-load allowance plus a generous per-item
 * budget. Errs long, since firing retires the worker for the session.
 */
const ROUND_DEADLINE_BASE_MS = 2_000;
const ROUND_DEADLINE_PER_VERIFY_MS = 50;
const ROUND_DEADLINE_PER_SIGN_MS = 100;

/** A deadline timer this late fired after a long task, not after the worker's silence. */
const LATE_TIMER_MS = 250;

let roundDeadlineOverride: number | undefined;

function roundDeadlineMs(request: WorkerRequest): number {
  if (roundDeadlineOverride !== undefined) return roundDeadlineOverride;
  if (request.op === "sign") return ROUND_DEADLINE_BASE_MS + ROUND_DEADLINE_PER_SIGN_MS * request.jobs.length;
  if (request.op === "decrypt") return ROUND_DEADLINE_BASE_MS + ROUND_DEADLINE_PER_VERIFY_MS * request.jobs.length;
  return ROUND_DEADLINE_BASE_MS + ROUND_DEADLINE_PER_VERIFY_MS * request.triples.length;
}

/** Leave cores for the compositor; the pool is to free the UI thread, not saturate. */
function poolSize(): number {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/** One triple, inline. Any malformed hex reads as invalid, never as a throw. */
function verifyOneInline(t: VerifyTriple): boolean {
  try {
    return schnorr.verify(hexToBytes(t.sig), hexToBytes(t.id), hexToBytes(t.pubkey));
  } catch {
    return false;
  }
}

/** One sign job, inline. A malformed key reads as `null`, never as a throw. */
function signOneInline(job: SignJob): string | null {
  try {
    return bytesToHex(schnorr.sign(hexToBytes(job.hash), job.sk));
  } catch {
    return null;
  }
}

/** A batch on this thread, yielding every INLINE_SLICE_MS. */
async function runInline<J, R>(items: J[], one: (item: J) => R): Promise<R[]> {
  const out = new Array<R>(items.length);
  let sliceStart = performance.now();
  for (let i = 0; i < items.length; i++) {
    out[i] = one(items[i]);
    if (i + 1 < items.length && performance.now() - sliceStart >= INLINE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return out;
}

/** One round in flight: how to settle it, and the deadline that settles it "unanswered". */
interface PendingRound {
  /** `null` settles as "unanswered" — the caller recomputes inline. */
  settle: (results: unknown[] | null) => void;
  deadline: ReturnType<typeof setTimeout>;
}

/** A worker plus the replies it still owes, keyed by round id. */
interface PoolWorker {
  worker: Worker;
  pending: Map<number, PendingRound>;
  /** Set on any failure: a dead worker swallows messages, so never dispatch again. */
  dead: boolean;
}

/**
 * Retire a worker for good: owed rounds settle "unanswered" (recomputed
 * inline) and it's terminated so late replies land nowhere.
 */
function retire(entry: PoolWorker): void {
  entry.dead = true;
  for (const round of entry.pending.values()) {
    clearTimeout(round.deadline);
    round.settle(null);
  }
  entry.pending.clear();
  try {
    entry.worker.terminate();
  } catch {
    // already gone
  }
}

/** `undefined` = not attempted; `null` = unavailable (always inline); array = workers. */
let pool: PoolWorker[] | null | undefined;
let nextRoundId = 0;

/** Build the pool once; pin it `null` (inline forever) if `Worker` can't run. */
function ensurePool(): PoolWorker[] | null {
  if (pool !== undefined) return pool;
  if (typeof Worker === "undefined") {
    pool = null;
    return null;
  }
  try {
    pool = Array.from({ length: poolSize() }, () => {
      const worker = new Worker(new URL("./verify.worker.ts", import.meta.url), { type: "module" });
      const entry: PoolWorker = { worker, pending: new Map(), dead: false };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const { id, results } = event.data;
        const round = entry.pending.get(id);
        if (round) {
          clearTimeout(round.deadline);
          entry.pending.delete(id);
          round.settle(results);
        }
      };
      // A dead worker silently swallows postMessage; retire it.
      worker.onerror = () => retire(entry);
      return entry;
    });
    return pool;
  } catch {
    pool = null;
    return null;
  }
}

/**
 * One chunk to one worker; `null` (worker retired) when no answer will come,
 * and the caller computes inline.
 */
function dispatch(entry: PoolWorker, request: WorkerRequest): Promise<unknown[] | null> {
  return new Promise<unknown[] | null>((resolve) => {
    const ms = roundDeadlineMs(request);
    // The deadline is a timer on THIS thread: when a long task held it, the reply can
    // be queued behind the overdue timer, which then retired a healthy worker for the
    // session and left every verify inline. A timer that fired late only re-arms.
    const arm = (): ReturnType<typeof setTimeout> => {
      const due = performance.now() + ms;
      return setTimeout(() => {
        const round = entry.pending.get(request.id);
        if (!round) return;
        if (performance.now() - due > LATE_TIMER_MS) round.deadline = arm();
        else retire(entry);
      }, ms);
    };
    entry.pending.set(request.id, { settle: resolve, deadline: arm() });
    try {
      entry.worker.postMessage(request);
    } catch {
      retire(entry);
    }
  });
}

/**
 * Split items into contiguous chunks across live workers and stitch answers
 * back in order. Chunks without a usable answer are computed inline.
 */
async function runBatch<J, R>(
  items: J[],
  inlineThreshold: number,
  request: (chunk: J[]) => WorkerRequest,
  one: (item: J) => R,
  coerce: (answer: unknown) => R,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workers = ensurePool()?.filter((entry) => !entry.dead);
  if (!workers || workers.length === 0 || items.length < inlineThreshold) {
    return runInline(items, one);
  }

  const chunkSize = Math.ceil(items.length / workers.length);
  const chunks: J[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  const parts = await Promise.all(chunks.map((chunk, i) => dispatch(workers[i], request(chunk))));

  const out: R[] = [];
  for (let c = 0; c < chunks.length; c++) {
    let answered: unknown[] | null = parts[c];
    if (!answered || answered.length !== chunks[c].length) {
      answered = await runInline(chunks[c], one);
    }
    for (let j = 0; j < chunks[c].length; j++) out.push(coerce(answered[j]));
  }
  return out;
}

/** The {@link EcVerifyBatch} the app hands `verifyEventsOnce`. */
export const ecVerifyBatch: EcVerifyBatch = (triples: VerifyTriple[]): Promise<boolean[]> =>
  runBatch(
    triples,
    verifyInlineThreshold(),
    (chunk) => ({ id: nextRoundId++, op: "verify", triples: chunk }),
    verifyOneTimed,
    (answer) => answer === true,
  );

/** Running average of one inline NIP-44 open (~0.3ms on a desktop, ~2ms on a low-end phone). */
let inlineDecryptMs = 0.3;

function decryptOneTimed(job: DecryptJob): string | null {
  const start = performance.now();
  let out: string | null;
  try {
    out = nip44Decrypt(job.payload, job.key);
  } catch {
    out = null;
  }
  inlineDecryptMs = inlineDecryptMs * 0.9 + (performance.now() - start) * 0.1;
  return out;
}

/**
 * Open NIP-44 payloads (pool or inline), in order; `null` where one doesn't open.
 * Never throws. Worker failures fall back inline.
 */
export const ecDecryptBatch = (jobs: DecryptJob[]): Promise<(string | null)[]> =>
  runBatch(
    jobs,
    Math.max(2, Math.min(VERIFY_INLINE_MAX * 4, Math.ceil(VERIFY_INLINE_BUDGET_MS / inlineDecryptMs))),
    (chunk) => ({ id: nextRoundId++, op: "decrypt", jobs: chunk }),
    decryptOneTimed,
    (answer) => (typeof answer === "string" ? answer : null),
  );

/** A pluggable Schnorr batch signer: one hex signature (or `null`) per job, in order. */
export type EcSignBatch = (jobs: SignJob[]) => Promise<(string | null)[]>;

/**
 * Sign pre-hashed messages (pool or inline). Never throws; unusable keys answer
 * `null`. Worker failures fall back inline.
 */
export const ecSignBatch: EcSignBatch = (jobs: SignJob[]): Promise<(string | null)[]> =>
  runBatch(
    jobs,
    SIGN_INLINE_THRESHOLD,
    (chunk) => ({ id: nextRoundId++, op: "sign", jobs: chunk }),
    signOneInline,
    (answer) => (typeof answer === "string" ? answer : null),
  );

/** Test seam: tear down the pool; optionally pin the round deadline. */
export function _resetVerifyPoolForTests(opts?: { roundDeadlineMs?: number }): void {
  if (Array.isArray(pool)) for (const entry of pool) retire(entry);
  pool = undefined;
  nextRoundId = 0;
  inlineVerifyMs = 1.8;
  inlineDecryptMs = 0.3;
  roundDeadlineOverride = opts?.roundDeadlineMs;
}
