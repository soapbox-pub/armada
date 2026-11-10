import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { clockNowMs } from "@/lib/relayClock";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { quarantinedIn } from "@/concord/lib/floodCluster";
import type { FloodPolicy } from "@/concord/lib/floodPolicy";
import { useFloodPolicy } from "@/concord/hooks/useFloodPolicy";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  rememberQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { KIND_DELETE, KIND_MESSAGE } from "@/concord/lib/kinds";
import { FUTURE_HOLD_MS, FUTURE_HORIZON_MS } from "@/concord/lib/stream";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { concordReadKey, useReadState } from "@/hooks/useReadState";
import type { GitTimelineActivity } from "@/lib/gitActivity";
import { hasEveryoneMention } from "@/concord/lib/everyoneMention";
import { sentDuringMembership } from "@/concord/lib/membershipFloor";
import { useCommunityEntry } from "@/concord/hooks/useCommunityList";
import { isTitledPost } from "@/concord/lib/forum";
import { showsAsFeed, useForumAsChatIds } from "@/concord/lib/forumPresentation";

const NO_GIT: ReadonlyMap<string, readonly GitTimelineActivity[]> = new Map();

/** Per-channel unread summary (mirrors NIP-29's `GroupUnread`). */
export interface ConcordUnread {
  /** Newest unread message's created_at, unix SECONDS. */
  latest: number;
  /** Any unread message p-tags the current user. */
  mention: boolean;
}

/**
 * Per-channel unread state, derived purely from {@link useCommunityRumors} and
 * the shared read-state map (key `c2:<channelIdHex>`, synced via NIP-78). A
 * channel is unread when its newest non-self kind-9 is newer than that stamp —
 * in a forum shown as its feed, its newest TITLED post, the only kind-9 shown there.
 * `byChannel[id]` present ⇒ unread.
 */
