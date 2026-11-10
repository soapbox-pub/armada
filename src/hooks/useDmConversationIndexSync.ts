import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { verifyEventOnce } from "@/lib/verifyCache";
import { loadSelfReadMarks, noteSelfRead, sinceSelfRead, storeSelfReadEvents } from "@/lib/selfReadMarks";

import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import {
  dmConversationIndexBuckets,
  hydrateDmConversationIndexRecords,
  recordDmConversationIndex,
  subscribeDmConversationIndexChanges,
} from "@/hooks/useDmConversationIndex";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDMConversations } from "@/hooks/useDirectMessages";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import {
  DM_CONVERSATIONS_EVENT_KIND,
  DM_CONVERSATIONS_SYNC_QUERY_KEY,
  dmConversationIndexEventGroups,
  dmConversationIndexFilter,
  fitDmConversationIndexBucket,
  MAX_DM_CONVERSATION_CIPHERTEXT_CHARS,
  MAX_DM_CONVERSATION_VERSIONS_PER_SHARD,
  parseDmConversationIndexBucketPlaintext,
  parseDmConversationIndexDTag,
  parseDmConversationIndexPlaintext,
  type DmConversationIndexBucketDoc,
  type DmConversationIndexRecord,
} from "@/lib/dmConversationIndex";
import { isSigned, type NostrRumor } from "@/lib/nostrRumor";
import { isPublishQueuedError } from "@/lib/publishOutbox";
import { normalizeRelayUrl } from "@/lib/platform";
import { publishSelfStateEvent } from "@/lib/selfStatePublish";
import { derivedDocOf, type DerivedDoc, type SettingsKeyring } from "@/lib/settingsKeys";
import type { SettingsKeys } from "@/lib/settingsRootStore";
import { queryRelayStrict } from "@/lib/strictRelayQuery";
import { nowSecs } from "@/lib/relayClock";
import { dmAt } from "@/lib/nip17/protocol";

export const DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS = 60_000;
export const DM_CONVERSATION_INDEX_RETRY_MS = 5 * 60_000;

/**
 * The DM conversation index is eight documents shared by every installation, each
 * under its key derived from the settings root (`settingsKeys.ts`). Each holds an
 * add-only union, so a device that sees an edition missing something it knows
 * republishes the union; concurrent writes converge without per-device shards.
 * The legacy per-installation shards the account key signed are read and folded in.
 */

export interface DmConversationIndexContext {
  signer: NostrSigner;
  pubkey: string;
  keys: SettingsKeys;
}

export interface DecodedDmConversationIndex {
  /** Every readable record set: derived buckets, a superseded root's, legacy shards. */
  sets: DmConversationIndexRecord[][];
  /** The current root's NIP-01 head per bucket. */
  heads: Map<number, { event: NostrRumor; doc: DmConversationIndexBucketDoc }>;
  /** Current-root buckets whose head could not be read: never overwritten. */
  unreadable: Set<number>;
}

function keyringsOf(keys: SettingsKeys): SettingsKeyring[] {
  return keys.keyring ? [keys.keyring, ...keys.previous] : keys.previous;
}

/** Every filter the index is read with: the derived buckets plus the legacy shards. */
export function dmConversationIndexFilters(pubkey: string, keys: SettingsKeys): NostrFilter[] {
  const authors = keyringsOf(keys).flatMap((keyring) => keyring.dmConversations.map((doc) => doc.pubkey));
  return [
    ...(authors.length > 0
      ? [{ kinds: [DM_CONVERSATIONS_EVENT_KIND], authors, limit: authors.length * 4 }]
      : []),
    dmConversationIndexFilter(pubkey),
  ];
}

/**
 * Relay results must carry a valid signature. ArmadaDB strips signatures after verified
 * ingest; a cached row that still has one is rechecked.
 */
