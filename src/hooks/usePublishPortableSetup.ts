import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { selfStateRelays } from "@/contexts/AppContext";
import {
  communityListWireDiffers,
  fetchCommunityListFragments,
  signCommunityListSnapshot,
  syncCommunityList,
  type FragSet,
  type PersistedList,
} from "@/concord/hooks/useCommunityList";
import { communityListFoldKey, mergeCommunityLists } from "@/concord/lib/communityList";
import {
  decodeInviteListEvents,
  inviteListFoldKey,
  inviteListKey,
  readPersistedInviteList,
  type PersistedInviteList,
} from "@/concord/hooks/useInvites";
import { KIND_COMMUNITY_LIST_FRAG, KIND_INVITE_LIST } from "@/concord/lib/kinds";
import { mergeInviteLists, type InviteList } from "@/concord/lib/invite";
import { useAppContext } from "@/hooks/useAppContext";
import { t } from "@/i18n";
import {
  KIND_BLOSSOM_SERVERS,
  type BlossomServerListQuery,
} from "@/hooks/useBlossomServerList";
import {
  KIND_DM_RELAYS,
  parseDmRelays,
  type DmRelayListQuery,
} from "@/hooks/useDmRelayList";
import {
  derivedDocFilter,
  isSettingsDocEvent,
  nextSettingsDoc,
  readSettingsDocChecked,
  settingsDocQueryKey,
  signDerivedSettingsDoc,
  useSettingsDoc,
  type SettingsDocQueryData,
} from "@/hooks/useSettingsDoc";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { signCurrentDmConversationIndexEvents } from "@/hooks/useDmConversationIndexSync";
import { signCurrentFavoriteGifEvents } from "@/hooks/useFavoriteGifsSync";
import { parseBlossomServerList } from "@/lib/blossom";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { KIND_USER_GROUPS } from "@/lib/nip29";
import {
  KIND_RELAY_LIST,
  publishSignedEventToRelays,
  queryExplicitRelaysWithStatus,
  uniqueRelayUrls,
} from "@/lib/nip65";
import { RELAY_LIST_DISCOVERY_RELAYS, RESCUE_RELAYS } from "@/lib/platform";
import {
  KIND_SEARCH_RELAYS,
  readSearchRelayList,
} from "@/lib/searchRelayList";
import type { SearchRelayListQuery } from "@/hooks/useSearchRelayList";
import {
  SETTINGS_DOC_NAMES,
  SETTINGS_DTAGS,
  SETTINGS_KIND,
  type SettingsDocName,
} from "@/lib/settingsDocs";
import { derivedDocOf, type DerivedDoc } from "@/lib/settingsKeys";
import type { SettingsKeys } from "@/lib/settingsRootStore";
import { newestSettingsRoot } from "@/lib/settingsRoot";
import {
  CONFIG_KEYS_BY_DOC,
  configSnapshot,
  docToConfigPatch,
  type ConfigDocName,
} from "@/lib/syncedConfig";
import { SELF_SYNC_DTAGS, SELF_SYNC_TOPIC_TAGS, T_ARMADA_DM_CONVERSATIONS } from "@/lib/selfSyncKinds";
import { isSigned } from "@/lib/nostrRumor";
import {
  queueSignedEvent,
  recordQueuedPublishAttempt,
  withSignature,
} from "@/lib/publishOutbox";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nowSecs } from "@/lib/relayClock";

const PUBLISH_TIMEOUT_MS = 8_000;
const MAX_PORTABLE_TOPIC_SHARDS = 512;

type PortableNostr = ReturnType<typeof useNostr>["nostr"];

export interface PortableWireState {
  events: NostrEvent[];
  communityEvents: NostrEvent[];
  communitySet: FragSet | null;
  answered: string[];
}

function dTagOf(event: NostrRumor): string | undefined {
  return event.tags.find(([name]) => name === "d")?.[1];
}

export function newestPortableAddressableEvents<T extends NostrRumor>(
  events: Iterable<T>,
  kind: number,
): T[] {
  const byD = new Map<string, T>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const d = dTagOf(event);
    if (d === undefined) continue;
    const held = byD.get(d);
    if (!held || event.created_at > held.created_at
      || (event.created_at === held.created_at && event.id < held.id)) {
      byD.set(d, event);
    }
  }
  return [...byD.values()];
}

