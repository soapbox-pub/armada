import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useBootGateOpen } from "@/lib/bootGate";

import { setBuzzMediaSigner } from "@/buzz/media";
import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useConfigDocSync, markConfigSynced } from "@/hooks/useConfigDocSync";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";
import { useEventStore } from "@/hooks/useEventStore";
import {
  getFrequentReactions,
  hydrateFrequentReactions,
  subscribeFrequentReactions,
} from "@/hooks/useFrequentReactions";
import { useFavoriteGifsSync } from "@/hooks/useFavoriteGifsSync";
import {
  useDmConversationIndexSync,
  useRecordDmConversationIndex,
} from "@/hooks/useDmConversationIndexSync";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import { useResumeEpoch } from "@/hooks/useResumeEpoch";
import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";
import { useTheme } from "@/hooks/useTheme";
import { replaceableIsNewerThanMetadata } from "@/lib/canonicalSelfList";
import {
  KIND_RELAY_LIST,
  newerRelayListUpdate,
  relayListIsNewerThanMetadata,
} from "@/lib/nip65";
import {
  admitSelfSyncEvent,
  KIND_APP_SPECIFIC,
  KIND_COMMUNITY_LIST_FRAG,
  queryKeysForDerivedDoc,
  queryKeysForSelfEvent,
  selfSyncTopicOf,
  SELF_SYNC_DTAGS,
  SELF_SYNC_OWNER_QUERY_KEYS,
  SELF_SYNC_REPLACEABLE_KINDS,
  SELF_SYNC_TOPIC_TAGS,
  type SelfSyncEventVersion,
} from "@/lib/selfSyncKinds";
import { derivedDocOf } from "@/lib/settingsKeys";
import type { CachingReqOpts } from "@/lib/NostrBatcher";
import { ACTIVE_THEME_KIND, parseDittoTheme, themeToConfig } from "@/lib/themeEvent";
import { savePushPrefs } from "@/lib/pushPrefs";
import { KeyedThrottle } from "@/lib/keyedThrottle";
import { loadSelfReadMarks, noteSelfRead, sinceSelfRead } from "@/lib/selfReadMarks";
import { verifyEventOnce } from "@/lib/verifyCache";
import { setPreferredVoiceServer } from "@/lib/voiceDevices";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

/** Longer than config's: reactions are rapid, and the table is only a convenience cache. */
const FREQUENT_REACTIONS_DEBOUNCE_MS = 10_000;

const SELF_SYNC_FLUSH_MS = 60;

/**
 * A query invalidated by a self-sync edition refetches at most this often. Each
 * community-list edition re-reads every fragment from every self-state relay, so
 * another client republishing it once a second would drive a full sync a second.
 */
const SELF_SYNC_KEY_MIN_GAP_MS = 15_000;

/** Background time before the self-state REQ is rebuilt on return (half-open sockets never reconnect). */
const SELF_SYNC_RESUBSCRIBE_AFTER_AWAY_MS = 30_000;

function dTagOf(event: NostrEvent): string | undefined {
  for (const t of event.tags) if (t[0] === "d") return t[1];
  return undefined;
}

/**
 * Self-state sync for the logged-in user's own replaceable/addressable events,
 * both directions across devices. ({@link ../wire/WireSync} owns timelines.)
 *
 * A. A standing REQ `{ authors:[me], kinds:[…] }` (plus scoped 30078 filters,
 *    and one for the documents under keys derived from the settings root)
 *    streams new versions into the cache, then invalidates the owning hook's
 *    query so it reconciles through its own merge / decrypt guards.
 * B. Application, adapted from Ditto's NostrSync:
 *    1. Encrypted settings docs (30078, derived keys) ↔ AppConfig via
 *       {@link useConfigDocSync}; see `docs/settings-documents.md`.
 *    1a. Quick-reaction frequency table ↔ its own document.
 *    1c. Blossom server list (10063) → config.
 *    1e. NIP-65 (10002) → config, restarting the stream on new write relays.
 *    2. Adopt the Ditto profile theme (16767) if none picked in Armada.
 */
export function NostrSync() {
  // Boot-gated so network catch-up doesn't compete with first paint. Every fetch is a full read.
  const bootGateOpen = useBootGateOpen();
  return bootGateOpen ? <NostrSyncInner /> : null;
}

