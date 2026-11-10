import { useNostr } from "@nostrify/react";
import { useMutation } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_RELAY_INVITE, KIND_RELAY_JOIN } from "@/lib/nip29";
import { nowSecs } from "@/lib/relayClock";

/**
 * Relay-level membership for community relays (zooid/Coracle, behind Flotilla/Soapbox), which
 * gate everything on relay membership. Join = ephemeral kind 28934 with a `claim` minted as kind
 * 28935 (see zooid `ValidateJoinRequest`, Flotilla `attemptRelayAccess`). Speculative and never
 * throws: the NIP-29 group join is the source of truth.
 */

/** Supporting relays issue one kind 28935 per authed pubkey; undefined if none is issued. */
export function useRelayClaim() {
  const { nostr } = useNostr();

  return useMutation({
    mutationFn: async (relayUrl: string): Promise<string | undefined> => {
      try {
        const events = await nostr.relay(relayUrl).query(
          [{ kinds: [KIND_RELAY_INVITE], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const claim = events[0]?.tags.find(([n]) => n === "claim")?.[1];
        return claim || undefined;
      } catch {
        return undefined;
      }
    },
  });
}

/**
 * Best-effort, never throws; non-supporting relays reject the unknown kind (e.g. relay29 for
 * lacking `h`).
 */
export function useJoinRelay() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async ({ relayUrl, claim }: { relayUrl: string; claim?: string }) => {
      if (!user) return;

      const tags: string[][] = [];
      if (claim) tags.push(["claim", claim]);

      try {
        const event = await user.signer.signEvent({
          kind: KIND_RELAY_JOIN,
          content: "",
          tags,
          created_at: nowSecs(),
        });
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(8000) });
      } catch {
        // Best-effort: any failure (unsupported kind, timeout, h-tag policy,
        // bad claim) is non-fatal here. The group join reports the real outcome.
      }
    },
  });
}
