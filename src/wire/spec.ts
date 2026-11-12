import { CI_EVENT_KINDS } from "@/lib/ci";
import type { HeldRoleMention } from "@/concord/lib/roleMentions";
import { isGitAnnouncementDiscoveryRelay, normalizeRelayUrl } from "@/lib/platform";
import { BUZZ_WIRE_KINDS } from "@/buzz/kinds";
import { MAX_WRAP_BACKDATE_SECS } from "@/lib/nip17/protocol";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { GIT_ISSUE_KIND, GIT_PULL_REQUEST_KIND, GIT_STATUS_KINDS, matchGitTicketRepository, NIP22_COMMENT_KIND, parseGitTicket, type GitRepositoryAttachment } from "@/lib/gitActivity";

import type { StreamKeyView } from "@/concord/lib/derive";
import type { Channel } from "@/concord/lib/types";
import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-88 poll kind (renders in NIP-29 group timelines). */
const KIND_POLL = 1068;
/** NIP-09 deletion kind. */
const KIND_DELETE = 5;
/** Legacy NIP-04 direct message kind (Armada's DM plane). */
const KIND_DM = 4;
/** NIP-59 gift-wrap kind — carries a NIP-17 (kind-14/15) private DM. */
const KIND_GIFT_WRAP = 1059;

/** Slack added behind the NIP-59 backdate window (clock skew, borderline wraps). */
const WRAP_SINCE_SLACK_SECS = 3600;
/** Stored-replay cap for the DM gift-wrap filter on a session's FIRST round. */
const DM_WRAP_REPLAY_LIMIT = 100;
/**
 * Wrap replay cap once a relay has EOSEd this session. The wrap `since`
 * rewinds the whole backdate window every round, so each 90s rotation would
 * replay ~100 duplicate wraps; deeper gaps are the DM inbox poll's job.
 */
const DM_WRAP_REPLAY_LIMIT_STEADY = 10;
/**
 * Git child-filter replay cap after EOSE. The installing round's
 * `limit: 4_000` would otherwise apply to every 90s rotation (93% duplicate
 * deliveries measured). Deeper history: `useWireGitTicketRoots` backfill and
 * `useGitProjects` sync.
 */
const GIT_CHILD_REPLAY_LIMIT_STEADY = 100;
/** Conservative relay-filter cardinality: keeps REQ frames comfortably small. */
export const GIT_ROOT_FILTER_CHUNK_SIZE = 100;

/** The NIP-17 inbox filter (`{kinds:[1059], "#p":[me]}`); Concord wrap filters use `authors` and no `#p`. */
function isDmWrapInboxFilter(f: NostrFilter): boolean {
  return !f.authors && f.kinds?.length === 1 && f.kinds[0] === KIND_GIFT_WRAP && Boolean(f["#p"]?.length);
}

/** A Git ticket CHILD filter, matched on the exact kind set so other `#e` filters aren't re-capped. */
function isGitChildFilter(f: NostrFilter): boolean {
  if (f.kinds?.length === 1 && f.kinds[0] === NIP22_COMMENT_KIND && f["#E"]?.length) return true;
  return Boolean(
    f["#e"]?.length && f.kinds?.length === GIT_STATUS_KINDS.length &&
      f.kinds.every((k) => (GIT_STATUS_KINDS as readonly number[]).includes(k)),
  );
}

/**
 * Stamp a round's filters with their resume `since`. A Git child filter's
 * first round keeps its root timestamp (a relay-wide cursor would skip older
 * comments). The NIP-17 wrap filter rewinds the full NIP-59 backdate window
 * (+ slack): relays apply `since` to LIVE events too, and wraps are backdated
 * up to 2 days, so a cursor `since` would drop virtually every live wrap.
 * `limit` bounds the replay; ingest dedupes by wrap id.
 */
