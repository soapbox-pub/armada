import { Ban } from "lucide-react";

import { FormattedMessage } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Shown in place of anything a user the blocklist bans posted
 * (`bannedUsers.ts`): their content is purged from the device, and this says
 * where it was.
 */
export function BannedTombstone({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm italic text-muted-foreground", className)}>
      <Ban aria-hidden className="size-3.5 shrink-0" />
      <FormattedMessage id="bannedUser.tombstone" defaultMessage="Removed: this account is unavailable in Armada" />
    </span>
  );
}
