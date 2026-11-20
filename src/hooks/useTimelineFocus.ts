import { useCallback, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";
import { chatRoute, parseChatRoute } from "@/lib/routes";

import type { MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import type { RefObject } from "react";

export interface TimelineFocus {
  /** Hand to `MessageTimeline`'s `handleRef`. */
  timelineRef: RefObject<MessageTimelineHandle | null>;
  jumpToMessage: (id: string) => void;
  clearMessageFocus: () => void;
  /** Follow the newest message AND drop the `/m/` segment. What a send means. */
  pinToPresent: () => void;
  /** Touch only. */
  activeId: string | undefined;
  toggleActive: (id: string) => void;
}

/**
 * The timeline handle plus jump-to-message, `/m/<id>` permalinks and the touch-revealed row.
 * Without `activeId` the toolbar stays `touch:pointer-events-none` and is untappable on the APK.
 */
export function useTimelineFocus(opts: {
  messages: readonly { id: string }[];
  isLoading: boolean;
  hasMore?: boolean;
  loadOlder?: () => Promise<unknown>;
  /** Gate for pages that reuse one route for several views (default true). */
  enabled?: boolean;
  /**
   * Closes the revealed row on change; pass the conversation identity where one component serves
   * several (DMs switch peers without remounting).
   */
  resetKey?: string;
}): TimelineFocus {
  const { messages, isLoading, hasMore, loadOlder, enabled, resetKey } = opts;
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  // Read at call time so `jumpToMessage` keeps one identity for memoized rows.
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const navigate = useStableNavigate();

  const jumpToMessage = useCallback((id: string) => {
    if (timelineRef.current?.scrollToMessage(id) !== false) return;
    // Not loaded: hand it to the permalink hunt, which pages back for it (and
    // replaces the segment away if it never turns up). A thread route's `/m/`
    // belongs to the thread panel, so it can't carry a timeline target.
    if (enabledRef.current === false) return;
    const { pathname, search, hash } = locationRef.current;
    const route = parseChatRoute(pathname);
    if (!route || (route.kind !== "dm" && route.threadRoot)) return;
    navigate(`${chatRoute({ ...route, messageId: id })}${search}${hash}`, { replace: true });
  }, [navigate]);

  // Without it a failed jump just drops the `/m/` segment and looks like a dead tap.
  const notifyNotFound = useCallback(() => {
    toast({
      title: t({ id: "timelineFocus.notFound", defaultMessage: "Couldn't find that message" }),
      description: t({
        id: "timelineFocus.notFoundDescription",
        defaultMessage: "It may have been deleted, or be older than the history loaded here. Scroll up to load more and try again.",
      }),
    });
  }, []);

  const permalinkScroll = useCallback(
    (id: string) => timelineRef.current?.scrollToMessage(id, true) ?? false,
    [],
  );
  const clearMessageFocus = useMessagePermalink({
    messages,
    isLoading,
    hasMore,
    loadOlder,
    scrollTo: permalinkScroll,
    enabled,
    onNotFound: notifyNotFound,
  });

  // Drop `/m/` focus too, or a remount would snap the reader back to it.
  const pinToPresent = useCallback(() => {
    timelineRef.current?.pinToBottom();
    clearMessageFocus();
  }, [clearMessageFocus]);

  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setActiveId(undefined);
  }

  return {
    timelineRef,
    jumpToMessage,
    clearMessageFocus,
    pinToPresent,
    activeId,
    toggleActive,
  };
}
