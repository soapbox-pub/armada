import { useCallback, useEffect } from "react";

/** How long after a keystroke into a text field a press elsewhere counts as stray. */
export const STRAY_PRESS_MS = 1000;

let lastTypedAt = 0;
let listeners = 0;

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el.isContentEditable || !!el.closest("[contenteditable]:not([contenteditable='false'])");
}

// Capture, so a field's own handler stopping propagation can't hide the keystroke.
function onKeyDown(e: KeyboardEvent) {
  // Tab is deliberate navigation: what it lands on may be pressed straight away.
  if (e.key === "Tab") {
    lastTypedAt = 0;
    return;
  }
  if (isTextField(e.target)) lastTypedAt = Date.now();
}

/**
 * Whether the user was typing into a text field within the last `windowMs`.
 * A press then on an irreversible control is a palm on the touchpad or a key
 * landing on a focused button, not a decision.
 */
export function useTypedRecently(windowMs = STRAY_PRESS_MS): () => boolean {
  useEffect(() => {
    if (listeners++ === 0) document.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (--listeners === 0) {
        document.removeEventListener("keydown", onKeyDown, true);
        lastTypedAt = 0;
      }
    };
  }, []);
  return useCallback(() => lastTypedAt > 0 && Date.now() - lastTypedAt < windowMs, [windowMs]);
}
