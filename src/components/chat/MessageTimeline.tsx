import { ChevronDown, ChevronUp, KeyRound, Loader2, MessagesSquare, Pause, ShieldOff } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  countRows,
  FIRST_PAINT_WINDOW,
  INITIAL_WINDOW,
  MAX_WINDOW,
  resolveWindowEnd,
  resolveWindowStart,
  stepBackRows,
  stepForwardRows,
  TRIM_ABOVE,
  TRIM_SLACK,
  WINDOW_STEP,
} from "@/components/chat/timelineWindow";
import { flashRow } from "@/components/chat/rowFlash";
import {
  captureScrollAnchor,
  clampedScrollTop,
  distanceFromBottom,
  restoreScrollAnchor,
  type ScrollAnchor,
} from "@/components/chat/scrollAnchor";
import { Skeleton } from "@/components/ui/skeleton";
import { markBootPainted } from "@/lib/bootGate";
import { beginSyncTask } from "@/lib/syncActivity";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useMutedWordFilter } from "@/hooks/useMutedWords";
import { usePerfMilestone } from "@/hooks/usePerfMilestone";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl, type IntlShape } from "@/i18n";

import { isGitContinuation, timelineEntryAuthor, type ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode, RefObject } from "react";

/** Max gap (seconds) for a same-author message to render as a continuation. */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** Shortest flood run worth folding: interleaved chat can split floods into tiny fragments. */
const FLOOD_ROW_MIN = 3;

/** Distance from the top (px) that requests older history; past the reveal band so the fetch overlaps reading. */
const BACKFILL_TRIGGER_PX = 8000;

/** A phone fling covers ~2400px before one reveal step commits, so start ahead of that. */
const REVEAL_TRIGGER_PX = 3000;

/**
 * Reveal steps that may chain without a new upward scroll. Every row drawn ahead of
 * the reader costs layout on every later frame, so a still reader stops being
 * walked up the band — unless it is within {@link CHAIN_FLOOR_PX} of the top.
 */
const MAX_CHAINED_REVEALS = 2;
const CHAIN_FLOOR_PX = 1500;

/** Hidden loaded rows left above the window when the next older page is requested. */
const PREFETCH_ROWS = 3 * WINDOW_STEP;

/** Underfilled auto-loads that may add nothing before the timeline stops asking. */
const UNDERFILL_DRY_LIMIT = 2;

const AT_BOTTOM_PX = 60;

const JUMP_PILL_PX = 300;

const JUMP_CONTEXT = 15;

/** How long a jumped-to row is held centered while rows around it settle, absent a gesture. */
const JUMP_HOLD_MS = 5000;

/**
 * Added to the measured distance while newer loaded rows are unrendered below
 * the window: the scroller's bottom is then not the newest message, so nothing
 * may treat the reader as at the bottom.
 */
const UNRENDERED_BELOW_PX = 1_000_000;

/** Rows per commit as a conversation opens, one step per frame; the switch click's commit mounts none. */
const OPENING_RAMP = [0, FIRST_PAINT_WINDOW, INITIAL_WINDOW];

