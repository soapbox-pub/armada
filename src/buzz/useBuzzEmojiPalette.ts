import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { BUZZ_EMOJI_SET_D, KIND_EMOJI_SET } from "@/buzz/kinds";
import { useIsBuzzRelay } from "@/buzz/detect";
import { emojiPackCoord, emojiPackName } from "@/hooks/useEmojiPacks";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

/**
 * The workspace's custom-emoji palette: the union of every member's kind-30030
 * set with `d = "buzz:custom-emoji"`. First publisher wins on shortcode clashes.
 * Resolves Buzz-ness itself, so any relay (or undefined) may be passed.
 */
export function useBuzzEmojiPalette(relayUrl: string | undefined): CustomEmoji[] {
  const { nostr } = useNostr();
  const { isBuzz } = useIsBuzzRelay(relayUrl);

  const query = useQuery<CustomEmoji[]>({
    queryKey: ["buzz", "emoji-palette", relayUrl],
    enabled: Boolean(relayUrl && isBuzz),
    staleTime: 10 * 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_EMOJI_SET], "#d": [BUZZ_EMOJI_SET_D], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const out: CustomEmoji[] = [];
      const seen = new Set<string>();
      // Oldest-first so an established shortcode isn't hijacked by a newer set.
      for (const ev of [...events].sort((a, b) => a.created_at - b.created_at)) {
        const packCoord = emojiPackCoord(ev.pubkey, BUZZ_EMOJI_SET_D);
        const packName = emojiPackName(ev);
        for (const [n, shortcode, url] of ev.tags) {
          if (n === "emoji" && shortcode && url && !seen.has(shortcode)) {
            seen.add(shortcode);
            out.push({ shortcode, url, packCoord, packName, workspace: true });
          }
        }
      }
      return out;
    },
  });

  return query.data ?? EMPTY;
}

const EMPTY: CustomEmoji[] = [];
