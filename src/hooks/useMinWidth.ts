import { useCallback, useRef, useState } from "react";

/** Whether the attached element is at least `min` px wide, re-read as it resizes. */
export function useMinWidth(min: number) {
  const [wide, setWide] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const attach = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el) return;
      setWide(el.getBoundingClientRect().width >= min);
      observer.current = new ResizeObserver((entries) => setWide((entries[0]?.contentRect.width ?? 0) >= min));
      observer.current.observe(el);
    },
    [min],
  );
  return [wide, attach] as const;
}
