import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isUserBannedNow, metBannedUsers, onBannedUserMet } from "@/lib/bannedUsers";
import { onBlocklistChange } from "@/lib/blocklistStore";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { knownBannedUsers, pruneKnownBannedUsers, purgeBannedUser } from "@/lib/purgeBannedUser";

/** Banned users purged this session. */
const purged = new Set<string>();

/**
 * Purge each banned user from this device once a session (`purgeBannedUser.ts`):
 * those met before, those met as their content comes by, and, as entries
 * arrive, anyone the device holds a profile of who turns out banned.
 */
export function useBannedUserPurge(): void {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const self = user?.pubkey;

  useEffect(() => {
    let live = true;
    const purge = (pubkey: string) => {
      if (!live || purged.has(pubkey)) return;
      purged.add(pubkey);
      void purgeBannedUser(self, pubkey, { queryClient }).catch(() => purged.delete(pubkey));
    };
    // Asking is enough: a banned pubkey met for the first time is announced.
    const sweep = async () => {
      const [known, profiles] = await Promise.all([
        knownBannedUsers(),
        getArmadaDB().kv.list<unknown>({ prefix: "profile-fresh:" }).catch(() => []),
      ]);
      for (const pubkey of known) isUserBannedNow(pubkey);
      for (const { key } of profiles) isUserBannedNow(key.slice("profile-fresh:".length));
      for (const pubkey of metBannedUsers()) purge(pubkey);
      await pruneKnownBannedUsers();
    };
    const unmet = onBannedUserMet(purge);
    const unchange = onBlocklistChange(() => void sweep());
    void sweep();
    return () => {
      live = false;
      unmet();
      unchange();
    };
  }, [self, queryClient]);
}
