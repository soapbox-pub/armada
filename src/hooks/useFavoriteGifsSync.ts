import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { verifyEventOnce } from "@/lib/verifyCache";
import { loadSelfReadMarks, noteSelfRead, sinceSelfRead, storeSelfReadEvents } from "@/lib/selfReadMarks";

import { selfStateRelays } from "@/contexts/AppContext";
import {
  claimLegacyFavoriteGifs,
  completeLegacyFavoriteGifMigration,
  FAVORITE_GIFS_D_PREFIX,
  FAVORITE_GIFS_EVENT_KIND,
  FAVORITE_GIFS_EVENT_TAG,
  getFavoriteGifRecords,
  hydrateFavoriteGifRecords,
  parseFavoriteGifDoc,
  parseFavoriteGifShard,
  readyFavoriteGifShards,
  subscribeFavoriteGifChanges,
  type FavoriteGifDoc,
  type FavoriteGifRecord,
} from "@/hooks/useFavoriteGifs";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import { isSigned } from "@/lib/nostrRumor";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import { normalizeRelayUrl } from "@/lib/platform";
import { publishSelfStateEvent } from "@/lib/selfStatePublish";
import { derivedDocOf, type DerivedDoc, type SettingsKeyring } from "@/lib/settingsKeys";
import type { SettingsKeys } from "@/lib/settingsRootStore";

import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

/**
 * GIF favorites are ONE document shared by every installation, under its key derived
 * from the settings root. Records are a last-writer-wins set per GIF, so a device that
 * sees an edition missing something it knows republishes the merge. The legacy
 * per-installation shards the account key signed are read and folded in.
 */

const QUERY_KEY = "favorite-gifs-sync";
export const FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS = 400;
const MAX_EDITIONS = 32;

export interface FavoriteGifContext {
  signer: NostrSigner;
  pubkey: string;
  keys: SettingsKeys;
}

function keyringsOf(keys: SettingsKeys): SettingsKeyring[] {
  return keys.keyring ? [keys.keyring, ...keys.previous] : keys.previous;
}

/** The shared derived document(s) plus the legacy shards. */
export function favoriteGifFilters(pubkey: string, keys: SettingsKeys): NostrFilter[] {
  const authors = keyringsOf(keys).map((keyring) => keyring.gifFavorites.pubkey);
  return [
    ...(authors.length > 0 ? [{ kinds: [FAVORITE_GIFS_EVENT_KIND], authors, limit: authors.length * 4 }] : []),
    { kinds: [FAVORITE_GIFS_EVENT_KIND], authors: [pubkey], "#t": [FAVORITE_GIFS_EVENT_TAG] },
  ];
}

function dTag(event: NostrRumor): string | undefined {
  return event.tags.find((tag) => tag[0] === "d")?.[1];
}

function newestFirst(a: NostrRumor, b: NostrRumor): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id);
}

export interface DecodedFavoriteGifs {
  sets: FavoriteGifRecord[][];
  /** The current root's NIP-01 head. */
  head?: { event: NostrRumor; doc: FavoriteGifDoc };
  /** The current root's head exists but could not be read: never overwrite it. */
  headUnreadable: boolean;
}

export async function decodeFavoriteGifEvents(
  events: NostrRumor[],
  ctx: FavoriteGifContext,
): Promise<DecodedFavoriteGifs> {
  const sets: FavoriteGifRecord[][] = [];
  let head: DecodedFavoriteGifs["head"];
  let headUnreadable = false;

  const derived = new Map<DerivedDoc, NostrRumor[]>();
  const legacy = new Map<string, NostrRumor[]>();
  for (const event of events) {
    if (event.kind !== FAVORITE_GIFS_EVENT_KIND) continue;
    const doc = keyringsOf(ctx.keys)
      .map((keyring) => derivedDocOf(keyring, event))
      .find((candidate) => candidate?.ref.family === "gif-favorites");
    if (doc) {
      const held = derived.get(doc) ?? [];
      if (!held.some((candidate) => candidate.id === event.id)) held.push(event);
      derived.set(doc, held);
      continue;
    }
    const identifier = dTag(event);
    if (
      event.pubkey !== ctx.pubkey
      || !event.tags.some(([name, value]) => name === "t" && value === FAVORITE_GIFS_EVENT_TAG)
      || !identifier?.startsWith(FAVORITE_GIFS_D_PREFIX)
    ) continue;
    const held = legacy.get(identifier) ?? [];
    if (!held.some((candidate) => candidate.id === event.id)) held.push(event);
    legacy.set(identifier, held);
  }

  for (const [doc, editions] of derived) {
    editions.sort(newestFirst);
    const current = ctx.keys.keyring?.gifFavorites === doc;
    // Divergent relay copies are CRDT inputs: keep every edition's operations.
    for (const [index, event] of editions.slice(0, MAX_EDITIONS).entries()) {
      let parsed: FavoriteGifDoc | null = null;
      try {
        parsed = parseFavoriteGifDoc(JSON.parse(await doc.signer.nip44!.decrypt(doc.pubkey, event.content)));
      } catch {
        parsed = null;
      }
      if (current && index === 0) {
        if (parsed) head = { event, doc: parsed };
        else headUnreadable = true;
      }
      if (parsed) sets.push(parsed.records);
    }
  }

  if (ctx.signer.nip44) {
    for (const [identifier, editions] of legacy) {
      editions.sort(newestFirst);
      for (const event of editions.slice(0, MAX_EDITIONS)) {
        try {
          const shard = parseFavoriteGifShard(JSON.parse(await ctx.signer.nip44.decrypt(ctx.pubkey, event.content)));
          if (shard && identifier === `${FAVORITE_GIFS_D_PREFIX}${shard.deviceId}`) sets.push(shard.records);
        } catch {
          // Another edition (or relay) can still carry these operations.
        }
      }
    }
  }
  return { sets, head, headUnreadable };
}

