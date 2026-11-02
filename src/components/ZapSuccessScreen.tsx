import { useMemo } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { DisplayName } from '@/components/DisplayName';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { getAvatarShape } from '@/lib/avatarShape';
import { useAppContext } from '@/hooks/useAppContext';
import { useAuthor } from '@/hooks/useAuthor';
import { formatMoneyAmount } from '@/lib/bitcoinMoney';
import { useEsploraApis } from '@/hooks/useEsploraApis';
import { common, FormattedMessage, useIntl } from '@/i18n';
import { AvatarInitial } from "@/components/AvatarInitial";

interface ZapSuccessScreenProps {
  /** Recipient pubkey (hex), used when `recipientLabel` is omitted. */
  recipientPubkey: string;
  /** Explicit label (e.g. a campaign title) instead of the author lookup. */
  recipientLabel?: string;
  amountSats: number;
  btcPrice: number | undefined;
  /** Bitcoin txid (onchain only). Enables the "View transaction" link. */
  txid?: string;
  onClose: () => void;
}

/** Post-send confirmation screen. */
export function ZapSuccessScreen({
  recipientPubkey,
  recipientLabel,
  amountSats,
  btcPrice,
  txid,
  onClose,
}: ZapSuccessScreenProps) {
  const intl = useIntl();
  const { data: author } = useAuthor(recipientPubkey);
  const { config } = useAppContext();
  const esploraApis = useEsploraApis();
  const metadata = author?.metadata;
  const fallbackName = metadata?.name || metadata?.display_name || intl.formatMessage({ id: 'zapSuccessScreen.anonymous', defaultMessage: 'Anonymous' });
  const displayName = recipientLabel ?? fallbackName;
  const avatarShape = getAvatarShape(metadata);

  // Falls back to sats when USD is preferred but no price is available.
  const amountDisplay = useMemo(
    () => formatMoneyAmount(amountSats, config.currencyDisplay ?? 'usd', btcPrice),
    [amountSats, config.currencyDisplay, btcPrice],
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className="grid gap-5 px-6 py-8 w-full text-center motion-safe:animate-success-fade-up"
    >
      <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-amber-500 motion-safe:animate-success-pop">
        <Check className="size-8 text-white" strokeWidth={3} aria-hidden />
      </div>

      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">
          {recipientLabel ? (
            <FormattedMessage id="zapSuccessScreen.donationSent" defaultMessage="Donation sent" />
          ) : (
            <FormattedMessage id="zapSuccessScreen.bitcoinSent" defaultMessage="Bitcoin sent" />
          )}
        </h2>
        <div className="text-4xl font-bold tabular-nums">
          {amountDisplay}
        </div>
      </div>

      <div className="mx-auto flex items-center gap-3 rounded-full border border-border/70 bg-muted/40 pl-2 pr-4 py-2 max-w-full">
        <Avatar shape={avatarShape} className="size-8 shrink-0">
          <AvatarImage src={metadata?.picture} imeta={author?.imeta?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xs">
            <AvatarInitial name={displayName} />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 text-left">
          <div className="text-2xs text-muted-foreground leading-tight">
            <FormattedMessage id="zapSuccessScreen.to" defaultMessage="To" />
          </div>
          <div className="text-sm font-medium truncate max-w-[220px]">
            {/* A campaign label isn't a Nostr profile, so no custom emoji. */}
            {recipientLabel ?? <DisplayName pubkey={recipientPubkey} name={fallbackName} />}
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        {txid && (
          <Button
            type="button"
            variant="outline"
            asChild
            className="w-full"
          >
            <a
              href={`${esploraApis[0]}/tx/${txid}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
            >
              <ExternalLink className="size-4 mr-2" />
              <FormattedMessage id="zapSuccessScreen.viewTransaction" defaultMessage="View transaction" />
            </a>
          </Button>
        )}
        <Button type="button" onClick={onClose} className="w-full">
          <FormattedMessage {...common.done} />
        </Button>
      </div>
    </div>
  );
}
