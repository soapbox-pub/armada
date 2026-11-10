/**
 * The time every event this client creates is dated by, and every sender's date is
 * judged against: this device's clock, corrected when the account's relays agree it is
 * off (CORD-03 §3, Vector `clock.rs`). Every HTTPS answer carries a `Date` (RFC 9110
 * §6.6.1), so any relay tells the time; their median moves the clock, so one wrong relay
 * can't. A browser hides `Date` from a cross-origin page, so native HTTP (Capacitor) and
 * the desktop shell ask the relays, and the web asks the origin that served it.
 */
import { desktop } from "@/lib/desktop";

/** `Date` has one-second resolution: a smaller gap is no evidence of a wrong clock. */
const NOISE_MS = 2_000;
/** How close two relays must be to count as agreeing. */
const AGREE_MS = 5_000;
/** How many relays must agree before the clock moves, so two can't move it (Vector `QUORUM`). */
const QUORUM = 3;
/** A sample whose round trip took longer than this can't place the time closely enough. */
const MAX_ROUND_TRIP_MS = 8_000;
/** How often the relays are asked again. */
export const CLOCK_RESYNC_MS = 60 * 60 * 1000;

let offsetMs = 0;

/** Now, in unix ms, corrected. */
export function clockNowMs(): number {
  return Date.now() + offsetMs;
}

/** Now, in corrected unix seconds: the `created_at` of anything signed now. */
export function nowSecs(): number {
  return Math.floor(clockNowMs() / 1000);
}

/** The correction in force (positive when this device runs behind). */
export function clockOffsetMs(): number {
  return offsetMs;
}

/** For tests and logout. */
export function resetClockOffset(): void {
  offsetMs = 0;
}

/** The offset `samples` agree on: their median, when at least {@link QUORUM} lie within {@link AGREE_MS} of it. */
export function agreedOffset(samples: number[]): number | undefined {
  if (samples.length < QUORUM) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return sorted.filter((s) => Math.abs(s - median) <= AGREE_MS).length >= QUORUM ? median : undefined;
}

/** Unix seconds of an IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), the form RFC 9110 has servers send. */
export function parseHttpDate(s: string): number | undefined {
  const m = /^[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(s.trim());
  if (!m) return undefined;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[2]);
  const [day, year, h, min, sec] = [m[1], m[3], m[4], m[5], m[6]].map(Number);
  if (month < 0 || day < 1 || day > 31 || h > 23 || min > 59 || sec > 60) return undefined;
  return Math.floor(Date.UTC(year, month, day, h, min, sec) / 1000);
}

export type DateFetcher = (url: string) => Promise<{ date?: string | null; age?: string | null }>;

const defaultFetcher: DateFetcher = async (url) => {
  const headers = { Accept: "application/nostr+json", "Cache-Control": "no-cache" };
  const { Capacitor, CapacitorHttp } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({ url, headers, connectTimeout: 10_000, readTimeout: 10_000 });
    const h = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { date: h.date, age: h.age };
  }
  const shell = desktop()?.httpDate;
  if (shell) return (await shell(url)) ?? {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  return { date: res.headers.get("date"), age: res.headers.get("age") };
};

/** One relay's clock minus this device's, in ms, from the `Date` (and any `Age`) on its answer. */
async function sample(relay: string, fetcher: DateFetcher): Promise<number | undefined> {
  const url = relay.trim().replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
  if (!/^https?:\/\//.test(url)) return undefined;
  const sent = Date.now();
  const res = await fetcher(url).catch(() => undefined);
  const back = Date.now();
  if (!res?.date || back - sent > MAX_ROUND_TRIP_MS) return undefined;
  const date = parseHttpDate(res.date);
  if (date === undefined) return undefined;
  // Digits only, a leading `+` allowed, else none (Vector `trim().parse::<u64>()`).
  const ageText = res.age?.trim() ?? "";
  const age = /^\+?\d+$/.test(ageText) && BigInt(ageText) < 1n << 64n ? Number(ageText) : 0;
  // The relay stamped a whole second it was somewhere inside, met about mid-trip.
  const relayMs = (date + age) * 1000 + 500;
  return relayMs - (sent + back) / 2;
}

/**
 * The relays the clock is kept by: the account's own NIP-65 and DM relays, never a
 * Community's, which whoever made it chose and could stack to move every member's clock.
 */
export function accountClockRelays(
  relayMetadata: { relays: readonly { url: string }[]; pubkey?: string },
  dmRelays: readonly string[],
  pubkey: string | undefined,
): string[] {
  const own = relayMetadata.pubkey === undefined || relayMetadata.pubkey === pubkey ? relayMetadata.relays.map((r) => r.url) : [];
  return [...new Set([...own, ...dmRelays])].sort();
}

/** Ask up to eight `relays` for the time and correct the clock by what they agree on; the device's clock otherwise. */
export async function syncClockWithRelays(relays: readonly string[], fetcher: DateFetcher = defaultFetcher): Promise<void> {
  const samples = (await Promise.all(relays.slice(0, 8).map((r) => sample(r, fetcher)))).filter((s): s is number => s !== undefined);
  const agreed = agreedOffset(samples);
  offsetMs = agreed === undefined || Math.abs(agreed) < NOISE_MS ? 0 : Math.round(agreed);
}

/**
 * Correct the clock by the origin that served this page: one source, trusted alone
 * since it already serves the code, and the only `Date` a browser page can read.
 */
export async function syncClockWithOrigin(origin: string, fetcher: DateFetcher = defaultFetcher): Promise<void> {
  const offset = await sample(`${origin}/`, fetcher);
  offsetMs = offset === undefined || Math.abs(offset) < NOISE_MS ? 0 : Math.round(offset);
}

/** Whether this runtime can read a relay's `Date`: native HTTP, or the desktop shell's. */
async function relaysTellTime(): Promise<boolean> {
  if (desktop()?.httpDate) return true;
  const { Capacitor } = await import("@capacitor/core");
  return Capacitor.isNativePlatform();
}

/** Keep the clock by `relays` where their `Date` is readable, else by the page's own origin. */
export async function syncClock(relays: readonly string[]): Promise<void> {
  if (await relaysTellTime()) return syncClockWithRelays(relays);
  if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) return syncClockWithOrigin(location.origin);
  offsetMs = 0;
}