export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDayLabel(ts: number, intl: IntlShape): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  if (isSameDay(ts, Math.floor(now.getTime() / 1000))) {
    return intl.formatMessage({ id: "messageTimeline.today", defaultMessage: "Today" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(ts, Math.floor(yesterday.getTime() / 1000))) {
    return intl.formatMessage({ id: "messageTimeline.yesterday", defaultMessage: "Yesterday" });
  }
  // intl memoizes its formatters, so this doesn't build an Intl.DateTimeFormat per call.
  return intl.formatDate(date, date.getFullYear() === now.getFullYear() ? DAY_FORMAT : DAY_YEAR_FORMAT);
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
const DAY_YEAR_FORMAT: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" };

/** Discord-style day separator. Memoized: the list re-renders on most page renders. */
export const DateSeparator = memo(function DateSeparator({ ts }: { ts: number }) {
  const intl = useIntl();
  return (
    <div className="flex items-center gap-3 px-2 pt-3 pb-1 select-none" aria-hidden>
      <div className="h-px flex-1 bg-border/60" />
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/80">
        {formatDayLabel(ts, intl)}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
});

function NewMessagesDivider() {
  const intl = useIntl();
  return (
    <div
      className="flex items-center px-2 py-1 select-none"
      role="separator"
      aria-label={intl.formatMessage({ id: "messageTimeline.newMessages", defaultMessage: "New messages" })}
    >
      <div className="h-px flex-1 bg-destructive/70" />
      <span className="pl-1.5 text-3xs font-semibold uppercase tracking-wider text-destructive">
        <FormattedMessage id="messageTimeline.new" defaultMessage="New" />
      </span>
    </div>
  );
}

/**
 * Concord key-rotation boundary: everything above was sealed under a previous
 * key. The warning tone is deliberate.
 */
function KeyRotationDivider() {
  const intl = useIntl();
  return (
    <div
      className="flex items-center gap-3 px-2 py-1 select-none"
      role="separator"
      aria-label={intl.formatMessage({
        id: "messageTimeline.keyRotatedLabel",
        defaultMessage: "Key rotated. Earlier messages use a previous key",
      })}
    >
      <div className="h-px flex-1 bg-warning/50" />
      <span
        className="flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-wider text-warning"
        title={intl.formatMessage({
          id: "messageTimeline.keyRotatedTitle",
          defaultMessage: "The community's encryption key was rotated here. Messages above were sealed under a previous key.",
        })}
      >
        <KeyRound className="size-3" aria-hidden />
        <FormattedMessage id="messageTimeline.keyRotated" defaultMessage="Key rotated" />
      </span>
      <div className="h-px flex-1 bg-warning/50" />
    </div>
  );
}

/**
 * A run the transport marked as flood (`quarantinedIds`), folded into one
 * openable row — a summary, not a removal, since the heuristic can be wrong.
 * `reason` swaps the copy for a community pause or the community's permissions
 * (CORD-04 §8), where flood wording would be a false accusation.
 */
function FloodNotice({
  count,
  authors,
  reason,
  expanded,
  onToggle,
}: {
  count: number;
  authors: number;
  reason: FoldReason;
  expanded: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const label = expanded
    ? reason === "paused"
      ? intl.formatMessage({ id: "messageTimeline.flood.hidePaused", defaultMessage: "Hide messages sent while paused" })
      : reason === "ruled"
        ? intl.formatMessage({ id: "messageTimeline.flood.hideRuled", defaultMessage: "Hide these messages" })
        : intl.formatMessage({ id: "messageTimeline.flood.hideSimilar", defaultMessage: "Hide similar messages" })
    : reason === "paused"
      ? intl.formatMessage(
        {
          id: "messageTimeline.flood.paused",
          defaultMessage: "{count, plural, one {# message} other {# messages}} sent while the community was paused",
        },
        { count },
      )
      : reason === "ruled"
        ? intl.formatMessage(
          {
            id: "messageTimeline.flood.ruled",
            defaultMessage: "{count, plural, one {# message} other {# messages}} from members who can't post here",
          },
          { count },
        )
        : intl.formatMessage(
          {
            id: "messageTimeline.flood.similar",
            defaultMessage: "{count, plural, one {# similar message} other {# similar messages}} from {authors, plural, one {# account} other {# accounts}}",
          },
          { count, authors },
        );
  return (
    <div className="flex items-center gap-3 px-2 py-1 select-none">
      <div className="h-px flex-1 bg-muted-foreground/25" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 rounded px-1.5 py-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground touch:py-1.5 touch:text-xs"
        title={
          expanded
            ? intl.formatMessage({ id: "messageTimeline.flood.foldTitle", defaultMessage: "Fold these back up" })
            : reason === "paused"
              ? intl.formatMessage({
                id: "messageTimeline.flood.pausedTitle",
                defaultMessage: "Posted after a moderator paused the community. Nothing was removed.",
              })
              : reason === "ruled"
                ? intl.formatMessage({
                  id: "messageTimeline.flood.ruledTitle",
                  defaultMessage: "Posted by someone this channel's permissions or a timeout don't let post here. Nothing was removed.",
                })
                : intl.formatMessage({
                  id: "messageTimeline.flood.similarTitle",
                  defaultMessage: "Several accounts posted near-identical messages at once. Nothing was removed.",
                })
        }
      >
        {reason === "paused" ? (
          <Pause className="size-3 shrink-0" aria-hidden />
        ) : reason === "ruled" ? (
          <ShieldOff className="size-3 shrink-0" aria-hidden />
        ) : (
          <MessagesSquare className="size-3 shrink-0" aria-hidden />
        )}
        {label}
      </button>
      <div className="h-px flex-1 bg-muted-foreground/25" />
    </div>
  );
}

/** Why a run folded: the flood heuristic, a community pause, or the community's permissions. */
type FoldReason = "flood" | "paused" | "ruled";

type TimelineItem =
  | { type: "date"; ts: number; key: string }
  | { type: "unread"; key: string }
  | { type: "rotation"; key: string }
  | { type: "message"; msg: ChatMsg; continuation: boolean; key: string }
  | { type: "flood"; msgs: readonly ChatMsg[]; authors: number; reason: FoldReason; key: string }
  | { type: "entry"; entry: NonChatEntry; related?: readonly NonChatEntry[]; key: string };

type NonChatEntry = Exclude<ChannelTimelineEntry, { type: "chat" }>;

/**
 * A Git group head plus its same-day continuations (which emit no row).
 * `undefined` for a lone entry. Grouping rules: {@link isGitContinuation}.
 */
function relatedGitEntries(
  entries: readonly ChannelTimelineEntry[],
  index: number,
  entry: NonChatEntry,
): readonly NonChatEntry[] | undefined {
  // Checked before allocating: most entries start no group.
  if (!isGitContinuation(entry, entries[index + 1])) return undefined;
  const related: NonChatEntry[] = [entry];
  for (let cursor = index + 1; cursor < entries.length; cursor++) {
    const candidate = entries[cursor];
    if (
      !candidate ||
      candidate.type === "chat" ||
      !isSameDay(entry.createdAt, candidate.createdAt) ||
      !isGitContinuation(related[related.length - 1], candidate)
    ) {
      break;
    }
    related.push(candidate);
  }
  return related.length > 1 ? related : undefined;
}

export interface MessageTimelineHandle {
  /**
   * Reveal and center a loaded message; false when not in this timeline (e.g. a
   * thread reply). `focus` marks a permalink target (longer highlight + bar).
   */
  scrollToMessage: (id: string, focus?: boolean) => boolean;
  pinToBottom: () => void;
  /**
   * Stay at the bottom only if already there, for changes the internal
   * ResizeObserver can't see.
   */
  maintainBottom: () => void;
}

interface MessageTimelineProps {
  transport: ChatTransport;
  /** Render one message row; `continuation` is precomputed from the shared rule. */
  renderMessage: (event: ChatMsg, continuation: boolean) => ReactNode;
  /** Generalized channel entries; unset keeps the chat-only timeline (NIP-29, DMs, mesh). */
  entries?: readonly ChannelTimelineEntry[];
  renderEntry?: (entry: NonChatEntry, relatedEntries?: readonly NonChatEntry[]) => ReactNode;
  emptyState?: ReactNode;
  handleRef?: RefObject<MessageTimelineHandle | null>;
  /** Yield to a caller overlay (e.g. search results); suppresses scroll backfill. */
  paused?: boolean;
  /** First unread message id; the "NEW" divider renders above it (see {@link useNewMessagesDivider}). */
  newDividerId?: string;
  /**
   * A catch-up for this conversation is in flight, so an empty timeline isn't
   * "no messages" yet. Not part of the skeleton gate: the skeleton is for the
   * fast local read, not network latency.
   */
  syncing?: boolean;
  /**
   * The catch-up keeps failing. Empty relay reads also land here, so the empty
   * state says only that nothing has loaded yet, not that relays are unreachable.
   */
  syncFailed?: boolean;
  className?: string;
}

/**
 * Fixed pseudo-thread for the loading placeholder (varied authors and line
 * counts). Geometry matches {@link MessageRow} so nothing shifts on swap.
 */
const SKELETON_ROWS: { continuation: boolean; name?: string; widths: string[] }[] = [
  { continuation: false, name: "5rem", widths: ["62%"] },
  { continuation: true, widths: ["38%"] },
  { continuation: true, widths: ["74%", "41%"] },
  { continuation: false, name: "7rem", widths: ["48%"] },
  { continuation: false, name: "4.5rem", widths: ["83%", "56%", "29%"] },
  { continuation: true, widths: ["35%"] },
  { continuation: false, name: "6rem", widths: ["67%"] },
  { continuation: true, widths: ["52%", "44%"] },
  { continuation: false, name: "5.5rem", widths: ["31%"] },
  { continuation: false, name: "8rem", widths: ["78%", "38%"] },
  { continuation: true, widths: ["59%"] },
  { continuation: false, name: "4rem", widths: ["45%", "70%"] },
  { continuation: true, widths: ["33%"] },
  { continuation: false, name: "6.5rem", widths: ["71%", "50%"] },
];

/** Bottom-anchored placeholder, clipped at the top like scrolled-off history. */
const TimelineSkeleton = memo(function TimelineSkeleton() {
  return (
    <div
      className="flex-1 min-h-0 overflow-hidden flex flex-col justify-end px-3 py-4"
      aria-hidden
    >
      {[...SKELETON_ROWS, ...SKELETON_ROWS].map((row, i) => (
        <div
          key={i}
          className={cn("flex items-start gap-3 px-2.5", row.continuation ? "py-0.5" : "pt-1.5 pb-0.5")}
        >
          {row.continuation ? (
            <div className="w-10 shrink-0" />
          ) : (
            <Skeleton className="size-10 rounded-full shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0 space-y-1.5">
            {!row.continuation && (
              <div className="flex items-baseline gap-2">
                <Skeleton className="h-3.5" style={{ width: row.name }} />
                <Skeleton className="h-2.5 w-8" />
              </div>
            )}
            {row.widths.map((width, j) => (
              <Skeleton key={j} className="h-3.5 max-w-full" style={{ width }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});

/**
 * Transport-agnostic message timeline (NIP-29, Concord, DMs, mesh): owns scroll
 * mechanics and the continuation rule; content comes from `renderMessage`.
 *
 * Not virtualized: rows change height after mounting, which makes a measuring
 * virtualizer jump, and absolute positioning disables native scroll anchoring.
 * Instead the data is bounded:
 * - **Bounded window**: opens with {@link FIRST_PAINT_WINDOW} rows, fills to
 *   {@link INITIAL_WINDOW}, reveals {@link WINDOW_STEP} more near the top before
 *   asking the transport, and trims back at the bottom. Away from the bottom it
 *   holds at most {@link MAX_WINDOW} rows: revealing one edge drops the other.
 * - **Anchored position**: the first visible row and its offset are restored
 *   after reveals/prepends/growth (explicitly; WebKit lacks CSS scroll anchoring).
 * - **Stick-to-bottom** preserves distance from the bottom rather than snapping.
 */
/** Jump target naming the NEW divider row rather than a message. */
const UNREAD_DIVIDER_TARGET = "\u0000unread-divider";

function jumpTargetRow(content: HTMLElement | null, id: string): HTMLElement | null | undefined {
  return content?.querySelector<HTMLElement>(
    id === UNREAD_DIVIDER_TARGET ? '[data-scroll-anchor="unread-divider"]' : `[data-event-id="${id}"]`,
  );
}

export function MessageTimeline({
  transport,
  renderMessage,
  entries,
  renderEntry,
  emptyState,
  handleRef,
  paused = false,
  newDividerId,
  syncing = false,
  syncFailed = false,
  className,
}: MessageTimelineProps) {
  const intl = useIntl();
  const {
    messages,
    isLoading,
    loadOlder,
    hasMore,
    isLoadingOlder,
    hasNewer = false,
    loadNewer,
    isLoadingNewer,
    returnToPresent: leaveDetachedRun,
    rotationDividerIds,
    quarantinedIds,
    pausedIds,
    ruledIds,
  } = transport;

  // Opened flood rows, keyed by the run's first message id (so they don't leak
  // across channels). `floodRunOfRef` lets a jump open the run hiding its target.
  const [expandedFloods, setExpandedFloods] = useState<ReadonlySet<string>>(() => new Set());
  const floodRunOfRef = useRef<Map<string, string>>(new Map());
  const toggleFlood = useCallback((key: string) => {
    setExpandedFloods((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // The key milestone: when the skeleton came down.
  const firstRowsPainted = !isLoading && messages.length > 0;
  usePerfMilestone("timeline.first rows", firstRowsPainted);
  // Cue for the boot gate. (An empty channel opens it via its timeout.)
  useEffect(() => {
    if (firstRowsPainted) markBootPainted();
  }, [firstRowsPainted]);

  // Memoized: the row model and prepend anchor compare by identity.
  const allEntries = useMemo<readonly ChannelTimelineEntry[]>(
    () =>
      entries ??
      messages.map((message) => ({
        type: "chat" as const,
        id: `chat:${message.id}`,
        createdAt: message.created_at,
        message,
      })),
    [entries, messages],
  );

  // Mutes, muted words and hidden messages are filtered here, where every surface funnels
  // through. Mutes are skipped while cold (`!ready`) rather than hiding rows
  // without basis.
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();
  const { hiddenIds } = useHiddenMessages();
  const mutedWord = useMutedWordFilter();
  const timelineEntries = useMemo<readonly ChannelTimelineEntry[]>(() => {
    const dropMuted = mutesReady && mutedPubkeys.size > 0;
    if (!dropMuted && hiddenIds.size === 0 && !mutedWord) return allEntries;
    const kept = allEntries.filter((entry) => {
      if (entry.type === "chat" && hiddenIds.has(entry.message.id)) return false;
      if (entry.type === "chat" && mutedWord?.(entry.message)) return false;
      if (!dropMuted) return true;
      const author = timelineEntryAuthor(entry);
      return !author || !mutedPubkeys.has(author);
    });
    // Preserve identity when nothing was removed (the prepend anchor compares it).
    return kept.length === allEntries.length ? allEntries : kept;
  }, [allEntries, mutedPubkeys, mutesReady, hiddenIds, mutedWord]);

  // Once populated, a transient empty array shows the skeleton rather than the
  // empty state; reset while a fresh load is in flight. Tracked on UNFILTERED
  // entries, or a fully-muted channel would hold the skeleton forever.
  const hadMessagesRef = useRef(false);
  if (isLoading) hadMessagesRef.current = false;
  if (allEntries.length > 0) hadMessagesRef.current = true;
  const transientEmpty = allEntries.length === 0 && hadMessagesRef.current;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Live mirrors, so scroll/observer callbacks never close over stale props.
  const entriesRef = useRef(timelineEntries);
  entriesRef.current = timelineEntries;
  const quarantinedIdsRef = useRef(quarantinedIds);
  quarantinedIdsRef.current = quarantinedIds;
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;

  // Distance from the newest message; the single input to stick-to-bottom.
  const distanceRef = useRef(0);
  // A window extension is committed but not yet laid out — don't stack another.
  const extendLockRef = useRef(false);
  // Independent of the transport's possibly lagging `isLoadingOlder`/`isLoadingNewer`.
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  // Consecutive underfill loads that added nothing, per oldest row.
  const underfillDryRef = useRef<{ oldestId: string | undefined; count: number }>({ oldestId: undefined, count: 0 });
  // A scroll-triggered page landed above the first row: reveal a step
  // automatically, since a reader at scrollTop=0 has no further upward scroll.
  const backfillRevealRef = useRef<{ boundaryId: string; count: number } | null>(null);
  const [backfillPulse, setBackfillPulse] = useState(0);
  // A forward read settled; its rows may need revealing with no scroll to do it.
  const [newerPulse, setNewerPulse] = useState(0);
  const pinBottomRef = useRef(true);
  const pendingJumpRef = useRef<{ id: string; focus: boolean } | null>(null);
  // A landed jump: re-centered instead of anchor-restored until the reader's next gesture.
  const jumpHoldRef = useRef<{ id: string; until: number } | null>(null);
  // Persistent so it survives React 19 interrupted renders and async row resizes.
  const readingAnchorRef = useRef<ScrollAnchor | null>(null);
  // Distinguishes the reader moving up from our own downward scrolls.
  const lastScrollTopRef = useRef(Number.POSITIVE_INFINITY);
  // A slice change that leaves the reader at the top emits no further upward
  // scroll, so re-check next frame (one rAF per burst). `maybeExtendRef` breaks
  // the declaration-order cycle.
  const continueRafRef = useRef<number | null>(null);
  /** Reveal steps chained since the reader last scrolled up. */
  const chainedRevealsRef = useRef(0);
  const maybeExtendRef = useRef<() => void>(() => {});

  const listVisible = !isLoading && !transientEmpty && timelineEntries.length > 0;
  // The scroller remounts at `scrollTop: 0` after the skeleton, so the next
  // layout must pin (`messages` often arrives before `isLoading` clears).
  if (!listVisible) pinBottomRef.current = true;

  const [showJumpPill, setShowJumpPill] = useState(false);
  // "Jump to unread": shown while the NEW divider sits above the viewport (or
  // outside the rendered window), until the reader reaches it once.
  const [showUnreadPill, setShowUnreadPill] = useState(false);
  const reachedDividerRef = useRef<string | undefined>(undefined);
  const dividerIdRef = useRef(newDividerId);
  dividerIdRef.current = newDividerId;
  const checkUnreadPill = useCallback(() => {
    const id = dividerIdRef.current;
    const el = scrollRef.current;
    if (!id || !el || reachedDividerRef.current === id) {
      setShowUnreadPill(false);
      return;
    }
    const row = contentRef.current?.querySelector<HTMLElement>('[data-scroll-anchor="unread-divider"]');
    if (row && row.getBoundingClientRect().top >= el.getBoundingClientRect().top) {
      reachedDividerRef.current = id;
      setShowUnreadPill(false);
      return;
    }
    setShowUnreadPill(true);
  }, []);

  // Oldest message currently rendered. `null` = the newest INITIAL_WINDOW.
  const [windowStartId, setWindowStartId] = useState<string | null>(null);
  const windowStartIdRef = useRef<string | null>(null);
  windowStartIdRef.current = windowStartId;

  const setWindowStart = useCallback((id: string | null) => {
    windowStartIdRef.current = id;
    setWindowStartId(id);
  }, []);
  const revealFrom = useCallback((id: string) => {
    windowStartIdRef.current = id;
    setWindowStartId(id);
  }, []);

  const [rampStep, setRampStep] = useState(0);

  // Resolved over the ENTRY stream (Git rows included); a folded flood counts
  // as ONE row so spam can't spend the whole window.
  const { startIndex, anchorLost } = useMemo(
    () =>
      resolveWindowStart(timelineEntries, windowStartId, OPENING_RAMP[rampStep], (entry) =>
        entry.type === "chat" ? !!quarantinedIds?.has(entry.message.id) : false,
      ),
    [timelineEntries, windowStartId, rampStep, quarantinedIds],
  );
  const startIndexRef = useRef(startIndex);
  startIndexRef.current = startIndex;

  // Newest message currently rendered. `null` = the newest loaded.
  const [windowEndId, setWindowEndId] = useState<string | null>(null);
  const endIndex = useMemo(
    () => resolveWindowEnd(timelineEntries, windowEndId, startIndex, MAX_WINDOW, (entry) =>
      entry.type === "chat" ? !!quarantinedIds?.has(entry.message.id) : false,
    ),
    [timelineEntries, windowEndId, startIndex, quarantinedIds],
  );
  const endIndexRef = useRef(endIndex);
  endIndexRef.current = endIndex;

  const isFolded = useCallback(
    (entry: ChannelTimelineEntry) =>
      entry.type === "chat" && Boolean(quarantinedIdsRef.current?.has(entry.message.id)),
    [],
  );

  /** Distance from the newest message: the scroller's bottom, unless rows are unrendered or unread below it. */
  const readerDistance = useCallback(
    (el: HTMLElement) =>
      distanceFromBottom(el) +
      (endIndexRef.current < entriesRef.current.length || hasNewerRef.current ? UNRENDERED_BELOW_PX : 0),
    [],
  );

  // Continuation is computed against the entry before the window so the top row
  // doesn't change shape as it grows.
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    const runOf = new Map<string, string>();
    /**
     * Foldable into a flood run? Not the "NEW" divider's target (must stay visible)
     * nor a key-rotation boundary (folding would delete the rotation line).
     */
    const floodable = (entry: ChannelTimelineEntry | undefined) =>
      !!entry &&
      entry.type === "chat" &&
      !!quarantinedIds?.has(entry.message.id) &&
      newDividerId !== entry.message.id &&
      !rotationDividerIds?.has(entry.message.id);
    const byRule = (id: string) => Boolean(pausedIds?.has(id) || ruledIds?.has(id));

    for (let i = startIndex; i < endIndex; i++) {
      const entry = timelineEntries[i];
      const prev = timelineEntries[i - 1];
      const newDay = !!prev && !isSameDay(prev.createdAt, entry.createdAt);

      // A run breaks on any other message, on a day boundary, and where a
      // pause or permission collapse meets a flood: those fold even one at a time.
      if (floodable(entry) && entry.type === "chat") {
        const ruledHere = byRule(entry.message.id);
        const run: ChatMsg[] = [];
        let j = i;
        for (; j < endIndex; j++) {
          const at = timelineEntries[j];
          if (!floodable(at) || at.type !== "chat" || byRule(at.message.id) !== ruledHere) break;
          if (j > i && !isSameDay(timelineEntries[j - 1].createdAt, at.createdAt)) break;
          run.push(at.message);
        }
        if (run.length >= (ruledHere ? 1 : FLOOD_ROW_MIN)) {
          const headKey = run[0].renderKey ?? run[0].id;
          const key = `flood-${headKey}`;
          if (newDay) out.push({ type: "date", ts: entry.createdAt, key: `date-${headKey}` });
          for (const m of run) runOf.set(m.id, key);
          out.push({
            type: "flood",
            msgs: run,
            authors: new Set(run.map((m) => m.pubkey)).size,
            // Pause wording only when the WHOLE run is pause-collapsed.
            reason: !ruledHere ? "flood" : run.every((m) => pausedIds?.has(m.id) ?? false) ? "paused" : "ruled",
            key,
          });
          i = j - 1;
          continue;
        }
      }
      // Absorbed into the previous Git row's group, unless it opens the window
      // (its head would be outside the slice).
      if (i > startIndex && !newDay && isGitContinuation(prev, entry)) continue;
      // `renderKey` keeps optimistic rows from remounting when they adopt the signed id.
      const rowKey = entry.type === "chat" ? entry.message.renderKey ?? entry.message.id : entry.id;
      if (newDay) out.push({ type: "date", ts: entry.createdAt, key: `date-${rowKey}` });
      if (entry.type === "chat") {
        if (rotationDividerIds?.has(entry.message.id)) {
          out.push({ type: "rotation", key: `rotation-${rowKey}` });
        }
        if (newDividerId === entry.message.id) out.push({ type: "unread", key: "unread-divider" });
        const continuation =
          !!prev &&
          prev.type === "chat" &&
          !newDay &&
          prev.message.pubkey === entry.message.pubkey &&
          entry.createdAt - prev.createdAt < CONTINUATION_WINDOW_SECONDS;
        out.push({ type: "message", msg: entry.message, continuation, key: rowKey });
      } else {
        if (newDividerId === entry.id) out.push({ type: "unread", key: "unread-divider" });
        out.push({
          type: "entry",
          entry,
          related: relatedGitEntries(timelineEntries, i, entry),
          key: rowKey,
        });
      }
    }
    // Assigned during render so it never lags the rows by a commit.
    floodRunOfRef.current = runOf;
    return out;
  }, [timelineEntries, startIndex, endIndex, newDividerId, rotationDividerIds, quarantinedIds, pausedIds, ruledIds]);

  const captureReadingAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || distanceRef.current <= AT_BOTTOM_PX) {
      readingAnchorRef.current = null;
      return;
    }
    // Ignore WebKit rubber-band positions outside the real scroll range.
    if (scroller.scrollTop !== clampedScrollTop(scroller)) return;
    readingAnchorRef.current = captureScrollAnchor(scroller, content, readingAnchorRef.current);
  }, []);

  const restoreReadingAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const anchor = readingAnchorRef.current;
    if (!scroller || !content || !anchor) return false;
    if (!restoreScrollAnchor(scroller, content, anchor)) {
      readingAnchorRef.current = null;
      return false;
    }
    distanceRef.current = readerDistance(scroller);
    lastScrollTopRef.current = clampedScrollTop(scroller);
    return true;
  }, [readerDistance]);

  /**
   * Re-center a held jump target. Rows above it settle from their intrinsic-size
   * estimate, media resolves and reveals land after the jump, so the reading
   * anchor (the viewport's top row) would let the target drift. False when no hold.
   */
  const holdJumpTarget = useCallback(() => {
    const hold = jumpHoldRef.current;
    const el = scrollRef.current;
    if (!hold || !el) return false;
    if (performance.now() >= hold.until) {
      jumpHoldRef.current = null;
      return false;
    }
    // Briefly unrendered while a detached run re-renders: keep holding for its return.
    const row = jumpTargetRow(contentRef.current, hold.id);
    if (!row) return false;
    const rowBox = row.getBoundingClientRect();
    const delta = rowBox.top - el.getBoundingClientRect().top - (el.clientHeight - rowBox.height) / 2;
    // Sub-pixel writes are skipped: they cancel iOS momentum.
    if (Math.abs(delta) >= 0.5) el.scrollTop = clampedScrollTop(el) + delta;
    distanceRef.current = readerDistance(el);
    lastScrollTopRef.current = clampedScrollTop(el);
    setShowJumpPill(distanceRef.current > JUMP_PILL_PX);
    captureReadingAnchor();
    return true;
  }, [captureReadingAnchor, readerDistance]);

  /**
   * Reveal older rows from `index`. Past {@link MAX_WINDOW} the newest edge is
   * dropped too — only while the reader is in the reveal band, so the dropped
   * rows are well below the viewport.
   */
  const revealUp = useCallback(
    (index: number) => {
      const all = entriesRef.current;
      const next = all[index];
      if (!next) return false;
      const el = scrollRef.current;
      if (
        el &&
        clampedScrollTop(el) < REVEAL_TRIGGER_PX &&
        countRows(all, index, endIndexRef.current, isFolded) > MAX_WINDOW + TRIM_SLACK
      ) {
        setWindowEndId(all[stepForwardRows(all, index, MAX_WINDOW, isFolded) - 1].id);
      }
      revealFrom(next.id);
      return true;
    },
    [isFolded, revealFrom],
  );

  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    distanceRef.current = 0;
    lastScrollTopRef.current = clampedScrollTop(el);
    readingAnchorRef.current = null;
    jumpHoldRef.current = null;
    setShowJumpPill(false);
  }, []);

  /** Hold the reader's distance from the bottom across height changes (pins only at the bottom). */
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (distanceRef.current > AT_BOTTOM_PX) return;
    el.scrollTop = el.scrollHeight - el.clientHeight - distanceRef.current;
    lastScrollTopRef.current = clampedScrollTop(el);
    readingAnchorRef.current = null;
  }, []);

  const jumpToRow = useCallback((id: string, focus = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const settle = () => {
      const row = jumpTargetRow(contentRef.current, id);
      if (!row) return;
      if (id !== UNREAD_DIVIDER_TARGET) flashRow(row, focus);
      jumpHoldRef.current = { id, until: performance.now() + JUMP_HOLD_MS };
      // A jump into a detached run lands after its loading skeleton, which asked
      // for a pin to the bottom; the jump supersedes it.
      pinBottomRef.current = false;
      holdJumpTarget();
    };
    if (jumpTargetRow(contentRef.current, id)) {
      settle();
      return;
    }
    // Folded under a flood row: open it and jump next frame.
    const runKey = floodRunOfRef.current.get(id);
    if (!runKey) return;
    setExpandedFloods((prev) => (prev.has(runKey) ? prev : new Set(prev).add(runKey)));
    requestAnimationFrame(settle);
  }, [holdJumpTarget]);

  // The one place scroll is adjusted for a rendered-slice change; exactly one
  // branch applies, in priority order.
  useLayoutEffect(() => {
    extendLockRef.current = false;
    const el = scrollRef.current;
    if (!el || items.length === 0) return;
    if (anchorLost) {
      // The anchor message is gone (different conversation): fall back to the
      // newest, pinned. Before paint, so no flash.
      readingAnchorRef.current = null;
      jumpHoldRef.current = null;
      pinBottomRef.current = true;
      setRampStep(0);
      setWindowStart(null);
      setWindowEndId(null);
      return;
    }
    const jump = pendingJumpRef.current;
    if (jump) {
      pendingJumpRef.current = null;
      readingAnchorRef.current = null;
      pinBottomRef.current = false;
      jumpToRow(jump.id, jump.focus);
      return;
    }
    const backfill = backfillRevealRef.current;
    if (backfill) {
      // The boundary entry can vanish in the same commit (expiry, delete); fall back
      // to the slice top rather than stranding a reader at scrollTop 0.
      const found = timelineEntries.findIndex((entry) => entry.id === backfill.boundaryId);
      const boundaryIndex =
        found >= 0 ? found : timelineEntries.length > backfill.count ? startIndexRef.current : -1;
      if (boundaryIndex > 0) {
        // Restore the old viewport first, then capture afresh for the exposing commit.
        if (distanceRef.current > AT_BOTTOM_PX && !holdJumpTarget()) restoreReadingAnchor();
        captureReadingAnchor();
        const nextIndex = stepBackRows(timelineEntries, boundaryIndex, WINDOW_STEP, isFolded);
        backfillRevealRef.current = null;
        if (revealUp(nextIndex)) return;
      } else if (!loadingOlderRef.current) {
        // Empty/duplicate/error page. The pulse in finally guarantees this render.
        backfillRevealRef.current = null;
      }
    }
    if (pinBottomRef.current) {
      pinBottomRef.current = false;
      readingAnchorRef.current = null;
      pinToBottomNow();
      return;
    }
    // A held jump target wins even at the bottom: a detached run ends at it, and
    // sticking to the bottom while newer rows load would push it out of view.
    if (holdJumpTarget() || (distanceRef.current > AT_BOTTOM_PX && restoreReadingAnchor())) {
      // Scrolled up near the top with no gesture coming: re-check next frame.
      // Self-limiting (no-op outside the trigger band).
      if (continueRafRef.current == null) {
        continueRafRef.current = requestAnimationFrame(() => {
          continueRafRef.current = null;
          const el = scrollRef.current;
          if (!el) return;
          if (chainedRevealsRef.current >= MAX_CHAINED_REVEALS && clampedScrollTop(el) >= CHAIN_FLOOR_PX) return;
          chainedRevealsRef.current += 1;
          maybeExtendRef.current();
        });
      }
      return;
    }
    stickToBottom();
    // `listVisible`: the scroller this effect moves may only just have mounted.
  }, [items, listVisible, anchorLost, timelineEntries, backfillPulse, captureReadingAnchor, setWindowStart, isFolded, revealUp, jumpToRow, pinToBottomNow, holdJumpTarget, restoreReadingAnchor, stickToBottom]);

  // Content growth and container reflows (thread panel, composer swap) land here.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let viewportHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (pinBottomRef.current || pendingJumpRef.current) return;
      const resized = el.clientHeight !== viewportHeight;
      viewportHeight = el.clientHeight;
      if (holdJumpTarget()) return;
      if (distanceRef.current > AT_BOTTOM_PX) restoreReadingAnchor();
      else if (resized && distanceRef.current > 1) {
        // The pane resized under a reader just short of the bottom (the composer
        // grew a line): keep what they're reading still rather than shifting it.
        distanceRef.current = readerDistance(el);
        lastScrollTopRef.current = clampedScrollTop(el);
        setShowJumpPill(distanceRef.current > JUMP_PILL_PX);
        captureReadingAnchor();
      } else stickToBottom();
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [listVisible, captureReadingAnchor, readerDistance, holdJumpTarget, restoreReadingAnchor, stickToBottom]);

  // Any reader input ends a jump hold; our own scroll writes emit only `scroll`.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const release = () => {
      jumpHoldRef.current = null;
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of events) el.addEventListener(type, release, { passive: true });
    return () => {
      for (const type of events) el.removeEventListener(type, release);
    };
  }, [listVisible]);

  /**
   * Near the top: reveal loaded messages, else request an older page. Only when
   * away from the bottom, so a fresh conversation doesn't walk its own history.
   */
  const maybeExtend = useCallback(() => {
    const el = scrollRef.current;
    if (!el || paused || extendLockRef.current) return;
    if (distanceRef.current <= AT_BOTTOM_PX) return;
    const start = startIndexRef.current;
    if (start > 0) {
      if (clampedScrollTop(el) >= REVEAL_TRIGGER_PX) return;
      const nextIndex = stepBackRows(entriesRef.current, start, WINDOW_STEP, isFolded);
      if (!entriesRef.current[nextIndex]) return;
      extendLockRef.current = true;
      captureReadingAnchor();
      revealUp(nextIndex);
      // Fetch the next page while hidden rows remain, so a fling never waits on it at
      // the top. The window is anchored by id, so rows landing above it move nothing.
      if (nextIndex < PREFETCH_ROWS && loadOlder && hasMore && !isLoadingOlder && !loadingOlderRef.current) {
        loadingOlderRef.current = true;
        void loadOlder().finally(() => {
          loadingOlderRef.current = false;
        });
      }
      return;
    }
    if (clampedScrollTop(el) >= BACKFILL_TRIGGER_PX) return;
    if (!loadOlder || !hasMore || isLoadingOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    captureReadingAnchor();
    const boundaryId = entriesRef.current[0]?.id;
    if (boundaryId) {
      backfillRevealRef.current = { boundaryId, count: entriesRef.current.length };
    }
    void loadOlder().finally(() => {
      loadingOlderRef.current = false;
      setBackfillPulse((pulse) => pulse + 1);
    });
  }, [paused, loadOlder, hasMore, isLoadingOlder, captureReadingAnchor, isFolded, revealUp]);

  /**
   * Near the window's bottom while newer loaded rows are unrendered: reveal a
   * step below, dropping the oldest edge past {@link MAX_WINDOW}. Rows added
   * below the reader move nothing; a trim above is restored by the anchor.
   */
  const maybeExtendDown = useCallback(() => {
    const el = scrollRef.current;
    if (!el || paused || extendLockRef.current) return;
    const all = entriesRef.current;
    const end = endIndexRef.current;
    // A detached run reads forward while few loaded rows remain below the window.
    if (
      hasNewer && loadNewer && !isLoadingNewer && !loadingNewerRef.current &&
      all.length - end < PREFETCH_ROWS && distanceFromBottom(el) < BACKFILL_TRIGGER_PX
    ) {
      loadingNewerRef.current = true;
      void loadNewer()
        .catch(() => 0)
        .finally(() => {
          loadingNewerRef.current = false;
          setNewerPulse((pulse) => pulse + 1);
        });
    }
    if (end >= all.length) return;
    if (distanceFromBottom(el) >= REVEAL_TRIGGER_PX) return;
    const nextEnd = stepForwardRows(all, end, WINDOW_STEP, isFolded);
    extendLockRef.current = true;
    captureReadingAnchor();
    if (countRows(all, startIndexRef.current, nextEnd, isFolded) > MAX_WINDOW + TRIM_SLACK) {
      setWindowStart(all[stepBackRows(all, nextEnd, MAX_WINDOW, isFolded)].id);
    }
    setWindowEndId(nextEnd >= all.length ? null : all[nextEnd - 1].id);
  }, [paused, captureReadingAnchor, isFolded, setWindowStart, hasNewer, loadNewer, isLoadingNewer]);
  // Called via ref from the earlier-declared layout effect. Cancel on unmount.
  maybeExtendRef.current = maybeExtend;

  // Rows read forward land below the window, where a reader already at the
  // bottom has no further scroll to reveal them: check after every change.
  useEffect(() => {
    if (!listVisible || !loadNewer) return;
    const frame = requestAnimationFrame(() => maybeExtendDown());
    return () => cancelAnimationFrame(frame);
  }, [listVisible, loadNewer, timelineEntries, endIndex, hasNewer, newerPulse, maybeExtendDown]);

  // While detached, the window ends at its last row so rows read forward are
  // revealed a step at a time rather than mounted in one commit.
  useEffect(() => {
    if (!hasNewer || windowEndId !== null || timelineEntries.length === 0) return;
    setWindowEndId(timelineEntries[timelineEntries.length - 1].id);
  }, [hasNewer, windowEndId, timelineEntries]);
  useEffect(
    () => () => {
      if (continueRafRef.current != null) cancelAnimationFrame(continueRafRef.current);
    },
    [],
  );

  // Extend while the slice doesn't fill the scroller (e.g. a folded flood), since
  // there's no scroll gesture to trigger it. One step per commit. Measured in the
  // next frame: reading `scrollHeight` in the effect would force an extra layout.
  useEffect(() => {
    if (!listVisible || paused) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      // Zero height (not laid out, or tests) isn't underfilled.
      if (!el || el.clientHeight === 0) return;
      if (el.scrollHeight > el.clientHeight + AT_BOTTOM_PX) return;
      if (startIndexRef.current > 0) {
        const nextIndex = stepBackRows(entriesRef.current, startIndexRef.current, WINDOW_STEP, isFolded);
        if (entriesRef.current[nextIndex]) {
          captureReadingAnchor();
          revealUp(nextIndex);
        }
        return;
      }
      if (!loadOlder || !hasMore || isLoadingOlder || loadingOlderRef.current) return;
      // A transport that never reports the end must not page (and spin) forever.
      const oldestId = entriesRef.current[0]?.id;
      const dry = underfillDryRef.current;
      if (dry.oldestId !== oldestId) underfillDryRef.current = { oldestId, count: 0 };
      else if (dry.count >= UNDERFILL_DRY_LIMIT) return;
      loadingOlderRef.current = true;
      captureReadingAnchor();
      void loadOlder()
        .then((added) => {
          const cur = underfillDryRef.current;
          if (cur.oldestId !== oldestId) return;
          underfillDryRef.current = { oldestId, count: added > 0 ? 0 : cur.count + 1 };
        })
        .catch(() => undefined)
        .finally(() => {
          loadingOlderRef.current = false;
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [items, listVisible, paused, loadOlder, hasMore, isLoadingOlder, captureReadingAnchor, isFolded, revealUp]);

  // Older-history paging surfaces through the header's sync indicator, not an overlay.
  useEffect(() => {
    if (!isLoadingOlder) return;
    const task = beginSyncTask("older messages");
    return () => task.end();
  }, [isLoadingOlder]);
  useEffect(() => {
    if (!isLoadingNewer) return;
    const task = beginSyncTask("newer messages");
    return () => task.end();
  }, [isLoadingNewer]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only the reader moving up leaves the bottom; our own scrolls record their
    // offsets, so we don't react to ourselves.
    const top = clampedScrollTop(el);
    const movingUp = top < lastScrollTopRef.current;
    const movingDown = top > lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    // Growth below the fold raises distance without a scroll; scroll events lag a
    // frame, so only count growth when the reader moved, or stick-to-bottom latches off.
    const distance = readerDistance(el);
    if (movingUp || distance <= distanceRef.current) distanceRef.current = distance;
    setShowJumpPill(distanceRef.current > JUMP_PILL_PX);
    checkUnreadPill();
    if (el.scrollTop === top) captureReadingAnchor();
    if (movingUp) {
      chainedRevealsRef.current = 0;
      maybeExtend();
    } else if (movingDown) maybeExtendDown();
  }, [captureReadingAnchor, readerDistance, maybeExtend, maybeExtendDown, checkUnreadPill]);

  // After the pin-to-bottom layout settles, so a divider already in view counts as reached.
  useEffect(() => {
    const frame = requestAnimationFrame(checkUnreadPill);
    return () => cancelAnimationFrame(frame);
  }, [items, newDividerId, listVisible, checkUnreadPill]);

  // Let rows that have been laid out once be skipped offscreen (`.timeline-row`).
  // Two frames: the size `contain-intrinsic-size: auto` remembers is recorded
  // after the layout that follows the commit. Not React-managed, so it persists.
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        for (const row of contentRef.current?.querySelectorAll(":scope > .timeline-row:not([data-settled])") ?? []) {
          row.setAttribute("data-settled", "");
        }
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [items, expandedFloods]);

  // Rows land above a bottom-pinned reader, so nothing moves.
  useEffect(() => {
    if (rampStep >= OPENING_RAMP.length - 1 || timelineEntries.length === 0) return;
    const frame = requestAnimationFrame(() => setRampStep((step) => step + 1));
    return () => cancelAnimationFrame(frame);
  }, [rampStep, timelineEntries.length]);

  // Back at the bottom: trim to the newest (bounds a long session's DOM).
  useEffect(() => {
    if (distanceRef.current > AT_BOTTOM_PX) return;
    if (timelineEntries.length - startIndex <= TRIM_ABOVE) return;
    setWindowStart(null);
  }, [timelineEntries, startIndex, setWindowStart]);

  // Moves the window first if the target is outside it, keeping it bounded.
  /** Jump to the row `target` names, at entry `index` (entry-space), moving the window there first. */
  const jumpToEntry = useCallback(
    (index: number, target: string, focus: boolean) => {
      const all = entriesRef.current;
      if (index < startIndexRef.current || index >= endIndexRef.current) {
        pendingJumpRef.current = { id: target, focus };
        const from = Math.max(0, index - JUMP_CONTEXT);
        const to = stepForwardRows(all, from, MAX_WINDOW, isFolded);
        setWindowStart(all[from].id);
        setWindowEndId(to >= all.length ? null : all[to - 1].id);
        return;
      }
      jumpToRow(target, focus);
    },
    [jumpToRow, isFolded, setWindowStart],
  );

  const scrollToMessage = useCallback(
    (id: string, focus = false) => {
      // Entry-space indexes; callers jump by message id.
      const index = entriesRef.current.findIndex((entry) => entry.type === "chat" && entry.message.id === id);
      if (index === -1) return false;
      jumpToEntry(index, id, focus);
      return true;
    },
    [jumpToEntry],
  );

  const jumpToUnread = useCallback(() => {
    const id = dividerIdRef.current;
    // The divider names a message id for chat and an entry id otherwise (see `items`).
    const index = id ? entriesRef.current.findIndex((entry) => (entry.type === "chat" ? entry.message.id : entry.id) === id) : -1;
    if (index === -1) return;
    reachedDividerRef.current = id;
    setShowUnreadPill(false);
    jumpToEntry(index, UNREAD_DIVIDER_TARGET, false);
  }, [jumpToEntry]);

  /** Back to the newest message; a window ending above it is re-anchored there first. */
  const returnToPresent = useCallback(() => {
    distanceRef.current = 0;
    if (hasNewerRef.current) leaveDetachedRun?.();
    if (endIndexRef.current >= entriesRef.current.length && !hasNewerRef.current) {
      pinToBottomNow();
      return;
    }
    readingAnchorRef.current = null;
    pinBottomRef.current = true;
    setShowJumpPill(false);
    setWindowStart(null);
    setWindowEndId(null);
  }, [pinToBottomNow, setWindowStart, leaveDetachedRun]);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToMessage,
      pinToBottom: returnToPresent,
      maintainBottom: stickToBottom,
    }),
    [scrollToMessage, returnToPresent, stickToBottom],
  );

  return (
    <div className={cn("relative flex flex-col", className)}>
      {isLoading || transientEmpty ? (
        <TimelineSkeleton />
      ) : timelineEntries.length === 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4">
          {/* A running catch-up isn't "no messages" yet; persistent failure wins over
              the spinner (backoff alternates states). Empty relay reads also come here,
              so don't diagnose a connection failure. */}
          {syncFailed ? (
            <p className="flex items-center justify-center gap-2 px-2 py-8 text-center text-sm text-muted-foreground">
              <MessagesSquare className="size-4 shrink-0" aria-hidden />
              <FormattedMessage
                id="messageTimeline.noMessagesYet"
                defaultMessage="No messages loaded yet. We’ll keep checking the relays for history in the background…"
              />
            </p>
          ) : syncing ? (
            <p className="flex items-center justify-center gap-2 px-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin shrink-0" />
              <FormattedMessage id="messageTimeline.catchingUp" defaultMessage="Catching up…" />
            </p>
          ) : (
            emptyState ?? null
          )}
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain [overflow-anchor:none] scrollbar-stable px-3"
          >
            {/* Positioned, so every row's `offsetTop` is measured against it. */}
            <div ref={contentRef} className="relative">
              <div className="h-4" aria-hidden />
              {items.map((item) => (
                // `hover:z-10` keeps the overhanging toolbar above the previous row.
                <div
                  key={item.key}
                  data-scroll-anchor={item.key}
                  className="timeline-row relative hover:z-10 focus-within:z-10"
                >
                  {item.type === "date" ? (
                    <DateSeparator ts={item.ts} />
                  ) : item.type === "unread" ? (
                    <NewMessagesDivider />
                  ) : item.type === "rotation" ? (
                    <KeyRotationDivider />
                  ) : item.type === "flood" ? (
                    <>
                      <FloodNotice
                        count={item.msgs.length}
                        authors={item.authors}
                        reason={item.reason}
                        expanded={expandedFloods.has(item.key)}
                        onToggle={() => toggleFlood(item.key)}
                      />
                      {expandedFloods.has(item.key) &&
                        item.msgs.map((msg) => (
                          <div key={msg.renderKey ?? msg.id} className="relative">
                            {renderMessage(msg, false)}
                          </div>
                        ))}
                    </>
                  ) : item.type === "entry" ? (
                    renderEntry?.(item.entry, item.related)
                  ) : (
                    renderMessage(item.msg, item.continuation)
                  )}
                </div>
              ))}
              <div className="h-4" aria-hidden />
            </div>
          </div>
          {showUnreadPill && (
            <div className="absolute top-3 inset-x-0 z-10 flex justify-center pointer-events-none">
              <button
                type="button"
                onClick={jumpToUnread}
                className="pointer-events-auto inline-flex items-center gap-2 clip-corner-lg bg-primary/90 backdrop-blur px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary transition-colors"
              >
                <ChevronUp className="size-4" />
                <FormattedMessage id="messageTimeline.jumpToUnread" defaultMessage="Jump to unread" />
              </button>
            </div>
          )}
          {showJumpPill && (
            <div className="absolute bottom-3 inset-x-0 z-10 flex justify-center pointer-events-none">
              <button
                type="button"
                onClick={returnToPresent}
                className="pointer-events-auto inline-flex items-center gap-2 clip-corner-lg bg-secondary/90 backdrop-blur px-5 py-2.5 text-sm font-medium text-foreground shadow-lg hover:bg-secondary transition-colors"
                aria-label={intl.formatMessage({
                  id: "messageTimeline.jumpToLatest",
                  defaultMessage: "Jump to the latest messages",
                })}
              >
                <ChevronDown className="size-4" />
                <FormattedMessage id="messageTimeline.jumpToPresent" defaultMessage="Jump to present" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
