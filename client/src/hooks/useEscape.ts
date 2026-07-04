import { useEffect } from "react";

/**
 * Call `onEscape` when the Escape key is pressed. Pass `enabled: false` to
 * temporarily suppress it (e.g. while a modal action is mid-flight).
 */
export function useEscape(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onEscape, enabled]);
}
