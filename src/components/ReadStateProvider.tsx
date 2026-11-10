import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ReadStateContext,
  type ReadStateMap,
} from "@/contexts/ReadStateContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";
import { capReadStamp, capReadStamps, planReadStatePublish } from "@/lib/readStateSync";
import { nowSecs } from "@/lib/relayClock";

const EMPTY: ReadStateMap = {};

function storageKey(pubkey: string): string {
  return `armada:read-state:${pubkey}`;
}

function loadLocal(pubkey: string): ReadStateMap {
  try {
    const raw = localStorage.getItem(storageKey(pubkey));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? capReadStamps(parsed as ReadStateMap, nowSecs()) : {};
  } catch {
    return {};
  }
}

function saveLocal(pubkey: string, map: ReadStateMap): void {
  try {
    localStorage.setItem(storageKey(pubkey), JSON.stringify(map));
  } catch { /* ignore */ }
}

function mergeReadState(a: ReadStateMap, b: ReadStateMap): ReadStateMap {
  const out: ReadStateMap = { ...a };
  for (const [key, ts] of Object.entries(capReadStamps(b, nowSecs()))) {
    if (!out[key] || ts > out[key]) out[key] = ts;
  }
  return out;
}

const SYNC_DEBOUNCE_MS = 4000;

/**
 * Per-conversation last-read timestamps: localStorage cache plus two debounced
 * NIP-78 documents for cross-device sync. `${APP_ID}/read-state` holds the
 * whole map, which is unbounded (never pruned); `${APP_ID}/read-state-recent`
 * holds only the entries newer than it. A read publishes the small one, so an
 * open channel stamping every incoming message doesn't make every other
 * device download the whole map per message; the base is rewritten only when
 * the delta passes `READ_STATE_ROLLOVER_BYTES` (lib/readStateSync.ts).
 */
export function ReadStateProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const {
    doc,
    sources: baseSources,
    isFetched: baseFetched,
    update,
    hasNip44Support,
  } = useSettingsDoc("read-state");
  const {
    doc: recentDoc,
    sources: recentSources,
    isFetched: recentFetched,
    update: updateRecent,
  } = useSettingsDoc("read-state-recent");
  const isFetched = baseFetched && recentFetched;
  // Legacy home of this map, merged in as a second source (max-per-key is commutative).
  const { doc: metadata } = useEncryptedSettings();
  const pubkey = user?.pubkey;

  const isFetchedRef = useRef(false);
  useEffect(() => {
    isFetchedRef.current = isFetched;
  }, [isFetched]);

  // The documents as last read, for the flush's delta (see planReadStatePublish).
  const baseRef = useRef<ReadStateMap>({});
  const recentRef = useRef<ReadStateMap>({});
  useEffect(() => {
    baseRef.current = doc?.readState ?? {};
    recentRef.current = recentDoc?.readState ?? {};
  }, [doc?.readState, recentDoc?.readState]);

  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSync = useRef<ReadStateMap | null>(null);

  const [readState, setReadState] = useState<ReadStateMap>(() =>
    pubkey ? loadLocal(pubkey) : EMPTY,
  );

  useEffect(() => {
    setReadState(pubkey ? loadLocal(pubkey) : EMPTY);
    // Never publish one account's read-state into another's settings.
    pendingSync.current = null;
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, [pubkey]);

  const scheduleSync = useCallback(
    (map: ReadStateMap) => {
      pendingSync.current = map;
      if (!automaticSettingsSync || !hasNip44Support) return;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        const next = pendingSync.current;
        if (!next) return;
        // Never publish before both stored docs are read: each is replaced wholesale,
        // which is only safe once hydration has folded them in.
        if (!isFetchedRef.current) return;
        pendingSync.current = null;
        const plan = planReadStatePublish(next, baseRef.current, recentRef.current);
        const publish = plan.kind === "recent"
          ? updateRecent({ readState: plan.readState })
          : plan.kind === "rollover"
            // Base first: clearing the delta before the base lands would lose its entries.
            ? update({ readState: next }).then(() => updateRecent({ readState: {} }))
            : undefined;
        publish?.catch((err) => console.warn("Read-state sync failed:", err));
      }, SYNC_DEBOUNCE_MS);
    },
    [automaticSettingsSync, hasNip44Support, update, updateRecent],
  );

  // Opt-out stops the debounce but keeps the local map for later re-enable.
  useEffect(() => {
    if (automaticSettingsSync) return;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
  }, [automaticSettingsSync]);

  useEffect(() => {
    if (!automaticSettingsSync || !isFetched || !pendingSync.current) return;
    scheduleSync(pendingSync.current);
  }, [automaticSettingsSync, isFetched, scheduleSync]);

  useEffect(() => {
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  const getLastRead = useCallback(
    (key: string) => readState[key] ?? 0,
    [readState],
  );

  const markRead = useCallback(
    (key: string, stamp: number) => {
      if (!pubkey) return;
      const timestamp = capReadStamp(stamp, nowSecs());
      setReadState((prev) => {
        if ((prev[key] ?? 0) >= timestamp) return prev;
        const next = { ...prev, [key]: timestamp };
        saveLocal(pubkey, next);
        scheduleSync(next);
        return next;
      });
    },
    [pubkey, scheduleSync],
  );

  const hydrate = useCallback(
    (map: ReadStateMap) => {
      if (!pubkey) return;
      setReadState((prev) => {
        const merged = mergeReadState(prev, map);
        const changed = Object.keys(merged).some((k) => merged[k] !== prev[k]);
        if (!changed) return prev;
        saveLocal(pubkey, merged);
        return merged;
      });
    },
    [pubkey],
  );

  // Merge-hydrate here (not NostrSync) so it's ordered against the flush above.
  useEffect(() => {
    if (!automaticSettingsSync || !pubkey) return;
    const absorb = (incoming: ReadStateMap) => {
      if (pendingSync.current) {
        pendingSync.current = mergeReadState(pendingSync.current, incoming);
      }
      hydrate(incoming);
    };
    if (doc?.readState) absorb(doc.readState);
    if (recentDoc?.readState) absorb(recentDoc.readState);
    // Older copies (legacy account-signed, a superseded root) still hold reads.
    for (const source of [...baseSources, ...recentSources]) {
      if (source.doc.readState) absorb(source.doc.readState);
    }
    if (metadata?.readState) absorb(metadata.readState);
  }, [
    automaticSettingsSync,
    pubkey,
    doc?.readState,
    recentDoc?.readState,
    baseSources,
    recentSources,
    metadata?.readState,
    hydrate,
  ]);

  const value = useMemo(
    () => ({ readState, getLastRead, markRead, hydrate }),
    [readState, getLastRead, markRead, hydrate],
  );

  return <ReadStateContext.Provider value={value}>{children}</ReadStateContext.Provider>;
}