/** Bounded set of signed records that can be mirrored byte-for-byte. */
export async function fetchPortableWireState(
  nostr: PortableNostr,
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  sourceRelays: Iterable<string>,
  signal: AbortSignal,
  requiredSourceRelays: Iterable<string> = [],
  requireEverySource = true,
  localCommunityEvents: Iterable<NostrRumor> = [],
  /** The settings root's derived authors, when the caller holds the root. */
  derivedAuthors: readonly string[] = [],
): Promise<PortableWireState> {
  const sources = uniqueRelayUrls(sourceRelays);
  const [response, inviteRescue] = await Promise.all([
    queryExplicitRelaysWithStatus(
      nostr,
      sources,
      [
        {
          kinds: [
            KIND_RELAY_LIST,
            KIND_SEARCH_RELAYS,
            KIND_USER_GROUPS,
            KIND_DM_RELAYS,
            KIND_BLOSSOM_SERVERS,
            KIND_INVITE_LIST,
          ],
          authors: [user.pubkey],
        },
        { kinds: [SETTINGS_KIND], authors: [user.pubkey], "#d": SELF_SYNC_DTAGS },
        ...(derivedAuthors.length > 0
          ? [{ kinds: [SETTINGS_KIND], authors: [...derivedAuthors], limit: derivedAuthors.length * 4 }]
          : []),
        {
          kinds: [SETTINGS_KIND],
          authors: [user.pubkey],
          "#t": SELF_SYNC_TOPIC_TAGS,
          limit: MAX_PORTABLE_TOPIC_SHARDS,
        },
        {
          kinds: [KIND_COMMUNITY_LIST_FRAG],
          authors: [user.pubkey],
          limit: 4096,
        },
      ],
      signal,
    ),
    // Creator Invite Lists are also written to the rescue set; read 13303 there so a
    // revocation only held there joins the merge.
    queryExplicitRelaysWithStatus(
      nostr,
      RESCUE_RELAYS,
      [{ kinds: [KIND_INVITE_LIST], authors: [user.pubkey] }],
      signal,
    ),
  ]);
  const required = new Set(uniqueRelayUrls(requiredSourceRelays));
  const events = [...new Map(
    [...response.events, ...inviteRescue.events].map((event) => [event.id, event]),
  ).values()];
  const fragments = await fetchCommunityListFragments(
    nostr,
    user,
    sources,
    signal,
    localCommunityEvents,
    events,
  );
  const answered = response.answered.filter((url) => fragments.answered.includes(url));
  const completeSources = [...required].filter((url) =>
    response.answered.includes(url) && fragments.answered.includes(url));
  const sourceRequirementFailed = required.size > 0 && (
    requireEverySource
      ? completeSources.length !== required.size
      : completeSources.length === 0
  );
  if (sourceRequirementFailed) {
    throw new Error(requireEverySource
      ? t({ id: "usePublishPortableSetup.sourcesIncomplete", defaultMessage: "Not all current account-state relays completed the portable-state read; the NIP-65 relay set was not changed" })
      : t({ id: "usePublishPortableSetup.bootstrapIncomplete", defaultMessage: "No bootstrap account-state relay completed the portable-state read; the NIP-65 relay set was not changed" }));
  }
  if (fragments.unreadable) {
    throw new Error(t({ id: "usePublishPortableSetup.communityDecryptFailed", defaultMessage: "Your encrypted community list could not be decrypted; nothing was published" }));
  }
  if (fragments.set && !fragments.set.complete) {
    throw new Error(
      t({ id: "usePublishPortableSetup.fragmentsMissing", defaultMessage: "Only {found} of {declared} community-list fragments were found; nothing was published" }, { found: fragments.set.createdAt.size, declared: fragments.set.declared }),
    );
  }
  const communityEvents = fragments.set
    ? [...fragments.set.winningEvents.values()].filter(isSigned)
    : [];
  return { events, communityEvents, communitySet: fragments.set, answered };
}

const PORTABLE_CONFIRM_FILTER_CHUNK = 32;

function portableCoordinate(event: NostrEvent): string {
  if (event.kind >= 30_000 && event.kind < 40_000) {
    const d = dTagOf(event);
    if (d === undefined) {
      throw new Error(`Portable addressable record kind ${event.kind} has no d tag`);
    }
    return `${event.kind}:${event.pubkey}:${d}`;
  }
  if (event.kind === 0 || event.kind === 3
    || (event.kind >= 10_000 && event.kind < 20_000)) {
    return `${event.kind}:${event.pubkey}`;
  }
  throw new Error(`Portable record kind ${event.kind} is not replaceable`);
}

function portableCoordinateFilter(event: NostrEvent): NostrFilter {
  const filter: NostrFilter = {
    kinds: [event.kind],
    authors: [event.pubkey],
    limit: 8,
  };
  if (event.kind >= 30_000 && event.kind < 40_000) {
    filter["#d"] = [dTagOf(event)!];
  }
  return filter;
}

function newerPortableRecord(candidate: NostrEvent, current: NostrEvent | undefined): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

/**
 * OK proves receipt, not retention: read back and require the exact NIP-01 head before a
 * NIP-65 pointer makes that relay authoritative.
 */
