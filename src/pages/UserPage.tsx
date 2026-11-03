import { Loader2, MessageSquare, UserRound } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import { JoinButton } from "@/components/auth/JoinButton";
import { DetailPage } from "@/components/layout/DetailPage";
import { ProfileDialog } from "@/components/profile/ProfileDialog";
import { UserBanned } from "@/components/profile/UserBanned";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNip05Resolve } from "@/hooks/useNip05Resolve";
import { useUserBan } from "@/hooks/useUserBan";
import { FormattedMessage, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { parseNip05Address } from "@/lib/nip05Address";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { tryNpubEncode } from "@/lib/safeNip19";
import { NotFound } from "@/pages/NotFound";
import { AvatarInitial } from "@/components/AvatarInitial";

/**
 * A person at `/<npub>`, `/<nprofile>`, `/<name@domain>` or `/<domain>`
 * (NIP-05 `_@domain`), matching the bare NIP-19 convention. Signed out: a share
 * link offering an account; signed in: a profile dialog over the app. As the
 * only single-segment dynamic route, it only claims identifiers that decode or
 * look like NIP-05 (a dot in the domain); everything else is the 404.
 */
export function UserPage() {
  const { user: identifier = "" } = useParams<{ user: string }>();
  const intl = useIntl();
  const { user } = useCurrentUser();
  // Closing steps back; a cold load lands home.
  const closeProfile = useBackOrHome();

  const direct = useMemo(() => resolvePubkey(identifier), [identifier]);
  // Only for segments that didn't decode, so npubs never cost a fetch.
  const address = useMemo(
    () => (direct ? undefined : parseNip05Address(identifier)),
    [direct, identifier],
  );
  const nip05 = useNip05Resolve(address);

  const pubkey = direct ?? nip05.data ?? undefined;
  const npub = pubkey ? tryNpubEncode(pubkey) : undefined;
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const banned = useUserBan(pubkey);

  // Until kind 0 lands, show the followed address rather than "Anonymous".
  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : "";
  const displayName =
    metadata?.name || metadata?.display_name || address?.display || shortNpub;

  if (!direct && !address) {
    return <NotFound />;
  }

  const icon = <UserRound className="size-4 shrink-0 text-primary" />;

  if (!pubkey) {
    return (
      <DetailPage title={address?.display ?? intl.formatMessage({ id: "userPage.profile", defaultMessage: "Profile" })} icon={icon}>
        {nip05.isPending ? (
          <div className="flex flex-col items-center gap-3 pt-12 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              <FormattedMessage
                id="userPage.lookingUp"
                defaultMessage="Looking up {address}…"
                values={{ address: address?.display }}
              />
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 pt-12 text-center">
            <MessageSquare className="size-10 text-muted-foreground/50" />
            <h2 className="text-xl font-semibold">
              <FormattedMessage id="userPage.noSuchPerson" defaultMessage="No such person" />
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {nip05.isError
                ? (
                  <FormattedMessage
                    id="userPage.unreachable"
                    defaultMessage="Couldn’t reach {domain} to look up {address}."
                    values={{ domain: address?.domain, address: address?.display }}
                  />
                )
                : (
                  <FormattedMessage
                    id="userPage.notFound"
                    defaultMessage="{address} isn’t a Nostr account we could find."
                    values={{ address: address?.display }}
                  />
                )}
            </p>
            <Button asChild variant="secondary">
              <Link to="/">
                <FormattedMessage id="notFound.backToBase" defaultMessage="Back to base" />
              </Link>
            </Button>
          </div>
        )}
      </DetailPage>
    );
  }

  // Signed in, the dialog shows it; signed out, nothing of the profile is shown.
  if (banned && !user) return <UserBanned />;

  return (
    <DetailPage
      title={displayName}
      icon={icon}
      overlay={user ? <ProfileDialog pubkey={pubkey} onClose={closeProfile} /> : undefined}
    >
      {!user && (
        <div className="flex flex-col items-center gap-4 clip-hairline-lg [--fill:var(--card)] [--fill-hover:var(--card)] px-6 py-8 text-center">
          <Avatar shape={getAvatarShape(metadata)} className="size-24 border-[3px] border-background">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-3xl">
              <AvatarInitial name={displayName} pubkey={pubkey} />
            </AvatarFallback>
          </Avatar>
          <h2 className="text-2xl font-bold">
            <FormattedMessage
              id="userPage.chatWith"
              defaultMessage="Chat with <name>{displayName}</name> on Armada"
              values={{ displayName, name: (chunks) => <span className="break-words">{chunks}</span> }}
            />
          </h2>
          {metadata?.about && (
            <p className="max-w-md text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap break-words">
              {metadata.about}
            </p>
          )}
          <p className="max-w-md text-muted-foreground">
            <FormattedMessage
              id="userPage.pitch"
              defaultMessage="Armada is end-to-end encrypted messaging on Nostr. Create an account or sign in and this conversation is waiting for you."
            />
          </p>
          <JoinButton size="lg" className="h-12 w-full max-w-xs clip-corner-lg text-base font-medium" />
        </div>
      )}
    </DetailPage>
  );
}

export default UserPage;
