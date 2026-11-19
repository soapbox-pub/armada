import { useNostr } from "@nostrify/react";
import { useEffect } from "react";

import { refreshBlocklist, useBlocklistAuthors } from "@/lib/blocklistStore";

const REFRESH_MS = 30 * 60_000;

/** Keep the community blocklist fresh: now, whenever its keys change, then every half hour. */
export function useBlocklistSync(): void {
  const { nostr } = useNostr();
  const authors = useBlocklistAuthors();
  useEffect(() => {
    void refreshBlocklist(nostr);
    const timer = setInterval(() => void refreshBlocklist(nostr), REFRESH_MS);
    return () => clearInterval(timer);
  }, [nostr, authors]);
}
