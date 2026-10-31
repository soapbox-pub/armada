import { useRef } from "react";

import { useReadState } from "@/hooks/useReadState";

export interface ReadableTimelineEntry {
  id: string;
  createdAt: number;
  author: string;
}

/**
 * Where the "NEW" divider belongs: the oldest message after last read. The last-read stamp is
 * captured on the first render per `readKey` (before mark-read) and frozen for the visit. Own
 * messages never count. While the loaded history starts after last read and `hasOlder` says
 * more exists, the true first unread isn't loaded yet: the divider sits on the oldest loaded
 * unread and moves back as older pages arrive, then freezes.
 */
export function useNewMessagesDivider(
  readKey: string,
  messages: readonly ReadableTimelineEntry[],
  selfPubkey?: string,
  hasOlder = false,
): string | undefined {
  const { getLastRead } = useReadState();

  const stateRef = useRef<{
    key: string;
    lastRead: number;
    dividerId?: string;
    settled: boolean;
  } | null>(null);

  // Capture before any mark-read effect bumps it.
  if (!stateRef.current || stateRef.current.key !== readKey) {
    stateRef.current = { key: readKey, lastRead: getLastRead(readKey), settled: false };
  }

  const state = stateRef.current;

  // A never-read conversation shows no divider.
  if (!state.settled && messages.length > 0) {
    const reachesLastRead = messages[0].createdAt <= state.lastRead;
    state.settled = state.lastRead <= 0 || reachesLastRead || !hasOlder;
    if (state.lastRead > 0) {
      state.dividerId = messages.find(
        (m) => m.createdAt > state.lastRead && m.author !== selfPubkey,
      )?.id;
    }
  }

  return state.dividerId;
}