export function stampRoundSince(filters: NostrFilter[], since: number, now: number, preserveExplicitSince = false, replayDone = false): NostrFilter[] {
  const wrapSince = Math.min(since, now - MAX_WRAP_BACKDATE_SECS - WRAP_SINCE_SLACK_SECS);
  const wrapLimit = replayDone ? DM_WRAP_REPLAY_LIMIT_STEADY : DM_WRAP_REPLAY_LIMIT;
  return filters.map((f) => {
    if (isDmWrapInboxFilter(f)) return { ...f, since: wrapSince, limit: wrapLimit };
    const stamped = { ...f, since: preserveExplicitSince && f.since !== undefined ? f.since : since };
    // The round that INSTALLS a child filter keeps the full bound to pull history.
    if (replayDone && !preserveExplicitSince && isGitChildFilter(f) && (f.limit ?? 0) > GIT_CHILD_REPLAY_LIMIT_STEADY) {
      stamped.limit = GIT_CHILD_REPLAY_LIMIT_STEADY;
    }
    return stamped;
  });
}

/**
 * Everything the app listens to, as plain data — the same spec
 * `useNativeNotifications` feeds the APK service.
 */
export interface WireInputs {
  /** The logged-in user (DM filters are addressed to them). */
  pubkey?: string;
  /** Joined NIP-29 groups (one REQ per host); `buzz` selects the wider Buzz kind set. */
  groups: Array<{ id: string; relay: string; buzz?: boolean }>;
  /** DM inbox relays (kind-4 reads; NIP-42-authed where the relay gates them). */
  dmRelays: string[];
  /** Friends-only DM senders (kind-3 follows). */
  dmFollows: string[];
  /** Concord channels (each carries its stream GroupKeys for decrypt). */
  concord: Array<{
    relays: string[];
    channel: Channel;
    communityIdHex: string;
    /** Community-level banned authors (CORD-04), carried per channel; suppresses notifications. */
    banned?: Set<string>;
    /** The Roles the viewer holds, and who may ping any Role (CORD-04 §8). */
    roleMentions?: HeldRoleMention[];
    roleMentionAuthors?: Set<string>;
    /** Authors whose posts readers collapse here (CORD-04 §8): no SEND in this open Channel, or a running Timeout. */
    sendDenied?: Set<string>;
    /** In a restricted Channel, the only authors whose posts ring (CORD-03 §1). */
    postAuthors?: Set<string>;
    timeouts?: { pk: string; fromSecs: number; until: number }[];
    /** The Nicknames members go by in the Community (CORD-04 §10). */
    nicknames?: Record<string, string>;
  }>;
  /**
   * Concord CONTROL planes, subscribed so new control editions (channels,
   * roster) land live for every community, not only the open one.
   */
  concordControl?: Array<{
    relays: string[];
    idHex: string;
    groups: StreamKeyView[];
    /** Whether the community has ever rotated its root (see `noteControlSnapshot`). */
    refounded: boolean;
  }>;
  /**
   * Concord GUESTBOOK planes: a KICK rotates no key and publishes no control
   * edition, so without this a kicked member keeps access until the 60s poll.
   */
  concordGuestbook?: Array<{
    relays: string[];
    idHex: string;
    groups: StreamKeyView[];
  }>;
  /** Repository activity planes attached through folded Concord channel metadata. */
  gitRepositories?: GitRepositoryWireInput[];
  /** Cache/history-discovered NIP-34 issue and PR roots for dynamic child filters. */
  gitTicketRoots?: NostrRumor[];
}

/** One canonical repository and every channel interval that references it. */
export interface GitRepositoryWireInput {
  address: string;
  /** Activity relays from the repository announcement, persisted in attachment metadata. */
  relays: string[];
  attachments: Array<{ channelId: string; communityId?: string; attachment: GitRepositoryAttachment }>;
}

/** One relay's standing subscription. */
export interface WireSub {
  /** Normalized relay URL. */
  relay: string;
  /** Filters to hold open (the manager stamps `since`). */
  filters: NostrFilter[];
}

