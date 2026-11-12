import { useEffect, useMemo, useRef, useState } from "react";

import type { RefObject } from "react";

/**
 * `order` as it stood while the list was last at its top: a row only moves when the
 * reader is at the top. Names resolve as rows scroll into view, and re-sorting
 * them then would pull the rows being read out from under the reader. New entries
 * go at the end and departed ones drop out.
 */
export function useOrderHeldOffTop(order: readonly string[], scrollRef: RefObject<HTMLDivElement | null>): readonly string[] {
  const [atTop, setAtTop] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setAtTop(el.scrollTop <= 0);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);
  const held = useRef(order);
  const shown = useMemo(() => {
    if (atTop) return order;
    const present = new Set(order);
    const kept = held.current.filter((pk) => present.has(pk));
    const keptSet = new Set(kept);
    const added = order.filter((pk) => !keptSet.has(pk));
    const next = added.length > 0 ? [...kept, ...added] : kept;
    return next.length === held.current.length && next.every((pk, i) => pk === held.current[i]) ? held.current : next;
  }, [order, atTop]);
  held.current = shown;
  return shown;
}