function verified(events: readonly NostrRumor[]): NostrRumor[] {
  // Network editions must verify; signature-stripped ArmadaDB rumors are trusted inputs.
  return events.filter((event) => !isSigned(event) || verifyEventOnce(event));
}

/** Whether this device knows more than the current head says. */
function needsPublish(pubkey: string, decoded: DecodedFavoriteGifs): boolean {
  if (decoded.headUnreadable) return false;
  const local = getFavoriteGifRecords(pubkey);
  if (local.length === 0) return false;
  return JSON.stringify(local) !== JSON.stringify(decoded.head?.doc.records);
}

async function signFavoriteGifDoc(
  doc: DerivedDoc,
  records: FavoriteGifRecord[],
  previousCreatedAt: number | undefined,
): Promise<NostrEvent> {
  const payload: FavoriteGifDoc = { version: 2, records };
  return doc.signer.signEvent({
    kind: FAVORITE_GIFS_EVENT_KIND,
    content: await doc.signer.nip44!.encrypt(doc.pubkey, JSON.stringify(payload)),
    tags: [["d", doc.d]],
    created_at: Math.max(nowSecs(), (previousCreatedAt ?? 0) + 1),
  });
}

/** Fold every readable edition and sign the shared document if it lacks something (Setup Sync). */
export async function signCurrentFavoriteGifEvents(
  remoteEvents: readonly NostrRumor[],
  ctx: FavoriteGifContext,
): Promise<NostrEvent[]> {
  await readyFavoriteGifShards();
  const keyring = ctx.keys.keyring;
  if (!keyring) throw new Error("No settings root to write GIF favorites under");
  const decoded = await decodeFavoriteGifEvents(verified(remoteEvents), ctx);
  hydrateFavoriteGifRecords(ctx.pubkey, decoded.sets);
  if (decoded.headUnreadable) throw new Error("The GIF favorites document could not be decrypted");
  if (!needsPublish(ctx.pubkey, decoded)) return [];
  return [await signFavoriteGifDoc(
    keyring.gifFavorites,
    getFavoriteGifRecords(ctx.pubkey),
    decoded.head?.event.created_at,
  )];
}

interface FavoriteGifPull extends DecodedFavoriteGifs {
  baseKey: string;
  publishRelays: string[];
}

