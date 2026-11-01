/**
 * Rank keys (CORD-04 §3): Role order as fractional keys over `0-9A-Za-z`,
 * compared byte by byte, 1 to 32 bytes and never ending in `0`, so a key strictly
 * between any two always exists. Channel and Category positions (CORD-03) use
 * the same keys. Ported from Vector's `community/rank.rs` (MIT).
 */

export const MAX_RANK_KEY_BYTES = 32;

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function digit(c: string | undefined): number | undefined {
  if (c === undefined) return undefined;
  const i = DIGITS.indexOf(c);
  return i < 0 || c.length !== 1 ? undefined : i;
}

/** A well-formed rank key. */
export function isRankKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_RANK_KEY_BYTES) return false;
  for (const c of key) if (digit(c) === undefined) return false;
  return key[key.length - 1] !== "0";
}

/** Byte order of two rank keys (ASCII, so code-unit order is byte order). */
export function compareRankKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A key strictly between `lo` and `hi` (undefined is the open end on that side),
 * or undefined when the keys are malformed, out of order, or the gap no longer
 * fits in 32 bytes, at which point the caller re-keys neighbours.
 */
export function rankBetween(lo: string | undefined, hi: string | undefined): string | undefined {
  const low = lo ?? "";
  if (low !== "" && !isRankKey(low)) return undefined;
  if (hi !== undefined && (!isRankKey(hi) || low >= hi)) return undefined;
  // Appending steps up a digit rather than halving the gap: ~61 keys per byte instead of 6.
  const key = hi === undefined && low !== "" ? after(low) : midpoint(low, hi);
  return key.length <= MAX_RANK_KEY_BYTES ? key : undefined;
}

function after(lo: string): string {
  if (lo.length === 0) return DIGITS[1];
  const a = digit(lo[0])!;
  if (a + 1 < DIGITS.length) return DIGITS[a + 1];
  return lo[0] + after(lo.slice(1));
}

function midpoint(lo: string, hi: string | undefined): string {
  if (hi !== undefined) {
    let n = 0;
    while (n < hi.length && (lo[n] ?? "0") === hi[n]) n++;
    if (n > 0) return hi.slice(0, n) + midpoint(lo.slice(n), hi.slice(n));
  }
  const a = digit(lo[0]) ?? 0;
  const b = hi === undefined ? DIGITS.length : digit(hi[0])!;
  if (b - a > 1) return DIGITS[Math.ceil((a + b) / 2)];
  if (hi !== undefined && hi.length > 1) return hi[0];
  return DIGITS[a] + midpoint(lo.slice(1), undefined);
}

/**
 * Order-preserving dense ranks: each distinct key maps to 1 + its index in byte
 * order, so equal keys are peers. 0 stays the owner's.
 */
export function denseRanks(keys: Iterable<string>): Map<string, number> {
  const sorted = [...new Set(keys)].sort(compareRankKeys);
  return new Map(sorted.map((k, i) => [k, i + 1]));
}
