import { GameOverScreen } from "@/components/brand/GameOverScreen";
import { FormattedMessage } from "@/i18n";

/**
 * Shown at `/c/:communityId` when the community is on the blocklist
 * (`blocklistStore.ts`). Mounted in place of the community page, so nothing of
 * it is read, synced or announced. Shows nothing about the community.
 */
export function CommunityBlocked() {
  return (
    <GameOverScreen
      title={<FormattedMessage id="communityBlocked.title" defaultMessage="This community is unavailable in Armada" />}
    />
  );
}
