import { useCallback, useSyncExternalStore } from "react";

import { getSyncTasks, onSyncActivity, type SyncTask } from "@/lib/syncActivity";

function subscribe(onStoreChange: () => void): () => void {
  return onSyncActivity(onStoreChange);
}

/**
 * In-flight background catch-up tasks (src/lib/syncActivity.ts). Debounce with useDelayedFlag
 * so fast syncs show nothing.
 */
export function useSyncTasks(): readonly SyncTask[] {
  return useSyncExternalStore(subscribe, getSyncTasks);
}

/** Whether any task is in flight: a boolean, so progress alone re-renders nothing. */
export function useSyncActive(): boolean {
  return useSyncExternalStore(subscribe, () => getSyncTasks().length > 0);
}

/**
 * Whether a task scoped to `scope` is in flight. A boolean snapshot, so a
 * screen re-renders only when that answer flips, not on every task's progress.
 */
export function useSyncTaskInScope(scope: string | undefined): boolean {
  const getSnapshot = useCallback(
    () => scope !== undefined && getSyncTasks().some((t) => t.scope === scope),
    [scope],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
