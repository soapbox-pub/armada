import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

/** Keys invalidated in the current synchronous run, per client. */
const asked = new WeakMap<QueryClient, Set<string>>();

/**
 * Invalidate `queryKey` once, however many mounted copies of a hook ask in the same
 * synchronous run (one bus delivery, one commit's effects). Each extra call would cancel
 * the refetch the first one started and start another, and the cancelled store read
 * runs on regardless: a ring heard by seven copies cost seven reads.
 */
export function invalidateOnce(queryClient: QueryClient, queryKey: QueryKey): void {
  let keys = asked.get(queryClient);
  if (!keys) {
    keys = new Set();
    asked.set(queryClient, keys);
  }
  const hash = hashKey(queryKey);
  if (keys.has(hash)) return;
  if (keys.size === 0) queueMicrotask(() => keys.clear());
  keys.add(hash);
  void queryClient.invalidateQueries({ queryKey });
}
