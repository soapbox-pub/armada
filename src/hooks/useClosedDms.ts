import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";

import type { ClosedDmMarker } from "@/contexts/AppContext";
import { nowSecs } from "@/lib/relayClock";

export interface DmLatestMarker {
  id?: string;
  created_at: number;
}

/**
 * A closed row stays hidden only while its newest message is the one present at
 * close (or older). A different id in the same second counts as new (1s precision).
 */
export function dmRemainsClosed(
  marker: ClosedDmMarker | undefined,
  latest: DmLatestMarker | undefined,
): boolean {
  if (!marker) return false;
  if (!latest) return true;
  if (latest.created_at < marker.createdAt) return true;
  if (latest.created_at > marker.createdAt) return false;
  if (!marker.eventId || !latest.id) return true;
  return latest.id === marker.eventId;
}

export function useClosedDms() {
  const { config, updateConfig } = useAppContext();

  const isClosed = useCallback(
    (peer: string, latest: DmLatestMarker | undefined) =>
      dmRemainsClosed(config.closedDms[peer], latest),
    [config.closedDms],
  );

  /** Close several rows in one config write. */
  const closeMany = useCallback(
    (rows: Array<{ peer: string; latest: DmLatestMarker | undefined }>) => {
      if (rows.length === 0) return;
      const now = nowSecs();
      const peers = new Set(rows.map((row) => row.peer));
      updateConfig((current) => {
        const closedDms = { ...current.closedDms };
        for (const { peer, latest } of rows) {
          closedDms[peer] = { eventId: latest?.id, createdAt: latest?.created_at ?? now };
        }
        // A reopened row returns unpinned.
        return { ...current, pinnedDms: current.pinnedDms.filter((p) => !peers.has(p)), closedDms };
      });
    },
    [updateConfig],
  );

  const close = useCallback(
    (peer: string, latest: DmLatestMarker | undefined) => closeMany([{ peer, latest }]),
    [closeMany],
  );

  const reopen = useCallback(
    (peer: string) => {
      updateConfig((current) => {
        if (!current.closedDms[peer]) return current;
        const closedDms = { ...current.closedDms };
        delete closedDms[peer];
        return { ...current, closedDms };
      });
    },
    [updateConfig],
  );

  const reopenForNewMessages = useCallback(
    (rows: Array<{ peer: string; latest: DmLatestMarker | undefined }>) => {
      updateConfig((current) => {
        let closedDms: Record<string, ClosedDmMarker> | undefined;
        for (const row of rows) {
          const marker = current.closedDms[row.peer];
          if (!marker || dmRemainsClosed(marker, row.latest)) continue;
          closedDms ??= { ...current.closedDms };
          delete closedDms[row.peer];
        }
        return closedDms ? { ...current, closedDms } : current;
      });
    },
    [updateConfig],
  );

  return { close, closeMany, reopen, reopenForNewMessages, isClosed };
}
