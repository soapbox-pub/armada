import { createContext, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";

/**
 * Who the surrounding room's composer offers as `@` mentions, so an in-place
 * edit offers the same. Undefined means mentions are off (plain DMs).
 */
export const MentionRosterContext = createContext<string[] | undefined>(undefined);

const NO_MESSAGES: readonly { pubkey: string }[] = [];

/** The composer's mention candidates: explicit `mentionPubkeys`, else a NIP-29 group's members and authors. */
export function useMentionRoster(
  relayUrl: string,
  groupId: string,
  messages: readonly { pubkey: string }[] = NO_MESSAGES,
  mentionPubkeys?: string[],
): string[] | undefined {
  const { user } = useCurrentUser();
  const isDM = relayUrl === "dm";
  const fromGroup = !mentionPubkeys && !isDM;
  const { data: groupDetails } = useGroup(fromGroup ? relayUrl : undefined, fromGroup ? groupId : undefined);
  return useMemo(() => {
    if (mentionPubkeys) return mentionPubkeys;
    if (isDM) return undefined;
    const set = new Set<string>();
    for (const a of groupDetails?.admins ?? []) set.add(a.pubkey);
    for (const m of groupDetails?.members ?? []) set.add(m);
    for (const m of messages) set.add(m.pubkey);
    if (user) set.add(user.pubkey);
    return [...set];
  }, [mentionPubkeys, isDM, groupDetails?.admins, groupDetails?.members, messages, user]);
}
