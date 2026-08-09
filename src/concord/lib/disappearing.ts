/**
 * Concord disappearing messages — CORD-08.
 *
 * The timer is COMMUNITY state, never a per-message choice: one
 * `message_expiration` field (seconds; absent/0 = off) in the vsk-0 metadata
 * entity, edited like any versioned edition under MANAGE_METADATA. While set,
 * every durable chat-plane rumor carries a NIP-40 `expiration` of its send
 * time plus the timer, and the OUTER wrap carries the same tag so relays purge
 * the ciphertext itself (CORD-08 §2). Two chat kinds are exempt: deletes
 * (an expiring delete would let a longer-lived target come back) and the timer
 * notice itself (the notice documents the policy; the policy must not erase
 * it).
 *
 * Enforcement is the DM plane's trio (CORD-08 §3): ingest refusal + read
 * filter + physical sweep, in `rumorStore.ts`; the tag rides inside the signed
 * rumor, so a timer change is never retroactive and the tag as signed always
 * governs.
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { dmTimerSeconds, expirationOf, isExpired } from "@/lib/nip17/protocol";
import { formatDisappearingDuration } from "@/lib/nip17/disappearing";
import { KIND_DELETE, KIND_SEAL_ENCRYPTED, KIND_TIMER_NOTICE } from "@/concord/lib/kinds";
import { writeRumors } from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, type StreamSigner } from "@/concord/lib/stream";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, CommunityMetadata, Community } from "@/concord/lib/types";
import { channelWriteGroup } from "@/concord/lib/community";

export { expirationOf, isExpired };

const DAY = 86_400;

/** The default a new community is created with: 30 days (CORD-08). */
export const DEFAULT_MESSAGE_EXPIRATION_SECS = 30 * DAY;

/**
 * The offered community timers. Longer-lived than the DM presets (Signal's
 * set) on purpose: a community's history is a shared artifact, and sub-day
 * timers there mostly punish whoever was asleep. "Off" leads because turning
 * the feature off is the one choice staff may need in a hurry.
 */
export const COMMUNITY_TIMER_PRESETS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: "Off" },
  { seconds: DAY, label: "1 day" },
  { seconds: 7 * DAY, label: "1 week" },
  { seconds: 30 * DAY, label: "30 days" },
  { seconds: 90 * DAY, label: "90 days" },
  { seconds: 365 * DAY, label: "1 year" },
];

/**
 * The community's timer in seconds, 0 = off. Absent, zero, or malformed reads
 * as OFF — a reader MUST NOT guess a default from garbage (CORD-08 §1) — so
 * this is the ONLY way the field should be read.
 */
export function messageExpirationOf(metadata: CommunityMetadata | undefined): number {
  const raw = metadata?.message_expiration;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 0;
  return Math.floor(raw);
}

/** The chat kinds that MUST NOT expire (CORD-08 §2): deletes and timer notices. */
export const NEVER_EXPIRING_CHAT_KINDS: ReadonlySet<number> = new Set([KIND_DELETE, KIND_TIMER_NOTICE]);

/**
 * The NIP-40 deadline (unix seconds) an outgoing chat rumor of `kind`, sent at
 * `sendMs`, must carry under `timerSecs` — or undefined when it carries none
 * (timer off, or an exempt kind).
 */
export function chatExpiresAt(kind: number, sendMs: number, timerSecs: number): number | undefined {
  if (timerSecs <= 0 || NEVER_EXPIRING_CHAT_KINDS.has(kind)) return undefined;
  return Math.floor(sendMs / 1000) + timerSecs;
}

/**
 * A community timer in words. Prefers this module's preset labels ("30 days" —
 * which the DM formatter would render as "4 weeks 2 days"), falling back to
 * the composed form for a value another client set.
 */
export function formatCommunityTimer(seconds: number): string {
  const preset = COMMUNITY_TIMER_PRESETS.find((p) => p.seconds === seconds && p.seconds > 0);
  return preset ? preset.label : formatDisappearingDuration(seconds);
}

/** The in-timeline notice copy, phrased from the viewer's side like the DM one. */
export function communityTimerNotice(seconds: number, byMe: boolean, name: string): string {
  const who = byMe ? "You" : name;
  if (seconds <= 0) return `${who} turned off disappearing messages.`;
  return `${who} set disappearing messages to ${formatCommunityTimer(seconds)}.`;
}

/**
 * The timer (seconds; 0 = off) a kind-1740 notice announces, or undefined when
 * the tag is missing/malformed — an unreadable notice must not be mistaken for
 * "turned it off". Same `["timer", "<seconds>"]` tag as the DM notice.
 */
export function timerNoticeSeconds(rumor: { tags: readonly string[][] }): number | undefined {
  return dmTimerSeconds(rumor);
}

/** The minimal relay-pool surface the notice broadcast needs. */
interface NoticeRelayPool {
  relay(url: string): { event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown> };
}

/**
 * Post one kind-1740 timer notice into each of `channels` (CORD-08 §4) —
 * called by the staff mutation right after the metadata edition publishes.
 * Sealed and wrapped like any chat rumor under each channel's CURRENT stream
 * key; written to the local store first (so the actor's own timelines show the
 * notice immediately), then broadcast best-effort. Notices are informational —
 * the fold is the authority — so a channel that fails here is simply a channel
 * without the courtesy line, and readers gate display on the author holding
 * MANAGE_METADATA regardless.
 */
export async function publishTimerNotices(
  nostr: NoticeRelayPool,
  community: Community,
  channels: readonly Channel[],
  signer: StreamSigner,
  actorPubkey: string,
  seconds: number,
): Promise<void> {
  const ms = Date.now();
  const timer = String(Math.max(0, Math.floor(seconds)));
  const opened: OpenedChat[] = [];
  const wraps: NostrEvent[] = [];

  for (const channel of channels) {
    const tags = [...channelBindingTags(channel.idHex, channel.current.epoch), ["timer", timer]];
    const rumor = buildRumor({ kind: KIND_TIMER_NOTICE, content: "", tags, pubkey: actorPubkey, ms });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, signer);
    const wrap = wrapSeal(seal, channelWriteGroup(channel));
    wraps.push(wrap);
    opened.push({
      rumorId: rumor.id,
      author: actorPubkey,
      kind: KIND_TIMER_NOTICE,
      content: "",
      tags,
      ms,
      createdAt: rumor.created_at,
      wrapId: wrap.id,
      streamPk: wrap.pubkey,
      sealKind: KIND_SEAL_ENCRYPTED,
      seal,
      channelIdHex: channel.idHex,
      epoch: channel.current.epoch,
    });
  }

  await writeRumors(community.idHex, opened);
  await Promise.allSettled(
    wraps.flatMap((wrap) =>
      community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
    ),
  );
}
