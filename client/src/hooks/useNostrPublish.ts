import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { APP_NAME } from "@/lib/platform";
import { PublishQueuedError, isPublishQueuedError, queueSignedEvent, removeQueuedPublish } from "@/lib/publishOutbox";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { useCurrentUser } from "./useCurrentUser";
import { useEventStore } from "./useEventStore";

import type { NostrEvent } from "@nostrify/nostrify";

/** Event template accepted by `useNostrPublish`. */
export type EventTemplate = Omit<NostrEvent, "id" | "pubkey" | "sig" | "created_at"> & {
  created_at?: number;
  /**
   * The previous version of the event being replaced (for replaceable/addressable kinds).
   * When provided, `published_at` from the old event is preserved on the new one.
   */
  prev?: NostrEvent;
  /**
   * When set, publish only to this relay (NIP-29 group traffic must stay on
   * the group's host server). When omitted, the event goes to all configured
   * servers via the pool's eventRouter.
   */
  relay?: string;
  /**
   * Called with the fully-signed event immediately before it is sent to the
   * network. Lets callers optimistically insert the event into a local cache
   * (and learn its final id) before the relay round-trip completes.
   */
  onSigned?: (event: NostrEvent) => void;
};

/** Returns true if the kind falls in a replaceable or addressable range. */
function isReplaceableKind(kind: number): boolean {
  if (kind === 0 || kind === 3) return true;
  return (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, EventTemplate> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  return useMutation({
    mutationFn: async (t: EventTemplate) => {
      if (!user) {
        throw new Error("User is not logged in");
      }

      const { prev, relay, onSigned, ...template } = t;
      const tags = [...(template.tags ?? [])];

      // NIP-89 client tag
      if (!tags.some(([name]) => name === "client")) {
        tags.push(["client", APP_NAME]);
      }

      const created_at = template.created_at ?? Math.floor(Date.now() / 1000);

      // published_at for replaceable/addressable events (NIP-24)
      if (isReplaceableKind(template.kind) && !tags.some(([name]) => name === "published_at")) {
        const oldTag = prev?.tags.find(([name]) => name === "published_at");
        if (oldTag) {
          tags.push(["published_at", oldTag[1]]);
        } else if (!prev) {
          tags.push(["published_at", String(created_at)]);
        }
      }

      const event = await user.signer.signEvent({
        kind: template.kind,
        content: template.content ?? "",
        tags,
        created_at,
      });

      if (event.pubkey !== user.pubkey) {
        throw new Error(
          "Signed event pubkey does not match the currently selected account. Please check your signer configuration.",
        );
      }

      // Store the signed event locally before any network work. This makes
      // offline-created profiles/settings visible immediately and gives the
      // retry worker a durable copy if the app closes before relays recover.
      void eventStore.then((store) => store.event(event)).catch(() => undefined);
      queueSignedEvent(event, relay);

      // Let callers optimistically render the event before the network call.
      onSigned?.(event);

      try {
        // Wider window for bunker logins: an auth-gating relay can embed a
        // remote NIP-42 sign inside this round-trip (see publishTimeout.ts).
        const timeout = publishTimeoutMs(user.method);
        if (relay) {
          await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(timeout) });
        } else {
          await nostr.event(event, { signal: AbortSignal.timeout(timeout) });
        }
        removeQueuedPublish(event.id);
      } catch (error) {
        throw new PublishQueuedError(event, error);
      }

      return event;
    },
    onError: (error) => {
      if (isPublishQueuedError(error)) return;
      console.error("Failed to publish event:", error);
    },
  });
}

/**
 * Re-publish an already-signed event (e.g. retrying a failed optimistic send).
 * Unlike `useNostrPublish`, this does not re-sign or mutate tags — the event id
 * is preserved so it reconciles with the original optimistic message.
 */
export function useRepublish(): UseMutationResult<
  NostrEvent,
  Error,
  { event: NostrEvent; relay?: string }
> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ event, relay }) => {
      const timeout = publishTimeoutMs(user?.method);
      if (relay) {
        await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(timeout) });
      } else {
        await nostr.event(event, { signal: AbortSignal.timeout(timeout) });
      }
      return event;
    },
  });
}
