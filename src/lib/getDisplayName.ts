import type { NostrMetadata } from '@nostrify/nostrify';

import { t } from '@/i18n/intl';

/**
 * name → display_name → "Anonymous" (in the active language). Truncate via CSS, not here, so NIP-30
 * emoji shortcodes aren't broken.
 */
export function getDisplayName(
  metadata: NostrMetadata | undefined,
  _pubkey?: string,
): string {
  return metadata?.name || metadata?.display_name || anonymousName();
}

function anonymousName(): string {
  return t({ id: 'notification.anonymous', defaultMessage: 'Anonymous' });
}

/**
 * Whether `name` is the "Anonymous" fallback. Compares the string, so a kind 0 named
 * "Anonymous" is treated the same: every catalog spells the fallback identically.
 */
export function isAnonymousName(name: string | undefined): boolean {
  return !!name && name === anonymousName();
}