export interface WireSpec {
  subs: WireSub[];
  /** Concord stream address (wrap author) → owning channel, for decrypt + scope. */
  concordByPk: Map<string, Channel>;
  /** Concord channel id hex → its owning community id hex (for notification routing). */
  concordCommunityByChannel: Map<string, string>;
  /** Concord community id hex → its folded set of banned authors, for notification suppression. */
  concordBannedByCommunity: Map<string, Set<string>>;
  /** Concord community id hex → the Nicknames its members go by (CORD-04 §10). */
  concordNicknamesByCommunity: Map<string, Record<string, string>>;
  /** Concord channel id hex → whose posts there ring nobody (CORD-04 §8). */
  concordSilenceByChannel: Map<string, { sendDenied?: Set<string>; postAuthors?: Set<string>; timeouts?: { pk: string; fromSecs: number; until: number }[] }>;
  /** Concord community id hex → the Roles the viewer holds and who may ping any Role. */
  concordRoleMentionsByCommunity: Map<string, { held: HeldRoleMention[]; authors: Set<string> }>;
  /** Concord CONTROL stream address (wrap author) → its community, for decrypt + fold wake. */
  concordCtlByPk: Map<string, { idHex: string; groups: StreamKeyView[]; refounded: boolean }>;
  /** Concord GUESTBOOK stream address (wrap author) → its community, for decrypt + membership wake. */
  concordGbByPk: Map<string, { idHex: string; groups: StreamKeyView[] }>;
  /** Repository address → channels/intervals that reference it. */
  gitByRepository: Map<string, Array<{ channelId: string; communityId?: string; attachment: GitRepositoryAttachment }>>;
  /** Known ticket root id → repository address, for validating child activity. */
  gitRootById: Map<string, string>;
  /** Known ticket root id → author, for trusted ticket-author status activity. */
  gitRootAuthorById: Map<string, string>;
  /** Deterministic signature of `subs` for cheap diffing/resubscribe. */
  sig: string;
}

/**
 * Build the per-relay subscription spec. NIP-29 gets one `#h` filter per host
 * (NIP-42 AUTH handled by the pool; Concord stream keys via stream-auth).
 * Muted channels are deliberately INCLUDED: muting is a notification concern,
 * not an ingestion one.
 */
