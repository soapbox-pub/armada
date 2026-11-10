import { useCallback, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useWallet } from "@/hooks/useWallet";
import { t } from "@/i18n";
import { notify } from "@/lib/haptics";
import { fetchLnurlInvoice, resolveLnurlPay } from "@/lib/lnurl";
import { bolt11Info } from "@/lib/zaps";

import type { ChatMsg, ZapPayment } from "@/components/chat/transport";
import type { NostrMetadata } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

export type ZapStatus = "idle" | "resolving" | "paying" | "manual" | "success";

/**
 * Zap outcome. `"unproven"`: a private zap that settled but whose wallet couldn't
 * surface the preimage CORD.md needs, so no tally was posted. Not a failure.
 */
export type ZapOutcome = "paid" | "manual" | "unproven";

export interface UseZapResult {
  /** Run the zap. Resolves with the outcome; throws only on a real failure. */
  zap: (amountSats: number, comment: string) => Promise<ZapOutcome>;
  status: ZapStatus;
  invoice: string | null;
  reset: () => void;
}

/**
 * The zap payment flow.
 *  - NIP-57 (no `sendZap`): kind-9734 request rides the LNURL callback only; the
 *    provider's kind-9735 receipt on our app relays is the announcement.
 *    Payment falls back NWC → WebLN → manual QR.
 *  - CORD.md (`sendZap` given): no `nostr` param, payment must return the
 *    preimage (NWC/WebLN only), and the transport publishes a sealed announcement.
 */
export function useZap(opts: {
  target: ChatMsg;
  /** Zap recipient: the message author's pubkey + lightning fields. */
  recipient: { pubkey: string; metadata?: NostrMetadata };
  /** lud16/LNURL overriding kind-0 metadata (a NIP-A3 `lightning` payment target). */
  lnAddressOverride?: string;
  /** CORD.md announcement publisher; presence selects the private flow. */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
}): UseZapResult {
  const { target, recipient, lnAddressOverride, sendZap } = opts;
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { activeConnection, payWithNWC, lookupPreimage, webln } = useWallet();

  const [status, setStatus] = useState<ZapStatus>("idle");
  const [invoice, setInvoice] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setInvoice(null);
  }, []);

  const zap = useCallback(
    async (amountSats: number, comment: string) => {
      if (!user) throw new Error(t({ id: "useZap.signIn", defaultMessage: "Sign in to zap." }));
      if (!Number.isFinite(amountSats) || amountSats < 1) throw new Error(t({ id: "useZap.enterAmount", defaultMessage: "Enter an amount in sats." }));
      const isPrivate = Boolean(sendZap);
      // CORD.md's proof is the preimage, which the manual QR path can't return.
      if (isPrivate && !activeConnection && !webln) {
        throw new Error(t({ id: "useZap.privateNeedsWallet", defaultMessage: "Private zaps need a connected wallet (Settings → Wallet)." }));
      }

      setStatus("resolving");
      try {
        // A NIP-A3 payment target takes precedence over the profile's lud16/lud06.
        const override = lnAddressOverride?.trim();
        const lnurlSource: NostrMetadata = override
          ? (/^lnurl1/i.test(override) ? { lud06: override } : { lud16: override })
          : (recipient.metadata ?? {});
        const params = await resolveLnurlPay(lnurlSource);
        const amountMsats = amountSats * 1000;
        if (amountMsats < params.minSendable || amountMsats > params.maxSendable) {
          throw new Error(
            t(
              { id: "useZap.amountOutOfRange", defaultMessage: "Amount must be between {min} and {max} sats for this recipient." },
              { min: Math.ceil(params.minSendable / 1000), max: Math.floor(params.maxSendable / 1000) },
            ),
          );
        }
        const trimmedComment = comment.trim();

        // NIP-57 zap request: handed only to the provider, never published by us.
        // CORD.md omits it (§2).
        let zapRequest: string | undefined;
        if (!isPrivate) {
          if (!params.allowsNostr) {
            throw new Error(t({ id: "useZap.noZapSupport", defaultMessage: "Recipient's wallet service doesn't support zaps." }));
          }
          const signed = await user.signer.signEvent({
            kind: 9734,
            content: trimmedComment,
            created_at: nowSecs(),
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
          // A private zap's comment lives only in the sealed rumor (CORD.md §5).
          comment: isPrivate ? undefined : trimmedComment,
          zapRequest,
        });
        // Never pay an invoice that doesn't encode what we asked for.
        const info = bolt11Info(bolt11);
        if (info.amountMsats !== amountMsats) {
          throw new Error(t({ id: "useZap.mismatchedInvoice", defaultMessage: "The wallet service returned a mismatched invoice." }));
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
            throw new Error(e instanceof Error ? e.message : t({ id: "useZap.browserWalletFailed", defaultMessage: "Browser wallet payment failed." }));
          }
        } else if (!isPrivate) {
          // Manual fallback; the provider's receipt confirms it once paid.
          setInvoice(bolt11);
          setStatus("manual");
          return "manual";
        } else {
          // Unreachable (guarded above); an external wallet can't return a preimage.
          throw new Error(t({ id: "useZap.privateNeedsWallet", defaultMessage: "Private zaps need a connected wallet (Settings → Wallet)." }));
        }

        if (isPrivate) {
          // A falsy preimage here means the payment settled but the wallet
          // didn't surface proof (often a lost NWC ack): keep looking it up and
          // seal the zap late if it turns up.
          if (!preimage) {
            const payment = { amountMsats, bolt11, comment: trimmedComment };
            const post = sendZap!;
            void lookupPreimage(bolt11).then(async (recovered) => {
              if (!recovered) return;
              try {
                await post(target, { ...payment, preimage: recovered });
                notify("success");
              } catch {
                // Sealing failed; the payment still settled.
              }
            });
            notify("warning");
            setStatus("success");
            return "unproven";
          }
          await sendZap!(target, { amountMsats, bolt11, preimage, comment: trimmedComment });
        }
        // NIP-57 zaps don't need the preimage: the provider publishes the receipt.
        notify("success");
        setStatus("success");
        return "paid";
      } catch (e) {
        setStatus("idle");
        throw e;
      }
    },
    [user, sendZap, lnAddressOverride, activeConnection, webln, payWithNWC, lookupPreimage, recipient, target, config.appRelays],
  );

  return { zap, status, invoice, reset };
}
