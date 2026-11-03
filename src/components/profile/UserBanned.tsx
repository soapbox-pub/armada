import { GameOverScreen } from "@/components/brand/GameOverScreen";
import { FormattedMessage } from "@/i18n";

/**
 * Shown in place of a profile whose user the blocklist bans
 * (`bannedUsers.ts`). Mounted instead of the profile, so nothing of theirs is
 * read or shown.
 */
export function UserBanned() {
  return (
    <GameOverScreen
      title={<FormattedMessage id="userBanned.title" defaultMessage="This account is unavailable in Armada" />}
    />
  );
}