export async function confirmPortableRecordHeads(
  nostr: PortableNostr,
  events: Iterable<NostrEvent>,
  targetRelays: Iterable<string>,
): Promise<void> {
  const targets = uniqueRelayUrls(targetRelays);
  const expectedByCoordinate = new Map<string, NostrEvent>();
  for (const event of events) {
    const coordinate = portableCoordinate(event);
    const held = expectedByCoordinate.get(coordinate);
    if (newerPortableRecord(event, held)) expectedByCoordinate.set(coordinate, event);
  }
  const expected = [...expectedByCoordinate.values()];

  for (const target of targets) {
    for (let offset = 0; offset < expected.length; offset += PORTABLE_CONFIRM_FILTER_CHUNK) {
      const chunk = expected.slice(offset, offset + PORTABLE_CONFIRM_FILTER_CHUNK);
      const read = await queryExplicitRelaysWithStatus(
        nostr,
        [target],
        chunk.map(portableCoordinateFilter),
        AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      );
      if (!read.answered.includes(target)) {
        throw new Error(
          t({ id: "usePublishPortableSetup.targetUnreadable", defaultMessage: "The new account-state relay {relay} could not be read back; the NIP-65 relay set was not changed" }, { relay: target }),
        );
      }
      for (const wanted of chunk) {
        const coordinate = portableCoordinate(wanted);
        let retained: NostrEvent | undefined;
        for (const candidate of read.events) {
          if (portableCoordinate(candidate) !== coordinate) continue;
          if (newerPortableRecord(candidate, retained)) retained = candidate;
        }
        if (retained?.id !== wanted.id) {
          throw new Error(
            t({ id: "usePublishPortableSetup.targetNotRetained", defaultMessage: "The new account-state relay {relay} did not retain setup record kind {kind} as its NIP-01 winner; the relay set was not changed" }, { relay: target, kind: wanted.kind }),
          );
        }
      }
    }
  }
}

/** Durable exact-byte fan-out shared by Setup Sync and two-phase NIP-65 edits. */
export async function publishSignedPortableRecords(
  nostr: PortableNostr,
  events: Iterable<NostrEvent>,
  targetRelays: Iterable<string>,
  requireEveryDestination = false,
): Promise<{ records: number; rejectedDeliveries: number }> {
  const targets = uniqueRelayUrls(targetRelays);
  if (targets.length === 0) throw new Error(t({ id: "usePublishPortableSetup.noDestination", defaultMessage: "No portable-state destination is available" }));
  const uniqueEvents = [...new Map([...events].map((event) => [event.id, event])).values()];
  let rejectedDeliveries = 0;
  for (const event of uniqueEvents) {
    // Never fan out without a durable exact-byte retry entry.
    await queueSignedEvent(event, undefined, targets, { inheritPendingTargets: false });
    const result = await publishSignedEventToRelays(nostr, event, targets, PUBLISH_TIMEOUT_MS);
    await recordQueuedPublishAttempt(event.id, targets, result.rejected).catch(() => undefined);
    rejectedDeliveries += result.rejected.length;
    if (result.accepted.length === 0) {
      throw new Error(t({ id: "usePublishPortableSetup.noRelayAccepted", defaultMessage: "No relay accepted setup record kind {kind}" }, { kind: event.kind }));
    }
    if (requireEveryDestination && result.rejected.length > 0) {
      throw new Error(
        t({ id: "usePublishPortableSetup.stillMissing", defaultMessage: "The new relay set is still missing setup record kind {kind}; retry before changing NIP-65 relays" }, { kind: event.kind }),
      );
    }
  }
  if (requireEveryDestination) {
    await confirmPortableRecordHeads(nostr, uniqueEvents, targets);
  }
  return { records: uniqueEvents.length, rejectedDeliveries };
}

export interface PortableMirrorResult {
  records: number;
  /** Stable iff every expected replaceable/addressable head is unchanged. */
  fingerprint: string;
}

/**
 * Phase one of a NIP-65 edit: mirror all portable state to the proposed write set. A divergent
 * creator-invite list needs explicit Setup Sync first.
 */
