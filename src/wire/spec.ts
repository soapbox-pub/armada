import { CI_EVENT_KINDS } from "@/lib/ci";
import { isGitAnnouncementDiscoveryRelay, normalizeRelayUrl } from "@/lib/platform";
import { BUZZ_WIRE_KINDS } from "@/buzz/kinds";
import { MAX_WRAP_BACKDATE_SECS } from "@/lib/nip17/protocol";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT, KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_REACTION, KIND_COMMUNITY_CONTROL } from "@/concord-v1/lib/kinds";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { GIT_ISSUE_KIND, GIT_PULL_REQUEST_KIND, GIT_STATUS_KINDS, matchGitTicketRepository, NIP22_COMMENT_KIND, parseGitTicket, type GitRepositoryAttachment } from "@/lib/gitActivity";

import type { ConcordControlSub, ConcordSub } from "@/concord-v1/lib/concordNotifications";
import type { StreamKeyView } from "@/concord-v2/lib/derive";
import type { ChannelV2 } from "@/concord-v2/lib/types";
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
 * Stored-replay cap once a relay's round has EOSEd this session. The wrap
 * filter's `since` rewinds the full backdate window every round (it must, for
 * LIVE delivery — see {@link stampRoundSince}), so each routine 90s quiet
 * rotation replayed the newest {@link DM_WRAP_REPLAY_LIMIT} wraps of a 2-day
 * window as pure duplicate ciphertext (~100-150 KB per rotation per DM relay).
 * After the first EOSE the store already holds that window; the small cap
 * keeps a short-gap overlap, and anything deeper (a burst missed while the
 * device slept) is recovered by the DM inbox poll's periodic full scan.
 */
const DM_WRAP_REPLAY_LIMIT_STEADY = 10;
/** Conservative relay-filter cardinality: keeps REQ frames comfortably small. */
export const GIT_ROOT_FILTER_CHUNK_SIZE = 100;

/**
 * Whether a filter is the wire's NIP-17 DM gift-wrap inbox filter
 * (`{kinds:[1059], "#p":[me]}`). Concord V2 wrap filters share the kind but
 * are `authors`-scoped (stream addresses) and carry no `#p`.
 */
function isDmWrapInboxFilter(f: NostrFilter): boolean {
  return !f.authors && f.kinds?.length === 1 && f.kinds[0] === KIND_GIFT_WRAP && Boolean(f["#p"]?.length);
}

/**
 * Stamp a round's filters with their resume `since`.
 *
 * Every ordinary filter gets the cursor-derived `since`. The first round after
 * a Git child filter is added preserves its explicit root timestamp so a
 * relay-wide cursor cannot skip older comments. The NIP-17 gift-wrap inbox
 * filter also gets special treatment: a gift wrap's `created_at` is backdated
 * up to 2 days into the past (NIP-59 `tweakedPast`), and relays apply `since` to LIVE streamed
 * events too, so a cursor-derived `since` (≈ now − 60s) filters out virtually
 * every live wrap: only a backdate that randomly lands inside the overlap
 * window would pass (~0.03%). That deafness is exactly the "DMs only arrive on
 * the 30-60s poll" lag — the standing sub never received the wrap at all.
 *
 * So the wrap filter's `since` rewinds the full backdate window (+ slack)
 * behind `now`, and takes the cursor `since` when it reaches even deeper (a
 * device off for days replays what the window covers). The rewind means every
 * fresh round replays up to 2 days of stored wraps; `limit` bounds that replay
 * (newest-first), and ingest dedupes re-deliveries by wrap id — deeper catch-up
 * is the DM inbox poll's job (which already rewinds the same window).
 */
export function stampRoundSince(filters: NostrFilter[], since: number, now: number, preserveExplicitSince = false, wrapReplayDone = false): NostrFilter[] {
  const wrapSince = Math.min(since, now - MAX_WRAP_BACKDATE_SECS - WRAP_SINCE_SLACK_SECS);
  const wrapLimit = wrapReplayDone ? DM_WRAP_REPLAY_LIMIT_STEADY : DM_WRAP_REPLAY_LIMIT;
  return filters.map((f) =>
    isDmWrapInboxFilter(f)
      ? { ...f, since: wrapSince, limit: wrapLimit }
      : { ...f, since: preserveExplicitSince && f.since !== undefined ? f.since : since },
  );
}

/**
 * Everything the app needs listened-to, as plain data. This is the SAME shape
 * of information `useNativeNotifications` feeds the APK's persistent service —
 * one spec, two transports (web sockets / native service).
 */
