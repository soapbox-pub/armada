import { cloneElement, useContext, useRef, type ReactElement, type ReactNode } from "react";

import { MediaHoldContext } from "@/components/chat/mediaHold";

import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import type { AppScope } from "@/contexts/AppsContext";

/** Channels whose timelines stay mounted, the shown one included. */
const KEPT_TIMELINES = 3;

/**
 * The last {@link KEPT_TIMELINES} channels' timeline elements, the active one current.
 * One that stops being active is re-rendered once `paused`, then never again until
 * it's shown: the same element is skipped by React, so a hidden timeline costs no
 * render and, `display: none`, no style or layout. `onEvict` hears a dropped channel.
 */
export function useKeptTimelines(
  active: string | undefined,
  live: ReactElement<{ paused?: boolean }> | null,
  onEvict: (id: string) => void,
): ReadonlyMap<string, ReactElement> {
  const kept = useRef(new Map<string, ReactElement<{ paused?: boolean }>>());
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
  return map;
}

/**
 * Renders the kept timelines, the active one shown. In a FIXED order: moving a
 * mounted timeline in the DOM would cost what keeping it saves, and drop its scroll.
 */
export function KeptTimelines({
  active,
  kept,
  children,
}: {
  active: string | undefined;
  kept: ReadonlyMap<string, ReactElement>;
  children: ReactNode;
}) {
  if (!active || !kept.has(active)) return <>{children}</>;
  return (
    <>
      {[...kept.keys()].sort().map((id) => (
        <div key={id} className={id === active ? "contents" : "hidden"}>
          {id === active ? children : kept.get(id)}
        </div>
      ))}
    </>
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
