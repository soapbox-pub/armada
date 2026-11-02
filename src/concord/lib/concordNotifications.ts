import { bytesToHex } from "@noble/hashes/utils.js";

import { channelsView, signingStreams } from "@/concord/lib/community";
import { messageExpirationOf } from "@/concord/lib/disappearing";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
import type { FoldedControl } from "@/concord/lib/control";
import type { GroupKey } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";
import { everyoneMentionAuthors } from "@/concord/lib/everyoneMention";

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
 * A native-notification subscription for one channel: relays, per-epoch stream
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
  /** The CURRENT epoch's stream only — retired epochs are read-cutoff history and never notify. */
  streams: ConcordStream[];
  /**
   * The community's banned authors (CORD-04), sorted hex, so background notifiers
   * drop them before notifying (as `foldTimeline` does). Sorted for a stable
   * config signature.
   */
  banned?: string[];
  /** Authors currently allowed to issue @everyone in this channel. */
  mentionEveryoneAuthors?: string[];
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
  for (const channel of channelsView(community, folded)) {
    if (channel.streams.length === 0) continue;
    // EVERY held epoch registers for NIP-42 (backfill reads retired epochs)…
    streamKeys.push(...signingStreams(channel));
    const mentionEveryoneAuthors = folded
      ? everyoneMentionAuthors(folded.roster, folded.ownerHex, [channel.idHex])
      : community.owner ? [community.owner] : [];
    subs.push({
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
      ...(joinedAtMs !== undefined && { joinedAtMs }),
      communityImage,
      timerSecs,
      gitAttachments: channelGitRepositoryAttachments(folded?.channels.get(channel.idHex)?.metadata ?? { name: channel.name, private: channel.isPrivate }),
    });
  }
  // Deterministic order so a refetch/rename doesn't churn the native config.
  subs.sort((a, b) =>
    a.communityId !== b.communityId
      ? a.communityId < b.communityId ? -1 : 1
      : a.channelId < b.channelId ? -1 : 1,
  );
  return { subs, streamKeys };
}
