import { Bot } from 'lucide-react';

import { useAuthor } from '@/hooks/useAuthor';
import { FormattedMessage, useIntl } from '@/i18n';
import { cn } from '@/lib/utils';

import type { NostrMetadata } from '@nostrify/nostrify';

interface BotPillProps {
  /** Resolve the bot flag from this pubkey's kind-0. Ignored when `metadata` is supplied. */
  pubkey?: string;
  metadata?: NostrMetadata;
  className?: string;
  labelClassName?: string;
}

/**
 * "Bot" pill when the profile declares `bot: true` (NIP-24). Renders nothing
 * for non-bot or unknown accounts.
 */
export function BotPill({ pubkey, metadata, className, labelClassName }: BotPillProps) {
  // Skip even an inert `useAuthor(undefined)`: a timeline renders one per byline.
  if (metadata || !pubkey) return <BotPillView metadata={metadata} className={className} labelClassName={labelClassName} />;
  return <ResolvedBotPill pubkey={pubkey} className={className} labelClassName={labelClassName} />;
}

function ResolvedBotPill({ pubkey, className, labelClassName }: { pubkey: string; className?: string; labelClassName?: string }) {
  const author = useAuthor(pubkey);
  return <BotPillView metadata={author.data?.metadata} className={className} labelClassName={labelClassName} />;
}

function BotPillView({ metadata, className, labelClassName }: { metadata?: NostrMetadata; className?: string; labelClassName?: string }) {
  const intl = useIntl();
  if (metadata?.bot !== true) return null;

  return (
    <span
      title={intl.formatMessage({ id: 'botPill.title', defaultMessage: 'Bot account' })}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-3xs font-medium text-sky-500',
        className,
      )}
    >
      <Bot className="size-3" aria-hidden />
      <span className={labelClassName}><FormattedMessage id="botPill.label" defaultMessage="Bot" /></span>
    </span>
  );
}
