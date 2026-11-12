import { useNostr } from "@nostrify/react";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useEventStore } from "@/hooks/useEventStore";
import { BOT_MANIFEST_KIND, parseBotManifest, type BotCommandEntry } from "@/lib/botCommands";
import { parseProfileImeta } from "@/lib/profileImeta";
import type { ImetaEntry } from "@/lib/imeta";

import type { NostrEvent } from "@nostrify/nostrify";

/** Relays cap how many authors one filter may name; stay well inside that. */
const AUTHOR_CHUNK = 50;

/** The bits of a participant's profile the picker renders. */
export interface BotRosterProfile {
  name?: string;
  picture?: string;
  /** The kind 0's imeta for `picture`. */
  pictureImeta?: ImetaEntry;
}

export interface BotManifestsResult {
  /** Every command of every bot present, flattened and ready to render or parse. */
  entries: BotCommandEntry[];
  /** Hex pubkeys of the bots in this conversation, whether or not they publish a manifest. */
  bots: string[];
  /** Everyone's profiles (a by-product of the bot sweep), for the `user` argument picker. */
  profiles: Record<string, BotRosterProfile>;
  /** Nothing known yet and a fetch is in flight. */
  isLoading: boolean;
  /** A refresh is in flight behind data we already have. */
  isFetching: boolean;
}

const EMPTY: string[] = [];
// Stable empties, so consumers' memo inputs don't churn.
const EMPTY_ENTRIES: BotCommandEntry[] = [];
const EMPTY_PROFILES: Record<string, BotRosterProfile> = {};

/** How long a member's bot flag and profile are taken as read; the queries' own staleness. */
const FLAG_TTL_MS = 5 * 60 * 1000;

/**
 * Each member's bot flag and picker profile as last read (`null`: no kind 0 found), so a
 * member set that grows, or a community switched back to, reads only who it hasn't yet:
 * a public community's roster is thousands of kind 0s.
 */
const flagMemo = new Map<string, { at: number; bot: boolean; profile: BotRosterProfile | null }>();

/** The read filling {@link flagMemo}; the next waits on it, so a roster that changed while it ran reads only the rest. */
let reading: Promise<unknown> = Promise.resolve();

/** Forget the remembered flags (tests). */
export function clearBotFlagMemory(): void {
  flagMemo.clear();
  reading = Promise.resolve();
}

/** Query `kinds` for `authors` in author-sized chunks, over an explicit relay set. */
async function queryChunked(
  query: (filters: { kinds: number[]; authors: string[] }[], opts: { signal: AbortSignal }) => Promise<NostrEvent[]>,
  kinds: number[],
  authors: string[],
  signal: AbortSignal,
  onChunk?: (authors: string[], events: NostrEvent[]) => void,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  for (let i = 0; i < authors.length; i += AUTHOR_CHUNK) {
    const chunk = authors.slice(i, i + AUTHOR_CHUNK);
    const events = await query([{ kinds, authors: chunk }], { signal });
    onChunk?.(chunk, events);
    out.push(...events);
  }
  return out;
}

/**
 * Newest event of `kind` per author, re-checking kind and author rather than
 * trusting the relay (a manifest returned for a kind-0 query would win otherwise).
 */
function newestPerAuthor(events: NostrEvent[], asked: Set<string>, kind: number): Map<string, NostrEvent> {
  const best = new Map<string, NostrEvent>();
  for (const ev of events) {
    if (ev.kind !== kind || !asked.has(ev.pubkey)) continue;
    const held = best.get(ev.pubkey);
    if (!held || ev.created_at > held.created_at) best.set(ev.pubkey, ev);
  }
  return best;
}

/**
 * Resolve the bot commands available in a conversation. Two-stage: kind-0 `bot`
 * flags (NIP-24) pick the bots, then only they get a manifest query. Invalid
 * manifests are ignored entirely. Warms on open so the composer knows whether
 * to offer Commands. Searches `conversationRelays` plus app relays, since bots
 * may publish to either.
 */
