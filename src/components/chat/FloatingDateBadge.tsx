import { useContext, useEffect, useState, type RefObject } from "react";

import { formatDayLabel } from "@/components/chat/dayLabel";
import { AppContext } from "@/contexts/AppContext";
import { useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** How long the badge stays after the last scroll. */
const IDLE_MS = 1000;

/**
 * A scroll counts as the reader's within this long of their input. Once shown, any
 * scroll keeps it up, so touch momentum does too; our own scroll writes (stick to
 * bottom, anchor restores) never raise it.
 */
const INPUT_WINDOW_MS = 600;

/** The line, below the scroller's top, whose row's day the badge names. */
const BADGE_LINE_PX = 40;

/** A day separator this close above the line is already naming the day there. */
const SEPARATOR_BAND_PX = 64;

const INPUT_EVENTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;

/**
 * The day of the row under the badge, or null when there's none or a day separator
 * is already showing it there. Rows are the content's children (`data-ts` on the
 * dated ones), in order, so their `offsetTop`s ascend.
 */
function dayUnderBadge(scroller: HTMLElement, content: HTMLElement): number | null {
  const line = scroller.getBoundingClientRect().top + BADGE_LINE_PX - content.getBoundingClientRect().top;
  const rows = content.children as HTMLCollectionOf<HTMLElement>;
  let lo = 0;
  let hi = rows.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].offsetTop <= line) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = Math.max(0, at - 1); i <= at + 1 && i < rows.length; i++) {
    const top = rows[i].offsetTop;
    if (rows[i].dataset.dayStart !== undefined && top >= line - SEPARATOR_BAND_PX && top <= line) return null;
  }
  for (let i = Math.max(0, at); i < rows.length; i++) {
    const ts = rows[i].dataset.ts;
    if (ts) return Number(ts);
  }
  return null;
}

/** Midnight of `ts`'s local day, so state only changes when the day does. */
function startOfDay(ts: number): number {
  const date = new Date(ts * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/** Still within the screenful the conversation opened on. */
function onFirstPage(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < scroller.clientHeight;
}

/**
 * Today or yesterday: on the opening screenful their separator and the message
 * times already say so, so the badge waits until the reader is further up.
 */
function isRecent(ts: number): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  return ts >= Math.floor(yesterday.getTime() / 1000);
}

/**
 * The date of the messages in view, floated over the timeline while the reader
 * scrolls. Listens to the scroller itself, so scrolling re-renders only this.
 */
export function FloatingDateBadge({
  scrollRef,
  contentRef,
  belowPill,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** "Jump to unread" holds the top spot. */
  belowPill: boolean;
}) {
  const intl = useIntl();
  const enabled = useContext(AppContext)?.config.floatingDates ?? true;
  const [day, setDay] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!enabled || !scroller) return;
    let inputAt = Number.NEGATIVE_INFINITY;
    let shown = false;
    let frame = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const input = () => {
      inputAt = performance.now();
    };
    const hide = () => {
      shown = false;
      setVisible(false);
    };
    const update = () => {
      frame = 0;
      const content = contentRef.current;
      const ts = content ? dayUnderBadge(scroller, content) : null;
      if (ts === null || (onFirstPage(scroller) && isRecent(ts))) {
        setVisible(false);
        return;
      }
      setDay(startOfDay(ts));
      setVisible(true);
    };
    const onScroll = () => {
      if (!shown && performance.now() - inputAt > INPUT_WINDOW_MS) return;
      shown = true;
      clearTimeout(idle);
      idle = setTimeout(hide, IDLE_MS);
      if (!frame) frame = requestAnimationFrame(update);
    };

    for (const type of INPUT_EVENTS) scroller.addEventListener(type, input, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      for (const type of INPUT_EVENTS) scroller.removeEventListener(type, input);
      scroller.removeEventListener("scroll", onScroll);
      clearTimeout(idle);
      cancelAnimationFrame(frame);
      setVisible(false);
    };
  }, [enabled, scrollRef, contentRef]);

  if (!enabled || day === null) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex justify-center transition-opacity duration-300",
        belowPill ? "top-16" : "top-2",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <span className="clip-corner bg-background/85 backdrop-blur px-3 py-1 text-xs font-medium text-muted-foreground shadow-md select-none">
        {formatDayLabel(day, intl)}
      </span>
    </div>
  );
}
