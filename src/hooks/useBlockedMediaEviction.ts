import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { evictNewlyBlockedMedia } from "@/lib/evictBlockedUserMedia";

/** Drop the device's copies of a user's media once they're blocked, from this device or another. */
export function useBlockedMediaEviction(): void {
  const { user } = useCurrentUser();
  const { mutedPubkeys, ready } = useMutedPubkeys();
  const self = user?.pubkey;

  useEffect(() => {
    if (!self || !ready) return;
    let live = true;
    void evictNewlyBlockedMedia(self, mutedPubkeys, () => live).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [self, ready, mutedPubkeys]);
}
