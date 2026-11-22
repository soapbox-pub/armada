import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCommunityPeers } from "@/hooks/useSharedCommunities";
import { dmOpenerOf, type DmOpener, type StrangerFilterPolicy } from "@/lib/dmStrangerFilter";
import { queryDm17Opener } from "@/lib/nip17/dm17Store";

/** The stranger filter's inputs; undefined (filter off) until community memberships are read. */
export function useStrangerFilterPolicy(): StrangerFilterPolicy | undefined {
  const { config } = useAppContext();
  const communityPeers = useCommunityPeers();
  const blockNonMembers = config.blockNonMemberDms;
  return useMemo(
    () => (communityPeers ? { communityPeers, blockNonMembers } : undefined),
    [blockNonMembers, communityPeers],
  );
}

/** A request-tier conversation whose opener the filter judges. */
export interface OpenerRow {
  conversation: string;
  peers: string[];
  latest?: { id: string; pubkey: string; kind: number; content: string };
}

const NO_OPENERS: ReadonlyMap<string, DmOpener> = new Map();

/** Each row's first message (NIP-17 only: kind-4 strangers are never fetched), by conversation key. */
export function useDmOpeners(rows: readonly OpenerRow[], enabled = true): ReadonlyMap<string, DmOpener> {
  const self = useCurrentUser().user?.pubkey;
  const signature = rows
    .flatMap((row) => (row.latest ? [`${row.conversation}:${row.latest.id}`] : []))
    .sort()
    .join("|");
  const { data } = useQuery<Map<string, DmOpener>>({
    queryKey: ["dm-openers", self ?? "", signature],
    enabled: enabled && !!self && signature.length > 0,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => {
      const out = new Map<string, DmOpener>();
      await Promise.all(signature.split("|").map(async (entry) => {
        const sep = entry.lastIndexOf(":");
        const conversation = entry.slice(0, sep);
        const row = rows.find((r) => r.conversation === conversation);
        if (!row) return;
        const opener = await queryDm17Opener(self!, row.peers, entry.slice(sep + 1), { signal })
          .catch(() => undefined);
        // Nothing stored yet: the head is a fresh message ahead of its commit, and the only one.
        const head = row.latest!;
        out.set(conversation, opener ?? dmOpenerOf({ author: head.pubkey, kind: head.kind, content: head.content }));
      }));
      return out;
    },
  });
  return enabled && data ? data : NO_OPENERS;
}
