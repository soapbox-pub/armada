import { useNostr } from "@nostrify/react";
import { useCallback, useEffect } from "react";

import { checkUserBan, useIsUserBanned } from "@/lib/blocklistStore";

/** Fetch a user's own blocklist entry, as their card or profile is about to open. */
export function useCheckUserBan(): (pubkey: string) => void {
  const { nostr } = useNostr();
  return useCallback((pubkey: string) => void checkUserBan(nostr, pubkey), [nostr]);
}

/**
 * Whether the blocklist bans `pubkey`, fetching their own entry as this
 * mounts (a profile opening), so a ban published since the last full refresh
 * counts before anything of theirs shows.
 */
export function useUserBan(pubkey: string | undefined): boolean {
  const check = useCheckUserBan();
  useEffect(() => {
    if (pubkey) check(pubkey);
  }, [check, pubkey]);
  return useIsUserBanned()(pubkey);
}
