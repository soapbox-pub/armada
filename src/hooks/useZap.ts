import { useCallback, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useWallet } from "@/hooks/useWallet";
import { notify } from "@/lib/haptics";
import { fetchLnurlInvoice, resolveLnurlPay } from "@/lib/lnurl";
import { bolt11Info } from "@/lib/zaps";

import type { ChatMsg, ZapPayment } from "@/components/chat/transport";
import type { NostrMetadata } from "@nostrify/nostrify";

export type ZapStatus = "idle" | "resolving" | "paying" | "manual" | "success";

/**
 * Zap outcome:
 *  - `"paid"`      — settled and recorded (public receipt on its way, or the
 *                    private announcement sealed).
 *  - `"manual"`    — invoice surfaced for an external wallet (NIP-57 fallback).
 *  - `"unproven"`  — a PRIVATE zap whose payment settled (sats reached the
 *                    recipient) but whose wallet couldn't surface the preimage
 *                    CORD.md needs, so no tally could be posted. Not a failure.
 */
export type ZapOutcome = "paid" | "manual" | "unproven";

export interface UseZapResult {
  /** Run the zap. Resolves with the outcome; throws only on a real failure. */
  zap: (amountSats: number, comment: string) => Promise<ZapOutcome>;
  status: ZapStatus;
  /** The invoice awaiting manual payment (QR fallback), when status === "manual". */
  invoice: string | null;
  reset: () => void;
}

/**
 * The zap payment flow, shared by both surfaces. The announcement differs:
 *
 *  - **NIP-57** (NIP-29 group chat; no `sendZap` on the transport): a signed
 *    kind-9734 zap request rides the LNURL callback's `nostr` param — never
 *    published by us — and the provider's public kind-9735 receipt on our app
 *    relays IS the announcement. Payment falls back NWC → WebLN → manual QR.
 *
 *  - **CORD.md** (Concord v2; transport supplies `sendZap`): the invoice is
 *    fetched WITHOUT a `nostr` param (no public receipt anywhere), payment
 *    must return the preimage (NWC/WebLN only — manual QR can't), and the
 *    sealed announcement is published by the transport.
 */
export function useZap(opts: {
  target: ChatMsg;
  /** Zap recipient: the message author's pubkey + lightning fields. */
  recipient: { pubkey: string; metadata?: NostrMetadata };
  /** CORD.md announcement publisher; presence selects the private flow. */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
}): UseZapResult {
  const { target, recipient, sendZap } = opts;
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { activeConnection, payWithNWC, webln } = useWallet();

  const [status, setStatus] = useState<ZapStatus>("idle");
  const [invoice, setInvoice] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setInvoice(null);
  }, []);

  const zap = useCallback(
    async (amountSats: number, comment: string) => {
      if (!user) throw new Error("Sign in to zap.");
      if (!Number.isFinite(amountSats) || amountSats < 1) throw new Error("Enter an amount in sats.");
      const isPrivate = Boolean(sendZap);
      if (isPrivate && !activeConnection && !webln) {
        throw new Error("Private zaps need a connected wallet (Settings → Wallet).");
      }

      setStatus("resolving");
      try {
        const params = await resolveLnurlPay(recipient.metadata ?? {});
        const amountMsats = amountSats * 1000;
        if (amountMsats < params.minSendable || amountMsats > params.maxSendable) {
          throw new Error(
            `Amount must be between ${Math.ceil(params.minSendable / 1000)} and ${Math.floor(params.maxSendable / 1000)} sats for this recipient.`,
          );
        }
        const trimmedComment = comment.trim();

        // NIP-57 zap request: signed, handed ONLY to the provider (never
        // published by us). The provider publishes the public receipt to
        // these relays — our app relays, where useZapReceipts looks.
        // CORD.md deliberately omits it (CORD.md §2).
        let zapRequest: string | undefined;
        if (!isPrivate) {
          if (!params.allowsNostr) {
            throw new Error("Recipient's wallet service doesn't support zaps.");
          }
          const signed = await user.signer.signEvent({
            kind: 9734,
            content: trimmedComment,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", recipient.pubkey],
              ["amount", String(amountMsats)],
              ["relays", ...config.appRelays],
              ["e", target.id],
              ["k", String(target.kind)],
            ],
          });
          zapRequest = JSON.stringify(signed);
        }

        const bolt11 = await fetchLnurlInvoice(params, {
          amountMsats,
          comment: trimmedComment,
          zapRequest,
        });
        // Never pay an invoice that doesn't encode what we asked for.
        const info = bolt11Info(bolt11);
        if (info.amountMsats !== amountMsats) {
          throw new Error("The wallet service returned a mismatched invoice.");
        }

        setStatus("paying");
        let preimage: string | null | undefined;
        if (activeConnection) {
          ({ preimage } = await payWithNWC(bolt11));
        } else if (webln) {
          try {
            await webln.enable();
            const result = await webln.sendPayment(bolt11);
            preimage = result?.preimage;
          } catch (e) {
            throw new Error(e instanceof Error ? e.message : "Browser wallet payment failed.");
          }
        } else if (!isPrivate) {
          // Manual fallback: surface the invoice for an external wallet. The
          // provider's receipt (not us) confirms it once paid.
          setInvoice(bolt11);
          setStatus("manual");
          return "manual";
        } else {
          throw new Error("Private zaps need a connected wallet (Settings → Wallet).");
        }

        if (isPrivate) {
          // CORD.md's proof IS the preimage — without it there's no sealed
          // announcement to post. payWithNWC/WebLN only reach here with a
          // falsy preimage when the payment ITSELF settled (a genuine failure
          // throws), so the sats reached the recipient; this wallet just can't
          // surface the proof a private tally needs. Report it as sent-but-
          // unrecorded, not failed.
          if (!preimage) {
            notify("warning");
            setStatus("success");
            return "unproven";
          }
          await sendZap!(target, { amountMsats, bolt11, preimage, comment: trimmedComment });
        }
        // NIP-57 (public) zaps don't need the preimage: the provider publishes
        // the kind-9735 receipt and the ⚡ chip reflects it (like Ditto).
        notify("success");
        setStatus("success");
        return "paid";
      } catch (e) {
        setStatus("idle");
        throw e;
      }
    },
    [user, sendZap, activeConnection, webln, payWithNWC, recipient, target, config.appRelays],
  );

  return { zap, status, invoice, reset };
}
