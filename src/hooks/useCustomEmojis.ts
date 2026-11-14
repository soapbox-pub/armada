import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";

import { useBuzzEmojiPalette } from "@/buzz/useBuzzEmojiPalette";
import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useChatScope } from "@/hooks/useChatScope";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { emojiPackCoord, emojiPackName, readEmojiList } from "@/hooks/useEmojiPacks";
import { useEventStore } from "@/hooks/useEventStore";
import { parseAddr } from "@/lib/parseAddr";

import { loadPalette, savePalette } from "@/lib/emojiPalette";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface CustomEmoji {
  shortcode: string;
  url: string;
  /** The source pack's `30030:pubkey:dtag`, absent for emojis inlined on the kind-10030 list. */
  packCoord?: string;
  /** The source pack's human name, resolved at read time for display. */
  packName?: string;
  /** From a Buzz workspace's palette (any member's set), not the user's own list. */
  workspace?: boolean;
}

// The durable per-user palette lives in `@/lib/emojiPalette` (shared with `useEmojiPacks`).

/** Newest event per addressable coordinate (`kind:pubkey:d`). */
function newestPerAddr(events: NostrRumor[]): NostrRumor[] {
  const newest = new Map<string, NostrRumor>();
  for (const event of events) {
    const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
    const addr = `${event.kind}:${event.pubkey}:${d}`;
    const prev = newest.get(addr);
    if (!prev || event.created_at > prev.created_at) newest.set(addr, event);
  }
  return [...newest.values()];
}

/**
 * Flatten a kind-10030 list and its kind-30030 packs into a deduped palette;
 * conflicting shortcodes across packs get a pack-id prefix.
 */
function paletteFrom(listEvent: NostrRumor, packEvents: NostrRumor[]): CustomEmoji[] {
  const raw: {
    shortcode: string;
    url: string;
    packId: string;
    packCoord?: string;
    packName?: string;
  }[] = [];
  for (const t of listEvent.tags) {
    if (t[0] === "emoji" && t[1] && t[2]) raw.push({ shortcode: t[1], url: t[2], packId: "" });
  }
  for (const pack of packEvents) {
    const packId = pack.tags.find(([n]) => n === "d")?.[1] ?? "";
    const packCoord = emojiPackCoord(pack.pubkey, packId);
    const packName = emojiPackName(pack);
    for (const t of pack.tags) {
      if (t[0] === "emoji" && t[1] && t[2]) {
        raw.push({ shortcode: t[1], url: t[2], packId, packCoord, packName });
      }
    }
  }

  const urlsByCode = new Map<string, Set<string>>();
  for (const e of raw) {
    let urls = urlsByCode.get(e.shortcode);
    if (!urls) urlsByCode.set(e.shortcode, (urls = new Set()));
    urls.add(e.url);
  }

  const out: CustomEmoji[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const code =
      urlsByCode.get(e.shortcode)!.size > 1 && e.packId ? `${e.packId}-${e.shortcode}` : e.shortcode;
    if (!seen.has(code)) {
      seen.add(code);
      out.push({ shortcode: code, url: e.url, packCoord: e.packCoord, packName: e.packName });
    }
  }
  return out;
}

/**
 * The user's NIP-30 emoji palette (10030 + 30030 packs) with a durable local copy.
 * A read replaces the copy only when it produces something (or the list is
 * genuinely empty); short reads keep the last palette.
 */
export function useCustomEmojis(): CustomEmojisResult {
  const shared = useContext(CustomEmojisContext);
  // Provider presence is fixed per mount, so this never changes hook order.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return shared ?? useCustomEmojisSource();
}

export interface CustomEmojisResult {
  emojis: CustomEmoji[];
  isLoading: boolean;
}

/** One palette read per chat surface, instead of three query observers per row. */
const CustomEmojisContext = createContext<CustomEmojisResult | null>(null);

/** Provide {@link useCustomEmojis} to everything below, read once. Place it inside the chat scope. */
export function CustomEmojisProvider({ children }: { children: ReactNode }) {
  const source = useCustomEmojisSource();
  const value = useMemo(
    () => ({ emojis: source.emojis, isLoading: source.isLoading }),
    [source.emojis, source.isLoading],
  );
  return createElement(CustomEmojisContext.Provider, { value }, children);
}

function useCustomEmojisSource(): CustomEmojisResult {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  const query = useQuery({
    queryKey: ["custom-emojis", user?.pubkey ?? ""],
    enabled: !!user,
    // Show the durable palette instantly on mount; the read below reconciles.
    initialData: () => (user ? loadPalette(user.pubkey) : []),
    initialDataUpdatedAt: 0, // still stale, so mount triggers a reconcile
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    queryFn: async ({ signal }): Promise<CustomEmoji[]> => {
      if (!user) return [];
      const store = await eventStore;
      const floor = loadPalette(user.pubkey);

      const { event: list } = await readEmojiList(nostr, store, user.pubkey, accountDataRelays(config), signal);
      if (!list) return floor; // list read came up short — keep what we had

      const packRefs = list.tags
        .filter((t) => t[0] === "a" && t[1])
        .map((t) => parseAddr(t[1]))
        .filter((a): a is NonNullable<typeof a> => !!a && a.kind === 30030);

      let packEvents: NostrRumor[] = [];
      if (packRefs.length > 0) {
        const filters = packRefs.map((r) => ({
          kinds: [30030],
          authors: [r.pubkey],
          "#d": [r.identifier],
          limit: 1,
        }));
        const [relay, cached] = await Promise.all([
          nostr.query(filters, { signal }).catch(() => [] as NostrRumor[]),
          store.query(filters).catch(() => [] as NostrRumor[]),
        ]);
        packEvents = newestPerAddr([...relay, ...cached]);
      }

      const palette = paletteFrom(list, packEvents);

      // Empty despite pack refs means a short read — keep the durable floor.
      const listIsEmpty =
        packRefs.length === 0 && !list.tags.some((t) => t[0] === "emoji" && t[1] && t[2]);
      if (palette.length === 0 && !listIsEmpty) return floor;

      savePalette(user.pubkey, palette);
      return palette;
    },
  });

  // Merge a Buzz relay's community palette; the user's own emojis win collisions.
  const scope = useChatScope();
  const scopeRelay = scope?.kind === "nip29" ? scope.relayUrl : undefined;
  const buzzPalette = useBuzzEmojiPalette(scopeRelay);

  const emojis = useMemo(() => {
    const own = query.data ?? [];
    if (buzzPalette.length === 0) return own;
    const seen = new Set(own.map((e) => e.shortcode));
    const merged = [...own];
    for (const e of buzzPalette) {
      if (!seen.has(e.shortcode)) {
        seen.add(e.shortcode);
        merged.push(e);
      }
    }
    return merged;
  }, [query.data, buzzPalette]);

  return {
    emojis,
    isLoading: query.isLoading,
  };
}
