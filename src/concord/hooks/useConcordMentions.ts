import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { queryMentionRumors } from "@/concord/lib/rumorStore";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import { useChannelRules } from "@/concord/hooks/useChannelRules";
import { ruledOut } from "@/concord/lib/channelJudges";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import { useBootGateOpen } from "@/lib/bootGate";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";
import { concordMentionReadKey, useReadState } from "@/hooks/useReadState";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import {
  everyoneMayMention,
  everyoneMentionAuthors,
  isEveryoneMention,
} from "@/concord/lib/everyoneMention";
import { useCommunityEntry } from "@/concord/hooks/useCommunityList";
import { sentDuringMembership } from "@/concord/lib/membershipFloor";
import { heldRoleMentions, rolePings } from "@/concord/lib/roleMentions";
import { emptyRoles, isAuthorized, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

/** How many newest cached mentions to surface. */
const MENTION_LIMIT = 200;

/**
 * Stable empty result: a fresh `[]` default hands every consumer a new reference
 * per render, which drove the Notification Center into an infinite setState loop.
 */
const NO_MENTIONS: ChatMsg[] = [];
const NO_ROWS: OpenedChat[] = [];
const NO_ROLES = emptyRoles();

/**
 * The current user's mentions across a community: every cached kind-9 (and
 * kind-1111 thread reply) that p-tags them, newest-first. Purely local.
 *
 * Deliberately NOT derived from {@link useCommunityRumors}: that scan reads only
 * each channel's newest window, so older mentions would vanish. Uses its own
 * index-backed `#p` filter ({@link queryMentionRumors}) instead.
 *
 * Read state is ONE last-seen `created_at` per community at `c2m:<communityIdHex>`
 * in the shared read-state map (synced via NIP-78), independent of channel read
 * state.
 */
export function useConcordMentions(
  community: Community | undefined,
  channels: Channel[],
  /** Whether the community is on screen; ambient callers (the rail) leave Timeouts unread. */
  active = false,
): {
  mentions: ChatMsg[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (timestamp: number) => void;
  markAllRead: () => void;
} {
  const communityIdHex = community?.idHex;
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();
  const bootGateOpen = useBootGateOpen();
  const { readState, markRead: sharedMarkRead } = useReadState();
  // Passive: ambient callers must never turn this into a per-community control-plane sweep.
  const { data: folded } = useControlFold(community, false);

  // Recomputed only when the set changes, so the query key doesn't churn.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const roles = folded?.roster ?? NO_ROLES;
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const everyoneAuthors = useMemo(
    () => everyoneMentionAuthors(roles, ownerHex, channelIds),
    [roles, ownerHex, channelIds],
  );
  const everyoneAnyone = everyoneMayMention(roles);
  const everyoneAuthorSig = everyoneAnyone ? "*" : everyoneAuthors.join(",");
  const heldRoles = useMemo(() => (pubkey ? heldRoleMentions(roles, pubkey) : []), [roles, pubkey]);
  const roleSig = heldRoles.map((r) => `${r.id}:${r.name}:${r.anyone}`).join(",");
  const joinedAtMs = useCommunityEntry(communityIdHex)?.added_at;

  const { mutedPubkeys } = useMutedPubkeys();

  const rulesFor = useChannelRules(community, channels, active);

  const { data: allMentions = NO_ROWS, isLoading } = useQuery<OpenedChat[]>({
    ...STORE_READ,
    queryKey: ["concord-mentions", communityIdHex ?? null, pubkey, channelSig, everyoneAuthorSig, roleSig, joinedAtMs ?? null],
    queryFn: async ({ signal }) => {
      const rumors = await queryMentionRumors(communityIdHex!, channelIds, pubkey!, {
        limit: MENTION_LIMIT,
        signal,
        everyoneAuthors,
        everyoneAnyone,
        roleIds: heldRoles.map((r) => r.id),
      });
      // The index returns direct mentions plus candidates from authorized role
      // holders; re-check the literal and exact channel scope (the author union spans channels).
      return rumors
        .filter((r) => {
          if (r.author === pubkey) return false;
          if (!sentDuringMembership(r.ms, joinedAtMs)) return false;
          if (r.tags.some(([name, value]) => name === "p" && value === pubkey)) return true;
          if (rolePings(r.content, r.tags, heldRoles, isAuthorized(roles, r.author, ownerHex, Permissions.MENTION_EVERYONE))) return true;
          return isEveryoneMention(r.content, roles, ownerHex, r.author, r.channelIdHex);
        })
        .sort((a, b) => b.ms - a.ms)
        .slice(0, MENTION_LIMIT);
    },
    // After first paint, like useCommunityRumors: the rail asks for every community at once.
    enabled: bootGateOpen && !!communityIdHex && !!pubkey && channelIds.length > 0,
    // No refetch interval: the `c2:` bus ring below is the live path (polling per
    // joined community was N unaligned scans). `staleTime: 0` keeps a remount catch-up.
    staleTime: 0,
  });

  // Re-derive when the persisted quarantine memory warms or grows.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  const banned = folded?.banned;

  // Outside the query so a mute, ban or fold applies without a re-scan, and so
  // `hasNew` derives from the same list the tab renders.
  const mentions = useMemo(() => {
    void memoryRev;
    // The index bypasses the timeline fold, so its Banlist drop and the Channel's
    // own rules are repeated here (CORD-04 §4, §8; CORD-03 §1).
    const kept = allMentions.filter(
      (r) => !mutedPubkeys.has(r.author) && !banned?.has(r.author) && !ruledOut(rulesFor(r.channelIdHex), r, pubkey),
    );
    if (kept.length === 0) return NO_MENTIONS;
    let list = kept.map(openedToChatMsg);
    // Drop mentions quarantined as floods in their channel. A cross-channel `#p`
    // scan can't be re-folded live, so this reads the durable per-channel verdicts
    // (quarantineMemory); rumorIds are unique across channels.
    if (communityIdHex && channelIds.length > 0) {
      let quarantined: Set<string> | undefined;
      for (const idHex of channelIds) {
        const remembered = recallQuarantined(communityIdHex, idHex);
        if (!remembered) continue;
        quarantined ??= new Set();
        for (const id of remembered) quarantined.add(id);
      }
      if (quarantined && quarantined.size > 0) list = list.filter((m) => !quarantined.has(m.id));
    }
    return list;
  }, [allMentions, mutedPubkeys, banned, communityIdHex, channelIds, memoryRev, rulesFor, pubkey]);

  useWireScopes((scopes) => {
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord-mentions", communityIdHex ?? null, pubkey] });
        return;
      }
    }
  });

  const readKey = communityIdHex ? concordMentionReadKey(communityIdHex) : undefined;
  const readAt = readKey ? (readState[readKey] ?? 0) : 0;

  // `created_at` is unix SECONDS on the ChatMsg; the newest mention is first.
  const newestMentionAt = mentions[0]?.created_at ?? 0;
  const hasNew = newestMentionAt > readAt;

  // Monotonic (the shared map no-ops on older stamps). Used when a mention is
  // seen outside the tab, e.g. in its channel.
  const markRead = useCallback(
    (timestamp: number) => {
      if (!readKey || timestamp <= 0) return;
      sharedMarkRead(readKey, timestamp);
    },
    [readKey, sharedMarkRead],
  );

  const markAllRead = useCallback(() => {
    if (newestMentionAt <= 0) return;
    markRead(newestMentionAt);
  }, [markRead, newestMentionAt]);

  return useMemo(
    () => ({ mentions, isLoading, hasNew, markRead, markAllRead }),
    [mentions, isLoading, hasNew, markRead, markAllRead],
  );
}
