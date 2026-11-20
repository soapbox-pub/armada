import { useEffect, useRef, useState } from "react";

import { encode, readFoldedShared, writeFolded } from "@/lib/foldedCache";

/**
 * Process-lifetime memory of the last live fold per key, so a key coming back
 * into view repaints synchronously instead of flashing empty while the
 * IndexedDB snapshot reloads. Untyped: one cache across all fold types.
 */
const memCache = new Map<string, unknown>();

/**
 * Max deferral, measured from when the fold became owed — NOT from the latest
 * reschedule, so a dependency burst can't push it back.
 */
const FOLD_DEADLINE_MS = 250;

/** Floor between two encodes of one fold for its persisted snapshot. */
const PERSIST_MS = 2_000;

/**
 * Persisting a fold, shared by every instance of its key: one timer per key
 * encodes the latest value at most once per PERSIST_MS (folds can be hundreds of
 * KB), and a value already written isn't encoded again.
 */
const persistPending = new Map<string, unknown>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const persistedValue = new Map<string, unknown>();

function schedulePersist(key: string, value: unknown): void {
  persistPending.set(key, value);
  // A timer, not an idle callback, so it never takes the fold's idle slot.
  if (!persistTimers.has(key)) persistTimers.set(key, setTimeout(() => flushPersist(key), PERSIST_MS));
}

/**
 * Forget in-memory folds and drop pending writes (decrypted state that would
 * land in a just-purged store). Called by `purgeClientStorage`.
 */
export function clearDeferredFoldMemory(): void {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  persistPending.clear();
  persistedValue.clear();
  memCache.clear();
}

/** A fold's in-memory copy, persisted like {@link useDeferredFold}'s; for stores folding outside React. */
export function rememberFold(key: string, value: unknown): void {
  memCache.set(key, value);
  schedulePersist(key, value);
}

/** The in-memory copy of a fold, if this process has one. */
export function recalledFold<T>(key: string): T | undefined {
  return memCache.get(key) as T | undefined;
}

/** Write `key`'s pending value now — on its timer, or when any instance unmounts/leaves it. */
export function flushPersist(key: string): void {
  const timer = persistTimers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  persistTimers.delete(key);
  if (!persistPending.has(key)) return;
  const value = persistPending.get(key);
  persistPending.delete(key);
  if (value === persistedValue.get(key)) return;
  persistedValue.set(key, value);
  const serialized = encode(value);
  void writeFolded(key, value, serialized);
}

/**
 * Compute a heavy synchronous Concord fold (roster / metadata / banlist) off the
 * render path — after paint, deadline-bounded — and persist/restore it across
 * reloads, since verifying a large control history would otherwise block first paint.
 *
 * `key` namespaces the snapshot (e.g. `roster:<cid>`); `compute` returns the
 * fold or `undefined` when inputs aren't ready; `deps` trigger recomputes.
 * Returns the live fold, else the persisted snapshot.
 *
 * `accept` vets a snapshot restored from disk (it may be from a build with a
 * different shape; see `isCurrentFoldedControl`); a rejection is a miss. The
 * in-memory cache isn't vetted — this process wrote it.
 */
export function useDeferredFold<T>(
  key: string | null,
  compute: () => T | undefined,
  deps: unknown[],
  accept?: (value: unknown) => boolean,
): T | undefined {
  const [live, setLive] = useState<T | undefined>(undefined);
  // Seed from the in-memory cache so a remount paints immediately, not blank.
  const [restored, setRestored] = useState<T | undefined>(() =>
    key ? (memCache.get(key) as T | undefined) : undefined,
  );
  // Keep the latest `compute` without making it a scheduling dependency.
  const computeRef = useRef(compute);
  computeRef.current = compute;
  // Same, so an inline predicate doesn't re-run the restore every render.
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  // Whether anything is on screen for a deferral to protect. Read, not depended
  // on, so a `live`/`restored` change never reschedules a fold.
  const paintableRef = useRef(false);
  paintableRef.current = live !== undefined || restored !== undefined;
  // When the owed fold is DUE; deliberately NOT reset by a reschedule.
  const deadlineRef = useRef<number | undefined>(undefined);

  // Reset synchronously on key change so one community's fold can never render
  // or persist under another's key (leaking A's banlist into B). Seed `restored`
  // from the NEW key's memory entry.
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setLive(undefined);
    setRestored(key ? (memCache.get(key) as T | undefined) : undefined);
    deadlineRef.current = undefined;
  }

  useEffect(() => {
    if (!key) {
      setRestored(undefined);
      return;
    }
    let cancelled = false;
    // Shared: every instance of a key restores the SAME object.
    void readFoldedShared<T>(key).then((v) => {
      if (cancelled || v === undefined) return;
      // A snapshot this build can't read is a miss, not something to render.
      if (acceptRef.current && !acceptRef.current(v)) return;
      setRestored(v);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Recompute after commit, but never later than a deadline a dependency burst
  // can't move, and never deferred when nothing is painted. Without the deadline
  // a cold-boot `c2ctl` ring burst re-armed the idle callback indefinitely,
  // leaving channels empty. `key` is included so a switch always reschedules.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      deadlineRef.current = undefined;
      setLive(computeRef.current());
    };

    // Nothing painted (first-ever open), so deferring only lengthens the empty
    // frame; run now, still post-commit.
    if (!paintableRef.current) {
      run();
      return;
    }

    const now = Date.now();
    deadlineRef.current ??= now + FOLD_DEADLINE_MS;
    if (now >= deadlineRef.current) {
      run();
      return;
    }
    const handle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(run, { timeout: deadlineRef.current - now })
        : (setTimeout(run, 0) as unknown as number);
    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);

  // Persist whenever CONTENT changes (best-effort), via {@link schedulePersist}.
  useEffect(() => {
    if (!key || live === undefined) return;
    // Keep the in-memory cache hot so cycling back repaints synchronously.
    memCache.set(key, live);
    schedulePersist(key, live);
  }, [key, live]);
  useEffect(() => {
    if (!key) return;
    return () => flushPersist(key);
  }, [key]);

  return live ?? restored;
}
