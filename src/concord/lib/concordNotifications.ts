import { bytesToHex } from "@noble/hashes/utils.js";

import { restrictedPostersIn, restrictedWritersIn, sendDeniedIn } from "@/concord/lib/channelJudges";
import { clockOffsetMs } from "@/lib/relayClock";
import { heldRoleMentions, roleMentionAuthors, type HeldRoleMention } from "@/concord/lib/roleMentions";
import { channelsView, liveWriterStreams, signingStreams, visibleChannels } from "@/concord/lib/community";
import { messageExpirationOf } from "@/concord/lib/disappearing";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
import type { FoldedControl } from "@/concord/lib/control";
import type { GroupKey } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";
import { everyoneMayMention, everyoneMentionAuthors } from "@/concord/lib/everyoneMention";

/**
 * One stream address of a Concord channel (one per held epoch). The stream
 * SECRET is deliberately not shipped to native code — the conversation key
 * decrypts; NIP-42 stream auth stays in the WebView (see streamAuth.ts).
 */
export interface ConcordStream {
  /** Stream address (x-only pubkey hex) — the kind-1059 `authors` filter entry. */
  pk: string;
  /** NIP-44 conversation key (hex) that decrypts this stream's wraps. */
  convKey: string;
  /** Epoch (decimal string) the rumor's `epoch` binding tag must equal. */
  epoch: string;
}

/**
 * A native-notification subscription for one channel address: relays, per-epoch stream
 * addresses + decrypt keys, and names/ids for the notification and deep link
 * (/c/<communityId>/<channelId>). The service filters `{kinds:[1059], authors}`
 * and opens wrap → seal → rumor.
 */
export interface ConcordSub {
  relays: string[];
  communityId: string;
  communityName: string;
  /** Channel id (hex): deep-link segment + the rumor's `channel` binding tag. */
  channelId: string;
  channelName: string;
  /**
   * The CURRENT epoch's stream only — retired epochs are read-cutoff history and never notify.
   * A restricted Channel gets a second sub for its live writer address.
   */
  streams: ConcordStream[];
  /**
   * The community's banned authors (CORD-04), sorted hex, so background notifiers
   * drop them before notifying (as `foldTimeline` does). Sorted for a stable
   * config signature.
   */
  banned?: string[];
  /** Authors currently allowed to issue @everyone in this channel. */
  mentionEveryoneAuthors?: string[];
  /** `@everyone` itself holds MENTION_EVERYONE, so any author's @everyone counts. */
  mentionEveryoneAnyone?: boolean;
  /** The Roles the viewer holds, as a mention of them is judged (CORD-04 §8). */
  roleMentions?: HeldRoleMention[];
  /** Who may mention a Role that isn't mentionable: MENTION_EVERYONE server-wide. */
  roleMentionAuthors?: string[];
  /** How far the relays' clock runs ahead of this device's (CORD-03 §3), for judging what's dated ahead. */
  clockOffsetMs?: number;
  /**
   * Posts readers collapse ring nobody (CORD-04 §8, Vector `post_silenced`): members
   * lacking SEND_MESSAGES in this open Channel, and the Timeouts running, by window.
   */
  sendDenied?: string[];
  /** In a restricted Channel, the only authors whose posts at these streams ring: held posts never notify (CORD-03 §1). */
  postAuthors?: string[];
  timeouts?: { pk: string; fromSecs: number; until: number }[];
  /** The Nicknames members go by here (CORD-04 §10), which a notification names its sender by. */
  nicknames?: Record<string, string>;
  /**
   * When this membership began (ms, the vault entry's `added_at`). Background
   * notifiers drop anything sent earlier: the viewer wasn't there.
   */
  joinedAtMs?: number;
  /**
   * Encrypted icon pointer (CORD-02 §6) for the notification group summary;
   * AES-GCM with `key`/`nonce`, verified against `hash`.
   */
  communityImage?: { url: string; key: string; nonce: string; hash: string };
  /**
   * CORD-08 disappearing timer (seconds; 0 = off), so native quick replies expire
   * like any message. A snapshot until the next reconfigure.
   */
  timerSecs: number;
  /** Public repository attachments folded from this channel's local metadata. */
  gitAttachments: ReturnType<typeof channelGitRepositoryAttachments>;
}

