import { useNostr } from "@nostrify/react";
import { useMutation } from "@tanstack/react-query";

import { useAppContext } from "./useAppContext";
import { useCurrentUser } from "./useCurrentUser";
import { useNip29Servers } from "./useNip29Servers";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/**
 * Publish a NIP-62 Request to Vanish (kind 62): targeted (`relay` tags) or global (ALL_RELAYS).
 * The user should be logged out afterwards.
 */
export function useRequestToVanish() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const servers = useNip29Servers();

  return useMutation({
    mutationFn: async ({ relayUrls, content }: { relayUrls: string[]; content: string }) => {
      if (!user) throw new Error(t({ id: "useRequestToVanish.notLoggedIn", defaultMessage: "User is not logged in" }));

      const isGlobal = relayUrls.includes("ALL_RELAYS");

      const tags: string[][] = relayUrls.map((url) => ["relay", url]);

      const event = await user.signer.signEvent({
        kind: 62,
        content,
        tags,
        created_at: nowSecs(),
      });

      if (isGlobal) {
        await nostr.event(event, { signal: AbortSignal.timeout(10_000) });

        // Also send to each configured relay directly, for redundancy.
        const relaySet = new Set<string>([
          ...servers,
          ...config.appRelays,
          ...config.dmRelays,
        ]);
        const directSends = [...relaySet].map((url) =>
          nostr.relay(url).event(event, { signal: AbortSignal.timeout(10_000) }).catch(() => {
            // Swallow individual relay errors — best-effort delivery.
          }),
        );
        await Promise.allSettled(directSends);
      } else {
        const sends = relayUrls.map((url) =>
          nostr.relay(url).event(event, { signal: AbortSignal.timeout(10_000) }).catch(() => {
            // Swallow individual relay errors — best-effort delivery.
          }),
        );
        await Promise.allSettled(sends);
      }

      return event;
    },
  });
}
