import { useNostr } from "@nostrify/react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { APP_NAME } from "@/lib/platform";
import { t } from "@/i18n";
import { publishSignedEventToRelays, uniqueRelayUrls } from "@/lib/nip65";
import {
  PublishQueuedError,
  isPublishOutboxConflictError,
  isPublishQueuedError,
  queueSignedEvent,
  recordQueuedPublishAttempt,
  removeQueuedPublish,
} from "@/lib/publishOutbox";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import { useCurrentUser } from "./useCurrentUser";
import { useEventStore } from "./useEventStore";

import type { NostrEvent } from "@nostrify/nostrify";

import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

export type EventTemplate = Omit<NostrEvent, "id" | "pubkey" | "sig" | "created_at"> & {
  created_at?: number;
  /** Previous version of a replaceable event; its `published_at` is preserved. */
  prev?: NostrRumor;
  /** Publish only to this relay (NIP-29 traffic stays on its host). Default: all servers. */
  relay?: string;
  /** Exact relay set (portable self-state to NIP-65 write relays). Exclusive with `relay`. */
  relays?: string[];
  /**
   * Disable only when the document was merged from a partial read and is unsafe for
   * unanswered relays.
   */
  inheritPendingTargets?: boolean;
  /** Called with the signed event before sending, for optimistic inserts. */
  onSigned?: (event: NostrEvent) => void;
};

function isReplaceableKind(kind: number): boolean {
  if (kind === 0 || kind === 3) return true;
  return (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}

export function useNostrPublish(): UseMutationResult<NostrEvent, Error, EventTemplate> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  return useMutation({
    mutationFn: async (request: EventTemplate) => {
      if (!user) {
        throw new Error(t({ id: "useNostrPublish.notLoggedIn", defaultMessage: "User is not logged in" }));
      }

      const {
        prev,
        relay,
        relays,
        inheritPendingTargets,
        onSigned,
        ...template
      } = request;
      if (relay && relays) throw new Error("Specify either relay or relays, not both");
      const exactRelays = relays ? uniqueRelayUrls(relays) : undefined;
      if (relays && exactRelays?.length === 0) {
        throw new Error(t({ id: "useNostrPublish.noRelays", defaultMessage: "Add at least one relay before publishing this account state" }));
      }
      // NIP-89: always stamp this build; replaceable RMW often copies another app's `client` tag.
      const tags = [
        ...(template.tags ?? []).filter(([name]) => name !== "client"),
        ["client", APP_NAME],
      ];

      const created_at = template.created_at ?? nowSecs();

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
          t({
            id: "useNostrPublish.pubkeyMismatch",
            defaultMessage: "Signed event pubkey does not match the currently selected account. Please check your signer configuration.",
          }),
        );
      }

      // Before publishing: the push gateway may echo it before normal ingest.
      await markOwnWebPushEvent(event.id);

      // Stored locally first (offline visibility), under the relay it's published to. The retry
      // copy is the outbox below: the store drops `sig`.
      void eventStore.then((store) => store.event(event, { relay })).catch(() => undefined);
      // Awaited so it can't land after a successful publish's removal; not fatal, since KV can fail
      // (quota, iOS Lockdown Mode).
      let durablyQueued = false;
      try {
        await queueSignedEvent(event, relay, exactRelays, {
          inheritPendingTargets,
        });
        durablyQueued = true;
      } catch (error) {
        if (isPublishOutboxConflictError(error)) throw error;
        // If delivery fails, the catch must not claim it was queued.
      }

      onSigned?.(event);

      try {
        // An auth-gating relay may need a NIP-42 sign here (a bunker round-trip).
        const timeout = publishTimeoutMs(user.method);
        if (relay) {
          await nostr.relay(relay).event(event, { signal: AbortSignal.timeout(timeout) });
        } else if (exactRelays) {
          const result = await publishSignedEventToRelays(nostr, event, exactRelays, timeout);
          // Settle only the destinations THIS attempt addressed; inherited targets stay pending.
          await recordQueuedPublishAttempt(event.id, exactRelays, result.rejected).catch(() => undefined);
          if (result.rejected.length > 0) {
            throw new Error(
              result.accepted.length > 0
                ? t(
                  {
                    id: "useNostrPublish.partiallyQueued",
                    defaultMessage: "Queued for {count, plural, one {# relay} other {# relays}} that did not accept it",
                  },
                  { count: result.rejected.length },
                )
                : t({ id: "useNostrPublish.noneAccepted", defaultMessage: "No requested relay accepted the event" }),
            );
          }
        } else {
          await nostr.event(event, { signal: AbortSignal.timeout(timeout) });
        }
      } catch (error) {
        if (durablyQueued) throw new PublishQueuedError(event, error);
        throw error;
      }

      // Outside the try: the relay accepted it, so a queue-clear failure isn't a failed publish.
      if (!exactRelays) await removeQueuedPublish(event.id).catch(() => undefined);

      return event;
    },
    onError: (error) => {
      if (isPublishQueuedError(error)) return;
      console.error("Failed to publish event:", error);
    },
  });
}

/** Re-publish an already-signed event without re-signing; the id is preserved. */
export function useRepublish(): UseMutationResult<
  NostrEvent,
  Error,
  { event: NostrEvent; relay?: string }
> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ event, relay }) => {
      // Store copies have `sig: ""`, which every relay rejects; fail loudly instead of looping.
      if (!event.sig) {
        throw new Error(t({ id: "useNostrPublish.unsigned", defaultMessage: "Cannot re-publish an unsigned event (its signature was not preserved)." }));
      }
      await markOwnWebPushEvent(event.id);
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
