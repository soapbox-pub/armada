import { Ban, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { ServerRail } from "@/components/layout/ServerRail";
import { JoinButton } from "@/components/auth/JoinButton";
import { Button } from "@/components/ui/button";
import {
  BannedFromCommunityError,
  BlockedCommunityError,
  DissolvedCommunityError,
  useCommunityActions,
  type InvitePreview,
} from "@/concord/hooks/useCommunityActions";
import { CommunityBlocked } from "@/concord/components/CommunityBlocked";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { InviteDetail } from "@/concord/pages/InvitesPage";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { InviteError, parseInviteRoute } from "@/concord/lib/invite";
import { FormattedMessage, t } from "@/i18n";

/** A user-facing reason for an invite failure; protocol-level InviteError text stays English. */
function inviteErrorText(e: unknown, fallback: string): string {
  if (e instanceof InviteError && e.code === "revoked") {
    return t({ id: "invitePage.error.revoked", defaultMessage: "this invite link has been revoked" });
  }
  if (e instanceof InviteError && e.code === "expired") {
    return t({ id: "invitePage.error.expired", defaultMessage: "this invite link has expired" });
  }
  return e instanceof Error ? e.message : fallback;
}

/**
 * Landing page for a Concord invite link — `/invite/<naddr>#<fragment>` (CORD-05).
 * The fragment (token + bootstrap relays) never reaches a server. Resolves the
 * bundle and shows the same consent surface as a Direct Invite
 * ({@link InviteDetail}); Accept is explicit.
 */
export function InvitePage() {
  const { naddr } = useParams<{ naddr: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { preview, join, isJoining } = useCommunityActions();
  const [error, setError] = useState<string | null>(null);
  const [banned, setBanned] = useState(false);
  const [dissolved, setDissolved] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [resolved, setResolved] = useState<InvitePreview | null>(null);

  const fragment = (location.hash || window.location.hash).replace(/^#/, "").trim();
  const invite = naddr && fragment ? parseInviteRoute(naddr, fragment) : undefined;

  // A link to a community already held opens it: Accept would never re-key it.
  const held = useCommunity(resolved?.communityId);
  useEffect(() => {
    if (resolved && held) navigate(`/c/${encodeURIComponent(resolved.communityId)}`, { replace: true });
  }, [resolved, held, navigate]);

  // Resolve the bundle even before sign-in, so the consent surface can paint.
  useEffect(() => {
    if (!naddr || !fragment) {
      setError(
        t({ id: "invitePage.error.missingSecret", defaultMessage: "This invite link is missing its secret. Ask for a fresh link." }),
      );
      return;
    }
    if (!invite) {
      setError(t({ id: "invitePage.error.malformed", defaultMessage: "This invite link is malformed or from a newer client." }));
      return;
    }
    let cancelled = false;
    setError(null);
    preview({ invite })
      .then((p) => {
        if (!cancelled) setResolved(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setDissolved(e instanceof DissolvedCommunityError);
        setBlocked(e instanceof BlockedCommunityError);
        setError(inviteErrorText(e, t({ id: "invitePage.error.loadFailed", defaultMessage: "Couldn't load that invite link." })));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naddr, fragment]);

  const handleAccept = async () => {
    if (!invite || !resolved) return;
    try {
      // Optimistic: the durable join chain runs in the background (failures toast
      // via useCommunityActions).
      const { communityId, name, alreadyMember } = await join({ invite, bundle: resolved.bundle });
      toast({
        title: alreadyMember
          ? t({ id: "invitePage.alreadyMember", defaultMessage: "You're already in this community" })
          : t({ id: "invitePage.joined", defaultMessage: "Joined" }),
        description: name,
      });
      navigate(`/c/${encodeURIComponent(communityId)}`, { replace: true });
    } catch (e) {
      setBanned(e instanceof BannedFromCommunityError);
      setDissolved(e instanceof DissolvedCommunityError);
      setBlocked(e instanceof BlockedCommunityError);
      setError(inviteErrorText(e, t({ id: "invitePage.error.joinFailed", defaultMessage: "Couldn't join with that invite link." })));
    }
  };

  if (blocked) {
    return (
      <>
        <ServerRail />
        <main className="flex-1 min-w-0">
          <CommunityBlocked />
        </main>
      </>
    );
  }

  if (error) {
    return (
      <>
        <ServerRail />
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
          {banned ? (
            <Ban className="size-12 text-destructive" />
          ) : (
            <ShieldCheck className="size-12 text-muted-foreground" />
          )}
          <h1 className="text-2xl font-bold">
            {banned ? (
              <FormattedMessage id="invitePage.bannedTitle" defaultMessage="You’re banned" />
            ) : dissolved ? (
              <FormattedMessage id="invitePage.dissolvedTitle" defaultMessage="Community dissolved" />
            ) : (
              <FormattedMessage id="invitePage.failedTitle" defaultMessage="Invite link didn’t work" />
            )}
          </h1>
          <p className="max-w-md text-muted-foreground">{error}</p>
          <Button asChild>
            <Link to="/">
              <FormattedMessage id="invitePage.backToBase" defaultMessage="Back to base" />
            </Link>
          </Button>
        </main>
      </>
    );
  }

  if (!resolved) {
    return (
      <>
        <ServerRail />
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground">
            <FormattedMessage id="invitePage.opening" defaultMessage="Opening the invite…" />
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <ServerRail />
      <main className="flex flex-1 min-w-0 flex-col bg-background h-full">
        <InviteDetail
          bundle={resolved.bundle}
          communityId={resolved.communityId}
          name={resolved.name}
          accepting={isJoining}
          declining={false}
          onAccept={handleAccept}
          onDecline={() => navigate("/")}
          signInSlot={
            user ? undefined : (
              <JoinButton
                size="lg"
                className="h-12 min-w-0 flex-1 clip-corner-lg text-base font-medium"
              >
                <FormattedMessage id="invitePage.signInToAccept" defaultMessage="Sign in to accept" />
              </JoinButton>
            )
          }
        />
      </main>
    </>
  );
}

export default InvitePage;
