import { Copy, ExternalLink, Loader2, Zap } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { QRCodeCanvas } from "@/components/ui/qrcode";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";
import { useZap } from "@/hooks/useZap";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
import { ZAP_PRESETS, formatSats } from "@/lib/zaps";
import { cn } from "@/lib/utils";

import type { ChatMsg, ZapPayment } from "@/components/chat/transport";

interface ZapDialogImplProps {
  target: ChatMsg;
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  onDone: () => void;
}

/** The zap dialog body: amount presets, custom amount, comment, pay, QR fallback. */
export default function ZapDialogImpl({ target, sendZap, onDone }: ZapDialogImplProps) {
  const { config } = useAppContext();
  const { toast } = useToast();
  const { activeConnection, webln } = useWallet();
  const author = useAuthor(target.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(target.pubkey, metadata);

  const [amount, setAmount] = useState<number>(config.defaultZapAmount || ZAP_PRESETS[1]);
  const [custom, setCustom] = useState("");
  const [comment, setComment] = useState("");

  const { zap, status, invoice, reset } = useZap({
    target,
    recipient: { pubkey: target.pubkey, metadata },
    sendZap,
  });

  const isPrivate = Boolean(sendZap);
  const hasLightning = Boolean(metadata?.lud16 || metadata?.lud06);
  const hasWallet = Boolean(activeConnection || webln);
  const busy = status === "resolving" || status === "paying";
  const effectiveAmount = custom.trim() ? Math.floor(Number(custom)) : amount;

  const handleZap = async () => {
    try {
      const outcome = await zap(effectiveAmount, comment);
      if (outcome === "paid") {
        toast({ title: `Zapped ${formatSats(effectiveAmount)} sats ⚡` });
        onDone();
      } else if (outcome === "unproven") {
        // The sats went through; this wallet just can't provide the proof a
        // private-zap tally needs. Inform, don't alarm.
        toast({
          title: `Sent ${formatSats(effectiveAmount)} sats ⚡`,
          description:
            "The payment went through, but this wallet can't provide the proof needed to show a private zap tally here. Use a wallet like Alby Hub, Coinos, or lnbits to have private zaps counted.",
        });
        onDone();
      }
      // "manual" keeps the dialog open — the state flip re-renders the QR view.
    } catch (e) {
      toast({
        title: "Zap failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  if (status === "manual" && invoice) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Pay with a lightning wallet</DialogTitle>
          <DialogDescription>
            Scan or open the invoice; the zap appears once the payment settles.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-lg bg-white p-2">
            <QRCodeCanvas value={invoice.toUpperCase()} size={224} />
          </div>
          <div className="flex w-full gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                void writeClipboardText(invoice);
                toast({ title: "Invoice copied" });
              }}
            >
              <Copy className="size-4" /> Copy
            </Button>
            <Button asChild variant="secondary" className="flex-1">
              <a href={`lightning:${invoice}`}>
                <ExternalLink className="size-4" /> Open wallet
              </a>
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { reset(); onDone(); }}>
            Done
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Zap className="size-4 text-amber-500" />
          {isPrivate ? "Private Zap" : "Zap"} {displayName}
        </DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          <Avatar shape={getAvatarShape(metadata)} className="size-5">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="text-[9px]">{displayName[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
          Send sats over lightning for this message.
        </DialogDescription>
      </DialogHeader>

      {!hasLightning ? (
        <p className="text-sm text-muted-foreground">
          {displayName} hasn't set a lightning address on their profile, so they can't receive
          zaps yet.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {ZAP_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  setAmount(preset);
                  setCustom("");
                }}
                className={cn(
                  "rounded-lg border px-2 py-2 text-sm font-medium tabular-nums transition-colors",
                  !custom.trim() && amount === preset
                    ? "border-amber-500 bg-amber-500/15 text-amber-500"
                    : "border-border/60 bg-secondary/40 hover:border-foreground/40",
                )}
              >
                ⚡ {formatSats(preset)}
              </button>
            ))}
          </div>
          <Input
            type="number"
            min={1}
            placeholder="Custom amount (sats)"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <Input
            placeholder="Comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={200}
          />
          {isPrivate && !hasWallet && (
            <p className="text-xs text-amber-500">
              Private zaps need a payment proof, so connect a wallet first (Settings → Wallet).
            </p>
          )}
          <Button
            className="w-full"
            disabled={busy || !effectiveAmount || effectiveAmount < 1 || (isPrivate && !hasWallet)}
            onClick={handleZap}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {status === "resolving" ? "Fetching invoice…" : "Paying…"}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                Zap {effectiveAmount >= 1 ? `${formatSats(effectiveAmount)} sats` : ""}
              </>
            )}
          </Button>
        </div>
      )}
    </>
  );
}