export function useConcordUnread(
  community: Community | undefined,
  channels: Channel[],
  // Shared default: a fresh Map per render would invalidate the memo below.
  gitByChannel: ReadonlyMap<string, readonly GitTimelineActivity[]> = NO_GIT,
  active = false,
): {
  byChannel: Record<string, ConcordUnread>;
  markRead: (channelIdHex: string, timestamp: number) => void;
  getLastRead: (channelIdHex: string) => number;
} {
  const communityIdHex = community?.idHex;
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const { mutedPubkeys } = useMutedPubkeys();
  // This scan reads the raw store, so the Banlist must be applied here too (CORD-04 §4).
  // Passive by DEFAULT: ambient callers are mounted per joined community, and an
  // active resolve fans out a control sweep for each. The page opts in explicitly.
  const { banned, canMentionEveryone, pingsByRole, holdsPost } = useChatModeration(community, active);
  const joinedAtMs = useCommunityEntry(communityIdHex)?.added_at;
  const {
    readState,
    getLastRead: sharedGetLastRead,
    markRead: sharedMarkRead,
  } = useReadState();

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const forumAsChat = useForumAsChatIds();
  const feedSig = channels.filter((c) => showsAsFeed(c, forumAsChat)).map((c) => c.idHex).join(",");
  const feedChannels = useMemo(() => new Set(feedSig ? feedSig.split(",") : []), [feedSig]);

  const { byChannel: rumorsByChannel } = useCommunityRumors(communityIdHex, channelIds);

  // Re-derive when the persisted quarantine memory warms or grows; after a
  // refresh it is what keeps a flood's badges from coming back.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);
  const floodPolicy = useFloodPolicy();

  // Remember what the badge path detected so a refresh can't resurrect it.
  // Merge-only, so it never un-remembers the timeline fold's verdicts.
  useEffect(() => {
    if (!communityIdHex) return;
    for (const [idHex, rumors] of rumorsByChannel) {
      const quarantined = quarantinedIn(rumors, pubkey, undefined, floodPolicy);
      if (quarantined.size === 0) continue;
      const entries: Array<[string, number]> = [];
      for (const r of rumors) if (quarantined.has(r.rumorId)) entries.push([r.rumorId, r.ms]);
      if (entries.length > 0) rememberQuarantined(communityIdHex, idHex, entries);
    }
  }, [communityIdHex, rumorsByChannel, pubkey, floodPolicy]);

  // Depend on this community's stamps only: `readState` changes on every markRead
  // anywhere, and the rail mounts one of these per community.
  const readStateRef = useRef(readState);
  readStateRef.current = readState;
  let readSig = "";
  for (const idHex of rumorsByChannel.keys()) readSig += `${readState[concordReadKey(idHex)] ?? 0},`;

  // The per-channel scan is the expensive half and ignores read state, so it's
  // cached per channel; a markRead then costs a comparison per channel. A scan
  // that skipped a future-dated message is redone when its time comes.
  const scanDeps = useMemo(
    () => ({ pubkey, mutedPubkeys, banned, canMentionEveryone, pingsByRole, holdsPost, joinedAtMs, communityIdHex, memoryRev, floodPolicy }),
    [pubkey, mutedPubkeys, banned, canMentionEveryone, pingsByRole, holdsPost, joinedAtMs, communityIdHex, memoryRev, floodPolicy],
  );
  const scanCacheRef = useRef(new Map<string, ChannelScan>());

  // Stable identities while unchanged, so a channel row re-renders only with its own badge.
  const previousRef = useRef<Record<string, ConcordUnread>>({});

  const byChannel = useMemo<Record<string, ConcordUnread>>(() => {
    void readSig;
    const cache = scanCacheRef.current;
    const now = clockNowMs();
    const next: Record<string, ConcordUnread> = {};
    for (const [idHex, rumors] of rumorsByChannel) {
      const git = gitByChannel.get(idHex);
      const feedOnly = feedChannels.has(idHex);
      let scan = cache.get(idHex);
      if (
        !scan || scan.rumors !== rumors || scan.git !== git || scan.deps !== scanDeps
        || scan.feedOnly !== feedOnly || now + FUTURE_HOLD_MS >= scan.heldUntilMs
      ) {
        scan = scanChannel(idHex, rumors, git, scanDeps, feedOnly);
        cache.set(idHex, scan);
      }
      const lastRead = readStateRef.current[concordReadKey(idHex)] ?? 0;
      if (scan.latest > lastRead) next[idHex] = { latest: scan.latest, mention: scan.latestMention > lastRead };
    }
    for (const idHex of cache.keys()) if (!rumorsByChannel.has(idHex)) cache.delete(idHex);
    const previous = previousRef.current;
    let same = Object.keys(previous).length === Object.keys(next).length;
    for (const [idHex, entry] of Object.entries(next)) {
      const old = previous[idHex];
      if (old && old.latest === entry.latest && old.mention === entry.mention) next[idHex] = old;
      else same = false;
    }
    const result = same ? previous : next;
    previousRef.current = result;
    return result;
  }, [rumorsByChannel, readSig, gitByChannel, scanDeps, feedChannels]);

  const markRead = useCallback(
    (channelIdHex: string, timestamp: number) => {
      if (timestamp <= 0) return;
      sharedMarkRead(concordReadKey(channelIdHex), timestamp);
    },
    [sharedMarkRead],
  );

  const getLastRead = useCallback(
    (channelIdHex: string) => sharedGetLastRead(concordReadKey(channelIdHex)),
    [sharedGetLastRead],
  );

  return useMemo(() => ({ byChannel, markRead, getLastRead }), [byChannel, markRead, getLastRead]);
}

interface ScanDeps {
  pubkey: string | undefined;
  mutedPubkeys: ReadonlySet<string>;
  banned: ReadonlySet<string>;
  canMentionEveryone: ((author: string, channelIdHex: string) => boolean) | undefined;
  pingsByRole: ((author: string, content: string, tags: string[][]) => boolean) | undefined;
  holdsPost: ((author: string, channelIdHex: string) => boolean) | undefined;
  /** When this membership began (ms); nothing earlier is a mention. */
  joinedAtMs: number | undefined;
  communityIdHex: string | undefined;
  memoryRev: number;
  floodPolicy: FloodPolicy;
}

/** One channel's unread inputs, before read state is applied. */
interface ChannelScan {
  rumors: OpenedChat[];
  git: readonly GitTimelineActivity[] | undefined;
  deps: ScanDeps;
  /** Scanned as the forum feed: only titled posts count. */
  feedOnly: boolean;
  /** Newest countable message (or git activity), unix seconds. */
  latest: number;
  /** Newest countable message that mentions the viewer, unix seconds. */
  latestMention: number;
  /** The earliest `ms` of a message held back as future-dated, or Infinity. */
  heldUntilMs: number;
}

