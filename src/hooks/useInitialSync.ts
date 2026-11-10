import { useNostr } from "@nostrify/react";
import { useNostrLogin } from "@nostrify/react/login";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { accountDataRelays, selfStateRelays } from "@/contexts/AppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useEventStore } from "@/hooks/useEventStore";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import { listQueryKey, syncCommunityList } from "@/concord/hooks/useCommunityList";
import { liveEntries } from "@/concord/lib/communityList";
import { warmupCommunities } from "@/concord/lib/loginWarmup";
import {
  KIND_GROUP_CHAT,
  KIND_USER_GROUPS,
  type GroupRef,
} from "@/lib/nip29";
import {
  resolveGroupListRead,
  type UserGroupListQuery,
} from "@/hooks/useUserGroupList";
import { isBlockedNow, refreshBlocklist } from "@/lib/blocklistStore";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { groupListFoldKey, type PersistedGroupList } from "@/lib/nip29ServerCache";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_KIND,
  hasMigratedKeys,
} from "@/lib/settingsDocs";
import { SELF_SYNC_DTAGS } from "@/lib/selfSyncKinds";
import { resolveSettingsKeys, type SettingsKeys } from "@/lib/settingsRootStore";
import { settingsKeysQueryKey } from "@/hooks/useSettingsKeys";
import { parseBlossomServerList } from "@/lib/blossom";
import {
  newestCanonicalSelfList,
  readStoredCanonicalSelfLists,
  replaceableVersionIsNewer,
  replaceableIsNewerThanMetadata,
} from "@/lib/canonicalSelfList";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import { logSync, sinceMs } from "@/lib/syncLog";
import {
  readSettingsDocSources,
  settingsDocExists,
  settingsDocQueryKey,
  type SettingsDocQueryData,
} from "@/hooks/useSettingsDoc";
import {
  decodeAndHydrateDmConversationIndex,
  dmConversationIndexFilters,
} from "@/hooks/useDmConversationIndexSync";
import { dmConversationIndexFilter } from "@/lib/dmConversationIndex";
import {
  discoverRelayList,
  KIND_RELAY_LIST,
  parseRelayList,
  queryExplicitRelays,
  queryExplicitRelaysWithStatus,
  relayListIsNewerThanMetadata,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { markNotificationSettingsReady } from "@/lib/notificationSettingsAuthority";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { defineMessages, t, type MessageDescriptor } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

/** NIP-88 poll kind — polls render inline in the group timeline. */
const KIND_POLL = 1068;
/** Mirrors useGroupMessages. */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];
/** Mirrors useGroupMessages PAGE_SIZE. */
const PAGE_SIZE = 50;
/** Only messages in this window are synced at login; older history is reached by scrolling. */
const CATCHUP_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_CATCHUP_CHANNELS = 8;

/**
 * Overall budget so a dead relay never traps the user; the in-chat status bar carries
 * whatever remains.
 */
const SYNC_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;
/**
 * Once the first relay in a batch answers, wait at most this long for stragglers. A relay
 * still in flight counts as neither answered nor failed (absence stays non-authoritative).
 */
const STEP_GRACE_MS = 1_500;
/**
 * Extra wait past the budget for the SETTINGS branch alone (theme/relay config), so the gate
 * doesn't lift onto defaults and repaint. Covers its two sequential reads.
 */
const SETTINGS_PRIORITY_GRACE_MS = 2 * STEP_TIMEOUT_MS;

export type SyncPhase =
  | "relays"
  | "settings"
  | "groups"
  | "messages"
  | "communities"
  | "channels"
  | "done";

/** One line in the SyncGate's boot-log terminal. */
export interface SyncLogLine {
  id: string;
  text: string;
  status?: string;
  tone?: "ok" | "info" | "warn";
}

export interface SyncState {
  phase: SyncPhase;
  log: SyncLogLine[];
  done: boolean;
}

const PHASE_OPENING: Record<Exclude<SyncPhase, "done">, MessageDescriptor> = defineMessages({
  relays: { id: "useInitialSync.phase.relays", defaultMessage: "locating signed relay map" },
  settings: { id: "useInitialSync.phase.settings", defaultMessage: "establishing secure channel" },
  groups: { id: "useInitialSync.phase.groups", defaultMessage: "mounting channel directory" },
  messages: { id: "useInitialSync.phase.messages", defaultMessage: "syncing recent transmissions" },
  communities: { id: "useInitialSync.phase.communities", defaultMessage: "restoring encrypted communities" },
  channels: { id: "useInitialSync.phase.channels", defaultMessage: "decrypting channel history" },
});

