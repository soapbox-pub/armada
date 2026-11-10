import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { contactListPubkeys } from "@/lib/contactList";
import { fetchFreshEvent } from "@/lib/fetchFreshEvent";
import { KIND_FOLLOW_LIST } from "@/lib/selfSyncKinds";

import type { FollowListData } from "@/hooks/useFollowList";
import type { NostrRumor } from "@/lib/nostrRumor";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

export interface UseFollowActionsReturn {
  isPending: boolean;
  /** Fetches the freshest kind 3 first, then publishes. */
  follow: (pubkey: string) => Promise<void>;
  unfollow: (pubkey: string) => Promise<void>;
}

/**
 * All kind-3 writes run one at a time, process-wide: concurrent read-modify-writes would
 * read the same list and the last publish would drop the other's edit (cf. useMuteList).
 */
let followListWriteChain: Promise<unknown> = Promise.resolve();

function serializeFollowListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = followListWriteChain.then(write, write);
  // Swallow on the chain so one failure doesn't wedge the queue; the caller still gets it.
  followListWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Replaceable events order by second and break ties by lowest id, so force strictly
 * increasing created_at for rapid consecutive edits.
 */
function nextCreatedAt(prev: NostrRumor | null): number {
  const now = nowSecs();
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/**
 * Safe follow/unfollow (ported from Ditto): fetch the freshest kind 3 right before mutating
 * (cached copy as a floor), and preserve all non-`p` tags and `content`. Never reads the query
 * cache, which may be stale.
 */
export function useFollowActions(): UseFollowActionsReturn {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const [isPending, setIsPending] = useState(false);

  const mutateFollowList = useCallback(
    async (targetPubkey: string, action: "follow" | "unfollow") => {
      if (!user) throw new Error(t({ id: "useFollowActions.notLoggedIn", defaultMessage: "Not logged in" }));
      setIsPending(true);

      try {
        await serializeFollowListWrite(async () => {
          const store = await eventStore;

          // Cached copy as a fallback so a relay miss can't wipe the follow list.
          const prev = await fetchFreshEvent(
            nostr,
            { kinds: [KIND_FOLLOW_LIST], authors: [user.pubkey] },
            { store },
          );

          const existingTags = prev?.tags ?? [];
          const pTags = existingTags.filter(([name]) => name === "p");
          const nonPTags = existingTags.filter(([name]) => name !== "p");

          let newPTags: string[][];
          if (action === "follow") {
            const alreadyFollowed = pTags.some(([, pk]) => pk === targetPubkey);
            newPTags = alreadyFollowed ? pTags : [...pTags, ["p", targetPubkey]];
          } else {
            newPTags = pTags.filter(([, pk]) => pk !== targetPubkey);
          }

          const newTags = [...nonPTags, ...newPTags];

          // Preserve content (relay hints / petnames in some clients).
          const content = prev?.content ?? "";

          const published = await publishEvent({
            kind: KIND_FOLLOW_LIST,
            content,
            tags: newTags,
            created_at: nextCreatedAt(prev),
            prev: prev ?? undefined,
          });

          // Seed store + cache with what we published: relays often haven't indexed it yet.
          void store.event(published);
          queryClient.setQueryData<FollowListData>(["follow-list", user.pubkey], {
            event: published,
            pubkeys: contactListPubkeys(published),
            // A local winner can't grant gateway prune authority until the all-relay read settles.
            wireReady: false,
          });

          // Safe: `fetchContactList` returns the newer of relay and cached copies.
          queryClient.invalidateQueries({ queryKey: ["follow-list"] });
        });
      } finally {
        setIsPending(false);
      }
    },
    [nostr, user, publishEvent, queryClient, eventStore],
  );

  const follow = useCallback(
    (pubkey: string) => mutateFollowList(pubkey, "follow"),
    [mutateFollowList],
  );

  const unfollow = useCallback(
    (pubkey: string) => mutateFollowList(pubkey, "unfollow"),
    [mutateFollowList],
  );

  return { isPending, follow, unfollow };
}
