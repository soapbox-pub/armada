import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_COMMENT, KIND_GROUP_CHAT } from "@/lib/nip29";
import { buildNip29ThreadReplyTags, nip29ThreadRootOf } from "@/lib/nip29Threads";

import { toChatMsg } from "@/components/chat/transport";
import type { ChatMsg } from "@/components/chat/transport";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

/** Kind-9 thread replies name their root in `#e`; legacy kind-1111 comments in `#E`. */
function threadFilters(ids: string[], groupId: string, window: Pick<NostrFilter, "since" | "limit">): NostrFilter[] {
  // `#h` is REQUIRED: relay29 serves no filter with an `#E`/`#e` alone.
  return [
    { kinds: [KIND_GROUP_CHAT], "#e": ids, "#h": [groupId], ...window },
    { kinds: [KIND_COMMENT], "#E": ids, "#h": [groupId], ...window },
  ];
}

/**
 * Replies and counts for all visible messages in ONE batched query plus one live subscription,
 * exposed via `replyCountFor(id)` / `threadRepliesFor(id)` (thread shape: `nip29Threads.ts`).
 * `localReplies` are thread replies the caller already holds (the timeline's own kind-9s),
 * merged in so a reply the store has is never waiting on the relay.
 */
export function useGroupThreads(
  relayUrl: string | undefined,
  groupId: string | undefined,
  messageIds: string[],
  localReplies: readonly NostrRumor[] = EMPTY_RUMORS,
): {
  replyCountFor: (id: string) => number;
  threadRepliesFor: (rootId: string) => ChatMsg[];
} {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const queryKey = ["nip29", "reply-counts", relayUrl, groupId] as const;

  const idsSig = useMemo(() => [...messageIds].sort().join(","), [messageIds]);

  const query = useQuery<Map<string, NostrRumor[]>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const ids = idsSig ? idsSig.split(",") : [];
      if (!relayUrl || !groupId || ids.length === 0) return new Map();
      const events = await nostr.relay(relayUrl).query(
        threadFilters(ids, groupId, { limit: ids.length * 20 }),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return bucketReplies(events);
    },
    enabled: Boolean(relayUrl && groupId) && Boolean(idsSig),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!relayUrl || !groupId || !idsSig) return;
    const ids = idsSig.split(",");
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          threadFilters(ids, groupId, { since: nowSecs() - 5 }),
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          const root = nip29ThreadRootOf(event);
          if (!root) continue;
          queryClient.setQueryData<Map<string, NostrRumor[]>>(queryKey, (old) => {
            const list = old?.get(root) ?? [];
            if (list.some((e) => e.id === event.id)) return old;
            const next = new Map(old);
            next.set(root, [...list, event]);
            return next;
          });
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, relayUrl, groupId, idsSig, queryClient]);

  const merged = useMemo(() => {
    if (localReplies.length === 0) return query.data;
    return bucketReplies([...localReplies, ...[...(query.data?.values() ?? [])].flat()]);
  }, [query.data, localReplies]);

  const replyCountFor = useCallback(
    (id: string) => merged?.get(id)?.length ?? 0,
    [merged],
  );

  // Identity-cached so unchanged threads keep stable references for React.memo.
  const adapted = useMemo(() => {
    const out = new Map<string, ChatMsg[]>();
    for (const [rootId, events] of merged ?? []) {
      const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
      out.set(rootId, sorted.map((e) => toChatMsg(e)));
    }
    return out;
  }, [merged]);

  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => adapted.get(rootId) ?? EMPTY_REPLIES,
    [adapted],
  );

  return { replyCountFor, threadRepliesFor };
}

const EMPTY_REPLIES: ChatMsg[] = [];
const EMPTY_RUMORS: NostrRumor[] = [];

/**
 * Post a kind-9 thread reply to the host relay; the live subscription folds the echo back,
 * so no optimistic insert. `composerTags` (mentions, hashtags, emoji, imeta, quotes) are merged
 * into the reply skeleton, minus `h`/`e`/`q` and duplicate `p`s.
 */
export function useSendThreadReply(relayUrl: string, groupId: string) {
  const { mutateAsync: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  return useCallback(
    async (root: NostrRumor, content: string, composerTags: string[][] = []) => {
      const tags = buildNip29ThreadReplyTags(root, groupId, relayUrl);
      for (const tag of composerTags) {
        // Thread structure comes from buildNip29ThreadReplyTags; the composer's variants would conflict.
        if (tag[0] === "h" || tag[0] === "e" || (tag[0] === "q" && tag[1] === root.id)) continue;
        // De-dupe mention p tags against the parent-author p tag.
        if (tag[0] === "p" && tags.some(([n, v]) => n === "p" && v === tag[1])) continue;
        tags.push(tag);
      }
      await createEvent({
        kind: KIND_GROUP_CHAT,
        content,
        tags,
        relay: relayUrl,
      });
      queryClient.invalidateQueries({ queryKey: ["nip29", "reply-counts", relayUrl, groupId] });
    },
    [createEvent, queryClient, relayUrl, groupId],
  );
}

/** De-duped by reply id. A kind 9 that is not a thread reply is dropped. */
function bucketReplies(events: Iterable<NostrRumor>): Map<string, NostrRumor[]> {
  const out = new Map<string, NostrRumor[]>();
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    const root = nip29ThreadRootOf(event);
    if (!root) continue;
    seen.add(event.id);
    const list = out.get(root) ?? [];
    list.push(event);
    out.set(root, list);
  }
  return out;
}