export function useBotManifests(
  memberPubkeys: string[] | undefined,
  conversationRelays?: string[],
): BotManifestsResult {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  // Sorted + joined so the key is stable under reordering.
  const members = useMemo(
    () => (memberPubkeys ? [...new Set(memberPubkeys)].sort() : EMPTY),
    [memberPubkeys],
  );
  // Hashed: thousands of pubkeys in a query key are re-hashed by every observer on every render.
  const membersKey = useMemo(() => bytesToHex(sha256(new TextEncoder().encode(members.join(",")))), [members]);

  // Search the conversation's relays plus app relays: a bot's kind-0 may never
  // have reached the pool.
  const relays = useMemo(
    () => [...new Set([...(conversationRelays ?? []), ...config.appRelays])].sort(),
    [conversationRelays, config.appRelays],
  );
  const relayKey = relays.join(",");

  const botsQuery = useQuery({
    queryKey: ["bot-flags", membersKey, relayKey],
    queryFn: async ({ signal }) => {
      const read = reading.then(async () => {
        const now = Date.now();
        const unread = members.filter((pk) => {
          const held = flagMemo.get(pk);
          return !held || now - held.at >= FLAG_TTL_MS;
        });
        if (unread.length === 0) return;
        // Each batch recorded as it lands: a switch away cancels the rest, and a
        // roster of thousands without stored profiles is many relay round trips.
        const record = (pubkeys: string[], events: NostrEvent[]) => {
          const newest = newestPerAuthor(events, new Set(pubkeys), 0);
          for (const pubkey of pubkeys) {
            const ev = newest.get(pubkey);
            let meta: { bot?: unknown; name?: unknown; display_name?: unknown; picture?: unknown } | undefined;
            try {
              meta = ev ? JSON.parse(ev.content) : undefined;
            } catch {
              // A profile we cannot parse is simply not a bot.
            }
            flagMemo.set(pubkey, {
              at: now,
              bot: meta?.bot === true,
              profile: ev && meta ? {
                name: typeof meta?.name === "string"
                  ? meta.name
                  : typeof meta?.display_name === "string"
                    ? meta.display_name
                    : undefined,
                picture: typeof meta?.picture === "string" ? meta.picture : undefined,
                pictureImeta: parseProfileImeta(ev.tags, meta)?.picture,
              } : null,
            });
          }
        };
        // Merge the local cache (what the Bot pill reads) with the network, asking
        // the network only about uncached members — re-sweeping every kind 0 would be the
        // largest network cost of reading a channel.
        const store = await eventStore;
        const cached = (await store.query([{ kinds: [0], authors: unread }])) as NostrEvent[];
        const known = new Set(cached.map((ev) => ev.pubkey));
        record(unread.filter((pk) => known.has(pk)), cached);
        const missing = unread.filter((pk) => !known.has(pk));
        if (missing.length > 0) {
          await queryChunked((filters, opts) => nostr.group(relays).query(filters, opts), [0], missing, signal, record);
        }
      });
      reading = read.catch(() => undefined);
      await read;
      const bots: string[] = [];
      const profiles: Record<string, BotRosterProfile> = {};
      for (const pubkey of members) {
        const held = flagMemo.get(pubkey);
        if (held?.bot) bots.push(pubkey);
        if (held?.profile) profiles[pubkey] = held.profile;
      }
      return { bots: bots.sort(), profiles };
    },
    enabled: members.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const bots = botsQuery.data?.bots ?? EMPTY;
  const botsKey = bots.join(",");

  const manifestsQuery = useQuery({
    // The relay set is part of the result's identity.
    queryKey: ["bot-manifests", botsKey, relayKey],
    queryFn: async ({ signal }) => {
      const asked = new Set(bots);
      const events = await queryChunked(
        (filters, opts) => nostr.group(relays).query(filters, opts),
        [BOT_MANIFEST_KIND],
        bots,
        signal,
      );
      const entries: BotCommandEntry[] = [];
      for (const [pubkey, ev] of newestPerAuthor(events, asked, BOT_MANIFEST_KIND)) {
        // Only the newest manifest counts; a broken latest means no interface.
        const manifest = parseBotManifest(ev.content);
        if (!manifest) continue;
        for (const command of manifest.commands) entries.push({ bot: pubkey, command });
      }
      return entries;
    },
    enabled: bots.length > 0,
    // Bounded staleness: republishing is how a bot changes its interface.
    staleTime: 5 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    entries: manifestsQuery.data ?? EMPTY_ENTRIES,
    bots,
    profiles: botsQuery.data?.profiles ?? EMPTY_PROFILES,
    isLoading:
      (botsQuery.isLoading && botsQuery.fetchStatus !== "idle") ||
      (manifestsQuery.isLoading && manifestsQuery.fetchStatus !== "idle"),
    isFetching: botsQuery.isFetching || manifestsQuery.isFetching,
  };
}
