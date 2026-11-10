import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_DELETE, KIND_REACTION } from "@/lib/nip29";

import type { MessageReactions } from "@/components/chat/transport";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

/**
 * A NIP-25 reaction by display key: `+`/empty → 👍, `-` → 👎; NIP-30 emoji keep `:shortcode:`
 * with the image URL from the `emoji` tag.
 */
export interface ReactionTally {
  key: string;
  /** Custom emoji image URL when the key is a `:shortcode:`. */
  url?: string;
  /** Distinct pubkeys that reacted with this key. */
  count: number;
  pubkeys: string[];
  /**
   * Per reactor, parallel to {@link pubkeys}: the image their own reaction named.
   * Lets the media hold show a trusted reactor's image rather than whoever was first.
   */
  urls?: (string | undefined)[];
  mine: boolean;
  /** The user's reaction event id for this key (to retract it). */
  mineEventId?: string;
}

export interface ReactInput {
  key: string;
  /** Raw content to publish (e.g. `+`, the emoji, or `:shortcode:`). */
  content: string;
  emojiUrl?: string;
  /** Remove the user's prior reaction instead (NIP-09 kind-5 deletion). */
  mineEventId?: string;
}

/** NIP-30 `["emoji", code, url]` tag for a `:shortcode:` reaction. Shared by NIP-29 and Concord. */
export function customEmojiReactionTags(content: string, emojiUrl?: string): string[][] {
  if (emojiUrl && content.startsWith(":") && content.endsWith(":")) {
    return [["emoji", content.slice(1, -1), emojiUrl]];
  }
  return [];
}

export function reactionKey(event: NostrRumor): string {
  return reactionContentKey(event.content);
}

export function reactionContentKey(content: string): string {
  if (content === "+" || content === "") return "👍";
  if (content === "-") return "👎";
  return content;
}

/** `muted` reactors are dropped before counting, so counts, names and `mine` agree. */
function tallyReactions(
  reactions: NostrRumor[],
  userPubkey: string | undefined,
  muted: ReadonlySet<string>,
): ReactionTally[] {
  // One reaction per (pubkey, key); the latest event wins.
  const latest = new Map<string, NostrRumor>();
  for (const reaction of reactions) {
    if (muted.has(reaction.pubkey)) continue;
    const key = `${reaction.pubkey}:${reactionKey(reaction)}`;
    const existing = latest.get(key);
    if (!existing || reaction.created_at > existing.created_at) {
      latest.set(key, reaction);
    }
  }

  const byKey = new Map<string, ReactionTally>();
  for (const reaction of latest.values()) {
    const key = reactionKey(reaction);
    const url = reaction.tags.find(([n]) => n === "emoji")?.[2];
    const tally = byKey.get(key) ?? { key, url, count: 0, pubkeys: [], mine: false };
    tally.count += 1;
    tally.pubkeys.push(reaction.pubkey);
    if (url && !tally.url) tally.url = url;
    if (userPubkey && reaction.pubkey === userPubkey) {
      tally.mine = true;
      tally.mineEventId = reaction.id;
    }
    byKey.set(key, tally);
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

/** Stable empty prop for messages without reactions. */
const EMPTY_TALLIES: ReactionTally[] = [];

/**
 * Live events are mirrored to the store asynchronously, so a fresh reaction may be missing
 * from a store read; after this long, missing means deleted.
 */
const MIRROR_GRACE_SECONDS = 60;

function reactionsKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "reactions", relayUrl, groupId] as const;
}

/**
 * NIP-25 reactions for a whole NIP-29 group in ONE batched `#e` query over the visible ids
 * (like Concord's `useConcordReactions`), with `reactionsFor(id)` per row. Local-first from the
 * store, then a background refresh + one live subscription.
 */
