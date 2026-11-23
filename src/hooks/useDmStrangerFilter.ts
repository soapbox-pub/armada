import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCommunityPeers } from "@/hooks/useSharedCommunities";
import { dmScreenOf, mergeDmScreens, type DmScreen, type StrangerFilterPolicy } from "@/lib/dmStrangerFilter";
import { queryDm17Screen } from "@/lib/nip17/dm17Store";
import type { SwStrangerFilter } from "@/lib/swPushConfig";

/** The stranger filter's inputs; undefined (filter off) until community memberships are read. */
export function useStrangerFilterPolicy(enabled = true): StrangerFilterPolicy | undefined {
  const { config } = useAppContext();
  const communityPeers = useCommunityPeers(enabled);
  const blockNonMembers = config.blockNonMemberDms;
  return useMemo(
    () => (communityPeers ? { communityPeers, blockNonMembers } : undefined),
    [blockNonMembers, communityPeers],
  );
}

/**
 * The policy as the background notifiers carry it (the service worker, Android's
 * service, iOS's extension); undefined while memberships load.
 */
export function useStrangerFilterConfig(enabled = true): SwStrangerFilter | undefined {
  const policy = useStrangerFilterPolicy(enabled);
  return useMemo(
    () => policy && {
      communityPeers: [...policy.communityPeers].sort(),
      blockNonMembers: policy.blockNonMembers,
    },
    [policy],
  );
}

/** A request-tier conversation the filter judges. */
export interface ScreenedRow {
  conversation: string;
  peers: string[];
  latest?: { id: string; pubkey: string; kind: number; content: string };
}

const NO_SCREENS: ReadonlyMap<string, DmScreen> = new Map();

/**
 * Each row's {@link DmScreen}, by conversation key: NIP-17 conversations from the
 * store, and every row's newest message too, since a fresh one (or a kind-4 DM,
 * which has no NIP-17 store) may not be stored yet.
 */
export function useDmScreens(rows: readonly ScreenedRow[], enabled = true): ReadonlyMap<string, DmScreen> {
  const self = useCurrentUser().user?.pubkey;
  const signature = useMemo(
    () => rows
      .flatMap((row) => (row.latest ? [`${row.conversation}:${row.latest.id}`] : []))
      .sort()
      .join("|"),
    [rows],
  );
  const byConversation = useMemo(() => new Map(rows.map((row) => [row.conversation, row])), [rows]);
  const { data } = useQuery<Map<string, DmScreen>>({
    queryKey: ["dm-screens", self ?? "", signature],
    enabled: enabled && !!self && signature.length > 0,
    staleTime: Infinity,
    gcTime: 60_000,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => {
      const out = new Map<string, DmScreen>();
      await Promise.all([...byConversation.values()].map(async (row) => {
        if (!row.latest) return;
        const head = dmScreenOf([{ author: row.latest.pubkey, kind: row.latest.kind, content: row.latest.content }], self!);
        const stored = await queryDm17Screen(self!, row.peers, row.latest.id, { signal }).catch(() => undefined);
        out.set(row.conversation, stored ? mergeDmScreens(stored, head) : head);
      }));
      return out;
    },
  });
  return enabled && data ? data : NO_SCREENS;
}
