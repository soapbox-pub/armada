import { Lock, UserIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getAvatarShape } from "@/lib/avatarShape";
import { type HomeLandingState } from "@/lib/railLayout";
import { useLoggedInAccounts } from "@/hooks/useLoggedInAccounts";
import { useSwitchAccount } from "@/hooks/useSwitchAccount";
import { FormattedMessage, useIntl } from "@/i18n";

/**
 * Shown at `/c/:communityId` when the active account has no membership. Shows
 * nothing about the community: without keys there's no non-leaking version,
 * and naming it would leak the previous account's vault. Mounted only once the
 * list has resolved (an unresolved list looks empty). Offers account switching.
 * "Back to base" skips this community, which may be the rail's first item.
 */
export function CommunityNoAccess({ communityId }: { communityId: string }) {
  const intl = useIntl();
  const homeState = useMemo<HomeLandingState>(() => ({ homeSkipped: [communityId] }), [communityId]);
  const { currentUser, otherUsers } = useLoggedInAccounts();
  const { switchTo } = useSwitchAccount();

  const displayName = (metadata: { name?: string; display_name?: string }) =>
    metadata.name || metadata.display_name || intl.formatMessage({ id: "communityNoAccess.anonymous", defaultMessage: "Anonymous" });

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Lock className="size-12 text-muted-foreground/50" />
      <h1 className="text-2xl font-bold">
        <FormattedMessage id="communityNoAccess.title" defaultMessage="You don't have access to this community" />
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {currentUser ? (
          <FormattedMessage
            id="communityNoAccess.notMember"
            defaultMessage="This account isn't a member, so it holds none of the keys needed to read anything here. If you joined with a different account, switch to it, or ask a member for an invite link."
          />
        ) : (
          <FormattedMessage
            id="communityNoAccess.signedOut"
            defaultMessage="Sign in with an account that's a member, or ask a member for an invite link."
          />
        )}
      </p>

      {otherUsers.length > 0 && (
        <div className="flex w-full max-w-xs flex-col gap-1">
          <div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FormattedMessage id="communityNoAccess.switchAccount" defaultMessage="Switch account" />
          </div>
          {otherUsers.map((user) => (
            <button
              key={user.id}
              onClick={() => switchTo(user.id)}
              className="flex items-center gap-2 clip-corner-lg p-2 text-left hover:bg-accent touch:min-h-11"
            >
              <Avatar shape={getAvatarShape(user.metadata)} className="size-8 shrink-0">
                <AvatarImage src={user.metadata.picture} imeta={user.imeta?.picture} alt={displayName(user.metadata)} />
                <AvatarFallback>
                  {displayName(user.metadata).charAt(0) || <UserIcon className="size-4" />}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-sm font-medium">{displayName(user.metadata)}</span>
            </button>
          ))}
        </div>
      )}

      <Button asChild variant="outline">
        <Link to="/" state={homeState}><FormattedMessage id="communityNoAccess.backToBase" defaultMessage="Back to base" /></Link>
      </Button>
    </div>
  );
}
