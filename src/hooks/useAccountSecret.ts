import { useNostrLogin } from "@nostrify/react/login";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * The current account's secret key when this device holds it (an nsec login), for
 * keys derived from it (CORD-01 `concord/wrap-owner`); undefined for a remote signer.
 */
export function useAccountSecret(): Uint8Array | undefined {
  const { logins } = useNostrLogin();
  const { user } = useCurrentUser();
  return useMemo(() => {
    const login = logins[0];
    if (!user || login?.type !== "nsec") return undefined;
    try {
      const decoded = nip19.decode(login.data.nsec);
      if (decoded.type !== "nsec" || getPublicKey(decoded.data) !== user.pubkey) return undefined;
      return decoded.data;
    } catch {
      return undefined;
    }
  }, [logins, user]);
}
