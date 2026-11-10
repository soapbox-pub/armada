import { createContext } from "react";

import type { BoostsByListing } from "@/lib/discoverBoost";

/** Discover's boosts, read per card by listing, and whose boost vouches for a listing. */
export const DiscoverBoostsContext = createContext<{ boosts: BoostsByListing; vouchers: ReadonlySet<string> | null }>({
  boosts: new Map(),
  vouchers: new Set(),
});