export function verifiedDmConversationIndexEvents(
  remote: readonly NostrEvent[],
  cached: readonly NostrRumor[],
): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const event of cached) {
    if (!isSigned(event) || verifyEventOnce(event)) byId.set(event.id, event);
  }
  for (const event of remote) {
    if (verifyEventOnce(event)) byId.set(event.id, event);
  }
  return [...byId.values()];
}

const decodedEventCache = new Map<string, DmConversationIndexRecord[] | null>();
const MAX_DECODE_CACHE = 256;

async function decodeOnce(
  event: NostrRumor,
  decode: () => Promise<DmConversationIndexRecord[] | null>,
): Promise<DmConversationIndexRecord[] | null> {
  if (decodedEventCache.has(event.id)) return decodedEventCache.get(event.id)!;
  let records: DmConversationIndexRecord[] | null = null;
  try {
    records = await decode();
  } catch {
    records = null;
  }
  decodedEventCache.set(event.id, records);
  while (decodedEventCache.size > MAX_DECODE_CACHE) {
    const oldest = decodedEventCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    decodedEventCache.delete(oldest);
  }
  return records;
}

function newestFirst(a: NostrRumor, b: NostrRumor): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id);
}

/** Sequential so a remote signer sees one legacy request at a time. */
export async function decodeDmConversationIndexEvents(
  events: readonly NostrRumor[],
  ctx: DmConversationIndexContext,
): Promise<DecodedDmConversationIndex> {
  const sets: DmConversationIndexRecord[][] = [];
  const heads = new Map<number, { event: NostrRumor; doc: DmConversationIndexBucketDoc }>();
  const unreadable = new Set<number>();

  const editionsOf = new Map<DerivedDoc, NostrRumor[]>();
  for (const event of events) {
    if (event.kind !== DM_CONVERSATIONS_EVENT_KIND || event.content.length > MAX_DM_CONVERSATION_CIPHERTEXT_CHARS) continue;
    for (const keyring of keyringsOf(ctx.keys)) {
      const doc = derivedDocOf(keyring, event);
      if (doc?.ref.family !== "dm-conversations") continue;
      const held = editionsOf.get(doc) ?? [];
      if (!held.some((candidate) => candidate.id === event.id)) held.push(event);
      editionsOf.set(doc, held);
    }
  }
  for (const [doc, editions] of editionsOf) {
    if (doc.ref.family !== "dm-conversations") continue;
    const bucket = doc.ref.bucket;
    editions.sort(newestFirst);
    const current = ctx.keys.keyring?.dmConversations[bucket] === doc;
    for (const [index, event] of editions.slice(0, MAX_DM_CONVERSATION_VERSIONS_PER_SHARD).entries()) {
      const records = await decodeOnce(event, async () =>
        parseDmConversationIndexBucketPlaintext(
          await doc.signer.nip44!.decrypt(doc.pubkey, event.content),
          bucket,
        )?.records ?? null);
      if (current && index === 0) {
        if (records) heads.set(bucket, { event, doc: fitDmConversationIndexBucket(bucket, records) });
        else unreadable.add(bucket);
      }
      if (records) sets.push(records);
    }
  }

  if (ctx.signer.nip44) {
    for (const editions of dmConversationIndexEventGroups(events, ctx.pubkey)) {
      const identifier = editions[0]!.tags.find(([name]) => name === "d")?.[1];
      const coordinate = identifier ? parseDmConversationIndexDTag(identifier) : null;
      if (!coordinate) continue;
      for (const event of editions) {
        const records = await decodeOnce(event, async () => {
          const shard = parseDmConversationIndexPlaintext(
            await ctx.signer.nip44!.decrypt(ctx.pubkey, event.content),
          );
          return shard && shard.deviceId === coordinate.deviceId && shard.bucket === coordinate.bucket
            ? shard.records
            : null;
        });
        if (records) sets.push(records);
      }
    }
  }
  return { sets, heads, unreadable };
}

