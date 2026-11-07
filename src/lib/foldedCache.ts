/**
 * Cache of decrypted/folded Concord results (community metadata, roster) across
 * reloads, in ArmadaDB KV under `folded:`. bigint/Uint8Array/Map/Set are
 * tag-encoded. Stores decrypted data at rest — same trust level as the keys.
 */
import { getArmadaDB } from "@/lib/db/armadaDB";
import { perfCount, perfTime } from "@/lib/perf";

const KEY_PREFIX = "folded:";

function foldedKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

// Tagged codec. Table-driven hex: decoding megabytes of fold on boot was hot.

const BYTE_HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
// Out-of-range indexes read undefined, which bit-ops coerce to 0.
const HEX_NIBBLE = new Uint8Array(103); // 'f' (102) is the highest hex char
for (let i = 0; i < 10; i++) HEX_NIBBLE[48 + i] = i; // '0'-'9'
for (let i = 0; i < 6; i++) {
  HEX_NIBBLE[97 + i] = 10 + i; // 'a'-'f'
  HEX_NIBBLE[65 + i] = 10 + i; // 'A'-'F'
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += BYTE_HEX[b];
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (HEX_NIBBLE[hex.charCodeAt(i * 2)] << 4) | HEX_NIBBLE[hex.charCodeAt(i * 2 + 1)];
  }
  return out;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __t: "bigint", v: value.toString() };
  if (value instanceof Uint8Array) return { __t: "u8", v: toHex(value) };
  if (value instanceof Map) return { __t: "map", v: [...value.entries()] };
  if (value instanceof Set) return { __t: "set", v: [...value.values()] };
  return value;
}

/**
 * Rebuild tagged wrappers bottom-up, in place. Much faster than a JSON.parse
 * reviver (see foldedCache.perf.test.ts). Safe because the input is a fresh
 * parse result, so `"__proto__"` keys are own data properties.
 */
function revive(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;

  if (Array.isArray(node)) {
    const array = node as unknown[];
    for (let i = 0; i < array.length; i++) {
      const child = array[i];
      if (child !== null && typeof child === "object") array[i] = revive(child);
    }
    return array;
  }

  const object = node as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    const child = object[key];
    if (child !== null && typeof child === "object") object[key] = revive(child);
  }

  // Children first, so wrappers unwrap over already-live shapes.
  const tag = object.__t;
  if (tag !== undefined) {
    switch (tag) {
      case "bigint": return BigInt(object.v as string);
      case "u8": return fromHex(object.v as string);
      case "map": return new Map(object.v as [unknown, unknown][]);
      case "set": return new Set(object.v as unknown[]);
    }
  }
  return object;
}

