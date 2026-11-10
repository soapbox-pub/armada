/**
 * Concord disappearing messages — CORD-08. The timer is COMMUNITY state: one
 * `message_expiration` field (seconds; absent/0 = off) in vsk-0 metadata, under
 * MANAGE_METADATA. While set, every durable chat rumor and its OUTER wrap carry a
 * NIP-40 `expiration` of send time + timer (§2), except deletes and the timer
 * notice itself. Enforcement (ingest refusal, read filter, sweep) lives in
 * `rumorStore.ts`; the signed tag always governs, so changes aren't retroactive.
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { dmTimerSeconds, expirationOf, isExpired } from "@/lib/nip17/protocol";
import { formatDisappearingDuration } from "@/lib/nip17/disappearing";
import { clockNowMs } from "@/lib/relayClock";
import { KIND_DELETE, KIND_SEAL_ENCRYPTED, KIND_TIMER_NOTICE } from "@/concord/lib/kinds";
import { writeRumors } from "@/concord/lib/rumorStore";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, type StreamSigner } from "@/concord/lib/stream";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, CommunityMetadata, Community } from "@/concord/lib/types";
import { t } from "@/i18n/intl";

export { expirationOf, isExpired };

const DAY = 86_400;

/** The default a new community is created with: 30 days (CORD-08). */
export const DEFAULT_MESSAGE_EXPIRATION_SECS = 30 * DAY;

/**
 * Offered community timers. Longer than the DM presets on purpose (sub-day timers
 * punish whoever was asleep); "Off" leads for staff in a hurry.
 */
export const COMMUNITY_TIMER_PRESETS: ReadonlyArray<{ seconds: number; readonly label: string }> = [
  {
    seconds: 0,
    get label() {
      return t({ id: "concordDisappearing.preset.off", defaultMessage: "Off" });
    },
  },
  {
    seconds: DAY,
    get label() {
      return t({ id: "concordDisappearing.preset.oneDay", defaultMessage: "1 day" });
    },
  },
  {
    seconds: 7 * DAY,
    get label() {
      return t({ id: "concordDisappearing.preset.oneWeek", defaultMessage: "1 week" });
    },
  },
  {
    seconds: 30 * DAY,
    get label() {
      return t({ id: "concordDisappearing.preset.thirtyDays", defaultMessage: "30 days" });
    },
  },
  {
    seconds: 90 * DAY,
    get label() {
      return t({ id: "concordDisappearing.preset.ninetyDays", defaultMessage: "90 days" });
    },
  },
  {
    seconds: 365 * DAY,
    get label() {
      return t({ id: "concordDisappearing.preset.oneYear", defaultMessage: "1 year" });
    },
  },
];

/**
 * The community's timer in seconds, 0 = off. Malformed reads as OFF — never guess
 * a default (CORD-08 §1). The only sanctioned reader of the field.
 */
export function messageExpirationOf(metadata: CommunityMetadata | undefined): number {
  const raw = metadata?.message_expiration;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 0;
  return Math.floor(raw);
}

/** The chat kinds that MUST NOT expire (CORD-08 §2): deletes and timer notices. */
export const NEVER_EXPIRING_CHAT_KINDS: ReadonlySet<number> = new Set([KIND_DELETE, KIND_TIMER_NOTICE]);

/** The NIP-40 deadline (unix seconds) for an outgoing rumor, or undefined (off or exempt kind). */
export function chatExpiresAt(kind: number, sendMs: number, timerSecs: number): number | undefined {
  if (timerSecs <= 0 || NEVER_EXPIRING_CHAT_KINDS.has(kind)) return undefined;
  return Math.floor(sendMs / 1000) + timerSecs;
}

/** A community timer in words, preferring preset labels ("30 days", not "4 weeks 2 days"). */
export function formatCommunityTimer(seconds: number): string {
  const preset = COMMUNITY_TIMER_PRESETS.find((p) => p.seconds === seconds && p.seconds > 0);
  return preset ? preset.label : formatDisappearingDuration(seconds);
}

/** The in-timeline notice copy, phrased from the viewer's side like the DM one. */
export function communityTimerNotice(seconds: number, byMe: boolean, name: string): string {
  if (seconds <= 0) {
    return byMe
      ? t({ id: "concordDisappearing.notice.offByMe", defaultMessage: "You turned off disappearing messages." })
      : t({ id: "concordDisappearing.notice.off", defaultMessage: "{name} turned off disappearing messages." }, { name });
  }
  const duration = formatCommunityTimer(seconds);
  return byMe
    ? t({ id: "concordDisappearing.notice.setByMe", defaultMessage: "You set disappearing messages to {duration}." }, { duration })
    : t(
        { id: "concordDisappearing.notice.set", defaultMessage: "{name} set disappearing messages to {duration}." },
        { name, duration },
      );
}

/**
 * The timer a kind-1740 notice announces (`["timer", "<seconds>"]`), or
 * undefined if malformed — never mistaken for "off".
 */
export function timerNoticeSeconds(rumor: { tags: readonly string[][] }): number | undefined {
  return dmTimerSeconds(rumor);
}

/** The minimal relay-pool surface the notice broadcast needs. */
interface NoticeRelayPool {
  relay(url: string): { event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown> };
}

/**
 * Post a kind-1740 timer notice into each channel (CORD-08 §4) after the metadata
 * edition publishes: written locally first, then broadcast best-effort. Purely
 * informational; readers gate display on the author holding MANAGE_METADATA.
 */
export async function publishTimerNotices(
  nostr: NoticeRelayPool,
  community: Community,
  channels: readonly Channel[],
  signer: StreamSigner,
  actorPubkey: string,
  seconds: number,
): Promise<void> {
  const ms = clockNowMs();
  const timer = String(Math.max(0, Math.floor(seconds)));
  const opened: OpenedChat[] = [];
  const wraps: NostrEvent[] = [];

  for (const channel of channels) {
    const tags = [...channelBindingTags(channel.idHex, channel.current.epoch), ["timer", timer]];
    const rumor = buildRumor({ kind: KIND_TIMER_NOTICE, content: "", tags, pubkey: actorPubkey, ms });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, signer);
    const wrap = await wrapSeal(seal, channel.current.group);
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

  await writeRumors(community.idHex, opened, { local: true });
  await Promise.allSettled(
    wraps.flatMap((wrap) =>
      community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
    ),
  );
}
