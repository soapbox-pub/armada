/**
 * One IntersectionObserver per root margin, shared by every element watched with
 * it. Chromium does per-observer work on every frame, and a scrolled timeline held
 * an observer per emoji and per animated avatar: hundreds, ~0.6 s of a 14 s fling
 * on a phone. Viewport-rooted only.
 */

type Listener = (entry: IntersectionObserverEntry) => void;

const observers = new Map<string, { observer: IntersectionObserver; listeners: Map<Element, Set<Listener>> }>();

/** Call `listener` with each intersection change of `el`; returns the unsubscribe. */
export function observeIntersection(el: Element, listener: Listener, rootMargin = "0px"): () => void {
  let shared = observers.get(rootMargin);
  if (!shared) {
    const listeners = new Map<Element, Set<Listener>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const l of [...(listeners.get(entry.target) ?? [])]) l(entry);
        }
      },
      { rootMargin },
    );
    shared = { observer, listeners };
    observers.set(rootMargin, shared);
  }
  const { observer, listeners } = shared;
  let set = listeners.get(el);
  if (!set) {
    listeners.set(el, (set = new Set()));
    observer.observe(el);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(el);
    if (!current?.delete(listener) || current.size > 0) return;
    listeners.delete(el);
    observer.unobserve(el);
  };
}
