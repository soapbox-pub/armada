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

function isAuthors(value: unknown, author: string): value is { content?: unknown; tags?: unknown; preview?: unknown } {
  if (!value || typeof value !== "object") return false;
  const row = value as { pubkey?: unknown; author?: unknown };
  return row.pubkey === author || row.author === author;
}

/** `value` with `author`'s rows tombstoned, sharing every untouched branch; `value` itself if none. */
function tombstonedIn(value: unknown, author: string, keep: ReadonlySet<string>, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (isAuthors(value, author) && (typeof value.content === "string" || "preview" in value)) {
    const row = { ...(value as Record<string, unknown>) };
    if (typeof row.content === "string") row.content = "";
    if (Array.isArray(row.tags)) row.tags = (row.tags as unknown[]).filter((tag) => Array.isArray(tag) && keep.has(tag[0] as string));
    if ("preview" in row) row.preview = undefined;
    return row;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = tombstonedIn(item, author, keep, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let out: Record<string, unknown> | undefined;
  for (const [key, field] of Object.entries(value)) {
    const next = tombstonedIn(field, author, keep, depth + 1);
    if (next !== field) (out ??= { ...(value as Record<string, unknown>) })[key] = next;
  }
  return out ?? value;
}

/**
 * Empty a banned user's messages in every cached query, keeping each row (and
 * the `keep` tags that place it) so a tombstone shows where it was.
 */
export function tombstoneAuthorInQueries(queryClient: QueryClient, author: string, keep: ReadonlySet<string>): void {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data;
    if (data === undefined) continue;
    const next = tombstonedIn(data, author, keep, 0);
    if (next !== data) queryClient.setQueryData(query.queryKey, next);
  }
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
