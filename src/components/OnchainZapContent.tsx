import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { AlertTriangle, Bitcoin, Check, Copy, Loader2, MessageCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useNostrLogin } from '@nostrify/react/login';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { AmountField, formatPresetLabel } from '@/components/AmountField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { QRCodeCanvas } from '@/components/ui/qrcode';

import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useBitcoinSigner } from '@/hooks/useBitcoinSigner';
import { useOnchainZap, type OnchainFeeSpeed } from '@/hooks/useOnchainZap';
import { useEsploraApis } from '@/hooks/useEsploraApis';
import { useToast } from '@/hooks/useToast';
import { writeClipboardText } from '@/lib/clipboard';
import { common, defineMessages, FormattedMessage, t, useIntl, type MessageDescriptor } from '@/i18n';
import {
  nostrPubkeyToBitcoinAddress,
  fetchUTXOs,
  fetchBtcPrice,
  getFeeRates,
  estimateFee,
  isLargeAmount,
  formatSats,
  amountInputToSats,
  formatAmountInput,
  formatMoneyAmount,
  presetsFor,
  type AmountPresetSet,
} from '@/lib/bitcoin';
import type { BitcoinRecipientOverride } from '@/hooks/useOnchainZap';
import type { CurrencyDisplay } from '@/contexts/AppContext';
import type { NostrRumor } from "@/lib/nostrRumor";

/** The sats row is hand-picked round numbers, not a conversion of the USD row. */
const PRESETS: AmountPresetSet = {
  usd: [1, 5, 20, 50, 100],
  sats: [1_000, 5_000, 20_000, 50_000, 100_000],
};

function defaultAmount(currency: CurrencyDisplay): number {
  return currency === 'sats' ? 5_000 : 5;
}

const FEE_SPEED_LABELS: Record<OnchainFeeSpeed, MessageDescriptor> = defineMessages({
  fastest: { id: 'onchainZapContent.fee.fastest', defaultMessage: '~10 min' },
  halfHour: { id: 'onchainZapContent.fee.halfHour', defaultMessage: '~30 min' },
  hour: { id: 'onchainZapContent.fee.hour', defaultMessage: '~1 hour' },
  economy: { id: 'onchainZapContent.fee.economy', defaultMessage: '~1 day' },
});

const FEE_SPEED_ORDER: OnchainFeeSpeed[] = ['fastest', 'halfHour', 'hour', 'economy'];

function getRateForSpeed(rates: { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }, speed: OnchainFeeSpeed): number {
  switch (speed) {
    case 'fastest': return rates.fastestFee;
    case 'halfHour': return rates.halfHourFee;
    case 'hour': return rates.hourFee;
    case 'economy': return rates.economyFee;
  }
}

function getUniqueFeeSpeeds(
  rates: { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number } | undefined,
): OnchainFeeSpeed[] {
  if (!rates) return FEE_SPEED_ORDER;
  const seen = new Set<number>();
  const result: OnchainFeeSpeed[] = [];
  for (const speed of FEE_SPEED_ORDER) {
    const rate = getRateForSpeed(rates, speed);
    if (!seen.has(rate)) {
      seen.add(rate);
      result.push(speed);
    }
  }
  return result;
}

interface OnchainZapContentProps {
  target: NostrRumor;
  bitcoinTarget?: BitcoinRecipientOverride;
  sendOnchainZap?: (target: NostrRumor, announcement: { txid: string; amountSats: number; comment: string }) => Promise<void>;
  onSuccess?: (result: { txid: string; amountSats: number }) => void;
  onClose?: () => void;
}

