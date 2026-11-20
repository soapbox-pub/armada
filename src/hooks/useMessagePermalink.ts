import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { chatRoute, parseChatRoute, withoutMessage } from "@/lib/routes";

const MAX_HUNT_PAGES = 8;
/** Frames allowed for a loaded row's surface/ref to become ready. */
const MAX_SCROLL_RETRIES = 4;

/**
 * Consume a `/m/<event id>` permalink. The id stays in the URL, so:
 * - Scroll exactly ONCE per arrival (`doneRef`, reset on `location.key`), not on every new message.
 * - Unresolvable ids (after bounded `loadOlder` paging) are replaced away.
 * - `scope` separates timeline `/m/` from thread `/t/<root>/m/`, so they don't fight over an id.
 * Returns a callback that drops the segment (e.g. on send).
 */
export function useMessagePermalink(opts: {
  messages: readonly { id: string }[];
  isLoading: boolean;
  hasMore?: boolean;
  loadOlder?: () => Promise<unknown>;
  scrollTo: (id: string) => boolean;
  scope?: "timeline" | "thread";
  enabled?: boolean;
  /** The hunt gave up without finding the target (history ended or the page budget ran out). */
  onNotFound?: () => void;
}): () => void {
  const {
    messages,
    isLoading,
    hasMore,
    loadOlder,
    scrollTo,
    scope = "timeline",
    enabled = true,
  } = opts;
  const onNotFoundRef = useRef(opts.onNotFound);
  onNotFoundRef.current = opts.onNotFound;
  const navigate = useNavigate();
  const location = useLocation();
  const route = useMemo(() => parseChatRoute(location.pathname), [location.pathname]);
  const inThread = Boolean(route && route.kind !== "dm" && route.threadRoot);
  const mine = scope === "thread" ? inThread : !inThread;
  const target = mine ? route?.messageId : undefined;

  const pagesRef = useRef(0);
  const scrollRetriesRef = useRef(0);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  // Re-run when a pull settles without changing `messages` (an empty page).
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    pagesRef.current = 0;
    scrollRetriesRef.current = 0;
    doneRef.current = false;
  }, [target, location.key]);

  // `replace` so no Back step re-runs the navigation.
  const clear = useCallback(() => {
    if (!route?.messageId) return;
    navigate(`${chatRoute(withoutMessage(route))}${location.search}${location.hash}`, {
      replace: true,
    });
  }, [route, navigate, location.search, location.hash]);

  useEffect(() => {
    if (!target || !enabled || isLoading || doneRef.current) return;
    if (messages.some((m) => m.id === target)) {
      // Only a timeline that actually accepted the target settles the arrival; the ref may be
      // unavailable during skeletons/switches.
      if (scrollTo(target)) {
        // Keep the segment (it names where the reader is), but don't fire again.
        doneRef.current = true;
        scrollRetriesRef.current = 0;
        return;
      }
      // Bounded retry: a ref may mount later, but a hidden row (muted author) never will.
      if (scrollRetriesRef.current >= MAX_SCROLL_RETRIES) {
        doneRef.current = true;
        clear();
        return;
      }
      // Counts FRAMES this effect requested, so unrelated re-runs while mounting don't spend it.
      const frame = requestAnimationFrame(() => {
        scrollRetriesRef.current += 1;
        setPulse((n) => n + 1);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!hasMore || !loadOlder || pagesRef.current >= MAX_HUNT_PAGES) {
      doneRef.current = true;
      clear();
      onNotFoundRef.current?.();
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    pagesRef.current += 1;
    void Promise.resolve(loadOlder()).finally(() => {
      busyRef.current = false;
      setPulse((n) => n + 1);
    });
    // `pulse` lets an empty page still advance the hunt.
  }, [target, enabled, isLoading, messages, hasMore, loadOlder, scrollTo, clear, pulse]);

  return clear;
}
