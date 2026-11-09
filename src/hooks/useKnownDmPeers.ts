import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import {
  useDmConversationIndex,
  useDmConversationIndexReady,
} from "@/hooks/useDmConversationIndex";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { readCachedContactList } from "@/lib/contactList";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { dmConvPeers } from "@/lib/nip17/conversation";

const PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface UseKnownDmPeersReturn {
  /** Main list vs request tier. `mine`: the viewer authored a message in this conversation. */
  isKnown: (peer: string, mine: boolean) => boolean;
  knownPeers: string[];
  /** Exact unmuted NIP-17 conversation keys the viewer pinned or wrote in. */
  knownConversationKeys: string[];
  /** Existing DM semantics hide any group containing one. */
  mutedPeers: string[];
  isLoading: boolean;
  /**
   * {@link isLoading} for surfaces that only display, which don't wait on the contact list's
   * relay read once this device has answered that it holds none: an account that follows
   * nobody would otherwise wait out the slowest relay on every boot. A list found there later
   * can move a conversation from the requests into the inbox. Never for recording or pruning.
   */
  displayLoading: boolean;
  /** True only when every source can authorize replacing/pruning background state. */
  authoritativeReady: boolean;
  /** Trusted last-good data is sufficient to replace the sealed DM policy. */
  configurationReady: boolean;
}

/**
 * The single "is this DM peer known?" predicate for the list, request list, rail dot and
 * thread notice. Known if followed, written to (`mine` / `acceptedDms`), 1:1-pinned, or a synced
 * index row proves the viewer wrote there; everything else is a request.
 * Must stay the only implementation, or surfaces disagree. Muted peers are rejected here too so
 * background consumers stay silent.
 */
export function useKnownDmPeers(): UseKnownDmPeersReturn {
  const { data: followData, isLoading: followsLoading } = useFollowList();
  const self = useCurrentUser().user?.pubkey;
  const eventStore = useEventStore();
  // Only asked while the relay read is out: a stored list seeds that query anyway.
  const { data: storedList } = useQuery({
    queryKey: ["contact-list-stored", self ?? ""],
    queryFn: async () => (await readCachedContactList(await eventStore, self!)) ?? null,
    enabled: !!self && followsLoading,
    staleTime: Infinity,
  });
  const noStoredList = storedList === null;
  const { accepted } = useAcceptedDms();
  const { pinned } = usePinnedDms();
  const indexed = useDmConversationIndex();
  const indexReady = useDmConversationIndexReady();
  const {
    mutedPubkeys,
    ready: mutesReady,
    wireReady: mutesWireReady,
    configReady: mutesConfigReady,
  } = useMutedPubkeys();

  const knownPeers = useMemo(() => {
    // Fail closed until mutes resolve: background consumers have no render-time mute filter.
    if (!mutesReady) return [];
    const peers = new Set(
      (followData?.pubkeys ?? []).filter(
        (peer) => PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer),
      ),
    );
    for (const peer of accepted) {
      if (PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer)) peers.add(peer);
    }
    // A group pin trusts that conversation, not every participant; a 1:1 pin trusts the peer.
    for (const key of pinned) {
      const participants = dmConvPeers(key);
      if (participants.length === 1
        && PUBKEY_RE.test(participants[0])
        && !mutedPubkeys.has(participants[0])) peers.add(participants[0]);
    }
    // Group rows prove participation in that group only, never widen the global allow-list.
    for (const record of indexed) {
      if (!record.mine) continue;
      const participants = dmConvPeers(record.key);
      const peer = participants.length === 1 ? participants[0] : undefined;
      if (peer && PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer)) peers.add(peer);
    }
    return [...peers].sort();
  }, [accepted, followData?.pubkeys, indexed, mutedPubkeys, mutesReady, pinned]);
  const knownSet = useMemo(() => new Set(knownPeers), [knownPeers]);

  const knownConversationKeys = useMemo(() => {
    if (!mutesReady) return [];
    const keys = new Set<string>();
    for (const key of pinned) {
      const peers = dmConvPeers(key);
      if (peers.length > 0 && peers.every((peer) =>
        PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer))) keys.add(key);
    }
    for (const record of indexed) {
      if (!record.mine) continue;
      const peers = dmConvPeers(record.key);
      if (peers.length > 0 && peers.every((peer) =>
        PUBKEY_RE.test(peer) && !mutedPubkeys.has(peer))) keys.add(record.key);
    }
    return [...keys].sort();
  }, [indexed, mutedPubkeys, mutesReady, pinned]);

  const mutedPeers = useMemo(
    () => mutesReady ? [...mutedPubkeys].filter((peer) => PUBKEY_RE.test(peer)).sort() : [],
    [mutedPubkeys, mutesReady],
  );

  const isKnown = useCallback(
    (peer: string, mine: boolean) => !mutedPubkeys.has(peer) && (mine || knownSet.has(peer)),
    [knownSet, mutedPubkeys],
  );

  return {
    isKnown,
    knownPeers,
    knownConversationKeys,
    mutedPeers,
    isLoading: followsLoading || !indexReady || !mutesReady,
    displayLoading: (followsLoading && !noStoredList) || !indexReady || !mutesReady,
    authoritativeReady: followData?.wireReady === true
      && indexReady
      && mutesWireReady === true,
    configurationReady: (followData?.wireReady === true || followData?.event != null)
      && indexReady
      && mutesConfigReady === true,
  };
}
