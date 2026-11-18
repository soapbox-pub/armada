import { ChevronDown, Copy, ExternalLink, HelpCircle, Loader2, MessageCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { AmountField } from "@/components/AmountField";
import { DisplayName } from "@/components/DisplayName";
import { OnchainZapContent } from "@/components/OnchainZapContent";
import { GenericPaymentContent } from "@/components/GenericPaymentContent";
import { PaymentMethodIcon } from "@/components/PaymentMethodIcon";
import { ZapSuccessScreen } from "@/components/ZapSuccessScreen";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QRCodeCanvas } from "@/components/ui/qrcode";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useBitcoinSigner } from "@/hooks/useBitcoinSigner";
import { useEsploraApis } from "@/hooks/useEsploraApis";
import { usePaymentTargets } from "@/hooks/usePaymentTargets";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";
import { useZap } from "@/hooks/useZap";
import { canZap } from "@/lib/canZap";
import { pickDefaultZapMethod } from "@/components/chat/zapDefaultMethod";
import { writeClipboardText } from "@/lib/clipboard";
import {
  amountInputToSats,
  fetchBtcPrice,
  formatAmountInput,
  formatMoneyAmount,
  formatSatsAmount,
  isLargeAmount,
  type AmountPresetSet,
} from "@/lib/bitcoinMoney";
import {
  PAYMENT_METHODS,
  findBitcoinTarget,
  findLightningTarget,
  isSilentPaymentLike,
  type PaymentMethodDef,
  type PaymentTarget,
} from "@/lib/paymentTargets";
import { common, FormattedMessage, useIntl, type IntlShape } from "@/i18n";

import type { ChatMsg, OnchainZapAnnouncement, ZapPayment } from "@/components/chat/transport";
import type { CurrencyDisplay } from "@/contexts/AppContext";

interface ZapDialogImplProps {
  target: ChatMsg;
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  sendOnchainZap?: (target: ChatMsg, announcement: OnchainZapAnnouncement) => Promise<void>;
  onDone: () => void;
}

/** Lightning presets stay in tip-jar territory; on-chain has a per-tx fee floor. */
const LIGHTNING_PRESETS: AmountPresetSet = {
  usd: [0.1, 0.5, 1, 2, 5],
  sats: [100, 500, 1_000, 2_100, 5_000],
};

function defaultAmount(currency: CurrencyDisplay): number {
  return currency === "sats" ? 500 : 0.5;
}

type DialogMethodId = string;

interface DialogMethod {
  id: DialogMethodId;
  def: PaymentMethodDef;
  target?: PaymentTarget;
}

function methodTitle(method: DialogMethod | undefined, intl: IntlShape): string {
  if (!method || method.def.kind === "bitcoin") {
    return intl.formatMessage({ id: "zapDialogImpl.sendBitcoin", defaultMessage: "Send Bitcoin" });
  }
  return method.def.label;
}

