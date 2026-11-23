import { Crown, Shield } from 'lucide-react';

import { useStaffRole, useStaffTier } from '@/hooks/useMemberRoles';
import { defineMessages, FormattedMessage, useIntl } from '@/i18n';
import { cn } from '@/lib/utils';

const LABEL = defineMessages({
  owner: { id: 'staffPill.owner', defaultMessage: 'Owner' },
  admin: { id: 'staffPill.admin', defaultMessage: 'Admin' },
  moderator: { id: 'staffPill.moderator', defaultMessage: 'Mod' },
});
const TITLE = defineMessages({
  owner: { id: 'staffPill.ownerTitle', defaultMessage: 'Community owner' },
  admin: { id: 'staffPill.adminTitle', defaultMessage: 'Community admin' },
  moderator: { id: 'staffPill.moderatorTitle', defaultMessage: 'Community moderator' },
});
const TINT = {
  owner: 'bg-amber-500/15 text-amber-500',
  admin: 'bg-primary/15 text-primary',
  moderator: 'bg-muted text-muted-foreground',
} as const;

/**
 * Owner/Admin/Mod pill beside a byline, matching the member list's tiers. A staff
 * tier is labelled with the Role that earns it, as the profile card names it.
 * Renders nothing outside a community scope or for a regular member.
 */
export function StaffPill({ pubkey, className }: { pubkey: string; className?: string }) {
  const intl = useIntl();
  const tier = useStaffTier(pubkey);
  const role = useStaffRole(tier && tier !== 'owner' ? pubkey : undefined);
  if (!tier) return null;
  const Icon = tier === 'owner' ? Crown : Shield;

  return (
    <span
      title={role
        ? intl.formatMessage({ id: 'staffPill.roleTitle', defaultMessage: '{role} ({tier})' }, { role: role.name, tier: intl.formatMessage(TITLE[tier]) })
        : intl.formatMessage(TITLE[tier])}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium',
        // A Role name is up to 64 bytes: it truncates before the byline's name does.
        role ? 'shrink min-w-0 max-w-[35%]' : 'shrink-0',
        TINT[tier],
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {role ? <span className="truncate">{role.name}</span> : <FormattedMessage {...LABEL[tier]} />}
    </span>
  );
}
