import { useCallback, useState } from "react";

import { effectiveDmRelays, type AppConfig } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { uniqueRelayUrls } from "@/lib/nip65";
import { DM_INBOX_RELAYS } from "@/lib/platform";

const dismissKey = (pubkey: string) => `armada:dm-inbox-notice-dismissed:${pubkey}`;

function readDismissed(pubkey: string | undefined): boolean {
  if (!pubkey) return false;
  try {
    return localStorage.getItem(dismissKey(pubkey)) !== null;
  } catch {
    return false;
  }
}

/** Where this client already receives DMs, plus the AUTH-gated inboxes a new account lists. */
export function recommendedDmInbox(config: AppConfig): string[] {
  return uniqueRelayUrls([...effectiveDmRelays(config), ...DM_INBOX_RELAYS]);
}

/**
 * An existing account with no kind 10050 can't be messaged from clients that
 * require one (Amethyst refuses to send). Offers a one-tap publish, and ONLY
 * on an authoritative absence — every account relay answered with no event —
 * since an empty read is not proof there is no list to overwrite.
 */
export function useDmInboxSetup() {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const dmRelayList = useDmRelayList();
  const [dismissed, setDismissed] = useState(() => readDismissed(user?.pubkey));
  const [publishing, setPublishing] = useState(false);

  const missing = !!user?.signer.nip44
    && !config.dmsDisabled
    && dmRelayList.isReady
    && dmRelayList.event === null;

  /** Resolves with the relays it published. */
  const publish = useCallback(async () => {
    const relays = recommendedDmInbox(config);
    setPublishing(true);
    try {
      await dmRelayList.publish(relays);
      updateConfig((current) => ({ ...current, dmRelays: relays }));
      return relays;
    } finally {
      setPublishing(false);
    }
  }, [config, dmRelayList, updateConfig]);


  const dismiss = useCallback(() => {
    setDismissed(true);
    if (!user?.pubkey) return;
    try {
      localStorage.setItem(dismissKey(user.pubkey), "1");
    } catch { /* ignore */ }
  }, [user?.pubkey]);

  return { missing, dismissed, publishing, publish, dismiss };
}