function scanChannel(
  idHex: string,
  rumors: OpenedChat[],
  git: readonly GitTimelineActivity[] | undefined,
  deps: ScanDeps,
  feedOnly: boolean,
): ChannelScan {
  const { pubkey, mutedPubkeys, banned, canMentionEveryone, pingsByRole, holdsPost, joinedAtMs, communityIdHex, floodPolicy } = deps;
  // A visual flood renders as ONE collapsed row, so its members don't badge.
  // A community PAUSE is deliberately not mirrored: this path has no roster so it
  // couldn't honor the staff exemption, and few messages arrive post-pause.
  // Memoized on the batch's identity, so a readState recompute never re-runs the fold.
  const quarantined = quarantinedIn(rumors, pubkey, undefined, floodPolicy);
  const remembered = communityIdHex ? recallQuarantined(communityIdHex, idHex) : undefined;
  // Fold self-deletes: the store's NIP-09 pass only fires within one write batch,
  // so a later-batch delete leaves its target stored, and a deleted newest message
  // would pin a badge no open can clear. Self-deletes only (no roster needed).
  const authorById = new Map<string, string>();
  for (const r of rumors) authorById.set(r.rumorId, r.author);
  const selfDeleted = new Set<string>();
  for (const r of rumors) {
    if (r.kind !== KIND_DELETE) continue;
    for (const [n, v] of r.tags) {
      if (n === "e" && v && authorById.get(v) === r.author) selfDeleted.add(v);
    }
  }
  let latest = 0;
  let latestMention = 0;
  // One clock for the whole scan, so the hold boundary can't split mid-loop.
  const holdCeilingMs = clockNowMs() + FUTURE_HOLD_MS;
  let heldUntilMs = Infinity;
  for (const r of rumors) {
    if (r.kind !== KIND_MESSAGE) continue;
    // The feed lists titled posts only; untitled chatter there is never seen.
    if (feedOnly && !isTitledPost(r)) continue;
    if (r.author === pubkey) continue; // never unread from self
    // ...nor a future-dated message the timeline holds (FUTURE_HOLD_MS).
    if (r.ms > holdCeilingMs) {
      // Past the hour's horizon it isn't held, and nothing waits on it (CORD-03 §3).
      if (r.ms <= holdCeilingMs - FUTURE_HOLD_MS + FUTURE_HORIZON_MS) heldUntilMs = Math.min(heldUntilMs, r.ms);
      continue;
    }
    // ...nor from someone muted (the timeline won't render it).
    if (mutedPubkeys.has(r.author)) continue;
    // ...nor from a banned one: the fold drops their events entirely.
    if (banned.has(r.author)) continue;
    // ...nor a post a restricted Channel holds (CORD-03 §1).
    if (holdsPost?.(r.author, idHex)) continue;
    // ...nor a message its author has since deleted (same reasoning).
    if (selfDeleted.has(r.rumorId)) continue;
    if (quarantined.has(r.rumorId)) continue;
    if (remembered?.has(r.rumorId)) continue;
    if (r.createdAt > latest) latest = r.createdAt;
    const mentionsViewer = sentDuringMembership(r.ms, joinedAtMs) && (
      r.tags.some(([n, v]) => n === "p" && v === pubkey)
      || (hasEveryoneMention(r.content) && Boolean(canMentionEveryone?.(r.author, idHex)))
      || Boolean(pingsByRole?.(r.author, r.content, r.tags))
    );
    if (r.createdAt > latestMention && mentionsViewer) {
      latestMention = r.createdAt;
    }
  }
  for (const activity of git ?? []) {
    const author = activity.type === "ticket-opened"
      ? activity.ticket.author
      : activity.type === "comment"
        ? activity.comment.author
        : activity.type === "ci-run"
          ? activity.run.author
          : activity.status.author;
    if (author === pubkey || mutedPubkeys.has(author)) continue;
    if (activity.createdAt > latest) latest = activity.createdAt;
  }
  return { rumors, git, deps, feedOnly, latest, latestMention, heldUntilMs };
}