export async function decodeAndHydrateDmConversationIndex(
  events: readonly NostrRumor[],
  ctx: DmConversationIndexContext,
): Promise<DecodedDmConversationIndex> {
  const decoded = await decodeDmConversationIndexEvents(events, ctx);
  await hydrateDmConversationIndexRecords(ctx.pubkey, decoded.sets);
  return decoded;
}

/** Buckets this device knows more of than the current head says. */
export async function dirtyDmConversationIndexBuckets(
  pubkey: string,
  decoded: Pick<DecodedDmConversationIndex, "heads" | "unreadable">,
): Promise<DmConversationIndexBucketDoc[]> {
  return (await dmConversationIndexBuckets(pubkey)).filter((local) =>
    local.records.length > 0
    && !decoded.unreadable.has(local.bucket)
    && JSON.stringify(local.records) !== JSON.stringify(decoded.heads.get(local.bucket)?.doc.records));
}

export async function signDmConversationIndexBucket(
  doc: DerivedDoc,
  bucket: DmConversationIndexBucketDoc,
  previousCreatedAt: number | undefined,
): Promise<NostrEvent> {
  return doc.signer.signEvent({
    kind: DM_CONVERSATIONS_EVENT_KIND,
    content: await doc.signer.nip44!.encrypt(doc.pubkey, JSON.stringify(bucket)),
    tags: [["d", doc.d]],
    created_at: Math.max(nowSecs(), (previousCreatedAt ?? 0) + 1),
  });
}

/**
 * Fold every readable edition, then sign each bucket whose head lacks something,
 * for Setup Sync to fan out to new relays.
 */
export async function signCurrentDmConversationIndexEvents(
  remoteEvents: readonly NostrRumor[],
  ctx: DmConversationIndexContext,
): Promise<NostrEvent[]> {
  const keyring = ctx.keys.keyring;
  if (!keyring) throw new Error("No settings root to write the DM conversation index under");
  const verified = verifiedDmConversationIndexEvents(
    remoteEvents.filter(isSigned),
    remoteEvents.filter((event) => !isSigned(event)),
  );
  const decoded = await decodeAndHydrateDmConversationIndex(verified, ctx);
  if (decoded.unreadable.size > 0) {
    throw new Error("An existing DM conversation index document could not be decrypted");
  }
  const signed: NostrEvent[] = [];
  for (const bucket of await dirtyDmConversationIndexBuckets(ctx.pubkey, decoded)) {
    signed.push(await signDmConversationIndexBucket(
      keyring.dmConversations[bucket.bucket]!,
      bucket,
      decoded.heads.get(bucket.bucket)?.event.created_at,
    ));
  }
  return signed;
}

/**
 * Always-mounted, noninteractive discovery recorder: never decrypts NIP-04 previews or
 * requests NIP-17 approval.
 */
export function useRecordDmConversationIndex(): void {
  const { user } = useCurrentUser();
  const { conversations: nip04, isLoading: nip04Loading } = useDMConversations({
    decryptPreviews: false,
  });
  const { conversations: nip17, isLoading: nip17Loading } = useDm17Conversations({
    interactive: false,
  });
  const { isKnown, isLoading: trustLoading } = useKnownDmPeers();

  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey || nip04Loading || nip17Loading || trustLoading) return;
    const records = [
      ...nip04.flatMap((conversation) => isKnown(conversation.peer, conversation.mine) ? [{
        key: conversation.peer,
        latest: {
          createdAt: conversation.latest.created_at,
          id: conversation.latest.id,
        },
        mine: conversation.mine,
      }] : []),
      ...nip17.flatMap((conversation) =>
        conversation.peers.every((peer) => isKnown(peer, conversation.mine)) ? [{
          key: conversation.key,
          latest: {
            createdAt: dmAt(conversation.latest),
            id: conversation.latest.rumorId,
          },
          mine: conversation.mine,
        }] : []),
    ];
    if (records.length === 0) return;
    const timer = setTimeout(() => void recordDmConversationIndex(pubkey, records), 800);
    return () => clearTimeout(timer);
  }, [isKnown, nip04, nip04Loading, nip17, nip17Loading, trustLoading, user?.pubkey]);
}

