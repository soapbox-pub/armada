import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";

import { getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { missingReplyIds } from "@/components/chat/replyParents";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { useChannelRules } from "@/concord/hooks/useChannelRules";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import { foldTimeline, type OpenedChat } from "@/concord/lib/chat";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { queryReplyParents } from "@/concord/lib/rumorStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { STORE_READ } from "@/lib/storeQuery";

import type { ChatMsg } from "@/components/chat/transport";
import type { Channel, Community } from "@/concord/lib/types";

const EMPTY = new Map<string, ChatMsg>();

/**
 * Inline-reply parents that fell outside the loaded window, read from the local
 * store. They bypass the timeline, so its drops are repeated here: the fold
 * (bans, author edits, deletes, the Channel's own rules), mutes, and
 * remembered flood quarantine.
 */
export function useConcordReplyParents(
  community: Community | undefined,
  channel: Channel | undefined,
  messages: readonly ChatMsg[],
  loaded: ReadonlyMap<string, ChatMsg>,
): ReadonlyMap<string, ChatMsg> {
  const communityIdHex = community?.idHex;
  const channelIdHex = channel?.idHex;
  const channels = useMemo(() => (channel ? [channel] : []), [channel]);
  const rulesFor = useChannelRules(community, channels, true);
  const missing = useMemo(() => missingReplyIds(messages, loaded, getQuoteReplyToId), [messages, loaded]);

  const query = useQuery<OpenedChat[]>({
    ...STORE_READ,
    queryKey: ["concord", "reply-parents", communityIdHex ?? null, channelIdHex ?? null, missing.join(",")],
    enabled: Boolean(communityIdHex && channelIdHex && missing.length > 0),
    staleTime: 30_000,
    // Keep resolved parents painted while a grown window re-keys the read.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === communityIdHex && prevQuery?.queryKey[3] === channelIdHex ? prev : undefined,
    queryFn: ({ signal }) => queryReplyParents(communityIdHex!, channelIdHex!, missing, { signal }),
  });

  const moderation = useChatModeration(community);
  const { mutedPubkeys } = useMutedPubkeys();
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  return useMemo(() => {
    void memoryRev;
    const opened = query.data;
    if (!opened || opened.length === 0 || !communityIdHex || !channelIdHex || !moderation.ready) return EMPTY;
    const quarantined = recallQuarantined(communityIdHex, channelIdHex);
    const out = new Map<string, ChatMsg>();
    const folded = foldTimeline(opened, moderation, rulesFor(channelIdHex));
    for (const m of folded.messages) {
      if (mutedPubkeys.has(m.author) || quarantined?.has(m.rumorId) || folded.ruled.has(m.rumorId)) continue;
      out.set(m.rumorId, openedToChatMsg(m));
    }
    return out;
  }, [query.data, moderation, mutedPubkeys, communityIdHex, channelIdHex, memoryRev, rulesFor]);
}
