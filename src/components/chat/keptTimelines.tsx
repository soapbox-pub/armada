import { cloneElement, useCallback, useContext, useLayoutEffect, useReducer, useRef, type ReactElement, type ReactNode } from "react";

import { MediaHoldContext } from "@/components/chat/mediaHold";

import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import type { AppScope } from "@/contexts/AppsContext";

/** Channels whose timelines stay mounted, the shown one included. */
const KEPT_TIMELINES = 3;

/** The kept timelines, and a way to drop one (unmounting it). */
export interface KeptTimelineSet {
  kept: ReadonlyMap<string, ReactElement>;
  drop: (id: string) => void;
}

/**
 * The last {@link KEPT_TIMELINES} channels' timeline elements, the active one current.
 * One that stops being active is re-rendered once `paused`, then never again until
 * it's shown: the same element is skipped by React, so a hidden timeline costs no
 * render. `onEvict` hears a dropped channel.
 */
export function useKeptTimelines(
  active: string | undefined,
  live: ReactElement<{ paused?: boolean }> | null,
  onEvict: (id: string) => void,
): KeptTimelineSet {
  const kept = useRef(new Map<string, ReactElement<{ paused?: boolean }>>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const evict = useRef(onEvict);
  evict.current = onEvict;
  const map = kept.current;
  if (active && live) {
    for (const [id, el] of map) {
      if (id !== active && !el.props.paused) map.set(id, cloneElement(el, { paused: true }));
    }
    // Most recently shown last, so eviction drops the coldest.
    map.delete(active);
    map.set(active, live);
    while (map.size > KEPT_TIMELINES) {
      const oldest = map.keys().next().value!;
      map.delete(oldest);
      onEvict(oldest);
    }
  }
  const drop = useCallback((id: string) => {
    if (!kept.current.delete(id)) return;
    evict.current(id);
    rerender();
  }, []);
  return { kept: map, drop };
}

/**
 * Renders the kept timelines, the active one shown. Each fills the same box whether
 * shown or not, and a hidden one is `content-visibility: hidden` rather than
 * `display: none`: its layout and scroll position survive, so showing it again is a
 * paint, not a style and layout pass over every row. In a FIXED order: moving a
 * mounted timeline in the DOM would cost what keeping it saves. The shown one is
 * stacked above the rest: a skipped box still takes hits on its own area, so a hidden
 * one later in that order would catch every wheel, touch and press meant for it. The
 * stack is isolated, so that order never reaches what lies around the timeline.
 */
export function KeptTimelines({
  active,
  timelines: { kept, drop },
  children,
}: {
  active: string | undefined;
  timelines: KeptTimelineSet;
  children: ReactNode;
}) {
  const boxes = useRef(new Map<string, HTMLDivElement>());
  const shown = useRef(active);
  useLayoutEffect(() => {
    const left = shown.current;
    shown.current = active;
    if (!left || left === active) return;
    const box = boxes.current.get(left);
    if (!box) return;
    // Hidden isn't stopped: a playing clip would go on being heard. An embed can't be
    // paused from here, so its timeline is unmounted as it was before keeping.
    for (const media of box.querySelectorAll<HTMLMediaElement>("video, audio")) media.pause();
    if (box.querySelector("iframe")) drop(left);
  }, [active, drop]);

  if (!active || !kept.has(active)) return <>{children}</>;
  const ref = (id: string) => (el: HTMLDivElement | null) => {
    if (el) boxes.current.set(id, el);
    else boxes.current.delete(id);
  };
  return (
    <div className="relative isolate flex-1 min-h-0">
      {[...kept.keys()].sort().map((id) =>
        id === active ? (
          <div key={id} ref={ref(id)} className="absolute inset-0 z-[1] flex flex-col">
            {children}
          </div>
        ) : (
          // No `inert`: it is inherited, so toggling it restyles every row; skipped
          // contents are already out of focus, find-in-page and the a11y tree. Its own box
          // still hit-tests, and one later in the order would take the shown one's input.
          <div key={id} ref={ref(id)} className="absolute inset-0 flex flex-col pointer-events-none [content-visibility:hidden]">
            {kept.get(id)}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * A kept timeline with its own chat scope: the shell's sits above every kept one, and
 * would re-render the hidden ones on each switch, as the wrong channel. `paused` is
 * handed to the timeline, and freezes the media hold it reads.
 */
export function ScopedTimeline({
  scope,
  paused,
  children,
}: {
  scope: AppScope | undefined;
  paused?: boolean;
  children: ReactElement<{ paused?: boolean }>;
}) {
  // The hold follows the shown channel's trust set; a hidden one keeps its own.
  const hold = useContext(MediaHoldContext);
  const heldHold = useRef(hold);
  if (!paused) heldHold.current = hold;
  return (
    <ChatScopeContext.Provider value={scope}>
      <MediaHoldContext.Provider value={heldHold.current}>
        {paused ? cloneElement(children, { paused: true }) : children}
      </MediaHoldContext.Provider>
    </ChatScopeContext.Provider>
  );
}