interface DmConversationIndexPull extends DecodedDmConversationIndex {
  baseKey: string;
  publishRelays: string[];
}

/**
 * Network owner for the shared encrypted DM roster. Automatic settings sync is the
 * consent gate; explicit Pull/Sync use the helpers above.
 */
export function useDmConversationIndexSync(): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const { keys, isFetched: keysFetched, ensure } = useSettingsKeys();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
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
  const canSync = automaticSettingsSync && !!user?.pubkey && !!user.signer.nip44 && relays.length > 0 && keysFetched;
  const keysKey = [keys.keyring?.id ?? "", ...keys.previous.map((keyring) => keyring.id)].join(",");
  const syncBaseKey = user?.pubkey && relayKey ? `${user.pubkey}\u0001${relayKey}\u0002${canonicalKey}\u0003${keysKey}` : undefined;

  const activeBaseKeyRef = useRef(syncBaseKey);
  activeBaseKeyRef.current = syncBaseKey;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const pulledRef = useRef<DmConversationIndexPull | undefined>(undefined);
  const publishChain = useRef<Promise<unknown>>(Promise.resolve());
  const retryRef = useRef<{ buckets: Set<number>; timer?: ReturnType<typeof setTimeout> }>({ buckets: new Set() });

  const query = useQuery({
    queryKey: [...DM_CONVERSATIONS_SYNC_QUERY_KEY, user?.pubkey, relayKey, canonicalKey, keysKey],
    enabled: canSync,
    queryFn: async ({ signal }): Promise<DmConversationIndexPull> => {
      if (!user) throw new Error("Not logged in");
      // Never let the general-pool fallback widen this private read.
      if (relays.length === 0) throw new Error("No self-state relays configured");
      const ctx = { signer: user.signer, pubkey: user.pubkey, keys };
      const filters = dmConversationIndexFilters(user.pubkey, keys);
      const store = await eventStore;
      await loadSelfReadMarks();
      const readKeyFor = (relay: string) => `dm-index\u0000${user.pubkey}\u0000${relay}\u0000${keysKey}`;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
      const [settled, cached] = await Promise.all([
        // Strict: a CLOSED REQ must not read as "no index there".
        Promise.allSettled(relays.map(async (relay) => {
          // Resumed: what an earlier pull read is in the store (stored below and by NostrSync).
          const requestedAt = nowSecs();
          const events = await queryRelayStrict(nostr.relay(relay), sinceSelfRead(filters, readKeyFor(relay)), { signal: deadline });
          await storeSelfReadEvents(store, filters, events);
          noteSelfRead(readKeyFor(relay), requestedAt);
          return events;
        })),
        store.query(filters).catch(() => []),
      ]);
      const completed = settled.flatMap((result, index) =>
        result.status === "fulfilled" ? [{ relay: relays[index]!, events: result.value }] : []);
      if (completed.length === 0) throw new Error("No self-state relay completed the DM index pull");
      const canonical = canonicalKey.split("\u0000");
      // Merging over a read that missed the account's declared relays would republish a partial base.
      if (!completed.some(({ relay }) => canonical.includes(relay))) {
        throw new Error("A declared NIP-65 write relay must complete the DM index pull");
      }
      const decoded = await decodeAndHydrateDmConversationIndex(
        verifiedDmConversationIndexEvents(completed.flatMap(({ events }) => events), cached),
        ctx,
      );
      return { ...decoded, baseKey: syncBaseKey!, publishRelays: completed.map(({ relay }) => relay) };
    },
    staleTime: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });

  /** Publish `buckets` from local state; returns those that failed. */
  const publishBuckets = useCallback((requested: readonly number[]): Promise<number[]> => {
    const run = async (): Promise<number[]> => {
      const pull = pulledRef.current;
      const baseKey = syncBaseKey;
      if (!automaticSettingsSync || !user || !pull || !baseKey || pull.baseKey !== baseKey) return [];
      const keyring = keysRef.current.keyring;
      if (!keyring) {
        // A new root re-keys the pull, whose result republishes; no root means this
        // account has not set up sync, which is not a failure either.
        await ensure().catch(() => undefined);
        return [];
      }
      const store = await eventStore;
      const wanted = new Set(requested);
      const failed: number[] = [];
      for (const bucket of await dirtyDmConversationIndexBuckets(user.pubkey, pull)) {
        if (!wanted.has(bucket.bucket) || activeBaseKeyRef.current !== baseKey) continue;
        const doc = keyring.dmConversations[bucket.bucket]!;
        const head = pull.heads.get(bucket.bucket);
        try {
          const event = await signDmConversationIndexBucket(doc, bucket, head?.event.created_at);
          // Optimistic: the next edition must be newer than this one, delivered or not.
          pull.heads.set(bucket.bucket, { event, doc: bucket });
          await publishSelfStateEvent(nostr, store, event, pull.publishRelays, { label: "DM conversation index" });
        } catch (error) {
          if (!isPublishQueuedError(error)) {
            if (head) pull.heads.set(bucket.bucket, head);
            else pull.heads.delete(bucket.bucket);
            console.warn("Failed to sync DM conversation index:", error);
            failed.push(bucket.bucket);
          }
        }
      }
      return failed;
    };
    const next = publishChain.current.then(run, run);
    publishChain.current = next;
    return next;
  }, [automaticSettingsSync, ensure, eventStore, nostr, syncBaseKey, user]);

  const scheduleRetry = useCallback((buckets: readonly number[]) => {
    const retry = retryRef.current;
    for (const bucket of buckets) retry.buckets.add(bucket);
    if (retry.buckets.size === 0 || retry.timer) return;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      const pending = [...retry.buckets];
      retry.buckets.clear();
      void publishBuckets(pending).then(scheduleRetry);
    }, DM_CONVERSATION_INDEX_RETRY_MS);
  }, [publishBuckets]);

  useEffect(() => {
    pulledRef.current = undefined;
    const retry = retryRef.current;
    retry.buckets.clear();
    if (retry.timer) clearTimeout(retry.timer);
    retry.timer = undefined;
  }, [syncBaseKey]);

  // A completed pull is the merge base; republish every bucket it lacks something of.
  useEffect(() => {
    const pull = query.data;
    if (!automaticSettingsSync || !pull || pull.baseKey !== syncBaseKey) return;
    pulledRef.current = pull;
    void dirtyDmConversationIndexBuckets(user!.pubkey, pull).then(async (dirty) => {
      if (dirty.length === 0) return;
      scheduleRetry(await publishBuckets(dirty.map((bucket) => bucket.bucket)));
    });
  }, [automaticSettingsSync, publishBuckets, query.data, scheduleRetry, syncBaseKey, user]);

  // This only schedules the encrypted rewrite and collapses bursts.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!automaticSettingsSync || !pubkey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<number>();
    const unsubscribe = subscribeDmConversationIndexChanges((changedPubkey, buckets) => {
      if (changedPubkey !== pubkey) return;
      for (const bucket of buckets) pending.add(bucket);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const scheduled = [...pending];
        pending.clear();
        void publishBuckets(scheduled).then(scheduleRetry);
      }, DM_CONVERSATION_INDEX_PUBLISH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [automaticSettingsSync, publishBuckets, scheduleRetry, user?.pubkey]);

  useEffect(() => () => {
    if (retryRef.current.timer) clearTimeout(retryRef.current.timer);
  }, []);
}

export const dmConversationIndexSyncQueryKey = DM_CONVERSATIONS_SYNC_QUERY_KEY;