export async function mirrorPortableStateBeforeRelayChange(
  nostr: PortableNostr,
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  sourceRelays: Iterable<string>,
  proposedWriteRelays: Iterable<string>,
  requiredSourceRelays: Iterable<string> = sourceRelays,
  requireEverySource = true,
  localSingletons: NostrRumor[] = [],
  keys: SettingsKeys = { keyring: null, previous: [] },
): Promise<PortableMirrorResult> {
  const proposed = uniqueRelayUrls(proposedWriteRelays);
  const readRelays = uniqueRelayUrls([...sourceRelays, ...proposed]);
  const wire = await fetchPortableWireState(
    nostr,
    user,
    readRelays,
    AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    requiredSourceRelays,
    requireEverySource,
    localSingletons.filter((event) => event.kind === KIND_COMMUNITY_LIST_FRAG),
    keys.keyring?.authors,
  );
  if (!proposed.every((url) => wire.answered.includes(url))) {
    throw new Error(
      t({ id: "usePublishPortableSetup.proposedIncomplete", defaultMessage: "Every proposed account-state relay must complete a portable-state read before the NIP-65 relay set can be changed" }),
    );
  }
  const persistedCommunity = await readFolded<PersistedList>(
    communityListFoldKey(user.pubkey),
  );
  const knownCommunityList = persistedCommunity && wire.communitySet
    ? mergeCommunityLists(wire.communitySet.list, persistedCommunity.list)
    : (persistedCommunity?.list ?? wire.communitySet?.list);
  const hasKnownCommunityFacts = Boolean(
    knownCommunityList
    && (knownCommunityList.entries.length > 0 || knownCommunityList.tombstones.length > 0),
  );
  if (hasKnownCommunityFacts && !wire.communitySet) {
    throw new Error(
      t({ id: "usePublishPortableSetup.communityAbsent", defaultMessage: "A known community list was absent from the current relay read; the NIP-65 relay set was not changed" }),
    );
  }
  const communityNeedsConsolidation = Boolean(
    wire.communitySet
    && (
      wire.communityEvents.length !== wire.communitySet.winningEvents.size
      || communityListWireDiffers(knownCommunityList ?? wire.communitySet.list, wire.communitySet)
    ),
  );
  const communityRecords = communityNeedsConsolidation
    ? await signCommunityListSnapshot(
      user,
      knownCommunityList ?? wire.communitySet!.list,
      wire.communitySet,
    )
    : wire.communityEvents;
  const records: NostrEvent[] = [];
  for (const kind of [KIND_SEARCH_RELAYS, KIND_USER_GROUPS, KIND_DM_RELAYS, KIND_BLOSSOM_SERVERS]) {
    const winner = newestPortableSingleton([...wire.events, ...localSingletons], kind);
    const event = winner
      ? await signedPortableRumor(user, winner)
      : undefined;
    if (event) records.push(event);
  }
  const nip78 = await portableNip78Records(user, keys, [...wire.events, ...localSingletons], true);
  records.push(...nip78.records);
  records.push(...communityRecords);

  const inviteEvents = [...wire.events, ...localSingletons]
    .filter((event) => event.kind === KIND_INVITE_LIST);
  const persistedInvites = await readPersistedInviteList(user.pubkey);
  // A known-published list missing from the read means the read was incomplete; don't rebuild.
  const knownPublishedInvites = Boolean(
    (persistedInvites && persistedInvites.newestCreatedAt > 0)
    || localSingletons.some((event) => event.kind === KIND_INVITE_LIST),
  );
  if (knownPublishedInvites && !wire.events.some((event) => event.kind === KIND_INVITE_LIST)) {
    throw new Error(
      t({ id: "usePublishPortableSetup.inviteAbsent", defaultMessage: "A known creator invite list was absent from the current relay read; the NIP-65 relay set was not changed" }),
    );
  }
  if (inviteEvents.length > 0 || persistedInvites) {
    const invite = await decodeInviteListEvents(inviteEvents, user);
    const complete = persistedInvites
      ? mergeInviteLists(invite.list, persistedInvites.list)
      : invite.list;
    if (invite.unreadable) {
      throw new Error(
        t({ id: "usePublishPortableSetup.inviteDecryptFailedRelays", defaultMessage: "Your creator invite records could not be decrypted; the NIP-65 relay set was not changed" }),
      );
    }
    const foldIsAhead = Boolean(
      persistedInvites
      && persistedInvites.newestCreatedAt > invite.newestCreatedAt,
    );
    if (invite.exactEvent
      && !foldIsAhead
      && JSON.stringify(complete) === JSON.stringify(invite.list)) {
      records.push(invite.exactEvent);
    } else {
      if (!user.signer.nip44) throw new Error(t({ id: "usePublishPortableSetup.cannotEncryptInvites", defaultMessage: "Your signer cannot encrypt creator invite records" }));
      const event = await user.signer.signEvent({
        kind: KIND_INVITE_LIST,
        content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(complete)),
        tags: [],
        created_at: Math.max(
          nowSecs(),
          invite.newestCreatedAt + 1,
          (persistedInvites?.newestCreatedAt ?? 0) + 1,
        ),
      });
      if (event.pubkey !== user.pubkey) throw new Error(t({ id: "usePublishPortableSetup.differentAccount", defaultMessage: "The signer returned a different account" }));
      records.push(event);
    }
  }
  const result = await publishSignedPortableRecords(
    nostr,
    records,
    proposed,
    true,
  );
  const fingerprint = [...new Map(records.map((event) => [portableCoordinate(event), event])).values()]
    .map((event) => `${portableCoordinate(event)}:${event.id}`)
    .sort()
    .join("|");
  return { records: result.records, fingerprint };
}

export interface PortableSetupPublishResult {
  records: number;
  destinations: number;
  rejectedDeliveries: number;
  /**
   * Local settings documents no relay returned, left alone rather than rebuilt from an
   * unconfirmed base.
   */
  unrefreshed: SettingsDocName[];
}

