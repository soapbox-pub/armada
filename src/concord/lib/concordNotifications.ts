import { bytesToHex } from "@noble/hashes/utils.js";

import { channelsView } from "@/concord/lib/community";
import { messageExpirationOf } from "@/concord/lib/disappearing";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
import type { FoldedControl } from "@/concord/lib/control";
import type { StreamKeyView } from "@/concord/lib/derive";
import type { Community } from "@/concord/lib/types";

/**
 * One stream address of a Concord channel (one per held epoch): the wrap author to
 * filter on and the NIP-44 self-ECDH conversation key that opens its wraps.
 * The stream SECRET key is deliberately NOT shipped to native code — the
 * conversation key decrypts (all the notification needs); NIP-42 stream auth
 * stays in the WebView (see streamAuth.ts).
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
 * A native-notification subscription for one Concord channel: the relays
 * its wraps live on, the per-epoch stream addresses + decrypt keys, and the
 * display names / ids for the notification and its deep link
 * (/c/<communityId>/<channelId>). The native service filters
 * `{kinds:[1059], authors:[…pk]}` and opens wrap → seal → rumor with the
 * supplied conversation key to show "<sender>: <preview>".
 */
export interface ConcordSub {
  relays: string[];
  /** Community id (hex) for the deep link. */
  communityId: string;
  communityName: string;
  /** Channel id (hex): deep-link segment + the rumor's `channel` binding tag. */
  channelId: string;
  channelName: string;
  /** The CURRENT epoch's stream only — retired epochs are read-cutoff history and never notify. */
  streams: ConcordStream[];
  /**
   * The community's encrypted icon pointer (CORD-02 §6), for the native
   * per-community notification group summary. The service fetches the blob,
   * AES-GCM decrypts with `key`/`nonce`, and verifies `hash`. Omitted when the
   * community has no icon.
   */
  communityImage?: { url: string; key: string; nonce: string; hash: string };
  /**
   * The community's CORD-08 disappearing-message timer (seconds; 0 = off),
   * read from the control fold's metadata. The native quick reply stamps its
   * rumor + wrap with `sendTime + timerSecs` so a reply sent from the
   * notification shade disappears like any other message. A snapshot, like
   * every other field here: a timer changed while the app is dead applies
   * from the next reconfigure.
   */
  timerSecs: number;
  /** Public repository attachments folded from this channel's local metadata. */
  gitAttachments: ReturnType<typeof channelGitRepositoryAttachments>;
}

/**
 * Build the per-channel Concord notification subscriptions for one community from
 * its rehydrated runtime shape + its (possibly cached) Control fold. Also
 * returns the channels' stream key VIEWS so the caller can register them for
 * NIP-42 stream auth (an auth-gating relay requires every `authors` entry to
 * be authenticated; the signing happens in the WebView).
 */
export function buildConcordSubs(
  community: Community,
  folded: FoldedControl | undefined,
): { subs: ConcordSub[]; streamKeys: StreamKeyView[] } {
  const subs: ConcordSub[] = [];
  const streamKeys: StreamKeyView[] = [];
  if (community.relays.length === 0) return { subs, streamKeys };

  const communityName = folded?.metadata?.name || community.name || "Community";
  // The community icon (if any) is the same for every channel — decrypted
  // natively for the group summary's large icon.
  const icon = folded?.metadata?.icon;
  const communityImage = icon
    ? { url: icon.url, key: icon.key, nonce: icon.nonce, hash: icon.hash }
    : undefined;
  const timerSecs = messageExpirationOf(folded?.metadata);
  for (const channel of channelsView(community, folded)) {
    if (channel.streams.length === 0) continue;
    // EVERY held epoch registers for NIP-42 stream auth (backfill still reads
    // retired epochs from auth-gating relays)…
    streamKeys.push(...channel.streams.map((s) => s.group));
    subs.push({
      relays: community.relays,
      communityId: community.idHex,
      communityName,
      channelId: channel.idHex,
      channelName: channel.name,
      // …but the native service only ever LISTENS on the current epoch: a
      // retired epoch is read-cutoff history — nothing on it may notify, and
      // its address must not stay open as a live socket filter.
      streams: [
        {
          pk: channel.current.group.pk,
          convKey: bytesToHex(channel.current.group.convKey),
          epoch: channel.current.epoch.toString(),
        },
      ],
      communityImage,
      timerSecs,
      gitAttachments: channelGitRepositoryAttachments(folded?.channels.get(channel.idHex)?.metadata ?? { name: channel.name, private: channel.isPrivate }),
    });
  }
  // Deterministic order (ids, not display names) so a mere refetch/rename
  // doesn't churn the native config and tear down live connections.
  subs.sort((a, b) =>
    a.communityId !== b.communityId
      ? a.communityId < b.communityId ? -1 : 1
      : a.channelId < b.channelId ? -1 : 1,
  );
  return { subs, streamKeys };
}
