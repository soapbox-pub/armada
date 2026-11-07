import { createContext, useContext } from "react";

/**
 * The Nicknames members go by in the Concord Community being viewed (CORD-04 §10),
 * by pubkey. Absent outside a Community: global profile names.
 */
export const CommunityNicknamesContext = createContext<ReadonlyMap<string, string> | undefined>(undefined);

export function useCommunityNickname(pubkey: string | undefined): string | undefined {
  const nicknames = useContext(CommunityNicknamesContext);
  return pubkey ? nicknames?.get(pubkey) : undefined;
}
