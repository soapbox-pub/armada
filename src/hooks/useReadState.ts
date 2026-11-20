import { useCallback, useContext, useSyncExternalStore } from "react";

import {
  ReadStateContext,
  ReadStateStoreContext,
  type ReadStateMap,
  type ReadStateStore,
  channelReadKey,
  concordInviteReadKey,
  concordMentionReadKey,
  concordReadKey,
  concordThreadReadKey,
  dmReadKey,
} from "@/contexts/ReadStateContext";

export {
  channelReadKey,
  concordInviteReadKey,
  concordMentionReadKey,
  concordReadKey,
  concordThreadReadKey,
  dmReadKey,
};

/** Access per-conversation read-state (last-read timestamps). */
export function useReadState() {
  const ctx = useContext(ReadStateContext);
  if (!ctx) {
    throw new Error("useReadState must be used within a ReadStateProvider");
  }
  return ctx;
}

function useReadStateStore(): ReadStateStore {
  const store = useContext(ReadStateStoreContext);
  if (!store) {
    throw new Error("useReadStateSelect must be used within a ReadStateProvider");
  }
  return store;
}

/**
 * A slice of the read-state, re-rendering only when it changes. `select` must return a
 * primitive (a stamp, or a signature string over several), since it's compared by identity.
 */
export function useReadStateSelect<T extends string | number | boolean | undefined>(select: (map: ReadStateMap) => T): T {
  const store = useReadStateStore();
  const getSnapshot = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * `markRead`, and `getLastRead` reading the latest state, both never changing identity.
 * A reader depending on a stamp selects it with {@link useReadStateSelect}.
 */
export function useReadStateActions(): Pick<ReadStateStore, "markRead" | "getLastRead"> {
  return useReadStateStore();
}

/** The read-state as it stands, read when called; never changes identity and subscribes to nothing. */
export function useReadStateGetter(): () => ReadStateMap {
  return useReadStateStore().get;
}
