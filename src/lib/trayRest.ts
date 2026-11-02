/**
 * Desktop: while the window is hidden to the tray or minimized, the app rests.
 * The renderer is still the notification service (background throttling is
 * off so its sockets and timers keep up), so live subscriptions and ingest go
 * on; what stops is work nobody is looking at — the sync scheduler's catch-up
 * and history rounds, and CSS animations (`data-resting` on `<html>`, read by
 * `index.css`), which otherwise keep producing frames for a hidden window.
 */
import { onDesktopWindowVisibility } from "@/lib/desktop";

/** Grace before resting, so a quick minimize-and-back doesn't abort a round. */
const REST_AFTER_MS = 10_000;

let resting = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (resting === next) return;
  resting = next;
  if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-resting", next);
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener must never break the others.
    }
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  onDesktopWindowVisibility((visible) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (visible) set(false);
    else timer = setTimeout(() => set(true), REST_AFTER_MS);
  });
}

/** Whether the desktop window is out of sight and the app is resting. */
export function isTrayResting(): boolean {
  install();
  return resting;
}

/** Subscribe to rest flips. Returns an unsubscribe. */
export function onTrayRest(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