export function encode(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/**
 * Deserialize a string produced by {@link encode}, or undefined on failure.
 * The walk starts at the parse result itself: the ROOT may be a tagged value
 * (`rekey.ts` persists a bare `Uint8Array`).
 */
export function decode<T>(json: string): T | undefined {
  try {
    return revive(JSON.parse(json)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Last serialized value per key this session. Identical writes are skipped:
 * folds are recomputed far more often than they change, and redundant writes
 * would flood the Android bridge and wake every listener. LRU-bounded, since
 * each entry is a full encoding; an evicted key only costs one redundant write.
 */
const knownEncoding = new Map<string, string>();
const KNOWN_ENCODING_MAX = 4096;

function rememberEncoding(key: string, json: string): void {
  knownEncoding.delete(key);
  knownEncoding.set(key, json);
  if (knownEncoding.size <= KNOWN_ENCODING_MAX) return;
  const oldest = knownEncoding.keys().next().value as string;
  knownEncoding.delete(oldest);
  // A shared hit is validated against this encoding, so it goes with it.
  sharedDecoded.delete(oldest);
}

/** The keys (as callers spell them) of every fold starting with `prefix`. */
export async function listFoldedKeys(prefix: string): Promise<string[]> {
  const entries = await getArmadaDB().kv.list({ prefix: foldedKey(prefix) });
  return entries.map(({ key }) => key.slice(KEY_PREFIX.length));
}

export async function readFolded<T>(key: string): Promise<T | undefined> {
  try {
    if (import.meta.env.VITE_PROFILE === "1") {
      const site = new Error().stack?.split("\n").slice(2, 4).join(" < ").replace(/https?:\/\/[^/]+/g, "") ?? "?";
      perfCount(`readFolded ${key.split(":")[0]} @ ${site}`, 0);
    }
    const before = knownEncoding.get(key);
    const json = await getArmadaDB().kv.get<string>(foldedKey(key));
    // A write during the read is newer than what the read saw.
    if (typeof json === "string" && knownEncoding.get(key) === before) rememberEncoding(key, json);
    // A non-string (undefined normalized to null) reads as a miss.
    return typeof json === "string"
      ? await perfTime("fold.decode", async () => decode<T>(json), () => json.length, "chars")
      : undefined;
  } catch {
    return undefined;
  }
}

const sharedDecoded = new Map<string, { json: string; value: unknown }>();

/**
 * {@link readFolded}, but one shared decoded object per key per session. Only
 * for values every reader treats as immutable (the control folds): they're read
 * constantly and each read is a large bridge crossing plus decode on Android.
 */
export async function readFoldedShared<T>(key: string): Promise<T | undefined> {
  const hit = sharedDecoded.get(key);
  if (hit && knownEncoding.get(key) === hit.json) {
    rememberEncoding(key, hit.json); // touch: shared keys are the hottest ones
    return hit.value as T;
  }
  // Stays empty until the next writeFolded.
  if (sharedMissing.has(key)) return undefined;
  // Share in-flight reads: boot mounts dozens of fold hooks at once.
  let pending = sharedInFlight.get(key);
  if (!pending) {
    pending = readFolded<unknown>(key).then((value) => {
      const json = knownEncoding.get(key);
      // A write that landed during the read already shared the newer value.
      const shared = sharedDecoded.get(key);
      if (json !== undefined && shared?.json === json) return shared.value;
      if (value !== undefined && json !== undefined) sharedDecoded.set(key, { json, value });
      else if (value === undefined && json === undefined) sharedMissing.add(key);
      return value;
    });
    sharedInFlight.set(key, pending);
    void pending.finally(() => {
      if (sharedInFlight.get(key) === pending) sharedInFlight.delete(key);
    });
  }
  return (await pending) as T | undefined;
}

const sharedInFlight = new Map<string, Promise<unknown>>();
/** Keys a shared read found empty, until the next write of the key. */
const sharedMissing = new Set<string>();

/**
 * Forget in-memory state on logout: shared decodes are decrypted data, and the
 * encoding memo would make the next account's identical first write a no-op.
 */
export function clearFoldedMemory(): void {
  knownEncoding.clear();
  sharedDecoded.clear();
  sharedInFlight.clear();
  sharedMissing.clear();
}

type FoldedWriteListener = (key: string) => void;
const foldedWriteListeners = new Set<FoldedWriteListener>();

/**
 * Observe fold writes, for consumers built from persisted folds (the wire
 * subscription spec) that have no other change signal. Returns an unsubscribe.
 */
export function onFoldedWrite(listener: FoldedWriteListener): () => void {
  foldedWriteListeners.add(listener);
  return () => {
    foldedWriteListeners.delete(listener);
  };
}

/**
 * Persist a folded value (best-effort). Unchanged encodings are skipped.
 * `encoded` is the caller's precomputed {@link encode}, if any.
 */
export async function writeFolded(key: string, value: unknown, encoded?: string): Promise<void> {
  try {
    const json = encoded ?? encode(value);
    if (knownEncoding.get(key) === json) return;
    // Set before the await so concurrent identical writes collapse to one.
    rememberEncoding(key, json);
    // Only keys someone shares: pinning every written value would hold it all.
    const shared = sharedDecoded.has(key) || sharedInFlight.has(key) || sharedMissing.has(key);
    sharedMissing.delete(key);
    if (value === undefined) sharedDecoded.delete(key);
    else if (shared) sharedDecoded.set(key, { json, value });
    try {
      await getArmadaDB().kv.set(foldedKey(key), json);
    } catch (error) {
      // Not on disk after all: let the next write try again.
      if (knownEncoding.get(key) === json) knownEncoding.delete(key);
      throw error;
    }
    for (const listener of foldedWriteListeners) {
      try {
        // Listeners match on the caller's key, so the prefix stays internal.
        listener(key);
      } catch {
        // A listener must never break the write path.
      }
    }
  } catch {
    // Best-effort cache.
  }
}

/** Forget a folded value, on disk and in this session (best-effort). */
export async function deleteFolded(key: string): Promise<void> {
  knownEncoding.delete(key);
  sharedDecoded.delete(key);
  sharedMissing.delete(key);
  try {
    await getArmadaDB().kv.delete(foldedKey(key));
  } catch {
    // Best-effort cache.
  }
}

/** Test seam: forget this session's in-memory state. */
export function __resetFoldedForTests(): void {
  knownEncoding.clear();
  sharedDecoded.clear();
  sharedInFlight.clear();
  sharedMissing.clear();
}