/**
 * One-time post-login sync for `pubkey`, with live progress:
 * 1. Discover the signed NIP-65 relay map.
 * 2. Encrypted settings (NIP-78 kind 30078), seeding their caches.
 * 3. The kind 10009 group list.
 * 4. Newest page per joined channel (capped).
 * 5. Concord community list (kind 33302) plus community warm-up (see warmupCommunities).
 * Every step is best-effort and timeout-bounded. `pubkey === undefined` stays idle.
 */
export function useInitialSync(pubkey: string | undefined): SyncState {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const { logins } = useNostrLogin();

  // Via a ref so the login list doesn't re-run the once-per-pubkey effect.
  const soleAccountRef = useRef(true);
  soleAccountRef.current = logins.length <= 1;

  // Relay discovery changes config mid-sequence; read via ref so the effect doesn't restart.
  const configRef = useRef(config);
  configRef.current = config;

  // The setter is recreated when config changes; depending on it would cancel this run
  // right after relay adoption, and the once-per-pubkey guard would never restart it.
  const updateConfigRef = useRef(updateConfig);
  updateConfigRef.current = updateConfig;

  const [state, setState] = useState<SyncState>({
    phase: "settings",
    log: [],
    done: pubkey === undefined,
  });

  const ranForRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pubkey) {
      setState({ phase: "done", log: [], done: true });
      return;
    }
    // Settings and the group list need this pubkey's signer (NIP-44).
    if (!user || user.pubkey !== pubkey) return;
    if (ranForRef.current === pubkey) return;
    ranForRef.current = pubkey;

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState({
        phase: "done",
        log: [
          {
            id: "auth",
            text: t({ id: "useInitialSync.authenticated", defaultMessage: "authenticated {key}" }, { key: `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` }),
            status: t({ id: "useInitialSync.status.ok", defaultMessage: "OK" }),
            tone: "ok",
          },
          { id: "offline", text: t({ id: "useInitialSync.offlineMode", defaultMessage: "offline mode active" }), status: t({ id: "useInitialSync.status.mesh", defaultMessage: "MESH" }), tone: "info" },
        ],
        done: true,
      });
      return;
    }

    let cancelled = false;
    const overall = AbortSignal.timeout(SYNC_TIMEOUT_MS);
    const log: SyncLogLine[] = [];
    /** Lifted by completion, budget, or hard cap; idempotent. */
    let lifted = false;
    let settingsSettled = false;
    /** Bounds only the non-settings work. */
    let budgetExpired = false;

    const begin = (phase: Exclude<SyncPhase, "done">): string => {
      const id = `${phase}`;
      logSync("gate", `phase "${phase}" started`);
      log.push({ id, text: t(PHASE_OPENING[phase]) });
      // After lifting, a straggling branch must not re-raise the overlay.
      if (!cancelled && !lifted) setState({ phase, log: [...log], done: false });
      return id;
    };

    const resolve = (id: string, status: string, tone: SyncLogLine["tone"] = "ok") => {
      logSync("gate", `phase "${id}" resolved: ${status}`);
      const line = log.find((l) => l.id === id);
      if (line) {
        line.status = status;
        line.tone = tone;
      }
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    /**
     * A phase that found nothing is noise (e.g. "0 channels" for every Concord-only account), so
     * drop its line once the count is known.
     */
    const drop = (id: string) => {
      const i = log.findIndex((l) => l.id === id);
      if (i === -1) return;
      log.splice(i, 1);
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    const progress = (id: string, status: string) => {
      const line = log.find((l) => l.id === id);
      if (line && !line.tone) {
        line.status = status;
        if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
      }
    };

    const note = (id: string, text: string, status?: string, tone: SyncLogLine["tone"] = "info") => {
      log.push({ id, text, status, tone });
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    /** Idempotent; branches keep running in the background afterwards. */
    const lift = () => {
      if (lifted || cancelled) return;
      lifted = true;
      clearTimeout(budget);
      clearTimeout(hardCap);
      note("ready", t({ id: "useInitialSync.ready", defaultMessage: "all systems nominal" }), t({ id: "useInitialSync.status.ready", defaultMessage: "READY" }), "ok");
      setState((s) => ({ ...s, phase: "done", done: true }));
    };
    /** Lift once the budget elapsed AND settings settled (settings decides theme/relay config). */
    const liftIfReady = () => {
      if (budgetExpired && settingsSettled) lift();
    };
    // A timer rather than `overall`'s abort event so fake timers can drive it in tests.
    const budget = setTimeout(() => {
      budgetExpired = true;
      liftIfReady();
    }, SYNC_TIMEOUT_MS);
    // Absolute ceiling: even a settings branch ignoring its abort can't trap the user.
    const hardCap = setTimeout(lift, SYNC_TIMEOUT_MS + SETTINGS_PRIORITY_GRACE_MS);

    const stepSignal = () => AbortSignal.any([overall, AbortSignal.timeout(STEP_TIMEOUT_MS)]);
    // Settings reads use only their step timeout, so an in-flight read can finish after the
    // budget elapses (the gate is holding for it).
    const settingsStepSignal = () => AbortSignal.timeout(STEP_TIMEOUT_MS);

    void (async () => {
      const shortPk = `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
      note("auth", t({ id: "useInitialSync.authenticated", defaultMessage: "authenticated {key}" }, { key: shortPk }), t({ id: "useInitialSync.status.ok", defaultMessage: "OK" }), "ok");

      const rId = begin("relays");
      let accountRelays = accountDataRelays(configRef.current, pubkey);
      try {
        const pointerSignal = stepSignal();
        const [remoteDiscovery, storedPointers] = await Promise.all([
          discoverRelayList(
            nostr,
            pubkey,
            uniqueRelayUrls([
              ...accountRelays,
              ...configRef.current.appRelays,
              ...RELAY_LIST_DISCOVERY_RELAYS,
            ]),
            pointerSignal,
            { graceMs: STEP_GRACE_MS },
          ),
          readStoredCanonicalSelfLists(
            eventStore,
            pubkey,
            [KIND_RELAY_LIST],
            pointerSignal,
          ),
        ]);
        // Android's background service may have persisted a newer pointer; treat that local rumor as
        // canonical so a stale discovery relay can't switch this boot away.
        const storedPointer = newestCanonicalSelfList(
          storedPointers.events.filter((event) => parseRelayList(event).length > 0),
          pubkey,
          KIND_RELAY_LIST,
        );
        const discovery = storedPointer && (
          !remoteDiscovery
          || replaceableVersionIsNewer(storedPointer, remoteDiscovery.event)
        )
          ? { event: storedPointer, relays: parseRelayList(storedPointer) }
          : remoteDiscovery;
        if (discovery) {
          const current = configRef.current;
          // A first discovery is the user's own signed declaration: adopt it. Preserve a later toggle-off.
          const sameOwner = current.relayMetadata.pubkey === pubkey;
          const metadataIsNewer = !sameOwner
            || relayListIsNewerThanMetadata(discovery.event, current.relayMetadata);
          if (metadataIsNewer) {
            const next = {
              ...current,
              useUserRelays:
                metadataIsNewer && (!sameOwner || current.relayMetadata.updatedAt === 0)
                  ? true
                  : current.useUserRelays,
              relayMetadata: metadataIsNewer
                ? {
                    relays: discovery.relays,
                    updatedAt: discovery.event.created_at,
                    eventId: discovery.event.id,
                    pubkey,
                  }
                : current.relayMetadata,
            };
            configRef.current = next;
            updateConfigRef.current((live) => {
              const sameLiveOwner = live.relayMetadata.pubkey === pubkey;
              const liveMetadataIsNewer = !sameLiveOwner
                || relayListIsNewerThanMetadata(discovery.event, live.relayMetadata);
              if (!liveMetadataIsNewer) return live;
              return {
                ...live,
                useUserRelays:
                  liveMetadataIsNewer && (!sameLiveOwner || live.relayMetadata.updatedAt === 0)
                    ? true
                    : live.useUserRelays,
                relayMetadata: liveMetadataIsNewer ? next.relayMetadata : live.relayMetadata,
              };
            });
          }
          // Use the discovered write set for this bootstrap even if disabled for ongoing traffic, so we
          // can find the preference recording that choice.
          accountRelays = uniqueRelayUrls([
            ...accountRelays,
            ...discovery.relays.filter((relay) => relay.write).map((relay) => relay.url),
          ]);
          resolve(rId, t({ id: "useInitialSync.status.found", defaultMessage: "{count} FOUND" }, { count: discovery.relays.length }));
        } else {
          resolve(rId, t({ id: "useInitialSync.status.appDefaults", defaultMessage: "APP DEFAULTS" }), "info");
        }
      } catch {
        resolve(rId, t({ id: "useInitialSync.status.appDefaults", defaultMessage: "APP DEFAULTS" }), "warn");
      }
      if (cancelled) return;

      // Steps 2–6 run as three independent concurrent branches (settings, NIP-29, Concord); ordering
      // is kept within each branch, and `done` awaits all three.

      const branchSettings = async () => {
        // Their normal queries may have cached an empty read against app defaults before discovery.
        let canonicalSearch: SearchRelayListQuery | undefined;
        let canonicalDm: DmRelayListQuery | undefined;
        let canonicalBlossom: (BlossomServerListQuery & { event: NostrRumor }) | undefined;
        try {
          const deadline = settingsStepSignal();
          const [wireEvents, stored] = await Promise.all([
            queryExplicitRelays(
              nostr,
              accountRelays,
              [{
                kinds: [KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
                authors: [pubkey],
              }],
              deadline,
              { graceMs: STEP_GRACE_MS },
            ),
            readStoredCanonicalSelfLists(
              eventStore,
              pubkey,
              [KIND_SEARCH_RELAYS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS],
              deadline,
            ),
          ]);
          const cachedSearch = queryClient.getQueryData<SearchRelayListQuery>(
            ["search-relay-list", pubkey],
          );
          const cachedDm = queryClient.getQueryData<DmRelayListQuery>(["dm-relay-list", pubkey]);
          const cachedBlossom = queryClient.getQueryData<BlossomServerListQuery>(
            ["blossom-server-list", pubkey],
          );
          const candidates: NostrRumor[] = [
            ...wireEvents,
            ...stored.events,
            ...(cachedSearch?.event ? [cachedSearch.event] : []),
            ...(cachedDm?.event ? [cachedDm.event] : []),
            ...(cachedBlossom?.event ? [cachedBlossom.event] : []),
          ];
          const newest = (kind: number) => newestCanonicalSelfList(candidates, pubkey, kind);

          const searchEvent = newest(KIND_SEARCH_RELAYS);
          if (searchEvent) {
            canonicalSearch = {
              event: searchEvent,
              ...(await readSearchRelayList(searchEvent, user.signer)),
            };
            if (!canonicalSearch.decryptFailed) {
              queryClient.setQueryData(["search-relay-list", pubkey], canonicalSearch);
            }
          }

          const dmEvent = newest(KIND_DM_RELAYS);
          if (dmEvent) {
            canonicalDm = { event: dmEvent, relays: parseDmRelays(dmEvent) };
            queryClient.setQueryData(["dm-relay-list", pubkey], canonicalDm);
          }

          const blossomEvent = newest(KIND_BLOSSOM_SERVERS);
          if (blossomEvent) {
            canonicalBlossom = {
              event: blossomEvent,
              servers: parseBlossomServerList(blossomEvent),
            };
            queryClient.setQueryData(["blossom-server-list", pubkey], canonicalBlossom);
          }

          if (!cancelled && (canonicalSearch || canonicalDm || canonicalBlossom)) {
            const search = canonicalSearch && !canonicalSearch.decryptFailed
              ? canonicalSearch.relays
              : undefined;
            updateConfigRef.current((current) => ({
              ...current,
              ...(search ? { searchRelays: search } : {}),
              ...(canonicalDm ? { dmRelays: canonicalDm.relays } : {}),
              ...(canonicalBlossom
                && replaceableIsNewerThanMetadata(
                  canonicalBlossom.event,
                  current.blossomServerMetadata,
                )
                ? {
                    blossomServerMetadata: {
                      servers: canonicalBlossom.servers,
                      updatedAt: canonicalBlossom.event.created_at,
                      eventId: canonicalBlossom.event.id,
                    },
                  }
                : {}),
            }));
          }
        } catch {
          // Best-effort; the owning hooks retry after the pool adopts NIP-65.
        }

        const sId = begin("settings");
        const settingsStart = Date.now();
        const settingsStep = (what: string) =>
          logSync("gate", `settings: ${what} (+${sinceMs(settingsStart)})`);
        let settingsFound = false;
        const automaticSettingsSync = configRef.current.automaticSettingsSync !== false;
        try {
          if (user.signer.nip44 && automaticSettingsSync) {
            const store = await eventStore;
            const derivedFilters = (keys: SettingsKeys) => keys.keyring
              ? [{ kinds: [SETTINGS_KIND], authors: keys.keyring.authors }]
              : [];
            // Store what a read found: every reader below reads the store, not this response.
            const readInto = async (filters: NostrFilter[]) => {
              const read = await queryExplicitRelaysWithStatus(
                nostr,
                accountRelays,
                filters,
                settingsStepSignal(),
                { graceMs: STEP_GRACE_MS },
              );
              await Promise.allSettled(read.events.map((event) => store.event(event)));
              settingsStep(
                `read ${read.events.length} event(s); answered ${read.answered.length}, failed ${read.failed.length} of ${accountRelays.length}`,
              );
              return read;
            };

            // A held root reads every document in one round trip; a fresh device first
            // needs the root from the wire, then the documents it addresses.
            let keys = await resolveSettingsKeys(store, user.signer, pubkey);
            const reads = [await readInto([
              // No `limit`: it caps the whole filter, not each `d`.
              { kinds: [SETTINGS_KIND], authors: [pubkey], "#d": SELF_SYNC_DTAGS },
              ...derivedFilters(keys),
              // The DM index must never widen to the general-pool fallback; with no explicit destination,
              // stay local and retry after discovery.
              ...(accountRelays.length > 0 ? [dmConversationIndexFilter(pubkey)] : []),
            ])];
            const heldKeyring = keys.keyring?.id;
            keys = await resolveSettingsKeys(store, user.signer, pubkey);
            if (keys.keyring && keys.keyring.id !== heldKeyring) {
              settingsStep("settings root decrypted");
              reads.push(await readInto(derivedFilters(keys)));
            }
            if (!cancelled) queryClient.setQueryData(settingsKeysQueryKey(pubkey), keys);
            const expectedSettingsRelays = uniqueRelayUrls(accountRelays);
            const settingsAbsenceAuthoritative = expectedSettingsRelays.length > 0
              && reads.every((read) => read.failed.length === 0
                && read.answered.length === expectedSettingsRelays.length);

            // Seed each document's cache to spare hooks the store round-trip on first render.
            const ctx = { store, signer: user.signer, pubkey, keys };
            for (const name of SETTINGS_DOC_NAMES) {
              if (name === "metadata") continue; // metadata is seeded below
              const sources = await readSettingsDocSources(ctx, name);
              settingsStep(`${name} ${sources.length > 0 ? "decoded" : "absent"}`);
              if (sources[0] && !cancelled) {
                queryClient.setQueryData<SettingsDocQueryData<typeof name>>(
                  settingsDocQueryKey(name, pubkey),
                  { ...sources[0], sources },
                );
              }
            }

            const metadataSources = await readSettingsDocSources(ctx, "metadata");
            const stored = metadataSources[0];
            const legacyNotificationsPresent = metadataSources.some((source) =>
              hasMigratedKeys(source.doc, "notifications"));
            if (stored && !cancelled) {
              settingsStep("metadata decrypted");
              // Fold this run's canonical relay lists (NIP-65, 10007/10050/10063) over the NIP-78 blob.
              const merged = {
                ...stored.doc,
                ...(canonicalSearch && !canonicalSearch.decryptFailed
                  ? { searchRelays: canonicalSearch.relays }
                  : {}),
                ...(canonicalDm ? { dmRelays: canonicalDm.relays } : {}),
                ...(canonicalBlossom
                  ? {
                      blossomServerMetadata: {
                        servers: canonicalBlossom.servers,
                        updatedAt: canonicalBlossom.event.created_at,
                        eventId: canonicalBlossom.event.id,
                      },
                    }
                  : {}),
              };
              // Seeded for `merged`, which exists only in memory (the event itself is already in ArmadaDB).
              queryClient.setQueryData<SettingsDocQueryData<"metadata">>(
                settingsDocQueryKey("metadata", pubkey),
                { event: stored.event, doc: merged, sources: metadataSources },
              );
              settingsFound = true;

              // Migration: pre-migration clients stored 10007/10050/10063 only in the NIP-78 blob. Keep the
              // blob's value locally until an explicit publish; nothing is published here.
              const legacySearch = !canonicalSearch && Array.isArray(stored.doc.searchRelays)
                ? stored.doc.searchRelays
                : undefined;
              const legacyDm = !canonicalDm && Array.isArray(stored.doc.dmRelays)
                ? stored.doc.dmRelays
                : undefined;
              const legacyBlossom = !canonicalBlossom && stored.doc.blossomServerMetadata
                ? stored.doc.blossomServerMetadata
                : undefined;
              if (legacySearch || legacyDm || legacyBlossom) {
                updateConfigRef.current((current) => ({
                  ...current,
                  ...(legacySearch ? { searchRelays: legacySearch } : {}),
                  ...(legacyDm ? { dmRelays: legacyDm } : {}),
                  ...(legacyBlossom ? { blossomServerMetadata: legacyBlossom } : {}),
                }));
              }
            }

            // An empty notifications doc is authoritative only after every self-state relay reached EOSE.
            if (
              !cancelled
              && settingsAbsenceAuthoritative
              && !legacyNotificationsPresent
              && !(await settingsDocExists(ctx, "notifications"))
            ) {
              markNotificationSettingsReady(pubkey);
            }

            // Off the settings phase: one sequential signer decrypt per legacy shard could hold
            // theme/relay config past the hard cap. Decryptions are cached.
            if (accountRelays.length > 0) {
              void store.query(dmConversationIndexFilters(pubkey, keys))
                .then((events) => decodeAndHydrateDmConversationIndex(events, ctx))
                .then(() => settingsStep("DM conversation index hydrated"))
                .catch(() => undefined);
            }
          }
        } catch (err) {
          // Best-effort; fall through to the next step.
          settingsStep(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
        resolve(
          sId,
          automaticSettingsSync
            ? (settingsFound ? t({ id: "useInitialSync.status.restored", defaultMessage: "RESTORED" }) : t({ id: "useInitialSync.status.defaults", defaultMessage: "DEFAULTS" }))
            : t({ id: "useInitialSync.status.off", defaultMessage: "OFF" }),
          settingsFound ? "ok" : "info",
        );
      };

      const branchGroups = async () => {
        const gId = begin("groups");
        let groups: GroupRef[] = [];
        try {
          const groupSignal = stepSignal();
          const [wireEvents, storedGroups] = await Promise.all([
            queryExplicitRelays(
              nostr,
              accountRelays,
              [{ kinds: [KIND_USER_GROUPS], authors: [pubkey], limit: 1 }],
              groupSignal,
              { graceMs: STEP_GRACE_MS },
            ),
            readStoredCanonicalSelfLists(
              eventStore,
              pubkey,
              [KIND_USER_GROUPS],
              groupSignal,
            ),
          ]);
          const queryKey = ["nip29", "user-groups", pubkey];
          const previous = queryClient.getQueryData<UserGroupListQuery>(queryKey);
          const persisted = await readFolded<PersistedGroupList>(groupListFoldKey(pubkey));
          const list = await resolveGroupListRead(
            [...wireEvents, ...storedGroups.events].filter((event) => event.pubkey === pubkey),
            user.signer,
            previous,
            persisted,
          );
          groups = list.groups;
          if (!cancelled && (list.event || previous || persisted)) {
            queryClient.setQueryData(queryKey, list);
            if (list.event && !list.decryptFailed) {
              void writeFolded(groupListFoldKey(pubkey), {
                event: list.event,
                groups: list.groups,
                servers: list.servers,
              } satisfies PersistedGroupList);
            }
          }
        } catch {
          // Best-effort.
        }
        if (groups.length > 0) {
          resolve(gId, t({ id: "useInitialSync.status.channels", defaultMessage: "{count, plural, one {# channel} other {# channels}}" }, { count: groups.length }));
        } else {
          drop(gId);
        }
        if (cancelled) return;

        // Skipped outright with no NIP-29 channels.
        const channels = groups.slice(0, MAX_CATCHUP_CHANNELS);
        if (channels.length > 0) {
          const mId = begin("messages");
          let messageCount = 0;
          const since = nowSecs() - CATCHUP_WINDOW_SECONDS;
          await Promise.all(
            channels.map(async ({ id, relay }) => {
              try {
                const events = await nostr.relay(relay).query(
                  [{ kinds: TIMELINE_KINDS, "#h": [id], since, limit: PAGE_SIZE }],
                  { signal: stepSignal() },
                );
                if (cancelled) return;
                messageCount += events.length;
                // The relay() wrapper mirrors these into the store every timeline reads from.
              } catch {
                // Best-effort per channel.
              }
            }),
          );
          resolve(mId, t({ id: "useInitialSync.status.cached", defaultMessage: "{count} cached" }, { count: messageCount }));
        }
      };

      const branchConcord = async () => {
        let concordLive: ReturnType<typeof liveEntries> = [];
        // Alongside the list fetch, and settled before the warm-up below, so a
        // blocked community's history is never pulled onto the device. Never throws.
        const blocklist = refreshBlocklist(nostr);
        if (user.signer.nip44) {
          const vId = begin("communities");
          try {
            // Pass the self-state write set so a confirmed-empty read can seed §8 from local state
            // (migration off the retired single-event list).
            const listData = await syncCommunityList(
              nostr,
              user,
              queryClient,
              stepSignal(),
              selfStateRelays(configRef.current, pubkey),
            );
            logSync(
              "gate",
              `concord list fetched: event=${listData.event ? listData.event.id.slice(0, 8) : "none"} entries=${listData.list.entries.length} live=${liveEntries(listData.list).length} decryptFailed=${Boolean(listData.decryptFailed)}`,
            );
            if (!cancelled && !listData.decryptFailed) {
              queryClient.setQueryData(listQueryKey(pubkey), listData);
              concordLive = liveEntries(listData.list);
            }
          } catch (err) {
            // Best-effort; never block login on Concord.
            logSync("gate", `concord list fetch FAILED: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (concordLive.length > 0) {
            resolve(vId, t({ id: "useInitialSync.status.communities", defaultMessage: "{count, plural, one {# community} other {# communities}}" }, { count: concordLive.length }));
          } else {
            drop(vId);
          }
        }
        if (cancelled) return;
        await blocklist;
        if (cancelled) return;
        concordLive = concordLive.filter((e) => !isBlockedNow(e.community_id));

        // Without warm-up the gate lifts onto empty rooms. Raced against the budget; it keeps running
        // after a lift, visible in the sync status bar.
        if (concordLive.length > 0) {
          const hId = begin("channels");
          const warmup = warmupCommunities(nostr, concordLive, {
            signal: overall,
            onProgress: (done, total) => progress(hId, `${done}/${total}`),
            // With a second account logged in, "retired epoch" can't be judged from this list alone.
            pruneSnapshots: soleAccountRef.current,
          });
          // The abandoned branch of the race must never surface as unhandled.
          warmup.catch(() => undefined);
          const warm = await Promise.race([
            warmup,
            new Promise<undefined>((settle) => {
              if (overall.aborted) settle(undefined);
              else overall.addEventListener("abort", () => settle(undefined), { once: true });
            }),
          ]);
          if (warm) {
            resolve(hId, t({ id: "useInitialSync.status.decrypted", defaultMessage: "{count} decrypted" }, { count: warm.messages }));
          } else {
            resolve(hId, t({ id: "useInitialSync.status.continuing", defaultMessage: "CONTINUING" }), "warn");
          }
        }
        if (cancelled) return;
      };

      // Flip the flag when settings settles so the budget's deferred lift can fire.
      const settingsBranch = branchSettings().finally(() => {
        settingsSettled = true;
        liftIfReady();
      });
      const branches = Promise.all([settingsBranch, branchGroups(), branchConcord()]);

      // Deliberately do NOT write the settings sync watermark: NostrSync records it after applying
      // the settings, and writing it now would make NostrSync skip them. Reload re-gating is handled by
      // useFreshLogin.
      try {
        await branches;
      } catch {
        // Best-effort: each branch already logs its own failures.
      }
      lift();
    })();

    return () => {
      cancelled = true;
      clearTimeout(budget);
      clearTimeout(hardCap);
    };
  }, [pubkey, user, nostr, queryClient, eventStore]);

  return state;
}
