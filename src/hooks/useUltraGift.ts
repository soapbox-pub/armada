import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useClosedDms } from "@/hooks/useClosedDms";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useStartedDms } from "@/hooks/useStartedDms";
import { t } from "@/i18n";
import { chatRoute } from "@/lib/routes";
import { stashShare } from "@/lib/shareTarget";
import { giftUrl } from "@/lib/ultraGift";

/** The message a gift is sent as; the link alone on its last line, so it renders as a card. */
export function giftMessage(url: string): string {
  return `${t({ id: "ultraGift.message", defaultMessage: "I got you Armada Ultra! 🎁" })}\n${url}`;
}

/**
 * Gifting from the signed-in account. Nothing is sent from here: the message is
 * staged in the chosen conversation's composer, and the user presses Send.
 */
export function useUltraGift() {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const { accept } = useAcceptedDms();
  const { reopen } = useClosedDms();
  const { start } = useStartedDms();
  const url = user ? giftUrl(user.pubkey) : undefined;

  // As the profile's Message button opens a DM: out of the request tier, row kept.
  const draftDm = useCallback((peer: string, text: string) => {
    reopen(peer);
    accept(peer);
    start(peer);
    const route = chatRoute({ kind: "dm", peer });
    stashShare({ text, files: [] }, route);
    navigate(route);
  }, [navigate, reopen, accept, start]);

  /** Pick any DM or channel in the share picker. */
  const sendToChat = useCallback(() => {
    if (!url) return;
    stashShare({ text: giftMessage(url), files: [] }, null);
    navigate("/share");
  }, [url, navigate]);

  /** Straight into a DM with `peer`. */
  const sendToPeer = useCallback((peer: string) => {
    if (url) draftDm(peer, giftMessage(url));
  }, [url, draftDm]);

  /** A DM to the gifter with a thank-you staged. */
  const thank = useCallback((peer: string) => {
    draftDm(peer, t({ id: "ultraGift.thanks", defaultMessage: "Thanks for the Ultra! 💎" }));
  }, [draftDm]);

  return { url, sendToChat, sendToPeer, thank };
}
