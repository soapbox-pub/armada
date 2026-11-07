import { createContext, useContext } from "react";

import type { MemberActionItem } from "@/contexts/MemberActionsContext";

/** A Concord call's moderator directives against one participant (CORD-07 §7); absent outside one. */
export const VoiceModerationContext = createContext<((pubkey: string) => MemberActionItem[]) | undefined>(undefined);

export function useVoiceModerationActions(pubkey: string | undefined): MemberActionItem[] {
  const actionsFor = useContext(VoiceModerationContext);
  return pubkey && actionsFor ? actionsFor(pubkey) : [];
}
