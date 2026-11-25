import { useQuery } from "@tanstack/react-query";
import { nip05 } from "nostr-tools";

import { isNostrId } from "@/lib/nostrId";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

import type { Nip05Address } from "@/lib/nip05Address";

/**
 * Resolve NIP-05 via `.well-known/nostr.json` (nostr-tools). The pubkey is validated as hex:
 * the domain is untrusted. `null` = not listed or not reachable (nostr-tools reports a failed
 * lookup as no match). A loopback/private domain is never fetched, as for sender-named media.
 */
export function useNip05Resolve(address: Nip05Address | undefined) {
  return useQuery<string | null>({
    queryKey: ["nip05-resolve", address?.address],
    queryFn: async () => {
      if (!address || isLocalNetworkUrl(`https://${address.domain}/`)) return null;
      const profile = await nip05.queryProfile(address.address);
      if (!profile) return null;
      return isNostrId(profile.pubkey) ? profile.pubkey : null;
    },
    enabled: !!address,
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  });
}