export function buildWireSpec(inputs: WireInputs): WireSpec {
  const byRelay = new Map<string, NostrFilter[]>();
  const add = (url: string, filter: NostrFilter) => {
    const relay = normalizeRelayUrl(url);
    if (!relay) return;
    const list = byRelay.get(relay);
    if (list) list.push(filter);
    else byRelay.set(relay, [filter]);
  };

  // NIP-29: one `#h` filter per host; Buzz relays get BUZZ_WIRE_KINDS.
  const groupsByRelay = new Map<string, Set<string>>();
  const buzzRelays = new Set<string>();
  for (const g of inputs.groups) {
    const relay = normalizeRelayUrl(g.relay);
    if (!relay || !g.id) continue;
    let set = groupsByRelay.get(relay);
    if (!set) groupsByRelay.set(relay, (set = new Set()));
    set.add(g.id);
    if (g.buzz) buzzRelays.add(relay);
  }
  for (const [relay, ids] of groupsByRelay) {
    const kinds = buzzRelays.has(relay)
      ? [...BUZZ_WIRE_KINDS]
      : [KIND_GROUP_CHAT, KIND_POLL, KIND_DELETE];
    add(relay, { kinds, "#h": [...ids].sort() });
  }

  if (inputs.pubkey) {
    const follows = [...new Set(inputs.dmFollows)].sort();
    for (const url of inputs.dmRelays) {
      add(url, { kinds: [KIND_DM], authors: [inputs.pubkey] });
      if (follows.length > 0) {
        add(url, { kinds: [KIND_DM], authors: follows, "#p": [inputs.pubkey] });
      }
      // NIP-17 wraps to the viewer; the wrap author hides the sender, so no `authors`.
      add(url, { kinds: [KIND_GIFT_WRAP], "#p": [inputs.pubkey] });
    }
  }

  // Concord chat: the standing sub carries only each channel's CURRENT epoch
  // (retired epochs are sealed history; holding them open is a side-channel
  // for ejected keyholders). `concordByPk` keeps every held epoch so stragglers
  // still decode (the decoder enforces the cutoff).
  const concordByPk = new Map<string, Channel>();
  const concordCommunityByChannel = new Map<string, string>();
  const concordBannedByCommunity = new Map<string, Set<string>>();
  const concordRoleMentionsByCommunity = new Map<string, { held: HeldRoleMention[]; authors: Set<string> }>();
  const concordNicknamesByCommunity = new Map<string, Record<string, string>>();
  const concordSilenceByChannel = new Map<string, { sendDenied?: Set<string>; postAuthors?: Set<string>; timeouts?: { pk: string; fromSecs: number; until: number }[] }>();
  const pksByRelay = new Map<string, Set<string>>();
  for (const { relays, channel, communityIdHex, banned, roleMentions, roleMentionAuthors, sendDenied, postAuthors, timeouts, nicknames } of inputs.concord) {
    if (nicknames && Object.keys(nicknames).length > 0) concordNicknamesByCommunity.set(communityIdHex, nicknames);
    if (sendDenied?.size || postAuthors || timeouts?.length) concordSilenceByChannel.set(channel.idHex, { sendDenied, postAuthors, timeouts });
    if (roleMentions?.length) concordRoleMentionsByCommunity.set(communityIdHex, { held: roleMentions, authors: roleMentionAuthors ?? new Set() });
    for (const s of channel.streams) concordByPk.set(s.group.pk, channel);
    concordCommunityByChannel.set(channel.idHex, communityIdHex);
    if (banned && banned.size > 0) concordBannedByCommunity.set(communityIdHex, banned);
    for (const url of relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = pksByRelay.get(relay);
      if (!set) pksByRelay.set(relay, (set = new Set()));
      set.add(channel.current.group.pk);
      // A restricted Channel's posts arrive at its live writer address (CORD-03 §1).
      for (const s of channel.streams) {
        if (s.writer && s.writer.to === undefined && s.epoch === channel.current.epoch) set.add(s.group.pk);
      }
    }
  }
  for (const [relay, pks] of pksByRelay) {
    add(relay, { kinds: [KIND_WRAP], authors: [...pks].sort() });
  }

  // Concord CONTROL: separate map (control keys, wakes the fold — see ingest.ts);
  // filters still merge per relay.
  const concordCtlByPk = new Map<string, { idHex: string; groups: StreamKeyView[]; refounded: boolean }>();
  const ctlPksByRelay = new Map<string, Set<string>>();
  for (const { relays, idHex, groups, refounded } of inputs.concordControl ?? []) {
    for (const g of groups) concordCtlByPk.set(g.pk, { idHex, groups, refounded });
    for (const url of relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = ctlPksByRelay.get(relay);
      if (!set) ctlPksByRelay.set(relay, (set = new Set()));
      for (const g of groups) set.add(g.pk);
    }
  }
  for (const [relay, pks] of ctlPksByRelay) {
    add(relay, { kinds: [KIND_WRAP], authors: [...pks].sort() });
  }

  // Concord GUESTBOOK: wakes the memberlist. Every HELD epoch is subscribed (as
  // the sweep reads them) so a Kick just before an epoch roll still lands.
  const concordGbByPk = new Map<string, { idHex: string; groups: StreamKeyView[] }>();
  const gbPksByRelay = new Map<string, Set<string>>();
  for (const { relays, idHex, groups } of inputs.concordGuestbook ?? []) {
    for (const g of groups) concordGbByPk.set(g.pk, { idHex, groups });
    for (const url of relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = gbPksByRelay.get(relay);
      if (!set) gbPksByRelay.set(relay, (set = new Set()));
      for (const g of groups) set.add(g.pk);
    }
  }
  for (const [relay, pks] of gbPksByRelay) {
    add(relay, { kinds: [KIND_WRAP], authors: [...pks].sort() });
  }

  // NIP-34 roots: one `#a` filter per activity relay; detached intervals stay
  // in gitByRepository but hold no subscription.
  const gitByRepository = new Map<string, Array<{ channelId: string; communityId?: string; attachment: GitRepositoryAttachment }>>();
  const reposByRelay = new Map<string, Set<string>>();
  // Earliest live attachment per relay: the CI filter's bootstrap `since`.
  const ciSinceByRelay = new Map<string, number>();
  for (const repository of inputs.gitRepositories ?? []) {
    const attachments = repository.attachments
      .filter(({ attachment }) => attachment.address.coordinate === repository.address)
      .sort((a, b) => a.channelId.localeCompare(b.channelId) || a.attachment.attachedAt - b.attachment.attachedAt);
    if (attachments.length === 0) continue;
    gitByRepository.set(repository.address, attachments);
    const live = attachments.filter(({ attachment }) => attachment.detachedAt === undefined);
    if (live.length === 0) continue;
    const attachedAt = Math.min(...live.map(({ attachment }) => attachment.attachedAt));
    for (const url of repository.relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let addresses = reposByRelay.get(relay);
      if (!addresses) reposByRelay.set(relay, (addresses = new Set()));
      addresses.add(repository.address);
      ciSinceByRelay.set(relay, Math.min(ciSinceByRelay.get(relay) ?? attachedAt, attachedAt));
    }
  }
  for (const [relay, addresses] of reposByRelay) {
    const sorted = [...addresses].sort();
    add(relay, { kinds: [GIT_PULL_REQUEST_KIND, GIT_ISSUE_KIND], "#a": sorted });
    // CI runs ride the coordinate filter but are activity, so skip discovery
    // relays. `since` = attachment time for the bootstrap round, or runs from
    // before startup would never be requested.
    if (!isGitAnnouncementDiscoveryRelay(relay)) {
      add(relay, { kinds: [...CI_EVENT_KINDS], "#a": sorted, since: ciSinceByRelay.get(relay) ?? 0 });
    }
  }

  // NIP-22 comments (`#E`) + NIP-34 statuses (`#e`) by root id, activity relays only.
  const gitRootById = new Map<string, string>();
  const gitRootAuthorById = new Map<string, string>();
  const rootIdsByRelay = new Map<string, Set<string>>();
  for (const root of inputs.gitTicketRoots ?? []) {
    const ticket = parseGitTicket(root);
    const matched = ticket ? matchGitTicketRepository(ticket, gitByRepository) : undefined;
    if (!ticket || !matched) continue;
    const address = matched.coordinate;
    gitRootById.set(root.id, address);
    gitRootAuthorById.set(root.id, ticket.author);
    const repository = (inputs.gitRepositories ?? []).find((entry) => entry.address === address);
    if (!repository?.attachments.some(({ attachment }) => attachment.detachedAt === undefined)) continue;
    for (const url of repository.relays) {
      if (isGitAnnouncementDiscoveryRelay(url)) continue;
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let ids = rootIdsByRelay.get(relay);
      if (!ids) rootIdsByRelay.set(relay, (ids = new Set()));
      ids.add(root.id);
    }
  }
  for (const [relay, rootIds] of rootIdsByRelay) {
    const ids = [...rootIds].sort();
    for (let offset = 0; offset < ids.length; offset += GIT_ROOT_FILTER_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + GIT_ROOT_FILTER_CHUNK_SIZE);
      // Root-based `since` for the first round (the shared relay cursor could skip existing comments).
      const childSince = Math.min(...chunk.map((id) => inputs.gitTicketRoots?.find((root) => root.id === id)?.created_at ?? 0));
      add(relay, { kinds: [NIP22_COMMENT_KIND], "#E": chunk, since: childSince, limit: 4_000 });
      add(relay, { kinds: [...GIT_STATUS_KINDS], "#e": chunk, since: childSince, limit: 4_000 });
    }
  }

  const subs: WireSub[] = [...byRelay.entries()]
    .map(([relay, filters]) => ({ relay, filters }))
    .sort((a, b) => (a.relay < b.relay ? -1 : 1));

  return { subs, concordByPk, concordCommunityByChannel, concordBannedByCommunity, concordRoleMentionsByCommunity, concordSilenceByChannel, concordNicknamesByCommunity, concordCtlByPk, concordGbByPk, gitByRepository, gitRootById, gitRootAuthorById, sig: JSON.stringify(subs) };
}