export function OnchainZapContent({ target, bitcoinTarget, sendOnchainZap, onSuccess, onClose }: OnchainZapContentProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { capability } = useBitcoinSigner();
  const { logins } = useNostrLogin();
  const { config } = useAppContext();
  const esploraApis = useEsploraApis();
  const loginType = logins[0]?.type;

  const currency: CurrencyDisplay = config.currencyDisplay ?? 'usd';
  const [amount, setAmount] = useState<number | string>(() => defaultAmount(currency));
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);
  const [feeSpeed, setFeeSpeed] = useState<OnchainFeeSpeed>('halfHour');
  const [error, setError] = useState('');
  const [feePopoverOpen, setFeePopoverOpen] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);

  const feeSpeedUserChanged = useRef(false);

  const senderAddress = user ? nostrPubkeyToBitcoinAddress(user.pubkey) : '';
  const recipientAddress = useMemo(() => {
    if (bitcoinTarget) return bitcoinTarget.value;
    return nostrPubkeyToBitcoinAddress(target.pubkey);
  }, [bitcoinTarget, target.pubkey]);
  const truncatedRecipient = recipientAddress
    ? `${recipientAddress.slice(0, 10)}…${recipientAddress.slice(-8)}`
    : '';

  const { data: btcPrice } = useQuery({
    queryKey: ['btc-price', esploraApis],
    queryFn: ({ signal }) => fetchBtcPrice(esploraApis, signal),
    staleTime: 30_000,
  });

  const { data: utxos } = useQuery({
    queryKey: ['bitcoin-utxos', esploraApis, senderAddress],
    queryFn: ({ signal }) => fetchUTXOs(senderAddress, esploraApis, signal),
    enabled: !!senderAddress && capability !== 'unsupported',
    staleTime: 30_000,
  });

  const { data: feeRates } = useQuery({
    queryKey: ['bitcoin-fee-rates', esploraApis],
    queryFn: ({ signal }) => getFeeRates(esploraApis, signal),
    enabled: capability !== 'unsupported',
    staleTime: 30_000,
  });

  const totalBalance = useMemo(() => utxos?.reduce((s, u) => s + u.value, 0) ?? 0, [utxos]);

  const currentFeeRate = useMemo(() => {
    if (!feeRates) return 0;
    return getRateForSpeed(feeRates, feeSpeed);
  }, [feeRates, feeSpeed]);

  const amountSats = useMemo(
    () => amountInputToSats(amount, currency, btcPrice),
    [amount, currency, btcPrice],
  );

  const estimatedFeeSats = useMemo(() => {
    if (!utxos?.length || !currentFeeRate || !amountSats) return 0;
    const fee2 = estimateFee(utxos.length, 2, currentFeeRate);
    const change = totalBalance - amountSats - fee2;
    const numOutputs = change > 546 ? 2 : 1;
    return estimateFee(utxos.length, numOutputs, currentFeeRate);
  }, [utxos, currentFeeRate, amountSats, totalBalance]);

  const totalSats = amountSats + estimatedFeeSats;
  const insufficient = totalBalance > 0 && totalSats > totalBalance;
  const showBalance = insufficient || (amountSats > 0 && totalBalance === 0);

  useEffect(() => {
    if (feeSpeedUserChanged.current) return;
    if (!utxos?.length || !feeRates || amountSats <= 0) return;

    const uniqueSpeeds = getUniqueFeeSpeeds(feeRates);
    const threshold = amountSats * 0.4;

    let targetSpeed: OnchainFeeSpeed = uniqueSpeeds[uniqueSpeeds.length - 1];
    for (const speed of uniqueSpeeds) {
      const rate = getRateForSpeed(feeRates, speed);
      const fee2 = estimateFee(utxos.length, 2, rate);
      const change = totalBalance - amountSats - fee2;
      const outputs = change > 546 ? 2 : 1;
      const fee = estimateFee(utxos.length, outputs, rate);
      if (fee <= threshold) {
        targetSpeed = speed;
        break;
      }
    }

    setFeeSpeed((prev) => (prev === targetSpeed ? prev : targetSpeed));
  }, [amountSats, feeRates, utxos, totalBalance]);

  const handleFeeSpeedChange = useCallback((speed: OnchainFeeSpeed) => {
    feeSpeedUserChanged.current = true;
    setFeeSpeed(speed);
    setFeePopoverOpen(false);
  }, []);

  const uniqueFeeSpeeds = useMemo(() => getUniqueFeeSpeeds(feeRates), [feeRates]);

  const { zapAsync, isZapping, progress } = useOnchainZap(target, (result) => {
    onSuccess?.({ txid: result.txid, amountSats: result.amountSats });
  }, bitcoinTarget, sendOnchainZap);

  // Two-tap confirmation for large amounts.
  const isLarge = isLargeAmount(totalSats, btcPrice);
  const [confirmArmed, setConfirmArmed] = useState(false);

  // Re-arm whenever amount, fee rate or price moves.
  useEffect(() => {
    setConfirmArmed(false);
  }, [amountSats, currentFeeRate, btcPrice]);

  const handleZap = useCallback(async () => {
    setError('');
    if (!user) { setError(t({ id: 'onchainZapContent.error.loggedOut', defaultMessage: 'You must be logged in.' })); return; }
    if (user.pubkey === target.pubkey) { setError(t({ id: 'onchainZapContent.error.self', defaultMessage: "You can't zap yourself." })); return; }
    // Only USD input needs a price; sats are payable when the price endpoint is down.
    if (currency === 'usd' && !btcPrice) { setError(t({ id: 'onchainZapContent.error.price', defaultMessage: 'Waiting for BTC price…' })); return; }
    if (amountSats <= 0) { setError(t({ id: 'onchainZapContent.error.amount', defaultMessage: 'Enter an amount.' })); return; }
    if (!utxos?.length) { setError(t({ id: 'onchainZapContent.error.noBitcoin', defaultMessage: "You don't have any Bitcoin yet." })); return; }
    if (insufficient) { setError(t({ id: 'onchainZapContent.error.insufficient', defaultMessage: 'Not enough Bitcoin.' })); return; }

    if (isLarge && !confirmArmed) {
      setConfirmArmed(true);
      return;
    }

    try {
      await zapAsync({ amountSats, comment: comment.trim(), feeSpeed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t({ id: 'onchainZapContent.error.failed', defaultMessage: 'Zap failed' });
      const isCapability = /does not support|doesn't support|signpsbt|sign_psbt/i.test(msg);
      if (!isCapability) setError(msg);
    }
  }, [user, target.pubkey, currency, btcPrice, amountSats, utxos, insufficient, zapAsync, comment, feeSpeed, isLarge, confirmArmed]);

  // Falls back to the raw input while the price loads in USD mode.
  const totalDisplay = totalSats > 0
    ? formatMoneyAmount(totalSats, currency, btcPrice)
    : formatAmountInput(amount, currency);

  if (user && capability === 'unsupported') {
    return (
      <UnsupportedSignerQR
        recipientAddress={recipientAddress}
        truncatedRecipient={truncatedRecipient}
        isSilentPayment={bitcoinTarget?.mode === 'sp'}
        amountSats={amountSats}
        btcPrice={btcPrice}
        amount={amount}
        setAmount={setAmount}
        currency={currency}
        loginType={loginType}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="grid gap-4 px-4 py-4 w-full overflow-hidden">
      <div className="grid gap-4 pt-2">
        <AmountField
          value={amount}
          onValueChange={(v) => { setAmount(v); setError(''); }}
          currency={currency}
          editing={editingAmount}
          setEditing={setEditingAmount}
          presets={PRESETS}
          invalid={insufficient}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {showComment && (
        <Input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={intl.formatMessage({ id: 'onchainZapContent.commentPlaceholder', defaultMessage: 'Add a comment (optional)' })}
          maxLength={280}
          aria-label={intl.formatMessage({ id: 'onchainZapContent.comment', defaultMessage: 'Comment' })}
          autoFocus
          className="text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-200"
        />
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={handleZap}
          disabled={isZapping || amountSats <= 0 || insufficient}
          variant={(insufficient || isLarge) && !isZapping ? 'destructive' : 'default'}
          className="flex-1 clip-corner-lg"
        >
          {isZapping ? (
            <>
              <Loader2 className="size-4 mr-1.5 animate-spin" />
              <FormattedMessage {...progressLabel(progress)} />
            </>
          ) : insufficient ? (
            <FormattedMessage id="onchainZapContent.insufficient" defaultMessage="Not enough Bitcoin" />
          ) : isLarge && confirmArmed ? (
            <FormattedMessage
              id="onchainZapContent.confirmSend"
              defaultMessage="Tap again to send {amount}"
              values={{ amount: totalDisplay }}
            />
          ) : (
            <FormattedMessage id="onchainZapContent.send" defaultMessage="Send {amount}" values={{ amount: totalDisplay }} />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setShowComment((v) => !v)}
          aria-label={intl.formatMessage({ id: 'onchainZapContent.addComment', defaultMessage: 'Add a comment' })}
          aria-pressed={showComment}
          className={`clip-corner-lg touch:size-11 ${comment.trim() ? 'text-primary' : 'text-muted-foreground'}`}
        >
          <MessageCircle className="size-4" />
        </Button>
      </div>

      {amountSats > 0 && (
        <div className="flex items-center justify-center gap-3 -mt-1 text-xs">
          <Popover open={feePopoverOpen} onOpenChange={setFeePopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>
                  {estimatedFeeSats > 0 && (currency === 'sats' || btcPrice) ? (
                    <FormattedMessage
                      id="onchainZapContent.feeEstimate"
                      defaultMessage="Fee ≈ {fee}"
                      values={{ fee: formatMoneyAmount(estimatedFeeSats, currency, btcPrice) }}
                    />
                  ) : (
                    <FormattedMessage id="onchainZapContent.feePending" defaultMessage="Fee …" />
                  )}
                  <span className="opacity-60"> · {intl.formatMessage(FEE_SPEED_LABELS[feeSpeed])}</span>
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" sideOffset={6} className="w-56 p-1">
              <div className="flex flex-col">
                {uniqueFeeSpeeds.map((speed) => {
                  const rate = feeRates ? getRateForSpeed(feeRates, speed) : 0;
                  const selected = speed === feeSpeed;
                  return (
                    <button
                      key={speed}
                      type="button"
                      onClick={() => handleFeeSpeedChange(speed)}
                      className={`flex items-center justify-between px-2 py-1.5 rounded-sm text-xs text-left hover:bg-muted transition-colors ${selected ? 'bg-muted font-medium' : ''}`}
                    >
                      <span>{intl.formatMessage(FEE_SPEED_LABELS[speed])}</span>
                      <span className="text-muted-foreground">
                        <FormattedMessage id="onchainZapContent.feeRate" defaultMessage="{rate} sat/vB" values={{ rate }} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          {showBalance && !insufficient && (currency === 'sats' || btcPrice) && (
            <span className="text-muted-foreground">
              <FormattedMessage
                id="onchainZapContent.balance"
                defaultMessage="Balance: {amount}"
                values={{ amount: formatMoneyAmount(totalBalance, currency, btcPrice) }}
              />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const PROGRESS_LABELS = defineMessages({
  building: { id: 'onchainZapContent.progress.building', defaultMessage: 'Building…' },
  signing: { id: 'onchainZapContent.progress.signing', defaultMessage: 'Signing…' },
  broadcasting: { id: 'onchainZapContent.progress.broadcasting', defaultMessage: 'Broadcasting…' },
  publishing: { id: 'onchainZapContent.progress.publishing', defaultMessage: 'Publishing…' },
  processing: { id: 'onchainZapContent.progress.processing', defaultMessage: 'Processing…' },
});

function progressLabel(progress: 'idle' | 'building' | 'signing' | 'broadcasting' | 'publishing'): MessageDescriptor {
  return progress === 'idle' ? PROGRESS_LABELS.processing : PROGRESS_LABELS[progress];
}

interface UnsupportedSignerQRProps {
  recipientAddress: string;
  truncatedRecipient: string;
  /** When true, `recipientAddress` is a BIP-352 silent-payment code. */
  isSilentPayment?: boolean;
  amountSats: number;
  btcPrice: number | undefined;
  amount: number | string;
  setAmount: (v: number | string) => void;
  currency: CurrencyDisplay;
  loginType: string | undefined;
  onClose?: () => void;
}

/** BIP-21 QR fallback for signers that can't sign PSBTs. We never see the tx, so no zap announcement is published. */
function UnsupportedSignerQR({
  recipientAddress,
  truncatedRecipient,
  isSilentPayment,
  amountSats,
  btcPrice,
  amount,
  setAmount,
  currency,
  loginType,
  onClose,
}: UnsupportedSignerQRProps) {
  const intl = useIntl();
  const { toast } = useToast();
  const [copied, setCopied] = useState<'address' | 'uri' | null>(null);

  // Omit `amount` when 0; silent-payment codes go in `sp=` for BIP-352 wallets.
  const bip21 = useMemo(() => {
    if (!recipientAddress) return '';
    const params = new URLSearchParams();
    if (amountSats > 0) {
      params.set('amount', (amountSats / 100_000_000).toFixed(8));
    }
    if (isSilentPayment) {
      params.set('sp', recipientAddress);
      const qs = params.toString();
      return qs ? `bitcoin:?${qs}` : `bitcoin:?sp=${recipientAddress}`;
    }
    const qs = params.toString();
    return qs ? `bitcoin:${recipientAddress}?${qs}` : `bitcoin:${recipientAddress}`;
  }, [recipientAddress, amountSats, isSilentPayment]);

  const signerKind = loginType === 'extension' ? 'extension' : loginType === 'bunker' ? 'bunker' : 'other';

  const copy = useCallback(
    async (value: string, which: 'address' | 'uri') => {
      try {
        await writeClipboardText(value);
        setCopied(which);
        toast({
          title: t(common.copied),
          description: which === 'address'
            ? t({ id: 'onchainZapContent.addressCopied', defaultMessage: 'Address copied to clipboard' })
            : t({ id: 'onchainZapContent.linkCopied', defaultMessage: 'Payment link copied to clipboard' }),
        });
        setTimeout(() => setCopied(null), 2000);
      } catch {
        toast({
          title: t({ id: 'onchainZapContent.copyFailed', defaultMessage: 'Copy failed' }),
          description: t({ id: 'onchainZapContent.copyManually', defaultMessage: 'Please copy manually.' }),
          variant: 'destructive',
        });
      }
    },
    [toast],
  );

  const isSats = currency === 'sats';
  const activePresets = presetsFor(PRESETS, currency);
  const hasAmount = amountSats > 0;

  return (
    <div className="grid gap-3 px-4 py-4 w-full overflow-hidden">
      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="onchainZapContent.unsupported"
          defaultMessage="{signer, select, extension {Your browser extension can't sign Bitcoin transactions.} bunker {Your remote signer can't sign Bitcoin transactions.} other {Your signer can't sign Bitcoin transactions.}} You can still zap by scanning this QR from any Bitcoin wallet."
          values={{ signer: signerKind }}
        />
      </p>

      <ToggleGroup
        type="single"
        value={activePresets.includes(Number(amount)) ? String(amount) : ''}
        onValueChange={(v) => { if (v) setAmount(Number(v)); }}
        className="grid grid-cols-5 gap-1 w-full"
      >
        {activePresets.map((v) => (
          <ToggleGroupItem
            key={v}
            value={String(v)}
            className="h-8 min-w-0 rounded-full text-xs font-semibold px-1"
          >
            {formatPresetLabel(v, currency)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-muted" />
        <span className="text-xs text-muted-foreground">
          <FormattedMessage id="onchainZapContent.or" defaultMessage="OR" />
        </span>
        <div className="h-px flex-1 bg-muted" />
      </div>

      <div className="relative">
        {!isSats && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        )}
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step={isSats ? '1' : '0.01'}
          placeholder={isSats
            ? intl.formatMessage({ id: 'onchainZapContent.customSats', defaultMessage: 'Custom amount (sats)' })
            : intl.formatMessage({ id: 'onchainZapContent.customUsd', defaultMessage: 'Custom amount (USD)' })}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={isSats ? undefined : 'pl-6'}
        />
      </div>

      <div className="flex justify-center">
        {hasAmount && bip21 ? (
          <div className="bg-white p-3 rounded-xl" aria-label={intl.formatMessage({ id: 'onchainZapContent.qrLabel', defaultMessage: 'Bitcoin payment QR code' })}>
            <QRCodeCanvas value={bip21} size={220} level="M" className="block" />
          </div>
        ) : (
          <div className="size-[220px] rounded-xl border border-dashed flex items-center justify-center text-xs text-muted-foreground text-center px-4">
            {isSats || btcPrice ? (
              <FormattedMessage
                id="onchainZapContent.chooseAmount"
                defaultMessage="Choose an amount above to generate a payment QR."
              />
            ) : (
              <FormattedMessage id="onchainZapContent.loadingPrice" defaultMessage="Loading BTC price…" />
            )}
          </div>
        )}
      </div>

      {hasAmount && (
        <div className="text-center text-sm">
          {!isSats && btcPrice && (
            <span className="font-medium">
              {formatMoneyAmount(amountSats, 'usd', btcPrice)}
            </span>
          )}
          <span className="text-muted-foreground">
            {!isSats && btcPrice ? ' · ' : ''}
            <FormattedMessage
              id="onchainZapContent.sats"
              defaultMessage="{amount} sats"
              values={{ amount: formatSats(amountSats) }}
            />
          </span>
        </div>
      )}

      {recipientAddress && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5 min-w-0">
            <Bitcoin className="size-3.5 text-orange-500 shrink-0" />
            <span className="shrink-0">
              <FormattedMessage id="onchainZapContent.to" defaultMessage="To:" />
            </span>
            <span className="font-mono truncate" title={recipientAddress}>{truncatedRecipient}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => copy(recipientAddress, 'address')}
          disabled={!recipientAddress}
          className="text-xs"
        >
          {copied === 'address' ? <Check className="size-3.5 mr-1.5" /> : <Copy className="size-3.5 mr-1.5" />}
          <FormattedMessage id="onchainZapContent.copyAddress" defaultMessage="Copy address" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => copy(bip21, 'uri')}
          disabled={!hasAmount || !bip21}
          className="text-xs"
        >
          {copied === 'uri' ? <Check className="size-3.5 mr-1.5" /> : <Copy className="size-3.5 mr-1.5" />}
          <FormattedMessage {...common.copyLink} />
        </Button>
      </div>

      <Alert>
        <AlertTriangle className="size-4" />
        <AlertDescription className="text-xs">
          <FormattedMessage
            id="onchainZapContent.unattributed"
            defaultMessage="Because we can't see your transaction, this zap won't be attributed to you. The recipient will still get the Bitcoin."
          />
        </AlertDescription>
      </Alert>

      {onClose && (
        <Button type="button" variant="secondary" onClick={onClose} className="w-full">
          <FormattedMessage {...common.done} />
        </Button>
      )}
    </div>
  );
}
