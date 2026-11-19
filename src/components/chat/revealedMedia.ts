/**
 * What the reader chose to load this session under the media hold (`mediaHold.ts`):
 * message ids. Shared, so a message loaded in the timeline stays
 * loaded across a remount, in its forum tile and in replies quoting it. Cleared on
 * logout, so the next account inherits none of it.
 */
const messages = new Set<string>();
const listeners = new Set<() => void>();

export function subscribeRevealed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const l of listeners) l();
}

export function isMessageRevealed(id: string | undefined): boolean {
  return Boolean(id && messages.has(id));
}

export function revealMessageMedia(id: string): void {
  if (messages.has(id)) return;
  messages.add(id);
  notify();
}

export function hideMessageMedia(id: string): void {
  if (messages.delete(id)) notify();
}

export function clearRevealedMedia(): void {
  messages.clear();
  notify();
}
