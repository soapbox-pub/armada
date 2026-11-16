/**
 * Relay fan-outs that don't wait on the slowest relay (Vector `QUORUM_GRACE_MS`,
 * `publish_durable`). A dead relay of three cost every read its full timeout and
 * left every write one attempt short; these bound the read by the first answer and
 * keep a write going until each relay takes it.
 */

import { logSync } from "@/lib/syncLog";

/** How long a read waits for the rest once one relay has answered. */
export const QUORUM_GRACE_MS = 2_000;

/** How many of `n` relays make a majority. */
export const majorityOf = (n: number) => Math.floor(n / 2) + 1;

/**
 * Each relay's answer, settled once a majority of relays has answered, or `graceMs`
 * after the first one did, or when every one has (failures count as answered); a
 * relay still out then is `undefined`. Its task runs on, unawaited.
 */
export async function quorum<T>(tasks: readonly Promise<T>[], graceMs = QUORUM_GRACE_MS): Promise<Array<T | undefined>> {
  const out: Array<T | undefined> = tasks.map(() => undefined);
  let answered = 0;
  let firstDone: () => void = () => undefined;
  let enough: () => void = () => undefined;
  const first = new Promise<void>((resolve) => (firstDone = resolve));
  const majority = new Promise<void>((resolve) => (enough = resolve));
  const settled = tasks.map((t, i) =>
    t.then(
      (v) => {
        out[i] = v;
        firstDone();
        if (++answered >= majorityOf(tasks.length)) enough();
      },
      () => undefined,
    ),
  );
  await Promise.race([Promise.all(settled), majority, first.then(() => new Promise((r) => setTimeout(r, graceMs)))]);
  return [...out];
}

/**
 * When a reader that expects something after an authority change reads again: a relay
 * that drops a live event (and one that omits it from a read) costs a step of this, not
 * the next periodic read. Ends on Vector's +20 s.
 */
export const REREAD_BACKOFF_MS = [1_500, 3_000, 5_000, 7_500, 10_000, 13_000, 16_000, 20_000];

/** Run `read` at each of `delays`; returns the cancel. */
export function rereadOnBackoff(read: () => void, delays: readonly number[] = REREAD_BACKOFF_MS): () => void {
  const timers = delays.map((ms) => setTimeout(read, ms));
  return () => timers.forEach(clearTimeout);
}

interface RelayPublisher {
  relay(url: string): { event(event: never, opts?: { signal?: AbortSignal }): Promise<void> };
}

/** Attempts per relay, and how long to wait for the first acceptance before failing. */
const DURABLE_ATTEMPTS = 12;
const DURABLE_CONFIRM_MS = 25_000;

/**
 * Publish to every relay, retrying each one until it accepts (Vector `publish_durable`):
 * resolves with the relays that accepted once one has, or throws when none has within
 * {@link DURABLE_CONFIRM_MS}; the rest keep being retried in the background.
 */
export function publishDurable<E>(nostr: RelayPublisher, relays: readonly string[], event: E, timeoutMs = 8_000, trace?: string): Promise<string[]> {
  const accepted: string[] = [];
  const errors: string[] = [];
  const started = Date.now();
  const unique = [...new Set(relays)];
  return new Promise<string[]>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok) resolve(accepted);
      else reject(new Error(errors.length ? [...new Set(errors)].slice(0, 2).join("; ") : "no relay accepted the event"));
    };
    const confirm = setTimeout(() => finish(accepted.length > 0), DURABLE_CONFIRM_MS);
    let running = unique.length;
    if (running === 0) {
      clearTimeout(confirm);
      return finish(false);
    }
    for (const url of unique) {
      void (async () => {
        for (let attempt = 0; attempt < DURABLE_ATTEMPTS; attempt++) {
          try {
            await nostr.relay(url).event(event as never, { signal: AbortSignal.timeout(timeoutMs) });
            accepted.push(url);
            if (trace) logSync("publish", `${trace}: ${url} took it after ${attempt + 1} attempt(s), ${Date.now() - started}ms`);
            clearTimeout(confirm);
            finish(true);
            return;
          } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
            // A relay that finds the event itself invalid won't change its mind.
            if (/^invalid/i.test(errors.at(-1) ?? "")) break;
            await new Promise((r) => setTimeout(r, Math.min(750 * 2 ** attempt, 15_000)));
          }
        }
        if (--running === 0 && accepted.length === 0) {
          clearTimeout(confirm);
          finish(false);
        }
      })();
    }
  });
}
