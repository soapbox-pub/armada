import { ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCommunityActions, type InvitePreview } from "@/concord/hooks/useCommunityActions";
import { useCommunity } from "@/concord/hooks/useCommunityList";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { parseInviteLink, type ParsedInviteLink } from "@/concord/lib/invite";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import { FormattedMessage, t, useIntl } from "@/i18n";

interface InviteEmbedProps {
  url: string;
  className?: string;
}

/** Join card for a Concord invite link, previewing the sealed bundle from its bootstrap relays. */
export function InviteEmbed({ url, className }: InviteEmbedProps) {
  const intl = useIntl();
  const invite = parseInviteLink(url);
  if (!invite) {
    // The secret lives in the `#fragment`; without it the invite can't be joined.
    return (
      <InviteTombstone
        message={intl.formatMessage({
          id: "inviteEmbed.missingSecret",
          defaultMessage: "This invite link is missing its secret (the part after #). Ask for a fresh link.",
        })}
        className={className}
      />
    );
  }
  return <InviteCard invite={invite} className={className} />;
}

function InviteCard({ invite, className }: { invite: ParsedInviteLink; className?: string }) {
  const { preview } = useCommunityActions();
  const [data, setData] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    preview({ invite })
      .then((p) => {
        if (!cancelled) setData(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error
            ? e.message
            : t({ id: "inviteEmbed.loadFailed", defaultMessage: "Couldn't load this invite." }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite.naddr]);

  if (error) {
    return <InviteTombstone message={error} className={className} />;
  }
  if (!data) {
    return <InviteSkeleton className={className} />;
  }
  return <InviteResolvedCard invite={invite} preview={data} className={className} />;
}

function InviteResolvedCard({
  invite,
  preview,
  className,
}: {
  invite: ParsedInviteLink;
  preview: InvitePreview;
  className?: string;
}) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { join, isJoining } = useCommunityActions();
  const iconUrl = useDecryptedImage(preview.bundle.icon);

  const alreadyJoined = !!useCommunity(preview.communityId);

  const expired =
    typeof preview.bundle.expires_at === "number" && Date.now() > preview.bundle.expires_at;

  const open = () => navigate(`/c/${encodeURIComponent(preview.communityId)}`);

  const doJoin = async () => {
    if (!user) {
      toast({
        title: t({ id: "inviteEmbed.signInToJoin", defaultMessage: "Sign in to join" }),
        description: t({
          id: "inviteEmbed.signInToJoinDescription",
          defaultMessage: "Create an account or sign in to accept this invite.",
        }),
      });
      return;
    }
    try {
      // Optimistic: the durable join runs in the background (failures toast).
      const { communityId, name, alreadyMember } = await join({ invite, bundle: preview.bundle });
      toast({
        title: alreadyMember
          ? t({ id: "inviteEmbed.alreadyMember", defaultMessage: "You're already in this community" })
          : t({ id: "inviteEmbed.joined", defaultMessage: "Joined" }),
        description: name,
      });
      navigate(`/c/${encodeURIComponent(communityId)}`);
    } catch (e) {
      toast({
        title: t({ id: "inviteEmbed.joinFailed", defaultMessage: "Couldn't join" }),
        description: e instanceof Error
          ? e.message
          : t({ id: "inviteEmbed.joinFailedDescription", defaultMessage: "The invite didn't work." }),
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className={cn(
        "block max-w-sm w-full clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3] overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3.5 py-3 space-y-2.5">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FormattedMessage id="inviteEmbed.invited" defaultMessage="You've been invited to join a community" />
        </p>

        <div className="flex items-center gap-3 min-w-0">
          <Avatar className="size-11 clip-corner-lg shrink-0">
            {iconUrl && <AvatarImage src={iconUrl} alt={preview.name} className="object-cover" />}
            <AvatarFallback className="clip-corner-lg bg-primary/20 text-primary font-semibold">
              {preview.name.slice(0, 2).toUpperCase() || "??"}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate leading-tight">{preview.name}</p>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3.5 text-success shrink-0" />
                <FormattedMessage id="inviteEmbed.encrypted" defaultMessage="Encrypted" />
              </span>
              {preview.channelCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3.5 shrink-0" />
                  <FormattedMessage
                    id="inviteEmbed.channelCount"
                    defaultMessage="{count, plural, one {# channel} other {# channels}}"
                    values={{ count: preview.channelCount }}
                  />
                </span>
              )}
            </div>
          </div>
        </div>

        {alreadyJoined ? (
          <Button variant="secondary" className="w-full clip-corner-lg" onClick={open}>
            <FormattedMessage id="inviteEmbed.open" defaultMessage="Open" />
          </Button>
        ) : expired ? (
          <Button variant="secondary" className="w-full clip-corner-lg" disabled>
            <FormattedMessage id="inviteEmbed.expired" defaultMessage="Invite expired" />
          </Button>
        ) : (
          <Button className="w-full clip-corner-lg" onClick={doJoin} disabled={isJoining}>
            <FormattedMessage id="inviteEmbed.join" defaultMessage="Join" />
          </Button>
        )}
      </div>
    </div>
  );
}

function InviteSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "max-w-sm w-full clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3] overflow-hidden my-1.5",
        className,
      )}
    >
      <div className="px-3.5 py-3 space-y-2.5">
        <Skeleton className="h-2.5 w-48" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 clip-corner-lg shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-9 w-full clip-corner-lg" />
      </div>
    </div>
  );
}

function InviteTombstone({ message, className }: { message: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 max-w-sm clip-corner-lg bg-secondary/20 px-3.5 py-4 my-1.5 text-muted-foreground",
        className,
      )}
    >
      <ShieldCheck className="size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}
