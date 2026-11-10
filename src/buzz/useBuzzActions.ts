import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNostr } from "@nostrify/react";

import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_TYPING_INDICATOR,
} from "@/buzz/kinds";
import { buildBuzzReplyTags, buzzThreadRef } from "@/buzz/protocol";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { t } from "@/i18n";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { isPlausiblyLive, liveSignalSince } from "@/lib/liveSignal";

/**
 * Edit via kind-40003 (content = FULL replacement, `e`-tagged at the original).
 * The original stays; clients fold the newest edit onto it.
 */
export function useBuzzEditMessage(relayUrl: string, channelId: string) {
  const { mutateAsync: publish } = useNostrPublish();

  return useMutation<NostrEvent | null, Error, { original: NostrRumor; content: string }>({
    mutationFn: async ({ original, content }) => {
      const trimmed = content.trim();
      if (!trimmed) throw new Error(t({ id: "useBuzzActions.emptyMessage", defaultMessage: "Message cannot be empty" }));
      if (trimmed === original.content.trim()) return null; // no-op
      return await publish({
        kind: KIND_STREAM_MESSAGE_EDIT,
        content: trimmed,
        tags: [
          ["h", channelId],
          ["e", original.id],
        ],
        relay: relayUrl,
      });
    },
  });
}

/**
 * Post a Buzz thread reply with NIP-10 marked `root`/`reply` tags. The
 * composer's `h`/`e` tags are replaced. `replyKind`: 9 for stream, 45003 for forum.
 */
export function useSendBuzzThreadReply(
  relayUrl: string,
  channelId: string,
  replyKind: number = KIND_STREAM_MESSAGE,
) {
  const { mutateAsync: publish } = useNostrPublish();
  return useCallback(
    async (root: NostrRumor, content: string, composerTags: string[][] = []) => {
      // Parent = root unless the root is itself a broadcast reply in a deeper thread.
      const ref = buzzThreadRef(root.tags);
      const rootId = ref.rootId ?? root.id;
      const tags = buildBuzzReplyTags(channelId, root.pubkey, root.id, rootId);
      for (const tag of composerTags) {
        if (tag[0] === "h" || tag[0] === "e") continue;
        if (tag[0] === "p" && tags.some(([n, v]) => n === "p" && v === tag[1])) continue;
        tags.push(tag);
      }
      await publish({
        kind: replyKind,
        content,
        tags,
        relay: relayUrl,
      });
    },
    [publish, relayUrl, channelId, replyKind],
  );
}

/** How long a Buzz typing signal is considered live (relay guidance: ~10s). */
const TYPING_WINDOW_MS = 8_000;
/** Minimum gap between published typing signals. */
const TYPING_THROTTLE_MS = 4_000;

/**
 * Live "who is typing" (ephemeral kind 20002, `h`-scoped) plus a throttled
 * publisher for the viewer's own signal.
 */
export function useBuzzTyping(
  relayUrl: string | undefined,
  channelId: string | undefined,
): { typers: string[]; publishTyping: () => void } {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const enabled = useAppContext().config.dmTypingIndicators;
  const [typers, setTypers] = useState<string[]>([]);
  const seen = useRef(new Map<string, number>());
  const lastSent = useRef(0);

  useEffect(() => {
    seen.current = new Map();
    setTypers([]);
    if (!enabled || !relayUrl || !channelId) return;
    const controller = new AbortController();

    const recompute = () => {
      const now = Date.now();
      const live: string[] = [];
      for (const [pk, ms] of seen.current) {
        if (now - ms <= TYPING_WINDOW_MS) live.push(pk);
        else seen.current.delete(pk);
      }
      setTypers((prev) =>
        prev.length === live.length && prev.every((p, i) => p === live[i]) ? prev : live,
      );
    };

    void (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_TYPING_INDICATOR], "#h": [channelId], since: liveSignalSince() }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const ev = msg[2] as NostrEvent;
          if (user && ev.pubkey === user.pubkey) continue;
          if (!isPlausiblyLive(ev.created_at * 1000)) continue;
          seen.current.set(ev.pubkey, Date.now());
          recompute();
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    const decay = setInterval(recompute, TYPING_WINDOW_MS / 2);
    return () => {
      controller.abort();
      clearInterval(decay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, relayUrl, channelId, user?.pubkey, enabled]);

  const publishTyping = useCallback(() => {
    if (!enabled || !user || !relayUrl || !channelId) return;
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;
    void (async () => {
      try {
        const event = await user.signer.signEvent({
          kind: KIND_TYPING_INDICATOR,
          content: "",
          tags: [["h", channelId]],
          created_at: Math.floor(now / 1000),
        });
        await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(6000) });
      } catch {
        // Best-effort; typing is ephemeral.
      }
    })();
  }, [nostr, user, relayUrl, channelId, enabled]);

  return { typers, publishTyping };
}