function newestPortableSingleton(
  events: Iterable<NostrEvent | NostrRumor>,
  kind: number,
): NostrEvent | NostrRumor | undefined {
  return [...events]
    .filter((event) => event.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export async function signedPortableSingletonWinner(
  wireEvents: NostrEvent[],
  localEvents: NostrRumor[],
  kind: number,
): Promise<NostrEvent | undefined> {
  const winner = newestPortableSingleton([...wireEvents, ...localEvents], kind);
  if (!winner) return undefined;
  const signedWire = wireEvents.find((event) => event.id === winner.id && isSigned(event));
  if (signedWire) return signedWire;
  try {
    return await withSignature(winner);
  } catch {
    throw new Error(
      t({ id: "usePublishPortableSetup.noRetainedSignature", defaultMessage: "A newer local setup record (kind {kind}) has no retained signature; refusing to mirror an older relay copy" }, { kind }),
    );
  }
}

/**
 * Recover exact queued bytes, or re-sign the same content at a newer version: ArmadaDB strips
 * signatures, so refusing those would block migrating Android-background updates.
 */
async function signedPortableRumor(
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  rumor: NostrRumor,
): Promise<NostrEvent> {
  try {
    return await withSignature(rumor);
  } catch {
    const event = await user.signer.signEvent({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: nextCreatedAt(rumor),
    });
    if (event.pubkey !== user.pubkey) throw new Error(t({ id: "usePublishPortableSetup.differentAccount", defaultMessage: "The signer returned a different account" }));
    return event;
  }
}

function nextCreatedAt(prev: NostrRumor | undefined): number {
  const now = nowSecs();
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

/** The exact signed bytes of `rumor`, if any copy kept them. */
async function exactSignature(rumor: NostrRumor): Promise<NostrEvent | undefined> {
  try {
    return await withSignature(rumor);
  } catch {
    return undefined;
  }
}

/** A derived document's exact bytes, or the same content re-signed under its own key. */
async function signedDerivedRumor(doc: DerivedDoc, rumor: NostrRumor): Promise<NostrEvent> {
  return (await exactSignature(rumor)) ?? doc.signer.signEvent({
    kind: rumor.kind,
    content: rumor.content,
    tags: rumor.tags,
    created_at: nextCreatedAt(rumor),
  });
}

function hasTopic(event: NostrRumor, topic?: string): boolean {
  return event.tags.some(([name, value]) =>
    name === "t" && (topic === undefined ? SELF_SYNC_TOPIC_TAGS.includes(value) : value === topic));
}

/**
 * The NIP-78 records to mirror: the settings root (re-signed only if no copy kept its
 * signature), legacy account-signed documents only as exact bytes (this build never
 * writes one), and the derived documents, with the shared GIF/DM documents folded
 * over every readable edition first.
 */
async function portableNip78Records(
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  keys: SettingsKeys,
  editions: NostrRumor[],
  includeDerivedSettings: boolean,
): Promise<{ records: NostrEvent[]; topicEvents: NostrEvent[] }> {
  const own = editions.filter((event) => event.kind === SETTINGS_KIND && event.pubkey === user.pubkey);
  const records: NostrEvent[] = [];
  const root = newestSettingsRoot(own, user.pubkey);
  if (root) records.push(await signedPortableRumor(user, root));
  const legacyHeads = newestPortableAddressableEvents(
    own.filter((event) => SETTINGS_DTAGS.includes(dTagOf(event) ?? "") || hasTopic(event)),
    SETTINGS_KIND,
  );
  for (const head of legacyHeads) {
    const exact = await exactSignature(head);
    if (exact) records.push(exact);
  }

  const keyring = keys.keyring;
  if (!keyring) return { records, topicEvents: [] };
  const ctx = { signer: user.signer, pubkey: user.pubkey, keys };
  const derived = editions.filter((event) => derivedDocOf(keyring, event));
  const ofFamily = (family: DerivedDoc["ref"]["family"]) =>
    derived.filter((event) => derivedDocOf(keyring, event)!.ref.family === family);
  const repaired = [
    ...await signCurrentDmConversationIndexEvents(
      [...ofFamily("dm-conversations"), ...own.filter((event) => hasTopic(event, T_ARMADA_DM_CONVERSATIONS))],
      ctx,
    ),
    ...await signCurrentFavoriteGifEvents(
      [...ofFamily("gif-favorites"), ...own.filter((event) => hasTopic(event) && !hasTopic(event, T_ARMADA_DM_CONVERSATIONS))],
      ctx,
    ),
  ];
  const repairedAuthors = new Set(repaired.map((event) => event.pubkey));
  const untouched: NostrEvent[] = [];
  for (const head of newestPortableAddressableEvents(derived, SETTINGS_KIND)) {
    const doc = derivedDocOf(keyring, head)!;
    if (repairedAuthors.has(doc.pubkey)) continue;
    if (doc.ref.family === "settings" && !includeDerivedSettings) continue;
    untouched.push(await signedDerivedRumor(doc, head));
  }
  const topicEvents = [...repaired, ...untouched.filter((event) =>
    derivedDocOf(keyring, event)!.ref.family !== "settings")];
  return { records: [...records, ...untouched, ...repaired], topicEvents };
}

/**
 * Additive DM fields must union with the decrypted relay base before re-signing, or a stale
 * device erases others' pins/hides/accepts.
 */
export function portableConfigSnapshot(
  name: ConfigDocName,
  base: Record<string, unknown>,
  config: Parameters<typeof configSnapshot>[0],
): Record<string, unknown> {
  const local = configSnapshot(config, name);
  if (name !== "dms") return local;
  const mergedRemote = docToConfigPatch("dms", base, config);
  return {
    ...local,
    ...mergedRemote,
    // A mutable preference, not an additive set.
    ...(local.dmProtocol !== undefined ? { dmProtocol: local.dmProtocol } : {}),
  };
}

/**
 * Explicit Setup Sync to every NIP-65 write relay: signed lists mirrored byte-for-byte; a
 * missing service list is created only from a non-empty Settings value; private preferences merged
 * into the latest decryptable NIP-78 doc, never over a failed read.
 */
export function usePublishPortableSetup() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const [isPending, setIsPending] = useState(false);
  const metadataDoc = useSettingsDoc("metadata");
  const { ensure: ensureSettingsKeys } = useSettingsKeys();
  const ownsRelayList = !!user && config.relayMetadata.pubkey === user.pubkey;
  const hasSyncRelay = ownsRelayList
    && config.relayMetadata.relays.some((relay) => relay.write);
  const isConfigured = Boolean(user?.signer.nip44 && metadataDoc.doc && hasSyncRelay);
  const isAutomatic = isConfigured && config.automaticSettingsSync !== false;

  const publish = useCallback(async (): Promise<PortableSetupPublishResult> => {
    if (!user) throw new Error(t({ id: "usePublishPortableSetup.notLoggedIn", defaultMessage: "Not logged in" }));
    if (!user.signer.nip44) throw new Error(t({ id: "usePublishPortableSetup.noEncryptedSettings", defaultMessage: "Your signer does not support encrypted settings" }));

    const ownsRelayList = config.relayMetadata.pubkey === user.pubkey;
    const targets = uniqueRelayUrls(
      ownsRelayList
        ? config.relayMetadata.relays
            .filter((relay) => relay.write)
            .map((relay) => relay.url)
        : [],
    );
    if (targets.length === 0) {
      throw new Error(t({ id: "usePublishPortableSetup.noWriteRelay", defaultMessage: "Publish a NIP-65 write relay first" }));
    }

    setIsPending(true);
    try {
      const sources = uniqueRelayUrls([
        ...selfStateRelays(config, user.pubkey),
        ...targets,
        ...RELAY_LIST_DISCOVERY_RELAYS,
      ]);
      const store = await eventStore;
      // An explicit Sync now is the action that may create the account's settings root.
      const keys = await ensureSettingsKeys(true);
      const keyring = keys.keyring!;
      let localPortableRumors: NostrRumor[] = [];
      try {
        localPortableRumors = await store.query([{
          kinds: [
            KIND_RELAY_LIST,
            KIND_SEARCH_RELAYS,
            KIND_USER_GROUPS,
            KIND_DM_RELAYS,
            KIND_BLOSSOM_SERVERS,
            KIND_INVITE_LIST,
            SETTINGS_KIND,
            KIND_COMMUNITY_LIST_FRAG,
          ],
          authors: [user.pubkey],
        }, { kinds: [SETTINGS_KIND], authors: keyring.authors }]);
      } catch {
        // Wire + folded plaintext remain available when ArmadaDB is not.
      }
      // Consolidate local Concord facts onto the wire first, so offline-era joins become portable.
      const community = await syncCommunityList(
        nostr,
        user,
        queryClient,
        undefined,
        uniqueRelayUrls([...selfStateRelays(config, user.pubkey), ...targets]),
        localPortableRumors.filter((event) => event.kind === KIND_COMMUNITY_LIST_FRAG),
      );
      const wire = await fetchPortableWireState(
        nostr,
        user,
        sources,
        AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        [],
        true,
        [],
        keyring.authors,
      );
      const localSingletons = localPortableRumors.filter(
        (event) => event.kind !== KIND_COMMUNITY_LIST_FRAG,
      );
      const hasCommunityFacts = community.list.entries.length > 0
        || community.list.tombstones.length > 0;
      if (hasCommunityFacts && (
        !wire.communitySet
        || communityListWireDiffers(community.list, wire.communitySet)
      )) {
        throw new Error(t({ id: "usePublishPortableSetup.communityNotDelivered", defaultMessage: "Your complete community list did not reach the account relays; nothing was published" }));
      }
      const { events } = wire;

      const relayList = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_RELAY_LIST,
      );
      if (!relayList) {
        throw new Error(t({ id: "usePublishPortableSetup.nip65RefreshFailed", defaultMessage: "Could not refresh your signed NIP-65 list; nothing was published" }));
      }

      // Portable data first, discovery pointer LAST, so a partial run never advertises relays
      // that lack the state.
      const toPublish: NostrEvent[] = [...wire.communityEvents];
      const groupWinner = newestPortableSingleton(
        [...events, ...localSingletons],
        KIND_USER_GROUPS,
      );
      const groupList = groupWinner
        ? await signedPortableRumor(user, groupWinner)
        : undefined;
      if (groupList) toPublish.push(groupList);

      let searchEvent = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_SEARCH_RELAYS,
      );
      if (!searchEvent && config.searchRelays.length > 0) {
        searchEvent = await user.signer.signEvent({
          kind: KIND_SEARCH_RELAYS,
          content: "",
          tags: config.searchRelays.map((relay) => ["relay", relay]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (searchEvent) toPublish.push(searchEvent);

      let dmEvent = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_DM_RELAYS,
      );
      if (!dmEvent && config.dmRelays.length > 0) {
        dmEvent = await user.signer.signEvent({
          kind: KIND_DM_RELAYS,
          content: "",
          tags: config.dmRelays.map((relay) => ["relay", relay]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (dmEvent) toPublish.push(dmEvent);

      let blossomEvent = await signedPortableSingletonWinner(
        events,
        localSingletons,
        KIND_BLOSSOM_SERVERS,
      );
      if (!blossomEvent && config.blossomServerMetadata.servers.length > 0) {
        blossomEvent = await user.signer.signEvent({
          kind: KIND_BLOSSOM_SERVERS,
          content: "",
          tags: config.blossomServerMetadata.servers.map((server) => ["server", server]),
          created_at: nextCreatedAt(undefined),
        });
      }
      if (blossomEvent) toPublish.push(blossomEvent);

      const nip78 = await portableNip78Records(user, keys, [...events, ...localSingletons], false);
      const portableTopicEvents = nip78.topicEvents;
      toPublish.push(...nip78.records);

      // Invite bookkeeping holds revocation secrets/tombstones: consolidate divergent copies into
      // one fresh event instead of mirroring the newest lossy one.
      const inviteEvents = [...events, ...localSingletons]
        .filter((event) => event.kind === KIND_INVITE_LIST);
      const decodedInvites = await decodeInviteListEvents(inviteEvents, user);
      if (decodedInvites.unreadable) {
        throw new Error(t({ id: "usePublishPortableSetup.inviteDecryptFailed", defaultMessage: "Your creator invite records could not be decrypted; nothing was published" }));
      }
      const cachedInvites = queryClient.getQueryData<InviteList>(inviteListKey(user.pubkey));
      const persistedInvites = await readPersistedInviteList(user.pubkey);
      let inviteList = decodedInvites.list;
      if (persistedInvites) inviteList = mergeInviteLists(inviteList, persistedInvites.list);
      if (cachedInvites) inviteList = mergeInviteLists(inviteList, cachedInvites);
      let inviteSeed: {
        event: NostrEvent;
        list: InviteList;
        newestCreatedAt: number;
      } | undefined;
      if (decodedInvites.exactEvent
        && JSON.stringify(inviteList) === JSON.stringify(decodedInvites.list)
        && (persistedInvites?.newestCreatedAt ?? 0) <= decodedInvites.newestCreatedAt) {
        toPublish.push(decodedInvites.exactEvent);
        inviteSeed = {
          event: decodedInvites.exactEvent,
          list: inviteList,
          newestCreatedAt: decodedInvites.newestCreatedAt,
        };
      } else if (inviteEvents.length > 0
        || inviteList.entries.length > 0
        || inviteList.tombstones.length > 0) {
        const newestCreatedAt = Math.max(
          decodedInvites.newestCreatedAt,
          persistedInvites?.newestCreatedAt ?? 0,
        );
        const event = await user.signer.signEvent({
          kind: KIND_INVITE_LIST,
          content: await user.signer.nip44.encrypt(user.pubkey, JSON.stringify(inviteList)),
          tags: [],
          created_at: Math.max(
            nextCreatedAt(decodedInvites.newestEvent ?? undefined),
            newestCreatedAt + 1,
          ),
        });
        toPublish.push(event);
        inviteSeed = { event, list: inviteList, newestCreatedAt: event.created_at };
      }

      // Wire copies into the store first, so one read arbitrates store vs wire across every
      // source (derived, a superseded root's, legacy).
      for (const event of events) {
        if (event.kind !== SETTINGS_KIND) continue;
        if (event.pubkey !== user.pubkey && !derivedDocOf(keyring, event)) continue;
        await store.event(event).catch(() => undefined);
      }
      const ctx = { store, signer: user.signer, pubkey: user.pubkey, keys };

      // A document never written is fine; one that exists locally but came back from NO relay is
      // skipped, not rebuilt.
      const settingsSeeds: { name: SettingsDocName; event: NostrEvent; doc: unknown }[] = [];
      const unrefreshed: SettingsDocName[] = [];

      for (const name of SETTINGS_DOC_NAMES) {
        const { stored, unreadable } = await readSettingsDocChecked(ctx, name);
        if (unreadable) {
          throw new Error(
            t({ id: "usePublishPortableSetup.settingsDecryptFailed", defaultMessage: "Could not decrypt your existing private settings ({name}); nothing was published" }, { name }),
          );
        }
        const onWire = events.some((event) => isSettingsDocEvent(keys, user.pubkey, name, event));
        // Known document not found: publishing an unconfirmed base would drop data everywhere. Skip
        // only this one.
        if (!onWire && stored) {
          unrefreshed.push(name);
          continue;
        }

        const derived = keyring.settings[name];
        const head = (await store.query([derivedDocFilter(derived)]).catch((): NostrRumor[] => []))
          .sort((a, b) => b.created_at - a.created_at)[0];
        const floor = Math.max(stored?.event.created_at ?? 0, head?.created_at ?? 0) || undefined;
        const configKeys = name in CONFIG_KEYS_BY_DOC ? (name as ConfigDocName) : undefined;
        // Module-owned docs (read-state, reactions): mirror the derived copy exactly; an older
        // source's newest copy is rewritten under the derived key.
        if (!configKeys) {
          if (!stored) continue;
          if (stored.event.pubkey === derived.pubkey) {
            toPublish.push(await signedDerivedRumor(derived, stored.event));
            continue;
          }
          const event = await signDerivedSettingsDoc(derived, stored.doc, floor);
          toPublish.push(event);
          settingsSeeds.push({ name, event, doc: stored.doc });
          continue;
        }

        const base = (stored?.doc ?? {}) as Record<string, unknown>;
        const next = nextSettingsDoc(
          name,
          base as never,
          portableConfigSnapshot(configKeys, base, config) as never,
        );
        const settingsEvent = await signDerivedSettingsDoc(derived, next, floor);
        toPublish.push(settingsEvent);
        settingsSeeds.push({ name, event: settingsEvent, doc: next });
      }

      toPublish.push(relayList);
      const uniqueToPublish = [...new Map(toPublish.map((event) => [event.id, event])).values()];
      for (const event of uniqueToPublish) {
        if (event.pubkey !== user.pubkey && !keyring.byPubkey.has(event.pubkey)) {
          throw new Error(t({ id: "usePublishPortableSetup.differentAccount", defaultMessage: "The signer returned a different account" }));
        }
      }

      const portableResult = await publishSignedPortableRecords(
        nostr,
        uniqueToPublish.filter((event) => event.kind !== KIND_RELAY_LIST),
        targets,
      );
      const pointerResult = await publishSignedPortableRecords(
        nostr,
        [relayList],
        uniqueRelayUrls([...targets, ...RELAY_LIST_DISCOVERY_RELAYS]),
      );
      const rejectedDeliveries = portableResult.rejectedDeliveries + pointerResult.rejectedDeliveries;

      if (searchEvent) {
        queryClient.setQueryData<SearchRelayListQuery>(
          ["search-relay-list", user.pubkey],
          { event: searchEvent, ...(await readSearchRelayList(searchEvent, user.signer)) },
        );
      }
      if (dmEvent) {
        queryClient.setQueryData<DmRelayListQuery>(["dm-relay-list", user.pubkey], {
          event: dmEvent,
          relays: parseDmRelays(dmEvent),
        });
      }
      if (blossomEvent) {
        const servers = parseBlossomServerList(blossomEvent);
        queryClient.setQueryData<BlossomServerListQuery>(
          ["blossom-server-list", user.pubkey],
          { event: blossomEvent, servers },
        );
        updateConfig((current) => ({
          ...current,
          blossomServerMetadata: {
            servers,
            updatedAt: blossomEvent!.created_at,
            eventId: blossomEvent!.id,
          },
        }));
      }
      // Store what we published so the next read (here or in the notification service) sees it.
      for (const { name, event, doc } of settingsSeeds) {
        await store.event(event);
        queryClient.setQueryData<SettingsDocQueryData<typeof name>>(
          settingsDocQueryKey(name, user.pubkey),
          { event, doc: doc as never, sources: [{ event, doc: doc as never }] },
        );
      }
      for (const event of [...wire.communityEvents, ...portableTopicEvents, ...(inviteSeed ? [inviteSeed.event] : [])]) {
        await store.event(event).catch(() => undefined);
      }
      if (inviteSeed) {
        await writeFolded(inviteListFoldKey(user.pubkey), {
          list: inviteSeed.list,
          newestCreatedAt: inviteSeed.newestCreatedAt,
        } satisfies PersistedInviteList);
        queryClient.setQueryData(inviteListKey(user.pubkey), inviteSeed.list);
      }
      if (wire.communityEvents.length > 0) {
        await queryClient.invalidateQueries({ queryKey: ["concord", "list", user.pubkey] });
      }
      if (portableTopicEvents.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["dm-conversations-sync"] });
        void queryClient.invalidateQueries({ queryKey: ["favorite-gifs-sync"] });
      }

      return {
        records: uniqueToPublish.length,
        destinations: targets.length,
        rejectedDeliveries,
        unrefreshed,
      };
    } finally {
      setIsPending(false);
    }
  }, [config, ensureSettingsKeys, eventStore, nostr, queryClient, updateConfig, user]);

  return {
    publish,
    isPending,
    isConfigured,
    isAutomatic,
    isStatusLoading: metadataDoc.isLoading,
  };
}
