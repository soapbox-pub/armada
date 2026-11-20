import { cloneElement, useRef, type ReactElement, type ReactNode } from "react";

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