export interface WireInputs {
  /** The logged-in user (DM filters are addressed to them). */
  pubkey?: string;
  /**
   * Joined NIP-29 groups. relay = the community host (one REQ per host).
   * `buzz` marks channels on a Buzz relay (see src/buzz/), whose standing
   * filter carries the wider Buzz kind set instead of the plain NIP-29 one.
   */
  groups: Array<{ id: string; relay: string; buzz?: boolean }>;
  /** DM inbox relays (kind-4 reads; NIP-42-authed where the relay gates them). */
  dmRelays: string[];
  /** Friends-only DM senders (kind-3 follows). */
  dmFollows: string[];
  /** Concord V1 channel subscriptions (relays + `#z` pseudonyms + bindings). */
  concord1: ConcordSub[];
  /**
   * Concord V1 CONTROL planes (relays + control `#z` per community). A standing
   * subscription lands new control editions — roster/metadata/banlist changes —
   * LIVE for every community, not only the one you have open, mirroring the V2
   * control plane. Control editions stay sealed in the store (the fold opens
   * them), so no decrypt key is needed here.
   */
  concord1Control?: ConcordControlSub[];
  /** Concord V2 channels (each carries its stream GroupKeys for decrypt). */
  concord2: Array<{ relays: string[]; channel: ChannelV2; communityIdHex: string }>;
  /**
   * Concord V2 CONTROL planes (each carries its control-stream GroupKeys). A
   * standing subscription to these authors lands new control editions —
   * channel creations, roster/metadata changes — LIVE for every community, not
   * only the one you have open, so a member added to a new channel sees it in
   * the sidebar without waiting for the slow background sweep (or for someone
   * to post the first message).
   */
  concord2Control?: Array<{
    relays: string[];
    idHex: string;
    groups: StreamKeyView[];
    /** Whether the community has ever rotated its root (see `noteControlSnapshot`). */
    refounded: boolean;
  }>;
  /** Repository activity planes attached through folded Concord V2 channel metadata. */
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
  /** V2 stream address (wrap author) → owning channel, for decrypt + scope. */
  v2ByPk: Map<string, ChannelV2>;
  /** V2 channel id hex → its owning community id hex (for notification routing). */
  v2CommunityByChannel: Map<string, string>;
  /** V2 CONTROL stream address (wrap author) → its community, for decrypt + fold wake. */
  v2CtlByPk: Map<string, { idHex: string; groups: StreamKeyView[]; refounded: boolean }>;
  /** V1 `#z` pseudonym → channel id hex, for scope naming. */
  v1ByZ: Map<string, string>;
  /** V1 CONTROL `#z` pseudonym → its community id hex, for the fold-wake scope. */
  v1CtlByZ: Map<string, string>;
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
 * Build the wire's per-relay subscription spec.
 *
 * NIP-29 is relay-per-community: each host relay gets exactly one `#h` filter
 * covering the groups it hosts (NIP-42 AUTH is handled by the relay pool for
 * private groups — the pool signs kind-22242 with the user's signer, and
 * Concord V2 stream keys are additionally authenticated via the stream-auth
 * registry, which matters on relays that gate kind-1059 REQs by `authors`).
 *
 * Muted channels are deliberately INCLUDED: the wire feeds the local stores
 * that timelines and badges hydrate from; muting is a notification/render
 * concern, not an ingestion one. (The APK service, which fires notifications,
 * keeps excluding muted channels in its own config.)
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

  // ── NIP-29: one `#h` filter per host relay ────────────────────────────────
  // Buzz relays (NIP-29-based, detected via NIP-11) get the wider Buzz kind
  // set — stream messages v1/v2, edits, deletions, reactions, system rows,
  // diffs, jobs, forum activity, huddle lifecycle — so Buzz timelines and
  // unread badges stay live through the same standing subscription.
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

  // ── DMs: sent + friends-only received, on the DM relays ──────────────────
  if (inputs.pubkey) {
    const follows = [...new Set(inputs.dmFollows)].sort();
    for (const url of inputs.dmRelays) {
      add(url, { kinds: [KIND_DM], authors: [inputs.pubkey] });
      if (follows.length > 0) {
        add(url, { kinds: [KIND_DM], authors: follows, "#p": [inputs.pubkey] });
      }
      // NIP-17: every gift wrap addressed to the viewer. The wrap author hides
      // the real sender, so this can't be `authors`-narrowed; useDm17 owns
      // fetching + decrypting these wraps.
      add(url, { kinds: [KIND_GIFT_WRAP], "#p": [inputs.pubkey] });
    }
  }