/** Encrypted GIF-favorites sync, gated by the automatic settings-sync preference. */
export function useFavoriteGifsSync(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const eventStore = useEventStore();
  const { keys, isFetched: keysFetched, ensure } = useSettingsKeys();
  const relayKey = selfStateRelays(config, user?.pubkey).sort().join("\u0000");
  const relays = useMemo(() => relayKey ? relayKey.split("\u0000") : [], [relayKey]);
  // Without a kind-10002, bootstrap from the self-state/app relays, or sync would never run.
  const nip65WriteRelays = config.relayMetadata.pubkey === user?.pubkey
    ? config.relayMetadata.relays
      .filter((relay) => relay.write)
      .map((relay) => normalizeRelayUrl(relay.url))
      .filter((relay): relay is string => relay !== undefined)
    : [];
  const canonicalKey = [...new Set(nip65WriteRelays.length > 0 ? nip65WriteRelays : relays)].sort().join("\u0000");
  const keysKey = [keys.keyring?.id ?? "", ...keys.previous.map((keyring) => keyring.id)].join(",");
  const syncBaseKey = user?.pubkey && relayKey ? `${user.pubkey}\u0001${relayKey}\u0002${canonicalKey}\u0003${keysKey}` : undefined;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const pulledRef = useRef<FavoriteGifPull | undefined>(undefined);
  const dirtyBeforePull = useRef(false);
  const publishChain = useRef<Promise<void>>(Promise.resolve());

  const query = useQuery({
    queryKey: [QUERY_KEY, user?.pubkey, relayKey, canonicalKey, keysKey],
    enabled: automaticSettingsSync && !!user?.pubkey && !!user.signer.nip44 && relays.length > 0 && keysFetched,
    queryFn: async ({ signal }): Promise<FavoriteGifPull> => {
      if (!user) throw new Error("Not logged in");
      const filters = favoriteGifFilters(user.pubkey, keys);
      const store = await eventStore;
      await loadSelfReadMarks();
      const readKeyFor = (relay: string) => `gifs\u0000${user.pubkey}\u0000${relay}\u0000${keysKey}`;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
      const [settled, cached] = await Promise.all([
        Promise.allSettled(relays.map(async (relay) => {
          // Resumed: what an earlier pull read is in the store (stored below and by NostrSync).
          const requestedAt = nowSecs();
          const events = await nostr.relay(relay).query(sinceSelfRead(filters, readKeyFor(relay)), { signal: deadline });
          await storeSelfReadEvents(store, filters, events);
          noteSelfRead(readKeyFor(relay), requestedAt);
          return events;
        })),
        store.query(filters).catch(() => []),
        readyFavoriteGifShards(),
      ]);
      const completed = settled.flatMap((result, index) =>
        result.status === "fulfilled" ? [{ relay: relays[index]!, events: result.value }] : []);
      if (completed.length === 0) throw new Error("No self-state relay completed the GIF pull");
      const canonical = canonicalKey.split("\u0000");
      // Merging over a read that missed the account's declared relays would republish a partial base.
      if (!completed.some(({ relay }) => canonical.includes(relay))) {
        throw new Error("A declared NIP-65 write relay must complete the GIF pull");
      }
      const byId = new Map<string, NostrRumor>();
      for (const event of verified([...cached, ...completed.flatMap(({ events }) => events)])) {
        byId.set(event.id, event);
      }
      const decoded = await decodeFavoriteGifEvents(
        [...byId.values()],
        { signer: user.signer, pubkey: user.pubkey, keys },
      );
      hydrateFavoriteGifRecords(user.pubkey, decoded.sets);
      return { ...decoded, baseKey: syncBaseKey!, publishRelays: completed.map(({ relay }) => relay) };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const publish = useCallback((completeMigration: boolean) => {
    const run = async () => {
      const pull = pulledRef.current;
      if (!automaticSettingsSync || !user || !pull || pull.baseKey !== syncBaseKey) return;
      const keyring = keysRef.current.keyring;
      if (!keyring) {
        // A new root re-keys the pull, whose result publishes.
        await ensure().catch(() => undefined);
        return;
      }
      if (!needsPublish(user.pubkey, pull)) {
        if (completeMigration) completeLegacyFavoriteGifMigration();
        return;
      }
      const previous = pull.head;
      try {
        const records = getFavoriteGifRecords(user.pubkey);
        const event = await signFavoriteGifDoc(keyring.gifFavorites, records, previous?.event.created_at);
        // Optimistic: the next edition must be newer than this one, delivered or not.
        pull.head = { event, doc: { version: 2, records } };
        await publishSelfStateEvent(nostr, await eventStore, event, pull.publishRelays, { label: "GIF favorites" });
        if (completeMigration) completeLegacyFavoriteGifMigration();
      } catch (error) {
        if (isPublishQueuedError(error)) {
          if (completeMigration) completeLegacyFavoriteGifMigration();
        } else {
          pull.head = previous;
          dirtyBeforePull.current = true;
          console.warn("Failed to sync GIF favorites:", error);
        }
      }
    };
    publishChain.current = publishChain.current.then(run, run);
    return publishChain.current;
  }, [automaticSettingsSync, ensure, eventStore, nostr, syncBaseKey, user]);

  useEffect(() => {
    pulledRef.current = undefined;
  }, [syncBaseKey]);

  // The legacy localStorage list is removed only once the merge has been signed and durably queued.
  useEffect(() => {
    const pubkey = user?.pubkey;
    const pull = query.data;
    if (!automaticSettingsSync || !pubkey || !pull || pull.baseKey !== syncBaseKey) return;
    pulledRef.current = pull;
    const migration = claimLegacyFavoriteGifs(pubkey);
    const dirty = dirtyBeforePull.current || needsPublish(pubkey, pull);
    dirtyBeforePull.current = false;
    if (!migration.hadLegacy && !dirty) return;
    void publish(migration.hadLegacy);
  }, [automaticSettingsSync, publish, query.data, syncBaseKey, user?.pubkey]);

  // Coalesce rapid clicks into one rewrite.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!automaticSettingsSync || !pubkey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFavoriteGifChanges((changedPubkey) => {
      if (changedPubkey !== pubkey) return;
      if (!pulledRef.current) {
        dirtyBeforePull.current = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void publish(false), FAVORITE_GIFS_PUBLISH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [automaticSettingsSync, publish, user?.pubkey]);
}

export const favoriteGifsSyncQueryKey = [QUERY_KEY] as const;
