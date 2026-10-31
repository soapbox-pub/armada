import type { QueryClient } from "@tanstack/react-query";

/** How deep a query's data is searched for rows; timelines and pages are shallow. */
const MAX_DEPTH = 4;

function isRow(value: unknown, id: string): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as { id?: unknown; rumorId?: unknown };
  return row.id === id || row.rumorId === id;
}

/** `value` without rows naming `id`, sharing every untouched branch; `value` itself if none. */
function without(value: unknown, id: string, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (isRow(item, id)) {
        changed = true;
        continue;
      }
      const next = without(item, id, depth + 1);
      if (next !== item) changed = true;
      out.push(next);
    }
    return changed ? out : value;
  }
  // Plain objects only: a Map or class instance is someone's own structure.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let out: Record<string, unknown> | undefined;
  for (const [key, field] of Object.entries(value)) {
    const next = without(field, id, depth + 1);
    if (next !== field) (out ??= { ...(value as Record<string, unknown>) })[key] = next;
  }
  return out ?? value;
}

/**
 * Drop a message removed from this device from every cached query: rows in
 * timelines, threads and pages, and a query whose whole answer is the message
 * (a quote or reply preview), which then reads as not found.
 */
export function scrubMessageFromQueries(queryClient: QueryClient, id: string): void {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data;
    if (data === undefined) continue;
    const next = isRow(data, id) ? null : without(data, id, 0);
    if (next !== data) queryClient.setQueryData(query.queryKey, next);
  }
}