/**
 * Build one community's per-channel notification subscriptions. Also returns the
 * stream GroupKeys for NIP-42 registration (auth-gating relays require every
 * `authors` entry authenticated).
 */
export function buildConcordSubs(
  community: Community,
  folded: FoldedControl | undefined,
  joinedAtMs?: number,
  /** The account notified: a Channel it can't view (CORD-04 §8) registers nothing. */
  viewer?: string,
  /** The running Timeouts ({@link runningTimeouts}). */
  timeouts: { pk: string; fromSecs: number; until: number }[] = [],
  /** The Nicknames members go by ({@link communityNicknames}). */
  nicknames: Record<string, string> = {},
): { subs: ConcordSub[]; streamKeys: GroupKey[] } {
  const subs: ConcordSub[] = [];
  const streamKeys: GroupKey[] = [];
  if (community.relays.length === 0) return { subs, streamKeys };

  const communityName = folded?.metadata?.name || community.name || "Community";
  const icon = folded?.metadata?.icon;
  const communityImage = icon
    ? { url: icon.url, key: icon.key, nonce: icon.nonce, hash: icon.hash }
    : undefined;
  const timerSecs = messageExpirationOf(folded?.metadata);
  // Sorted for a stable config signature.
  const banned = folded ? [...folded.banned].sort() : [];
  const clockOffset = clockOffsetMs();
  const roleMentions = folded && viewer ? heldRoleMentions(folded.roster, viewer).sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
  const roleMentionAuthorList = folded && roleMentions.length > 0 ? roleMentionAuthors(folded.roster, folded.ownerHex) : [];
  for (const channel of visibleChannels(channelsView(community, folded), folded, viewer)) {
    if (channel.streams.length === 0) continue;
    // EVERY held epoch registers for NIP-42 (backfill reads retired epochs)…
    streamKeys.push(...signingStreams(channel));
    const sendDenied = sendDeniedIn(folded, channel.idHex);
    const postAuthors = restrictedPostersIn(folded, channel.idHex);
    const mentionEveryoneAuthors = folded
      ? everyoneMentionAuthors(folded.roster, folded.ownerHex, [channel.idHex])
      : community.owner ? [community.owner] : [];
    const sub: ConcordSub = {
      relays: community.relays,
      communityId: community.idHex,
      communityName,
      channelId: channel.idHex,
      channelName: channel.name,
      // …but only the current epoch is listened on: retired epochs never notify.
      streams: [
        {
          pk: channel.current.group.pk,
          convKey: bytesToHex(channel.current.group.convKey),
          epoch: channel.current.epoch.toString(),
        },
      ],
      banned,
      mentionEveryoneAuthors,
      ...(folded && everyoneMayMention(folded.roster) && { mentionEveryoneAnyone: true }),
      ...(roleMentions.length > 0 && { roleMentions, roleMentionAuthors: roleMentionAuthorList }),
      ...(clockOffset !== 0 && { clockOffsetMs: clockOffset }),
      ...(sendDenied.length > 0 && { sendDenied }),
      ...(postAuthors && { postAuthors }),
      ...(timeouts.length > 0 && { timeouts }),
      ...(Object.keys(nicknames).length > 0 && { nicknames }),
      ...(joinedAtMs !== undefined && { joinedAtMs }),
      communityImage,
      timerSecs,
      gitAttachments: channelGitRepositoryAttachments(folded?.channels.get(channel.idHex)?.metadata ?? { name: channel.name, private: channel.isPrivate }),
    };
    subs.push(sub);
    // A restricted Channel's posts arrive at its live writer address, which takes its
    // own posters (CORD-03 §1): a second sub, since a notifier filters per stream.
    const writers = restrictedWritersIn(folded, channel.idHex);
    for (const s of liveWriterStreams(channel)) {
      const { postAuthors: _readPosters, ...rest } = sub;
      subs.push({
        ...rest,
        streams: [{ pk: s.group.pk, convKey: bytesToHex(s.group.convKey), epoch: s.epoch.toString() }],
        ...(writers ? { postAuthors: writers } : {}),
        gitAttachments: [],
      });
    }
  }
  // Deterministic order so a refetch/rename doesn't churn the native config.
  subs.sort((a, b) =>
    a.communityId !== b.communityId
      ? a.communityId < b.communityId ? -1 : 1
      : a.channelId < b.channelId ? -1 : 1,
  );
  return { subs, streamKeys };
}