function NostrSyncInner() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const { doc: metadata, hasNip44Support } = useEncryptedSettings();
  const reactionsDoc = useSettingsDoc("reactions");
  const { update: updateReactions } = reactionsDoc;
  const eventStore = useEventStore();
  const { keys: settingsKeys } = useSettingsKeys();
  const keyring = settingsKeys.keyring;
  const derivedAuthorKey = keyring?.authors.join(",") ?? "";

  // One instance per document, each with its own guards, so they can't race.
  useConfigDocSync("metadata");
  useConfigDocSync("rail");
  useConfigDocSync("notifications");
  useConfigDocSync("dms");

  const blossomServerList = useBlossomServerList();
  const dmRelayList = useDmRelayList();
  const searchRelayList = useSearchRelayList();
  const { applyCustomTheme } = useTheme();
  const queryClient = useQueryClient();
  const selfRelayKey = selfStateRelays(config, user?.pubkey).sort().join("\u0000");
  useFavoriteGifsSync();
  useDmConversationIndexSync();
  useRecordDmConversationIndex();

  // Bumped after real backgrounding (not an alt-tab) to rebuild the subscription.
  const resumeEpoch = useResumeEpoch(SELF_SYNC_RESUBSCRIBE_AFTER_AWAY_MS);

  const dittoCheckedPubkey = useRef<string | undefined>(undefined);
  const blossomAppliedEvent = useRef<string | undefined>(undefined);
  const dmRelaysAppliedEvent = useRef<string | undefined>(undefined);
  const searchRelaysAppliedEvent = useRef<string | undefined>(undefined);
  // NIP-01: the LOWER id wins when two replaceables share a second.
  const relayListSeenVersion = useRef<NostrEvent | undefined>(undefined);
  const seenSelfVersions = useRef<Map<string, SelfSyncEventVersion>>(new Map());
  // Ref so a debounced callback can read it without rebuilding the subscription.
  const reactionsFetched = useRef(false);
  useEffect(() => {
    reactionsFetched.current = reactionsDoc.isFetched;
  }, [reactionsDoc.isFetched]);

  // Lets Buzz media fetch with a signed BUD-11 GET header from any render site.
  useEffect(() => {
    setBuzzMediaSigner(user?.signer);
  }, [user?.signer]);

  useEffect(() => {
    blossomAppliedEvent.current = undefined;
    dmRelaysAppliedEvent.current = undefined;
    searchRelaysAppliedEvent.current = undefined;
    relayListSeenVersion.current = undefined;
    seenSelfVersions.current = new Map();
  }, [user?.pubkey]);

  // A changed destination set triggers a fresh read by every owner. Invalid/older
  // 10002s never change this key, so they can't cause a refetch storm.
  const previousSelfRelayKey = useRef(selfRelayKey);
  useEffect(() => {
    if (previousSelfRelayKey.current === selfRelayKey) return;
    previousSelfRelayKey.current = selfRelayKey;
    for (const queryKey of SELF_SYNC_OWNER_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [...queryKey] });
    }
  }, [queryClient, selfRelayKey]);

  const keyringRef = useRef(keyring);
  keyringRef.current = keyring;

  // A. Standing self-state subscription. Echoes suppressed by created_at;
  // invalidations coalesced. The first REQ per relay in a process is a full
  // read (a fixed lookback would miss changes made while away); a rebuild resumes
  // from that relay's last complete read, which is ~1 MB less per resume on an
  // account with a large read-state and many DM-index shards.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!pubkey) return;

    // No fallback to the general pool when empty: the batch contains 10009, which
    // would fan encrypted settings and vault coordinates out to NIP-29 servers.
    const relayUrls = selfRelayKey ? selfRelayKey.split("\u0000") : [];
    if (relayUrls.length === 0) return;

    const controller = new AbortController();

    // Held across resubscribes (reset on account change) so a resume doesn't
    // re-invalidate already-handled versions.
    const seen = seenSelfVersions.current;

    const pendingKeys = new KeyedThrottle<readonly string[]>(SELF_SYNC_FLUSH_MS, SELF_SYNC_KEY_MIN_GAP_MS);
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushAt = Infinity;
    const armFlush = () => {
      const delay = pendingKeys.nextDelay(Date.now());
      if (delay === undefined || Date.now() + delay >= flushAt) return;
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushAt = Date.now() + delay;
      flushTimer = setTimeout(flush, delay);
    };
    const flush = () => {
      flushTimer = undefined;
      flushAt = Infinity;
      for (const queryKey of pendingKeys.takeDue(Date.now())) {
        queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
      armFlush();
    };
    const scheduleInvalidate = (keys: readonly (readonly string[])[]) => {
      for (const key of keys) pendingKeys.add(key.join("\u0000"), key);
      armFlush();
    };

    const onEvent = (event: NostrEvent) => {
      // A document under a derived key: right author AND right `d`, or nothing.
      const derived = event.pubkey === pubkey ? undefined : derivedDocOf(keyringRef.current, event);
      // Relays can violate the author filter; don't poison the echo guard.
      if (event.pubkey !== pubkey && !derived) return;
      if (!verifyEventOnce(event)) return;
      if (derived) {
        if (event.kind !== KIND_APP_SPECIFIC || !admitSelfSyncEvent(seen, event, `${event.pubkey}:${derived.d}`)) return;
        void eventStore
          .then((store) => store.event(event))
          .catch(() => undefined)
          .finally(() => {
            if (!controller.signal.aborted) scheduleInvalidate(queryKeysForDerivedDoc(derived));
          });
        return;
      }
      if (event.kind === KIND_RELAY_LIST) {
        const previous = relayListSeenVersion.current;
        // Verifies sig/kind, rejects an empty map, applies NIP-01 timestamp/lower-id order.
        const update = newerRelayListUpdate(
          event,
          previous?.pubkey === pubkey ? previous : undefined,
        );
        if (!update) return;
        const { event: candidate, relays } = update;

        // Legacy metadata has only a timestamp: accept one equal-second winner and stamp its id.
        const sameOwner = config.relayMetadata.pubkey === pubkey;
        if (sameOwner && !relayListIsNewerThanMetadata(
          candidate,
          config.relayMetadata,
        )) return;
        relayListSeenVersion.current = candidate;

        void eventStore.then((store) => store.event(candidate)).catch(() => undefined);
        updateConfig((current) => {
          const ownsCurrent = current.relayMetadata.pubkey === pubkey;
          if (ownsCurrent && !relayListIsNewerThanMetadata(
            candidate,
            current.relayMetadata,
          )) return current;
          const next = {
            ...current,
            relayMetadata: {
              relays,
              updatedAt: candidate.created_at,
              eventId: candidate.id,
              pubkey,
            },
          };
          // Must not flip `useUserRelays` or republish an encrypted config document.
          markConfigSynced(next);
          return next;
        });

        return;
      }

      // Dedup per coordinate: the Community List is one event per fragment.
      const dTag =
        event.kind === KIND_APP_SPECIFIC || event.kind === KIND_COMMUNITY_LIST_FRAG
          ? dTagOf(event)
          : undefined;
      const topicTag = selfSyncTopicOf(event.tags);
      const keys = queryKeysForSelfEvent(event.kind, dTag, topicTag);

      if (!admitSelfSyncEvent(seen, event, dTag)) return;

      // Store first, THEN invalidate: this stream has the batcher mirror off, and
      // readers read the settings doc from the store.
      void eventStore
        .then((store) => store.event(event))
        .catch(() => undefined)
        .finally(() => {
          if (keys.length === 0) return;
          if (!controller.signal.aborted) scheduleInvalidate(keys);
        });
    };

    const filters: NostrFilter[] = [
      { authors: [pubkey], kinds: SELF_SYNC_REPLACEABLE_KINDS },
      ...(automaticSettingsSync
        ? [
            { authors: [pubkey], kinds: [KIND_APP_SPECIFIC], "#d": SELF_SYNC_DTAGS },
            {
              authors: [pubkey],
              kinds: [KIND_APP_SPECIFIC],
              "#t": SELF_SYNC_TOPIC_TAGS,
            },
            ...(derivedAuthorKey
              ? [{ authors: derivedAuthorKey.split(","), kinds: [KIND_APP_SPECIFIC] }]
              : []),
          ]
        : []),
    ];

    // `onEvent` stores each version it admits itself; see CachingReqOpts.
    const reqOpts: CachingReqOpts = { signal: controller.signal, cache: false };
    // Resumed from each relay's persisted read mark, so a cold start doesn't
    // re-read every stored version.
    void loadSelfReadMarks().then(() => {
      if (controller.signal.aborted) return;
      for (const url of relayUrls) {
        // A new filter set is a new read: a resume would miss documents older than its `since`.
        const readKey = `${pubkey}\u0000${url}\u0000${derivedAuthorKey}`;
        const relayFilters = sinceSelfRead(filters, readKey);
        const requestedAt = nowSecs();
        void (async () => {
          try {
            for await (const msg of nostr.relay(url).req(relayFilters, reqOpts)) {
              if (msg[0] === "EVENT") onEvent(msg[2] as NostrEvent);
              // Everything stamped before this REQ has now been read from `url`.
              else if (msg[0] === "EOSE") noteSelfRead(readKey, requestedAt);
            }
          } catch {
            // Subscription ended; NRelay1 reconnects, account change re-runs this.
          }
        })();
      }
    });

    return () => {
      controller.abort();
      if (flushTimer !== undefined) clearTimeout(flushTimer);
    };
    // `resumeEpoch`: half-open sockets and relay CLOSED leave the sub silently
    // dead, so rebuild after backgrounding. `selfRelayKey` follows relay-set changes.
  }, [
    nostr,
    user?.pubkey,
    queryClient,
    eventStore,
    resumeEpoch,
    selfRelayKey,
    automaticSettingsSync,
    derivedAuthorKey,
    config.relayMetadata,
    updateConfig,
  ]);

  // The voice runtime reads its localStorage key; keep it in sync with AppConfig.
  useEffect(() => {
    setPreferredVoiceServer(config.preferredVoiceServer);
  }, [config.preferredVoiceServer]);

  // Background notification runtimes can't read React state; mirror to localStorage.
  useEffect(() => {
    if (user?.pubkey) savePushPrefs(config.pushPrefs, user.pubkey);
  }, [config.pushPrefs, user?.pubkey]);

  // 1a. Merge-hydrate (max count / latest use per emoji); commutative, so the
  // legacy copy in metadata is folded in too.
  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey) return;
    if (reactionsDoc.doc?.frequentReactions) {
      hydrateFrequentReactions(user.pubkey, reactionsDoc.doc.frequentReactions);
    }
    for (const source of reactionsDoc.sources) {
      if (source.doc.frequentReactions) hydrateFrequentReactions(user.pubkey, source.doc.frequentReactions);
    }
    if (metadata?.frequentReactions) {
      hydrateFrequentReactions(user.pubkey, metadata.frequentReactions);
    }
  }, [
    automaticSettingsSync,
    user?.pubkey,
    reactionsDoc.doc?.frequentReactions,
    reactionsDoc.sources,
    metadata?.frequentReactions,
  ]);

  // Push only on user-initiated reactions, so devices can't ping-pong the table.
  useEffect(() => {
    const pubkey = user?.pubkey;
    if (!automaticSettingsSync || !pubkey || !hasNip44Support) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFrequentReactions((changed) => {
      if (changed !== pubkey) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Wait for the store read so we merge with other devices' table instead of replacing it.
        if (!reactionsFetched.current) return;
        updateReactions({ frequentReactions: getFrequentReactions(pubkey) }).catch((err) =>
          console.warn("Frequent-reaction sync failed:", err),
        );
      }, FREQUENT_REACTIONS_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [automaticSettingsSync, user?.pubkey, hasNip44Support, updateReactions]);

  // 1c. 10063 (BUD-03) is the source of truth; apply only when newer than
  // `updatedAt`. A signed empty event clears; a failed read never wipes.
  useEffect(() => {
    const event = blossomServerList.event;
    if (!user?.pubkey || !event || blossomAppliedEvent.current === event.id) return;
    blossomAppliedEvent.current = event.id;
    updateConfig((current) => {
      if (!replaceableIsNewerThanMetadata(event, current.blossomServerMetadata)) return current;
      const next = {
        ...current,
        blossomServerMetadata: {
          servers: blossomServerList.servers,
          updatedAt: event.created_at,
          eventId: event.id,
        },
      };
      markConfigSynced(next);
      return next;
    });
  }, [user?.pubkey, blossomServerList.event, blossomServerList.servers, updateConfig]);

  // 1d. A signed empty replacement clears; a missing result is ignored.
  useEffect(() => {
    const event = searchRelayList.event;
    if (!user?.pubkey
      || !event
      || searchRelayList.decryptFailed
      || searchRelaysAppliedEvent.current === event.id) return;
    searchRelaysAppliedEvent.current = event.id;
    updateConfig((current) => {
      const next = { ...current, searchRelays: searchRelayList.relays };
      markConfigSynced(next);
      return next;
    });
  }, [
    user?.pubkey,
    searchRelayList.event,
    searchRelayList.relays,
    searchRelayList.decryptFailed,
    updateConfig,
  ]);

  useEffect(() => {
    const event = dmRelayList.event;
    if (!user?.pubkey || !event || dmRelaysAppliedEvent.current === event.id) return;
    dmRelaysAppliedEvent.current = event.id;
    updateConfig((current) => {
      const next = { ...current, dmRelays: dmRelayList.relays };
      markConfigSynced(next);
      return next;
    });
  }, [user?.pubkey, dmRelayList.event, dmRelayList.relays, updateConfig]);

  // 2. Ditto profile theme fallback.
  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey) return;
    if (dittoCheckedPubkey.current === user.pubkey) return;

    // Only if no metadata document on disk AND still on the default theme.
    const usingDefault = config.theme === "dark" && !config.customTheme;
    if (metadata || !usingDefault) {
      dittoCheckedPubkey.current = user.pubkey;
      return;
    }

    dittoCheckedPubkey.current = user.pubkey;
    let cancelled = false;

    (async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [ACTIVE_THEME_KIND], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(6000) },
        );
        const event = events.sort((a, b) => b.created_at - a.created_at)[0];
        if (!event || cancelled) return;
        const theme = parseDittoTheme(event);
        if (theme && !cancelled) {
          applyCustomTheme(themeToConfig(theme));
        }
      } catch { /* ignore */ }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    automaticSettingsSync,
    user?.pubkey,
    metadata,
    config.theme,
    config.customTheme,
    nostr,
    applyCustomTheme,
  ]);

  return null;
}
