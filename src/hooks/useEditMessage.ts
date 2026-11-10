import { useMutation } from "@tanstack/react-query";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_DELETE } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/**
 * Edit an own message NIP-09 style: delete (kind 5) and republish with the SAME
 * `created_at` (the relay has a kind-9 timestamp exemption). Tags are preserved; an
 * `["edited", <unix>]` tag records the edit. Returns the new event.
 */
export function useEditMessage(relayUrl: string, groupId: string) {
  const { mutateAsync: publish } = useNostrPublish();

  return useMutation<NostrEvent | null, Error, { original: NostrRumor; content: string }>({
    mutationFn: async ({ original, content }) => {
      const trimmed = content.trim();
      if (!trimmed) throw new Error(t({ id: "useEditMessage.empty", defaultMessage: "Message cannot be empty" }));
      if (trimmed === original.content.trim()) return null;

      // `h` scopes the delete to the group; `k` records the deleted kind per NIP-09.
      await publish({
        kind: KIND_DELETE,
        content: "",
        tags: [
          ["e", original.id],
          ["k", String(original.kind)],
          ["h", groupId],
        ],
        relay: relayUrl,
      });

      const tags = original.tags.filter(([name]) => name !== "edited");
      tags.push(["edited", String(nowSecs())]);

      const edited = await publish({
        kind: original.kind,
        content: trimmed,
        tags,
        created_at: original.created_at,
        relay: relayUrl,
      });

      return edited;
    },
  });
}

/** Self-delete (NIP-09 kind 5). Moderator deletes use kind 9005 in `useGroupModeration`. */
export function useDeleteOwnMessage(relayUrl: string, groupId: string) {
  const { mutateAsync: publish } = useNostrPublish();

  return useMutation<void, Error, { event: NostrRumor }>({
    mutationFn: async ({ event }) => {
      await publish({
        kind: KIND_DELETE,
        content: "",
        tags: [
          ["e", event.id],
          ["k", String(event.kind)],
          ["h", groupId],
        ],
        relay: relayUrl,
      });
    },
  });
}
