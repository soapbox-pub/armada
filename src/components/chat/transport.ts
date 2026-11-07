/**
 * Transport-agnostic chat contracts. NIP-29 and Concord each implement a
 * transport; the shared components never touch relays or sealed envelopes.
 * Optional capabilities: a control renders only when its callback exists.
 */

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";
import type { SendStatus } from "@/hooks/useSendStatusMap";
import type { CalendarEvent, RsvpStatus, RsvpTally } from "@/lib/calendar";
import type { PollOption, PollTally, PollType } from "@/lib/polls";
import type { ZapTally } from "@/lib/zaps";
import type { NostrRumor } from "@/lib/nostrRumor";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_DM_CHAT } from "@/lib/nip17/protocol";

export type { ReactInput, ReactionTally, SendStatus };

/**
 * A chat message as a RUMOR, not a `NostrEvent`: Concord messages are adapted
 * from decrypted `OpenedMessage`s and the local store drops signatures. Use
 * `isSigned` (or the publish outbox) where a real signature is required.
 */
export type ChatMsg = NostrRumor & {
  /**
   * Stable React key when `id` changes over the message's life (optimistic sends
   * adopt the signed id); keying on `id` remounted the row and lost the scroll anchor.
   */
  renderKey?: string;
};

/** Distinct authors, most recent first (ranks `user`-argument pickers). */
export function authorsByRecency(messages: ChatMsg[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...messages].sort((a, b) => b.created_at - a.created_at)) {
    if (!seen.has(m.pubkey)) {
      seen.add(m.pubkey);
      out.push(m.pubkey);
    }
  }
  return out;
}

/**
 * Adapt a non-`NostrEvent` message (decrypted Concord/DM) to `ChatMsg`; fills
 * `sig: ""` since rendering never verifies.
 */
export function toChatMsg(m: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags?: string[][];
  renderKey?: string;
}): ChatMsg {
  return {
    id: m.id,
    pubkey: m.pubkey,
    created_at: m.created_at,
    kind: m.kind,
    content: m.content,
    tags: m.tags ?? [],
    ...(m.renderKey ? { renderKey: m.renderKey } : {}),
  };
}

/** Mirrors {@link useReactions}' return shape so `ReactionBar`/`ReactionPicker` consume it unchanged. */
export interface MessageReactions {
  tallies: ReactionTally[];
  react: (input: ReactInput) => void;
}

export interface MessageZaps {
  tally: ZapTally;
}

export interface MessagePoll {
  tally: PollTally;
  vote: (optionIds: string[]) => void;
}

/** RSVP state + setter for a calendar (kind 31922/31923) message. */
export interface MessageCalendar {
  /** Addressably deduped (newest per author/`d`). */
  event: CalendarEvent;
  tally: RsvpTally;
  canRsvp: boolean;
  isSettingRsvp: boolean;
  setRsvp: (status: RsvpStatus) => void;
}

/** A poll to publish, handed by the composer to a transport's {@link ChatTransport.sendPoll}. */
export interface PollDraft {
  question: string;
  options: PollOption[];
  pollType: PollType;
  /** Days until the poll closes; 0 = no end. */
  durationDays: number;
}

/** Per-id object cache so unchanged rows keep a stable {@link MessageZaps} (preserves memo). */
export function stableZapsFor(
  get: (id: string) => ZapTally | undefined,
): (id: string) => MessageZaps | undefined {
  const cache = new Map<string, { tally: ZapTally; value: MessageZaps }>();
  return (id) => {
    const tally = get(id);
    if (!tally) return undefined;
    const hit = cache.get(id);
    if (hit && hit.tally === tally) return hit.value;
    const value: MessageZaps = { tally };
    cache.set(id, { tally, value });
    return value;
  };
}

/**
 * Content equality for tally lists, so transports (which rebuild all tallies on
 * any change) can hand unchanged rows the SAME object.
 */
export function sameReactionTallies(a: readonly ReactionTally[], b: readonly ReactionTally[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const u = b[i];
    return t.key === u.key
      && t.url === u.url
      && t.count === u.count
      && t.mine === u.mine
      && t.mineEventId === u.mineEventId
      && t.pubkeys.length === u.pubkeys.length
      && t.pubkeys.every((pk, k) => pk === u.pubkeys[k])
      && t.urls?.length === u.urls?.length
      && (t.urls ?? []).every((url, k) => url === u.urls![k]);
  });
}

/**
 * A settled lightning payment for transports with their own announcement event
 * (Concord's sealed CORD.md rumor). NIP-29 omits {@link ChatTransport.sendZap}:
 * the LNURL receipt is the announcement.
 */
export interface ZapPayment {
  amountMsats: number;
  bolt11: string;
  /** Present when the payer's wallet returned it (NWC/WebLN). */
  preimage?: string;
  comment: string;
}

/**
 * A settled on-chain zap for transports that seal the announcement (Concord).
 * NIP-29 omits {@link ChatTransport.sendOnchainZap}: public kind 8333 is it.
 */
export interface OnchainZapAnnouncement {
  txid: string;
  amountSats: number;
  comment: string;
}

/** Required members: list + identity + send; everything else is presence-gated. */
export interface ChatTransport {
  /** Ascending (oldest-first) message list. */
  messages: ChatMsg[];
  isLoading: boolean;
  canWrite: boolean;
  canModerate: boolean;

