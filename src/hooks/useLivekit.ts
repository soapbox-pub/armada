import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_GROUP_PARTICIPANTS, parseGroupParticipants } from "@/lib/nip29";
import { relayToHttpUrl } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrSigner } from "@nostrify/types";
import { t } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/** NIP-98 HTTP Auth event kind. */
const KIND_HTTP_AUTH = 27235;

interface LivekitTokenResponse {
  token: string;
  url: string;
}

/**
 * NIP-29 LiveKit extension probe: STRICTLY 204 at /.well-known/nip29/livekit — an SPA
 * catch-all answers 200 with HTML, which would advertise voice on a host that can't serve tokens.
 */
export function useRelayLivekitSupport(relayUrl: string | undefined) {
  return useQuery({
    queryKey: ["nip29", "livekit-support", relayUrl],
    queryFn: async ({ signal }) => {
      try {
        const res = await fetch(`${relayToHttpUrl(relayUrl!)}/.well-known/nip29/livekit`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        return res.status === 204;
      } catch {
        return false;
      }
    },
    enabled: Boolean(relayUrl),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * LiveKit JWT from the relay's NIP-29 token endpoint via NIP-98 auth. `roomId` is a NIP-29
 * group id (DM calls use `src/lib/dmCall.ts`).
 */
async function fetchLivekitToken(
  relayUrl: string,
  roomId: string,
  signer: NostrSigner,
): Promise<LivekitTokenResponse> {
  // Don't percent-encode: the relay rebuilds the NIP-98 `u` URL from the decoded path, so an
  // encoded `u` would 401. Escape only path-breaking characters.
  const safeId = roomId.replace(/[/?#\s]/g, (c) => encodeURIComponent(c));
  const endpointUrl = `${relayToHttpUrl(relayUrl)}/.well-known/nip29/livekit/${safeId}`;

  const event = await signer.signEvent({
    kind: KIND_HTTP_AUTH,
    content: "",
    tags: [
      ["u", endpointUrl],
      ["method", "GET"],
    ],
    created_at: nowSecs(),
  });

  const res = await fetch(endpointUrl, {
    method: "GET",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
    },
  });

  if (!res.ok) {
    throw new Error(t({ id: "useLivekit.tokenFailed", defaultMessage: "LiveKit token request failed: HTTP {status}" }, { status: res.status }));
  }
  // An SPA catch-all returns HTML with 200; don't parse it as JSON.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(t({ id: "useLivekit.noToken", defaultMessage: "The relay did not return a voice token (no LiveKit support?)" }));
  }

  const data: Record<string, string> = await res.json();
  const token = data.participant_token ?? data.token;
  const url = data.server_url ?? data.url;
  if (!token || !url) {
    throw new Error("LiveKit token response missing token or url");
  }
  return { token, url };
}

export function useLivekitToken(relayUrl: string, roomId: string, enabled: boolean) {
  const { user } = useCurrentUser();

  return useQuery({
    queryKey: ["nip29", "livekit-token", relayUrl, roomId, user?.pubkey],
    queryFn: async () => {
      if (!user) throw new Error(t({ id: "useLivekit.notLoggedIn", defaultMessage: "Not logged in" }));
      return fetchLivekitToken(relayUrl, roomId, user.signer);
    },
    enabled: enabled && Boolean(user),
    // The token must stay STABLE for a call: each mint embeds a fresh LiveKit identity, so a
    // refetch forces a rejoin as a different participant. Valid for 6h.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}

/** Live participants of a group's AV room (kind 39004, relay-signed). */
export function useLivekitParticipants(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const query = useQuery<string[]>({
    queryKey: ["nip29", "livekit-participants", relayUrl, groupId],
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_GROUP_PARTICIPANTS], "#d": [groupId!], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return latest ? parseGroupParticipants(latest) : [];
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!relayUrl || !groupId) return;
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_GROUP_PARTICIPANTS], "#d": [groupId], since: nowSecs() }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            queryClient.setQueryData<string[]>(
              ["nip29", "livekit-participants", relayUrl, groupId],
              parseGroupParticipants(event),
            );
          }
        }
      } catch {
        // Subscription ended.
      }
    })();

    return () => controller.abort();
  }, [nostr, relayUrl, groupId, queryClient]);

  return query;
}

/** LiveKit identities start with the 64-char hex pubkey. */
export function pubkeyFromLivekitIdentity(identity: string): string {
  const match = identity.match(/^[0-9a-f]{64}/);
  return match ? match[0] : identity;
}
