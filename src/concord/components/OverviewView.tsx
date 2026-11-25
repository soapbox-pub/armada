import { Ban, Check, ChevronRight, Flag, Link as LinkIcon, ShieldAlert, ShieldCheck, UserMinus, Users } from "lucide-react";
import { memo, useCallback, useMemo, type ReactNode } from "react";

import { DisplayName } from "@/components/DisplayName";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { useConcordReports } from "@/concord/hooks/useConcordReports";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useNewMembers } from "@/concord/hooks/useNewMembers";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { useTimeTravelers } from "@/concord/hooks/useTimeTravelers";
import type { FoldedControl } from "@/concord/lib/control";
import type { ModerationAccess, ModerationPane } from "@/concord/lib/moderationPanes";
import type { NewMember } from "@/concord/lib/newMembers";
import type { Channel, Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { relativeTime } from "@/lib/formatTime";
import { nowSecs } from "@/lib/relayClock";
import { cn } from "@/lib/utils";

const WEEK_SECS = 7 * 24 * 60 * 60;

/**
 * The Manage community landing tab for staff: what needs a look (reports, suspicious
 * activity, bans) and the members who joined recently, with the hints that tell a
 * returning banned member from a newcomer.
 */
export function OverviewView({
  community,
  channels,
  folded,
  memberCount,
  access,
  onSelect,
  canKick,
  canBan,
  onKick,
  onBan,
}: {
  community: Community;
  channels: Channel[];
  folded: FoldedControl | undefined;
  memberCount: number;
  access: ModerationAccess;
  onSelect: (pane: ModerationPane) => void;
  canKick: (target: string) => boolean;
  canBan: (target: string) => boolean;
  /** Opens the page's kick confirmation. */
  onKick: (target: string) => void;
  /** Opens the page's ban confirmation. */
  onBan: (target: string) => void;
}) {
  const { data: reports } = useConcordReports(access.reports ? community : undefined);
  const { alert } = useSuspiciousActivity(community, folded);
  const travelers = useTimeTravelers(community, channels);
  const { members, markReviewed } = useNewMembers(community, folded);
  const { urlFor, revoke, isRevoking } = useJoinLinkRevoker(community);

  const recentReports = useMemo(() => {
    const since = nowSecs() - WEEK_SECS;
    return (reports ?? []).filter((r) => r.rumor.created_at >= since).length;
  }, [reports]);
  const needsAttention = alert || travelers.length > 0;
  const bannedCount = folded?.banned.size ?? 0;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-4 pb-24">
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          icon={<Users className="size-4" />}
          label={t({ id: "overviewView.members", defaultMessage: "Members" })}
          value={String(memberCount)}
          onClick={access.members ? () => onSelect("members") : undefined}
        />
        {access.reports && (
          <StatCard
            icon={<Flag className="size-4" />}
            label={t({ id: "overviewView.reports", defaultMessage: "Reports this week" })}
            value={String(recentReports)}
            tone={recentReports > 0 ? "warn" : undefined}
            onClick={() => onSelect("reports")}
          />
        )}
        {access.safety && (
          <StatCard
            icon={needsAttention ? <ShieldAlert className="size-4" /> : <ShieldCheck className="size-4" />}
            label={t({ id: "overviewView.safety", defaultMessage: "Suspicious activity" })}
            value={needsAttention
              ? t({ id: "overviewView.safetyAttention", defaultMessage: "Needs a look" })
              : t({ id: "overviewView.safetyClear", defaultMessage: "All clear" })}
            tone={needsAttention ? "danger" : undefined}
            onClick={() => onSelect("safety")}
          />
        )}
        {access.safety && (
          <StatCard
            icon={<Ban className="size-4" />}
            label={t({ id: "overviewView.banned", defaultMessage: "Banned" })}
            value={String(bannedCount)}
            onClick={() => onSelect("safety")}
          />
        )}
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="overviewView.newMembers" defaultMessage="New members" />
        </h3>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="overviewView.newMembersHint"
            defaultMessage="Everyone who joined in the last two weeks. Someone joining right after a ban, or through the same invite link as a banned member, is listed first. The invite shown is what the member says they used."
          />
        </p>
        {members.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md bg-foreground/5 px-4 py-8 text-sm text-muted-foreground">
            <Check className="size-5" />
            <FormattedMessage id="overviewView.noNewMembers" defaultMessage="Nobody new to look at." />
          </div>
        ) : (
          <ul className="space-y-1.5">
            {members.map((m) => (
              <NewMemberRow
                key={m.pubkey}
                member={m}
                revokeUrl={urlFor(m.invite)}
                revoke={revoke}
                revoking={isRevoking}
                canKick={canKick(m.pubkey)}
                canBan={canBan(m.pubkey)}
                onKick={onKick}
                onBan={onBan}
                onReviewed={markReviewed}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: "warn" | "danger";
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground",
        tone === "warn" && "text-warning",
        tone === "danger" && "text-destructive",
      )}>
        {icon}
        {label}
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className={cn("text-lg font-semibold tabular-nums", tone === "danger" && "text-destructive")}>{value}</span>
        {onClick && <ChevronRight className="size-4 text-muted-foreground" />}
      </span>
    </>
  );
  const className = "flex flex-col gap-1 rounded-md bg-foreground/5 px-3 py-2.5 text-left";
  return onClick ? (
    <button type="button" className={cn(className, "transition-colors hover:bg-foreground/10")} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

const NewMemberRow = memo(function NewMemberRow({
  member,
  revokeUrl,
  revoke,
  revoking,
  canKick,
  canBan,
  onKick,
  onBan,
  onReviewed,
}: {
  member: NewMember;
  revokeUrl: string | undefined;
  revoke: (url: string) => Promise<boolean>;
  revoking: boolean;
  canKick: boolean;
  canBan: boolean;
  onKick: (target: string) => void;
  onBan: (target: string) => void;
  onReviewed: (member: NewMember) => void;
}) {
  const intl = useIntl();
  const author = useAuthor(member.pubkey);
  const name = useScopedDisplayName(member.pubkey, author.data?.metadata);
  const flagged = member.afterBanMs !== undefined || member.sameLinkAsBanned;

  return (
    <li className={cn("space-y-2 rounded-md px-3 py-2.5", flagged ? "bg-destructive/10" : "bg-foreground/5")}>
      <div className="flex items-center gap-2.5">
        <UserAvatar
          pubkey={member.pubkey}
          metadata={author.data?.metadata}
          imeta={author.data?.imeta?.picture}
          name={name}
          className="size-8 shrink-0"
          fallbackClassName="text-3xs"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            <DisplayName pubkey={member.pubkey} name={name} />
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            <FormattedMessage
              id="overviewView.joined"
              defaultMessage="Joined {ago}"
              values={{ ago: relativeTime(Math.floor(member.joinedMs / 1000)) }}
            />
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 text-2xs">
        {member.afterBanMs !== undefined && (
          <Hint danger>
            {member.afterBanMs < 60 * 60 * 1000 ? (
              <FormattedMessage
                id="overviewView.afterBanMinutes"
                defaultMessage="{count, plural, one {Joined # minute after a ban} other {Joined # minutes after a ban}}"
                values={{ count: Math.max(1, Math.round(member.afterBanMs / 60_000)) }}
              />
            ) : (
              <FormattedMessage
                id="overviewView.afterBanHours"
                defaultMessage="{count, plural, one {Joined # hour after a ban} other {Joined # hours after a ban}}"
                values={{ count: Math.round(member.afterBanMs / 3_600_000) }}
              />
            )}
          </Hint>
        )}
        {member.sameLinkAsBanned && (
          <Hint danger>
            <FormattedMessage id="overviewView.sameLink" defaultMessage="Same invite link as a banned member" />
          </Hint>
        )}
        {member.invite ? <InviteHint invite={member.invite} /> : (
          <Hint>
            <FormattedMessage id="overviewView.noInvite" defaultMessage="No invite named" />
          </Hint>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => onReviewed(member)}>
          <Check className="size-3.5" />
          <FormattedMessage id="overviewView.looksFine" defaultMessage="Looks fine" />
        </Button>
        <RevokeJoinLink url={revokeUrl} revoke={revoke} busy={revoking} />
        {canKick && (
          <Button size="sm" variant="ghost" onClick={() => onKick(member.pubkey)}>
            <UserMinus className="size-3.5" />
            <FormattedMessage id="overviewView.kick" defaultMessage="Kick" />
          </Button>
        )}
        {canBan && (
          <Button
            size="sm"
            variant="destructive"
            aria-label={intl.formatMessage({ id: "overviewView.banNamed", defaultMessage: "Ban {name}" }, { name })}
            onClick={() => onBan(member.pubkey)}
          >
            <Ban className="size-3.5" />
            <FormattedMessage id="overviewView.ban" defaultMessage="Ban" />
          </Button>
        )}
      </div>
    </li>
  );
});

function Hint({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
      danger ? "bg-destructive/20 font-medium text-destructive" : "bg-foreground/10 text-muted-foreground",
    )}>
      {children}
    </span>
  );
}

function InviteHint({ invite }: { invite: { creator: string; label?: string } }) {
  const author = useAuthor(invite.creator);
  const creator = useScopedDisplayName(invite.creator, author.data?.metadata);
  return (
    <Hint>
      <LinkIcon className="size-3" />
      {invite.label ? (
        <FormattedMessage
          id="overviewView.viaLabel"
          defaultMessage="Via “{label}” by {creator}"
          values={{ label: invite.label, creator: <DisplayName pubkey={invite.creator} name={creator} /> }}
        />
      ) : (
        <FormattedMessage
          id="overviewView.viaCreator"
          defaultMessage="Via a link by {creator}"
          values={{ creator: <DisplayName pubkey={invite.creator} name={creator} /> }}
        />
      )}
    </Hint>
  );
}

/**
 * The viewer's own live link a member says they joined through, when its label names
 * exactly one: only a link's creator holds what revoking it takes.
 */
function useJoinLinkRevoker(community: Community) {
  const { user } = useCurrentUser();
  const { myLinks, revokeLink, isRevoking, revokeWouldPrivatize } = useInviteActions(community);
  const me = user?.pubkey;
  const urlFor = useCallback(
    (invite: NewMember["invite"]): string | undefined => {
      if (!invite?.label || invite.creator !== me) return undefined;
      const matches = myLinks.filter((l) => l.label === invite.label);
      return matches.length === 1 ? matches[0].url : undefined;
    },
    [myLinks, me],
  );
  const revoke = useCallback(
    async (url: string): Promise<boolean> => {
      if (
        revokeWouldPrivatize(url) &&
        !confirm(t({
          id: "overviewView.confirmRevokeLast",
          defaultMessage: "This is the last live invite link. Revoking it makes the community private: new members can then only be added by direct invite.",
        }))
      ) {
        return false;
      }
      await revokeLink({ url });
      return true;
    },
    [revokeLink, revokeWouldPrivatize],
  );
  return { urlFor, revoke, isRevoking };
}

function RevokeJoinLink({ url, revoke, busy }: { url: string | undefined; revoke: (url: string) => Promise<boolean>; busy: boolean }) {
  if (!url) return null;

  const onClick = async () => {
    try {
      if (!(await revoke(url))) return;
      toast({
        title: t({ id: "overviewView.revoked", defaultMessage: "Invite link revoked" }),
        description: t({ id: "overviewView.revokedDescription", defaultMessage: "It can no longer be used to join." }),
      });
    } catch (e) {
      toast({
        title: t({ id: "overviewView.revokeFailed", defaultMessage: "Couldn't revoke the link" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onClick()}>
      <LinkIcon className="size-3.5" />
      <FormattedMessage id="overviewView.revokeLink" defaultMessage="Revoke link" />
    </Button>
  );
}