  canMentionEveryone?: boolean;
  /** Concord Roles the viewer may ping (CORD-04 §8). */
  mentionRoles?: readonly { id: string; name: string }[];
  mentionsEveryone?: (event: ChatMsg) => boolean;

  /** Unsigned rumors (Concord): "View event JSON" instead of the event-id off-ramps. */
  isRumor?: boolean;

  /** Concord: messages opening a NEW key epoch get a "key rotated" divider above. */
  rotationDividerIds?: ReadonlySet<string>;

  /**
   * Visual flood members (Concord, `floodCluster.ts`), folded into expandable
   * rows. A DISPLAY hint only: never filter on it or use it for moderation (the
   * Banlist is the only author-identity drop an honest client performs).
   */
  quarantinedIds?: ReadonlySet<string>;

  /**
   * Subset of {@link quarantinedIds} collapsed because the community is PAUSED
   * (CORD-04 §8), so the row states the real reason rather than accusing a flood.
   */
  pausedIds?: ReadonlySet<string>;

  /** Resolves to the number of messages prepended. */
  loadOlder?: () => Promise<number>;
  hasMore?: boolean;
  isLoadingOlder?: boolean;

  /**
   * The messages are a run of older history detached from the present (a jump to
   * an old message): `loadNewer` reads forward toward the present, and the
   * timeline treats its bottom as history rather than the newest message.
   */
  hasNewer?: boolean;
  /** Resolves to the number of messages appended. */
  loadNewer?: () => Promise<number>;
  isLoadingNewer?: boolean;
  /** Drop a detached run and show the present again. */
  returnToPresent?: () => void;

  sendStatusFor?: (id: string) => SendStatus | undefined;
  retry?: (event: ChatMsg) => void;
  discard?: (id: string) => void;

  /** Own always; others' require moderation. */
  deleteMessage?: (event: ChatMsg) => void;
  editMessage?: (original: ChatMsg, content: string) => Promise<void>;

  isPinned?: (id: string) => boolean;
  togglePin?: (event: ChatMsg) => void;

  replyCountFor?: (id: string) => number;
  /** Batched per room. */
  reactionsFor?: (id: string) => MessageReactions;
  /** Presence enables the zap button; the payment runs in the shared dialog. */
  zapsFor?: (id: string) => MessageZaps | undefined;
  /**
   * Announce a settled zap as a chat-plane event (Concord / CORD.md). When
   * present, the dialog REQUIRES a proof-returning method (NWC/WebLN; manual QR
   * never reveals the preimage).
   */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /**
   * Seal the on-chain kind 8333 attribution into the channel (Concord) instead of
   * publishing publicly, which would leak community context. Absent: public (NIP-29).
   */
  sendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;

  /**
   * Poll tally + vote for a kind-1068 message (Concord's sealed fold). NIP-29 uses
   * {@link import("./PollCard").PollCard} instead.
   */
  pollFor?: (id: string) => MessagePoll | undefined;
  /** Calendar (kind 31922/31923) state for the inline event card. */
  calendarFor?: (id: string) => MessageCalendar | undefined;
  /** Publish a poll as a sealed rumor (Concord); enables poll mode. NIP-29 omits it. */
  sendPoll?: (draft: PollDraft) => Promise<void>;

  openThread?: (event: ChatMsg, focusReply?: boolean) => void;

  /**
   * Pre-flight send refusal (Concord's rate limit), checked before the composer
   * clears. Call exactly ONCE per real send: refusals count against the sender,
   * so never poll it from render.
   */
  canSend?: () => string | null;

  // Threading: replies are never top-level timeline messages; they show only in
  // the shared {@link ThreadPanel} (NIP-29 kind-1111 comments, Concord
  // parent-tagged sealed messages).

  threadRepliesFor?: (rootId: string) => ChatMsg[];
  threadLoading?: (rootId: string) => boolean;
  /** `content` is the composer's final text. */
  sendThreadReply?: (root: ChatMsg, content: string, tags: string[][]) => Promise<void>;
}

/** Thread badge summary: distinct repliers (newest-first) and last reply time. */
export function threadSummary(replies: ChatMsg[]): {
  participants: string[];
  lastReplyAt: number | undefined;
} {
  const seen = new Set<string>();
  const participants: string[] = [];
  let lastReplyAt: number | undefined;
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    if (lastReplyAt === undefined) lastReplyAt = r.created_at;
    if (!seen.has(r.pubkey)) {
      seen.add(r.pubkey);
      participants.push(r.pubkey);
    }
  }
  return { participants, lastReplyAt };
}

/**
 * The user's latest message an inline edit can reopen (ArrowUp in an empty
 * composer), using `ChatMessage`'s `canEdit` gate: own, plain text (kind 9 or
 * 14), and not a pending optimistic send. `isPending` flags pending/failed ids.
 */
export function lastEditableOwnMessage(
  messages: readonly ChatMsg[],
  userPubkey: string | undefined,
  isPending?: (id: string) => boolean,
): ChatMsg | undefined {
  if (!userPubkey) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.pubkey !== userPubkey) continue;
    if (m.kind !== KIND_GROUP_CHAT && m.kind !== KIND_DM_CHAT) continue;
    if (isPending?.(m.id)) continue;
    return m;
  }
  return undefined;
}
