import { useNostrLogin } from '@nostrify/react/login';
import { Gem } from 'lucide-react';
import { useContext, useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FormattedMessage, useIntl } from '@/i18n';
import { SettingsOverlayContext } from '@/lib/settingsOverlay';
import { readUltra } from '@/lib/ultra';
import { cn } from '@/lib/utils';

import type { NostrMetadata } from '@nostrify/nostrify';

const PILL_CLASS =
  'shrink-0 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-fuchsia-500/20 to-cyan-400/20 px-1.5 py-0.5 text-3xs font-semibold text-fuchsia-400';

interface UltraPillProps {
  metadata?: NostrMetadata;
  force?: boolean;
  className?: string;
  labelClassName?: string;
  /** Off inside a row that is itself a button or pick target: no nested button, and a tap still picks the row. */
  interactive?: boolean;
}

/** "Ultra" pill beside a byline when the profile carries Armada Ultra; opens a details popover like `ProxyPill`. */
export function UltraPill({ metadata, force, className, labelClassName, interactive = true }: UltraPillProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  if (!force && !readUltra(metadata)) return null;

  const title = intl.formatMessage({ id: 'ultraPill.title', defaultMessage: 'Armada Ultra member' });
  const body = (
    <>
      <Gem className="size-3" aria-hidden />
      <span className={labelClassName}>Ultra</span>
    </>
  );

  if (!interactive) {
    return <span title={title} className={cn(PILL_CLASS, className)}>{body}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          className={cn(PILL_CLASS, 'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring', className)}
        >
          {body}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[16rem] p-2 text-xs">
        <UltraPillDetails onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Mounted only while open, so the login lookup isn't paid per byline. */
function UltraPillDetails({ onNavigate }: { onNavigate: () => void }) {
  const loggedIn = useNostrLogin().logins.length > 0;
  const settings = useContext(SettingsOverlayContext);

  return (
    <p>
      <FormattedMessage id="ultraPill.description" defaultMessage="Armada Ultra member. All the premium perks, for $0.00." />
      {loggedIn && (
        <>
          {' '}
          <button
            type="button"
            className="font-medium underline underline-offset-2 hover:no-underline"
            onClick={() => {
              onNavigate();
              settings.show('ultra');
            }}
          >
            <FormattedMessage id="ultraPill.getUltra" defaultMessage="Get Ultra" />
          </button>
        </>
      )}
    </p>
  );
}