export default function ZapDialogImpl({ target, sendZap, sendOnchainZap, onDone }: ZapDialogImplProps) {
  const intl = useIntl();
  const { config } = useAppContext();
  const { toast } = useToast();
  const { activeConnection, webln } = useWallet();
  const author = useAuthor(target.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(target.pubkey, metadata);

  const isPrivate = Boolean(sendZap);
  // A private zap's tally is proven by the preimage, which only a connected
  // wallet (NWC / WebLN) can return, so the pane blocks without one.
  const walletRequired = isPrivate && !activeConnection && !webln;
  const hasLightning = canZap(metadata);

  const { targets: paymentTargets, isLoading: targetsLoading } = usePaymentTargets(target.pubkey);
  const lightningTarget = useMemo(() => findLightningTarget(paymentTargets), [paymentTargets]);
  const bitcoinTarget = useMemo(() => findBitcoinTarget(paymentTargets), [paymentTargets]);
  const bitcoinOverride = useMemo(
    () =>
      bitcoinTarget
        ? {
            value: bitcoinTarget.authority,
            mode: isSilentPaymentLike(bitcoinTarget.authority) ? ("sp" as const) : ("onchain" as const),
          }
        : undefined,
    [bitcoinTarget],
  );

  const genericTargets = useMemo(
    () => paymentTargets.filter((t) => t.type !== "bitcoin" && t.type !== "lightning"),
    [paymentTargets],
  );

  const { capability: btcCapability } = useBitcoinSigner();
  const bitcoinUnsupported = btcCapability === "unsupported";

  const methods = useMemo<DialogMethod[]>(() => {
    const list: DialogMethod[] = [{ id: "bitcoin", def: PAYMENT_METHODS.bitcoin }];
    if (hasLightning || lightningTarget) {
      list.push({ id: "lightning", def: PAYMENT_METHODS.lightning });
    }
    for (const t of genericTargets) {
      list.push({ id: t.type, def: PAYMENT_METHODS[t.type], target: t });
    }
    return list;
  }, [hasLightning, lightningTarget, genericTargets]);

  const defaultMethodId: DialogMethodId = pickDefaultZapMethod({
    preferred: config.defaultZapMethod,
    available: methods.map((m) => m.id),
    lightningAvailable: hasLightning || Boolean(lightningTarget),
    walletRequired,
    bitcoinUnsupported,
  });
  // `null` follows the computed default: NIP-A3 targets load async, so the
  // default may change until the user picks a method.
  const [userMethod, setUserMethod] = useState<DialogMethodId | null>(null);
  const activeMethod = userMethod ?? defaultMethodId;
  const currentMethod = methods.find((m) => m.id === activeMethod) ?? methods[0];

  const [success, setSuccess] = useState<
    | { kind: "onchain"; amountSats: number; txid: string }
    | { kind: "lightning"; amountSats: number }
    | null
  >(null);

  const esploraApis = useEsploraApis();
  const { data: btcPrice } = useQuery({
    queryKey: ["btc-price", esploraApis],
    queryFn: ({ signal }) => fetchBtcPrice(esploraApis, signal),
    staleTime: 30_000,
  });

  // Amount is in the user's display currency; converted to sats before the LNURL call.
  const currency: CurrencyDisplay = config.currencyDisplay ?? "usd";
  const [amount, setAmount] = useState<number | string>(() => defaultAmount(currency));
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const [error, setError] = useState("");
  const [confirmArmed, setConfirmArmed] = useState(false);

  const amountSats = useMemo(
    () => amountInputToSats(amount, currency, btcPrice),
    [amount, currency, btcPrice],
  );
  const isLarge = isLargeAmount(amountSats, btcPrice);
  // In USD mode `amountSats` is 0 until the BTC price lands.
  const amountDisplay = amountSats > 0
    ? formatMoneyAmount(amountSats, currency, btcPrice)
    : formatAmountInput(amount, currency);

  const { zap, status, invoice } = useZap({
    target,
    recipient: { pubkey: target.pubkey, metadata },
    lnAddressOverride: lightningTarget?.authority,
    sendZap,
  });

  const busy = status === "resolving" || status === "paying";
  const showingInvoice = status === "manual" && invoice;

  // Re-arm whenever the amount moves so editing after arming needs another click.
  useEffect(() => {
    setConfirmArmed(false);
  }, [amountSats]);

  const handleLightningZap = async () => {
    setError("");
    if (currency === "usd" && !btcPrice) { setError(intl.formatMessage({ id: "zapDialogImpl.waitingForPrice", defaultMessage: "Waiting for BTC price…" })); return; }
    if (amountSats <= 0) { setError(intl.formatMessage({ id: "zapDialogImpl.enterAmount", defaultMessage: "Enter an amount." })); return; }

    // Two-tap safety for large amounts.
    if (isLarge && !confirmArmed) {
      setConfirmArmed(true);
      return;
    }

    try {
      const outcome = await zap(amountSats, comment.trim());
      if (outcome === "paid") {
        setSuccess({ kind: "lightning", amountSats });
      } else if (outcome === "unproven") {
        toast({
          title: intl.formatMessage(
            { id: "zapDialogImpl.sentTitle", defaultMessage: "Sent {amount}" },
            { amount: formatSatsAmount(amountSats) },
          ),
          description: intl.formatMessage({
            id: "zapDialogImpl.unprovenDescription",
            defaultMessage: "The payment went through, but the wallet hasn't provided the proof a private zap tally needs. We'll keep checking for a couple of minutes and count the zap if it turns up. Alby Hub, Coinos and lnbits provide it reliably.",
          }),
        });
        setSuccess({ kind: "lightning", amountSats });
      }
      // "manual" keeps the dialog open for the QR view.
    } catch (e) {
      toast({
        title: intl.formatMessage({ id: "zapDialogImpl.zapFailed", defaultMessage: "Zap failed" }),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const handleCopy = () => {
    if (invoice) {
      void writeClipboardText(invoice);
      toast({ title: intl.formatMessage({ id: "zapDialogImpl.invoiceCopied", defaultMessage: "Invoice copied" }) });
    }
  };

  const openInWallet = () => {
    if (invoice) window.location.href = `lightning:${invoice}`;
  };

  return (
    <>
      <div className="flex items-center justify-between px-4 h-12">
        <h2 className="font-mono text-lg font-bold lowercase tracking-tight flex items-center gap-1.5 min-w-0">
          {success ? (
            <FormattedMessage id="zapDialogImpl.success" defaultMessage="Success" />
          ) : showingInvoice ? (
            <FormattedMessage id="zapDialogImpl.lightningPayment" defaultMessage="Lightning Payment" />
          ) : targetsLoading ? (
            <Skeleton className="h-5 w-28" />
          ) : methods.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 min-w-0 rounded-md px-1 -mx-1 hover:bg-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                  aria-label={intl.formatMessage({ id: "zapDialogImpl.switchMethod", defaultMessage: "Switch payment method" })}
                >
                  <PaymentMethodIcon method={currentMethod?.def} />
                  <span className="truncate">{methodTitle(currentMethod, intl)}</span>
                  <ChevronDown className="size-4 shrink-0 opacity-70" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44" onClick={(e) => e.stopPropagation()}>
                {methods.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={() => setUserMethod(m.id)}
                    className="gap-2"
                  >
                    <PaymentMethodIcon method={m.def} />
                    <span>{m.def.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="truncate">
              {isPrivate ? (
                methodTitle(currentMethod, intl)
              ) : (
                <FormattedMessage
                  id="zapDialogImpl.zapName"
                  defaultMessage="Zap {name}"
                  values={{
                    name: (
                      <span className="normal-case">
                        <DisplayName pubkey={target.pubkey} name={displayName} />
                      </span>
                    ),
                  }}
                />
              )}
            </span>
          )}
          {isPrivate && !showingInvoice && !success && !targetsLoading && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={intl.formatMessage({ id: "zapDialogImpl.howPrivateZapsWork", defaultMessage: "How private zaps work" })}
                >
                  <HelpCircle className="size-4 shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" className="w-72 p-3 text-xs leading-relaxed text-foreground/80">
                <FormattedMessage
                  id="zapDialogImpl.privateExplainer"
                  defaultMessage="Payment proof (preimage) is sealed into the channel so members verify the zap locally. No public receipt, no relay tally."
                />
              </PopoverContent>
            </Popover>
          )}
        </h2>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex size-8 touch:size-11 -mr-1.5 items-center justify-center clip-corner-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          aria-label={intl.formatMessage(common.close)}
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="overflow-y-auto max-h-[calc(95vh-3rem)]">
        {success ? (
          <ZapSuccessScreen
            recipientPubkey={target.pubkey}
            amountSats={success.amountSats}
            btcPrice={btcPrice}
            txid={success.kind === "onchain" ? success.txid : undefined}
            onClose={onDone}
          />
        ) : targetsLoading ? (
          // Skeleton until NIP-A3 targets resolve, so the pane doesn't flip after paint.
          <ZapMethodSkeleton />
        ) : showingInvoice ? (
          <LightningInvoiceView
            invoice={invoice!}
            amountDisplay={amountDisplay}
            webln={!!webln}
            busy={busy}
            onPay={handleLightningZap}
            onCopy={handleCopy}
            onOpenInWallet={openInWallet}
          />
        ) : currentMethod?.def.kind === "lightning" ? (
          <LightningZapPane
            amount={amount}
            setAmount={setAmount}
            currency={currency}
            amountSats={amountSats}
            amountDisplay={amountDisplay}
            isLarge={isLarge}
            confirmArmed={confirmArmed}
            comment={comment}
            setComment={setComment}
            showComment={showComment}
            setShowComment={setShowComment}
            editingAmount={editingAmount}
            setEditingAmount={setEditingAmount}
            error={error}
            setError={setError}
            busy={busy}
            status={status}
            walletRequired={walletRequired}
            onZap={handleLightningZap}
          />
        ) : currentMethod?.def.kind === "generic" && currentMethod.target ? (
          <GenericPaymentContent method={currentMethod.def} target={currentMethod.target} />
        ) : (
          <OnchainZapContent
            target={target}
            bitcoinTarget={bitcoinOverride}
            sendOnchainZap={sendOnchainZap}
            onSuccess={({ txid, amountSats }) => setSuccess({ kind: "onchain", amountSats, txid })}
            onClose={onDone}
          />
        )}
      </div>
    </>
  );
}

function ZapMethodSkeleton() {
  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden" aria-hidden>
      <div className="flex flex-col items-center gap-2 pt-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="grid grid-cols-5 gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-10 w-full rounded-full" />
    </div>
  );
}

interface LightningZapPaneProps {
  /** Raw amount input, denominated in `currency`. */
  amount: number | string;
  setAmount: (v: number | string) => void;
  currency: CurrencyDisplay;
  amountSats: number;
  amountDisplay: string;
  isLarge: boolean;
  confirmArmed: boolean;
  comment: string;
  setComment: (v: string) => void;
  showComment: boolean;
  setShowComment: (v: boolean) => void;
  editingAmount: boolean;
  setEditingAmount: (v: boolean) => void;
  error: string;
  setError: (s: string) => void;
  busy: boolean;
  status: string;
  /** Private zap with no connected wallet: block the CTA (no provable payment). */
  walletRequired: boolean;
  onZap: () => void;
}

function LightningZapPane({
  amount,
  setAmount,
  currency,
  amountSats,
  amountDisplay,
  isLarge,
  confirmArmed,
  comment,
  setComment,
  showComment,
  setShowComment,
  editingAmount,
  setEditingAmount,
  error,
  setError,
  busy,
  status,
  walletRequired,
  onZap,
}: LightningZapPaneProps) {
  const intl = useIntl();
  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <div className="grid gap-3 pt-2">
        <AmountField
          value={amount}
          onValueChange={(v) => { setAmount(v); setError(""); }}
          currency={currency}
          editing={editingAmount}
          setEditing={setEditingAmount}
          presets={LIGHTNING_PRESETS}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {walletRequired && (
        <p className="text-xs text-amber-500">
          <FormattedMessage
            id="zapDialogImpl.walletRequired"
            defaultMessage="Private zaps need a payment proof. Connect a wallet (Settings → Wallet) or switch to Bitcoin or another method from the menu above."
          />
        </p>
      )}

      {/* Comment goes into the NIP-57 zap request, or sealed into the private announcement. */}
      {showComment && (
        <Input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={intl.formatMessage({ id: "zapDialogImpl.commentPlaceholder", defaultMessage: "Add a comment (optional)" })}
          maxLength={280}
          aria-label={intl.formatMessage({ id: "zapDialogImpl.comment", defaultMessage: "Comment" })}
          autoFocus
          className="text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-200"
        />
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onZap}
          disabled={busy || amountSats <= 0 || walletRequired}
          variant={isLarge && !busy ? "destructive" : "default"}
          className="flex-1 clip-corner-lg"
        >
          {busy ? (
            <>
              <Loader2 className="size-4 mr-1.5 animate-spin" />
              {status === "resolving" ? intl.formatMessage({ id: "zapDialogImpl.creatingInvoice", defaultMessage: "Creating invoice…" }) : intl.formatMessage({ id: "zapDialogImpl.paying", defaultMessage: "Paying…" })}
            </>
          ) : isLarge && confirmArmed ? (
            <FormattedMessage
              id="zapDialogImpl.tapAgain"
              defaultMessage="Tap again to send {amount}"
              values={{ amount: amountDisplay }}
            />
          ) : (
            <FormattedMessage id="zapDialogImpl.send" defaultMessage="Send {amount}" values={{ amount: amountDisplay }} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setShowComment(!showComment)}
          aria-label={intl.formatMessage({ id: "zapDialogImpl.addComment", defaultMessage: "Add a comment" })}
          aria-pressed={showComment}
          className={`clip-corner-lg touch:size-11 ${comment.trim() ? "text-primary" : "text-muted-foreground"}`}
        >
          <MessageCircle className="size-4" />
        </Button>
      </div>
    </div>
  );
}

interface LightningInvoiceViewProps {
  invoice: string;
  amountDisplay: string;
  webln: boolean;
  busy: boolean;
  onPay: () => void;
  onCopy: () => void;
  onOpenInWallet: () => void;
}

function LightningInvoiceView({
  invoice,
  amountDisplay,
  webln,
  busy,
  onPay,
  onCopy,
  onOpenInWallet,
}: LightningInvoiceViewProps) {
  const intl = useIntl();
  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <div className="flex flex-col items-center pt-1">
        <div className="text-3xl font-semibold tabular-nums">
          {amountDisplay}
        </div>
      </div>

      <div className="flex justify-center">
        <div className="bg-white p-3 rounded-xl" aria-label={intl.formatMessage({ id: "zapDialogImpl.invoiceQr", defaultMessage: "Lightning invoice QR code" })}>
          <QRCodeCanvas value={invoice.toUpperCase()} size={220} level="M" className="block" />
        </div>
      </div>

      <div className="flex gap-2 min-w-0">
        <Input
          value={invoice}
          readOnly
          aria-label={intl.formatMessage({ id: "zapDialogImpl.invoice", defaultMessage: "Lightning invoice" })}
          className="font-mono text-xs min-w-0 flex-1 overflow-hidden text-ellipsis"
          onClick={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onCopy}
          className="shrink-0"
          aria-label={intl.formatMessage({ id: "zapDialogImpl.copyInvoice", defaultMessage: "Copy invoice" })}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-2">
        {webln && (
          <Button type="button" onClick={onPay} disabled={busy} className="w-full">
            {busy ? (
              <>
                <Loader2 className="size-4 mr-1.5 animate-spin" />
                <FormattedMessage id="zapDialogImpl.processing" defaultMessage="Processing…" />
              </>
            ) : (
              <FormattedMessage id="zapDialogImpl.payWithWebln" defaultMessage="Pay with WebLN" />
            )}
          </Button>
        )}
        <Button
          type="button"
          variant={webln ? "outline" : "default"}
          onClick={onOpenInWallet}
          className="w-full"
        >
          <ExternalLink className="h-4 w-4 mr-2" />
          <FormattedMessage id="zapDialogImpl.openInWallet" defaultMessage="Open in Lightning Wallet" />
        </Button>
      </div>

      <p className="text-2xs text-muted-foreground text-center">
        <FormattedMessage id="zapDialogImpl.scanHint" defaultMessage="Scan the QR or copy the invoice to pay with any Lightning wallet." />
      </p>
    </div>
  );
}
