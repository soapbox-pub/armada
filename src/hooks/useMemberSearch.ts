import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useServerScope } from "@/contexts/ServerScopeContext";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";

import type { QueryClient } from "@tanstack/react-query";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { ServerProfile } from "@/lib/nip29";

type AuthorEntry = { event?: NostrEvent; metadata?: NostrMetadata } | undefined;

/** Re-render as matched profiles land in the cache; inert while no search is active. */
function useProfileCacheVersion(active: boolean): number {
  const queryClient = useQueryClient();
  const version = useRef(0);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active) return () => {};
      return queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const key = event.query.queryKey[0];
        if (key !== "author" && key !== "server-profile") return;
        version.current += 1;
        onChange();
      });
    },
    [active, queryClient],
  );

  return useSyncExternalStore(subscribe, () => version.current);
}

/** Per-server nickname plus global profile fields, read from the shared query cache. */
function searchableText(
  queryClient: QueryClient,
  relayUrl: string | undefined,
  pubkey: string,
): string {
  const author = queryClient.getQueryData<AuthorEntry>(["author", pubkey]);
  const metadata = author?.metadata;
  const scoped = relayUrl
    ? queryClient.getQueryData<ServerProfile | null>(["server-profile", relayUrl, pubkey])
    : undefined;

  return [
    scoped?.nickname,
    scoped?.label,
    metadata?.name,
    metadata?.display_name,
    metadata?.nip05,
    getDisplayName(metadata, pubkey),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Token match on names (every word anywhere, like `profileMatches` in
 * {@link useSearchProfiles}); key-like queries match an npub/hex *prefix*.
 * Returns `null` when no search is active ("show everything"), distinct from an empty set.
 */
export function useMemberSearch(pubkeys: string[], query: string): Set<string> | null {
  const queryClient = useQueryClient();
  const relayUrl = useServerScope();

  const normalized = query.trim().replace(/^@+/, "").toLowerCase();
  const active = normalized.length > 0;
  const version = useProfileCacheVersion(active);

  const rosterKey = pubkeys.join(",");

  return useMemo(() => {
    if (!active) return null;

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const byKey = normalized.startsWith("npub1") || /^[0-9a-f]{8,}$/.test(normalized);

    const matched = new Set<string>();
    for (const pubkey of pubkeys) {
      if (byKey) {
        const npub = normalized.startsWith("npub1") ? tryNpubEncode(pubkey) : undefined;
        if (pubkey.startsWith(normalized) || npub?.startsWith(normalized)) matched.add(pubkey);
        continue;
      }
      const haystack = searchableText(queryClient, relayUrl, pubkey);
      if (tokens.every((token) => haystack.includes(token))) matched.add(pubkey);
    }
    return matched;
    // `version` is a cache-revision tripwire that re-runs the match as names arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, normalized, rosterKey, relayUrl, queryClient, version]);
}

/** The name a roster sorts by: server nickname, else the profile's own; never "Anonymous". */
function sortName(queryClient: QueryClient, relayUrl: string | undefined, pubkey: string): string | undefined {
  const scoped = relayUrl
    ? queryClient.getQueryData<ServerProfile | null>(["server-profile", relayUrl, pubkey])
    : undefined;
  const metadata = queryClient.getQueryData<AuthorEntry>(["author", pubkey])?.metadata;
  const name = scoped?.nickname || metadata?.display_name || metadata?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * A roster comparator: by name (locale-aware), nameless members last, then pubkey.
 * Reads only cached profiles (fetching the roster's would spend the room's REQ
 * budget), and changes only when a name it sorted by does.
 */
export function useMemberNameOrder(locale: string): (a: string, b: string) => number {
  const queryClient = useQueryClient();
  const relayUrl = useServerScope();
  // The names the comparator has read; the subscription re-reads only these.
  // Fresh per cache and scope, since a nickname is read under the scope's relay.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const names = useMemo(() => new Map<string, string | undefined>(), [queryClient, relayUrl]);
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const key = event.query.queryKey;
        const pubkey = key[0] === "author" ? key[1] : key[0] === "server-profile" && key[1] === relayUrl ? key[2] : undefined;
        if (typeof pubkey !== "string" || !names.has(pubkey)) return;
        const name = sortName(queryClient, relayUrl, pubkey);
        if (name === names.get(pubkey)) return;
        names.set(pubkey, name);
        version.current += 1;
        onChange();
      }),
    [queryClient, relayUrl, names],
  );
  const revision = useSyncExternalStore(subscribe, () => version.current);
  return useMemo(() => {
    const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
    const nameOf = (pubkey: string) => {
      if (!names.has(pubkey)) names.set(pubkey, sortName(queryClient, relayUrl, pubkey));
      return names.get(pubkey);
    };
    return (a, b) => {
      const na = nameOf(a);
      const nb = nameOf(b);
      if (na && nb) return collator.compare(na, nb) || a.localeCompare(b);
      if (na || nb) return na ? -1 : 1;
      return a.localeCompare(b);
    };
    // `revision` is the name-change tripwire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, relayUrl, queryClient, names, revision]);
}