export function useGroupReactions(
  relayUrl: string | undefined,
  groupId: string | undefined,
  messageIds: string[],
  opts?: {
    /** Messages cache key for resolving targets at click time; Buzz channels pass their own. */
    messagesKey?: readonly unknown[];
  },
): { reactionsFor: (id: string) => MessageReactions } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const eventStore = useEventStore();
  const { mutateAsync: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const queryKey = reactionsKey(relayUrl, groupId);

  // Stable primitive dep.
  const idsSig = useMemo(() => [...messageIds].sort().join(","), [messageIds]);

  const reactionsQuery = useQuery<Map<string, NostrRumor[]>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const ids = idsSig ? idsSig.split(",") : [];
      if (!relayUrl || !groupId || ids.length === 0) return new Map();
      const store = await eventStore;

      // Cap so each per-id index cursor stops early (scan cost scales with the window).
      const limit = ids.length * 20;

      const cached = await store.query([{ kinds: [KIND_REACTION], "#e": ids, limit }]);

      // Not awaited — never gates render.
      void (async () => {
        if (signal.aborted) return;
        try {
          const fresh = await nostr.relay(relayUrl).query(
            [{ kinds: [KIND_REACTION], "#e": ids, limit }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          if (signal.aborted || fresh.length === 0) return;
          queryClient.setQueryData<Map<string, NostrRumor[]>>(queryKey, (old) =>
            mergeReactions(old, fresh),
          );
        } catch {
          // Best-effort; the local-first result already rendered.
        }
      })();

      // Union with the cache, but let the store PRUNE settled reactions: NIP-09 deletes show up only
      // as absence, and a fresh reaction may not be mirrored yet (see MIRROR_GRACE_SECONDS).
      const prev = queryClient.getQueryData<Map<string, NostrRumor[]>>(queryKey);
      const settledBefore = nowSecs() - MIRROR_GRACE_SECONDS;
      const unmirrored: NostrRumor[] = [];
      if (prev) {
        const cachedIds = new Set(cached.map((e) => e.id));
        for (const list of prev.values()) {
          for (const e of list) {
            if (cachedIds.has(e.id) || e.created_at < settledBefore) continue;
            unmirrored.push(e);
          }
        }
      }
      return mergeReactions(groupReactionsByTarget(cached), unmirrored);
    },
    enabled: Boolean(relayUrl && groupId) && Boolean(idsSig),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!relayUrl || !groupId || !idsSig) return;
    const ids = idsSig.split(",");
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_REACTION], "#e": ids, since: nowSecs() - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrRumor;
          queryClient.setQueryData<Map<string, NostrRumor[]>>(queryKey, (old) =>
            mergeReactions(old, [event]),
          );
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
    // queryKey is derived from relayUrl + groupId, both already deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, relayUrl, groupId, idsSig, queryClient]);

  const react = useMutation({
    // Drop removals up front, or the grace window would keep them on screen.
    onMutate: ({ mineEventId }: { target: NostrRumor } & ReactInput) => {
      if (!mineEventId) return;
      queryClient.setQueryData<Map<string, NostrRumor[]>>(queryKey, (old) => {
        if (!old) return old;
        const next = new Map<string, NostrRumor[]>();
        for (const [target, list] of old) {
          const kept = list.filter((e) => e.id !== mineEventId);
          if (kept.length > 0) next.set(target, kept);
        }
        return next;
      });
    },
    mutationFn: async ({ target, content, emojiUrl, mineEventId }: { target: NostrRumor } & ReactInput) => {
      if (mineEventId) {
        // The store self-applies same-author NIP-09; the relay enforces author-only deletion.
        await createEvent({
          kind: KIND_DELETE,
          content: "",
          tags: [
            ["e", mineEventId],
            ["k", String(KIND_REACTION)],
            ["h", groupId!],
          ],
          relay: relayUrl,
        });
      } else {
        const tags: string[][] = [
          ["e", target.id],
          ["p", target.pubkey],
          ["k", String(target.kind)],
          ["h", groupId!],
          ...customEmojiReactionTags(content, emojiUrl),
        ];
        await createEvent({ kind: KIND_REACTION, content, tags, relay: relayUrl });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    const map = reactionsQuery.data;
    if (!map) return out;
    for (const [targetId, reactions] of map) {
      out.set(targetId, tallyReactions(reactions, user?.pubkey, mutedPubkeys));
    }
    return out;
  }, [reactionsQuery.data, user?.pubkey, mutedPubkeys]);

  // Stable closures/objects per id so unchanged rows keep React.memo; `mutate` churns, so read it
  // from a ref at click time.
  const reactRef = useRef(react.mutate);
  reactRef.current = react.mutate;
  const reactCache = useRef(new Map<string, (input: ReactInput) => void>());
  const objCache = useRef(new Map<string, { tallies: ReactionTally[]; value: MessageReactions }>());

  const messagesKey = opts?.messagesKey ?? ["nip29", "messages", relayUrl, groupId];
  const reactionsFor = useCallback(
    (id: string): MessageReactions => {
      const tallies = talliesById.get(id) ?? EMPTY_TALLIES;
      const hit = objCache.current.get(id);
      if (hit && hit.tallies === tallies) return hit.value;
      let fn = reactCache.current.get(id);
      if (!fn) {
        // Resolve the target from the messages cache lazily at click time.
        const reactFn = (input: ReactInput) => {
          const messages =
            queryClient.getQueryData<NostrRumor[]>(messagesKey) ?? [];
          const target = messages.find((m) => m.id === id);
          if (!target) return;
          reactRef.current({ target, ...input });
        };
        reactCache.current.set(id, (fn = reactFn));
      }
      const value: MessageReactions = { tallies, react: fn };
      objCache.current.set(id, { tallies, value });
      return value;
    },
    // messagesKey's parts are covered by relayUrl/groupId at every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [talliesById, queryClient, relayUrl, groupId],
  );

  return { reactionsFor };
}

function groupReactionsByTarget(reactions: NostrRumor[]): Map<string, NostrRumor[]> {
  const out = new Map<string, NostrRumor[]>();
  for (const r of reactions) {
    const target = r.tags.find(([n]) => n === "e")?.[1];
    if (!target) continue;
    const list = out.get(target);
    if (list) list.push(r);
    else out.set(target, [r]);
  }
  return out;
}

/** De-duped by id. */
function mergeReactions(
  old: Map<string, NostrRumor[]> | undefined,
  incoming: NostrRumor[],
): Map<string, NostrRumor[]> {
  const next = new Map<string, NostrRumor[]>();
  if (old) for (const [k, v] of old) next.set(k, [...v]);
  for (const r of incoming) {
    const target = r.tags.find(([n]) => n === "e")?.[1];
    if (!target) continue;
    const list = next.get(target);
    if (!list) {
      next.set(target, [r]);
    } else if (!list.some((e) => e.id === r.id)) {
      list.push(r);
    }
  }
  return next;
}
