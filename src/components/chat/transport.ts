/**
 * Transport-agnostic chat contracts.
 *
 * The chat UI (timeline, message rows, composer) is 100% presentational and
 * derives entirely from these types. A "transport" supplies the data and the
 * mutation callbacks; the shared components never touch a relay, a NIP-29 hook
 * or Concord's sealed envelopes directly. NIP-29 group chat and Concord
 * (end-to-end-encrypted communities) each implement a transport that satisfies
 * this contract, so they render through exactly the same components.
 *
 * Capabilities are optional: a feature's control renders only when the
 * transport provides the matching callback. A transport that can't pin (or
 * thread, or edit) simply omits that method and the UI hides the control —
 * there are no dead/disabled buttons.
 */

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";
import type { SendStatus } from "@/hooks/useGroupMessages";
import type { ZapTally } from "@/lib/zaps";
import type { NostrEvent } from "@nostrify/nostrify";

export type { ReactInput, ReactionTally, SendStatus };

/**
 * A chat message in the shared `NostrEvent` shape. NIP-29 messages already are
 * `NostrEvent`s (kind 9 / 1068); Concord messages are adapted from a decrypted
 * `OpenedMessage` into this shape (`openedToEvent`). Rendering never re-verifies
 * the signature, so a synthetic `sig: ""` is acceptable for adapted messages.
 */
export type ChatMsg = NostrEvent;

/**
 * Adapt a non-`NostrEvent` message (a decrypted Concord `OpenedMessage`, a
 * decrypted DM) into the shared `ChatMsg` shape so it renders through the same
 * `MessageRow`/`ChatContent`/`ChatMessage` path. Rendering never re-verifies the
 * signature, so a synthetic `sig: ""` is filled in when the source has none.
 */
export function toChatMsg(m: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags?: string[][];
  sig?: string;
}): ChatMsg {
  return {
    id: m.id,
    pubkey: m.pubkey,
    created_at: m.created_at,
    kind: m.kind,
    content: m.content,
    tags: m.tags ?? [],
    sig: m.sig ?? "",
  };
}

/**
 * Per-message reaction state + toggle, resolved by the transport for one
 * message. Mirrors the return shape of {@link useReactions} so the shared
 * `ReactionBar`/`ReactionPicker` consume it unchanged.
 */
export interface MessageReactions {
  tallies: ReactionTally[];
  react: (input: ReactInput) => void;
}

/** Per-message zap state, resolved by the transport for one message. */
export interface MessageZaps {
  tally: ZapTally;
}

/**
 * Wrap a tally lookup in a per-id object cache so unchanged rows keep a
 * stable {@link MessageZaps} prop (preserves React.memo). Shared by both
 * transports' `zapsFor`.
 */
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
 * A settled lightning payment, handed by the shared zap dialog to a transport
 * whose zap announcement is its own event (Concord v2's sealed CORD.md rumor).
 * NIP-29 has no publish step — the LNURL provider's public receipt is the
 * announcement — so its transport omits {@link ChatTransport.sendZap}.
 */
export interface ZapPayment {
  amountMsats: number;
  bolt11: string;
  /** Payment proof; present when the payer's wallet returned it (NWC/WebLN). */
  preimage?: string;
  comment: string;
}

/**
 * The capability surface a chat timeline/message/composer consumes. Required
 * members are the irreducible minimum (list + identity + send); everything else
 * is an optional capability gated by presence.
 */
export interface ChatTransport {
  /** Ascending (oldest-first) message list. */
  messages: ChatMsg[];
  /** Whether the initial message load is in flight (drives the skeleton). */
  isLoading: boolean;
  /** Whether the current user may write (drives composer + per-message actions). */
  canWrite: boolean;
  /** Whether the current user may moderate (delete others' messages, pin, …). */
  canModerate: boolean;

  /**
   * Whether this transport's messages are unsigned rumors (Concord's sealed
   * chat events) rather than relay-addressable signed events. Drives the
   * per-message context menu: rumors offer "View event JSON" instead of the
   * "Copy message ID" / "View on Ditto" off-ramps (which reference a
   * relay-addressable event id that doesn't exist for a rumor).
   */
  isRumor?: boolean;

  // ── Optional capabilities (control hidden when undefined) ────────────────

  /** Backfill older history; resolves to the number of messages prepended. */
  loadOlder?: () => Promise<number>;
  /** Whether more history remains to backfill. */
  hasMore?: boolean;
  /** Whether an older-history page is currently loading. */
  isLoadingOlder?: boolean;

  /** Optimistic send status for a message id (pending/failed), if tracked. */
  sendStatusFor?: (id: string) => SendStatus | undefined;
  /** Re-publish a failed optimistic message (retry). */
  retry?: (event: ChatMsg) => void;
  /** Drop a failed optimistic message (discard). */
  discard?: (id: string) => void;

  /** Delete a message (own always; others' require moderation). */
  deleteMessage?: (event: ChatMsg) => void;
  /** Submit an inline edit, returning when applied. */
  editMessage?: (original: ChatMsg, content: string) => Promise<void>;

  /** Whether a message id is pinned. */
  isPinned?: (id: string) => boolean;
  /** Pin/unpin a message (moderation). */
  togglePin?: (event: ChatMsg) => void;

  /** Threaded-reply count for a message id (drives the "N replies" badge). */
  replyCountFor?: (id: string) => number;
  /** Resolved reaction tallies + toggle for a message id (batched per room). */
  reactionsFor?: (id: string) => MessageReactions;
  /**
   * Aggregated zaps for a message id. Presence enables the zap button; the
   * payment itself runs in the shared dialog (it needs only the author's
   * lightning address), while this feeds the ⚡ total chip.
   */
  zapsFor?: (id: string) => MessageZaps | undefined;
  /**
   * Announce a settled zap payment for this message, for transports whose
   * announcement is a chat-plane event (Concord v2 / CORD.md). When present,
   * the dialog REQUIRES a proof-returning payment method (NWC/WebLN — no
   * manual QR, which never reveals the preimage).
   */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  /** Open the threaded-replies panel for a message. */
  openThread?: (event: ChatMsg, focusReply?: boolean) => void;

  // ── Threading (Slack-style; shared ThreadPanel reads these) ──────────────
  //
  // A reply is NOT a top-level timeline message: it's nested under its root and
  // only shown in the thread panel. Every protocol implements these three the
  // same way — NIP-29 via kind-1111 comments, Concord V1/V2 via a parent-tagged
  // sealed chat message — so the shared {@link ThreadPanel} is transport-driven.

  /** Ascending (oldest-first) replies to a root message id. */
  threadRepliesFor?: (rootId: string) => ChatMsg[];
  /** Whether a root's replies are still loading (drives the panel spinner). */
  threadLoading?: (rootId: string) => boolean;
  /** Post a reply into a root's thread (content is the composer's final text). */
  sendThreadReply?: (root: ChatMsg, content: string, tags: string[][]) => Promise<void>;
}

/**
 * Derive the thread badge's summary from a root's replies: the distinct
 * repliers (newest-first, so the freshest voices lead the avatar stack) and the
 * most recent reply time. Shared by every per-message binding so the badge
 * reads identically across protocols.
 */
export function threadSummary(replies: ChatMsg[]): {
  participants: string[];
  lastReplyAt: number | undefined;
} {
  const seen = new Set<string>();
  const participants: string[] = [];
  let lastReplyAt: number | undefined;
  // Replies arrive oldest-first; walk newest-first for the stack order.
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
