import { Gem } from 'lucide-react';

import { useIntl } from '@/i18n';
import { readUltra } from '@/lib/ultra';
import { cn } from '@/lib/utils';

import type { NostrMetadata } from '@nostrify/nostrify';

/** "Ultra" pill beside a byline when the profile carries Armada Ultra. */
export function UltraPill({ metadata, force, className, labelClassName }: { metadata?: NostrMetadata; force?: boolean; className?: string; labelClassName?: string }) {
  const intl = useIntl();
  if (!force && !readUltra(metadata)) return null;

  return (
    <span
      title={intl.formatMessage({ id: 'ultraPill.title', defaultMessage: 'Armada Ultra member' })}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-fuchsia-500/20 to-cyan-400/20 px-1.5 py-0.5 text-3xs font-semibold text-fuchsia-400',
        className,
      )}
    >
      <Gem className="size-3" aria-hidden />
      <span className={labelClassName}>Ultra</span>
    </span>
  );
}