  // ── Concord V1: merged `#z` filter per community relay ───────────────────
  const v1ByZ = new Map<string, string>();
  const zsByRelay = new Map<string, Set<string>>();
  for (const sub of inputs.concord1) {
    for (const k of sub.keys) v1ByZ.set(k.z, k.channelId);
    for (const url of sub.relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = zsByRelay.get(relay);
      if (!set) zsByRelay.set(relay, (set = new Set()));
      for (const z of sub.zs) set.add(z);
    }
  }
  for (const [relay, zs] of zsByRelay) {
    add(relay, {
      kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_EDIT, KIND_COMMUNITY_DELETE, KIND_COMMUNITY_REACTION],
      "#z": [...zs].sort(),
    });
  }

  // ── Concord V1 CONTROL: merged control-`#z` filter per community relay ────
  // Kept SEPARATE from the message-plane filter above: control editions carry a
  // DIFFERENT `#z` (the control pseudonym, not a channel one) and wake the fold
  // (roster/metadata/banlist) rather than a chat timeline. ingest.ts rings
  // `c1ctl:<communityId>` for these (see v1CtlByZ), mirroring V2's `c2ctl`.
  const v1CtlByZ = new Map<string, string>();
  const ctlZsByRelay = new Map<string, Set<string>>();
  for (const sub of inputs.concord1Control ?? []) {
    v1CtlByZ.set(sub.z, sub.communityId);
    for (const url of sub.relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = ctlZsByRelay.get(relay);
      if (!set) ctlZsByRelay.set(relay, (set = new Set()));
      set.add(sub.z);
    }
  }
  for (const [relay, zs] of ctlZsByRelay) {
    add(relay, { kinds: [KIND_COMMUNITY_CONTROL], "#z": [...zs].sort() });
  }

  // ── Concord V2: merged wrap-author filter per community relay ────────────
  // The STANDING subscription carries only each channel's CURRENT epoch: a
  // retired epoch is sealed history with a hard read cutoff (its rotation's
  // publish time), so nothing legitimate ever arrives there live — holding
  // every old address open forever was a permanent writable side-channel for
  // any ejected keyholder, plus unbounded filter growth. History still reaches
  // the store through the scheduler's backfill, and `v2ByPk` keeps EVERY held
  // epoch so a straggler wrap already in flight (or parked) still decodes —
  // the decode path enforces the cutoff either way.
  const v2ByPk = new Map<string, ChannelV2>();
  const v2CommunityByChannel = new Map<string, string>();
  const pksByRelay = new Map<string, Set<string>>();
  for (const { relays, channel, communityIdHex } of inputs.concord2) {
    for (const s of channel.streams) v2ByPk.set(s.group.pk, channel);
    v2CommunityByChannel.set(channel.idHex, communityIdHex);
    for (const url of relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = pksByRelay.get(relay);
      if (!set) pksByRelay.set(relay, (set = new Set()));
      set.add(channel.current.group.pk);
    }
  }
  for (const [relay, pks] of pksByRelay) {
    add(relay, { kinds: [KIND_WRAP], authors: [...pks].sort() });
  }

  // ── Concord V2 CONTROL: merged control-author filter per community relay ──
  // Kept SEPARATE from the chat-wrap map above: control wraps decode with the
  // control-stream keys (not any channel's) and wake the fold rather than a
  // chat timeline (see ingest.ts). Filters coalesce with the chat-wrap filter
  // on the same relay via the shared KIND_WRAP `add` merge — one round trip.
  const v2CtlByPk = new Map<string, { idHex: string; groups: StreamKeyView[]; refounded: boolean }>();
  const ctlPksByRelay = new Map<string, Set<string>>();
  for (const { relays, idHex, groups, refounded } of inputs.concord2Control ?? []) {
    for (const g of groups) v2CtlByPk.set(g.pk, { idHex, groups, refounded });
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

  // ── NIP-34 roots: one #a filter per repository activity relay ─────────────
  // Detached intervals remain in gitByRepository for store/history filtering,
  // but never keep a standing socket subscription alive.
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
    // CI runs carry the repository `a` tags directly, so they ride the same
    // coordinate filter as roots — but they are activity, not announcements,
    // so the discovery relay is excluded exactly as it is for children.
    //
    // The explicit `since` is the attachment time, honored on the bootstrap
    // round (see stampRoundSince): without it the relay cursor (≈ now) would
    // apply and runs published before the client started — everything the
    // channel is entitled to show — would never be requested at all.
    if (!isGitAnnouncementDiscoveryRelay(relay)) {
      add(relay, { kinds: [...CI_EVENT_KINDS], "#a": sorted, since: ciSinceByRelay.get(relay) ?? 0 });
    }
  }

  // ── NIP-22 comments + NIP-34 statuses: dynamic root-id filters ───────────
  // Child events do not carry the repository announcement. Route them only to
  // the repository's activity relays, never a discovery relay. NIP-22 uses
  // uppercase `#E`; NIP-34 status uses lowercase `#e`.
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
      // A relay cursor is shared by every filter on that relay. A root discovered
      // after a newer chat event would otherwise install its child filter with a
      // `since` beyond existing comments. Preserve this root-based bootstrap on
      // the first subscription round; subsequent rotations use the live cursor.
      const childSince = Math.min(...chunk.map((id) => inputs.gitTicketRoots?.find((root) => root.id === id)?.created_at ?? 0));
      add(relay, { kinds: [NIP22_COMMENT_KIND], "#E": chunk, since: childSince, limit: 4_000 });
      add(relay, { kinds: [...GIT_STATUS_KINDS], "#e": chunk, since: childSince, limit: 4_000 });
    }
  }

  const subs: WireSub[] = [...byRelay.entries()]
    .map(([relay, filters]) => ({ relay, filters }))
    .sort((a, b) => (a.relay < b.relay ? -1 : 1));

  return { subs, v2ByPk, v2CommunityByChannel, v2CtlByPk, v1ByZ, v1CtlByZ, gitByRepository, gitRootById, gitRootAuthorById, sig: JSON.stringify(subs) };
}
