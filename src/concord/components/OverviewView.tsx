import { Ban, Check, ChevronDown, Flag, Link as LinkIcon, Loader2, MoreHorizontal, ShieldAlert, ShieldCheck, UserCheck, UserMinus, Users } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { DisplayName } from "@/components/DisplayName";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useApprovalGate } from "@/concord/hooks/useApprovalGate";
import { useConcordReports } from "@/concord/hooks/useConcordReports";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useNewMembers } from "@/concord/hooks/useNewMembers";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { useTimeTravelers } from "@/concord/hooks/useTimeTravelers";
import type { FoldedControl } from "@/concord/lib/control";
import type { ModerationAccess, ModerationPane } from "@/concord/lib/moderationPanes";
import type { NewMember } from "@/concord/lib/newMembers";
import type { Role } from "@/concord/lib/roles";
import type { Channel, Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { relativeTime } from "@/lib/formatTime";
import { nowSecs } from "@/lib/relayClock";

const WEEK_SECS = 7 * 24 * 60 * 60;

/**
 * The Manage community landing section for staff: what needs a look (reports,
 * suspicious activity, bans), the members waiting for approval, and those who joined
 * recently, with the hints that tell a returning banned member from a newcomer.
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
  const intl = useIntl();
  const { data: reports } = useConcordReports(access.reports ? community : undefined);
  const { alert } = useSuspiciousActivity(community, folded);
  const travelers = useTimeTravelers(community, channels);
  const gate = useApprovalGate(community);
  const { pending, members, markReviewed } = useNewMembers(community, folded, gate.awaiting);
  const { urlFor, revoke, isRevoking } = useJoinLinkRevoker(community);
  const [approving, setApproving] = useState<ReadonlySet<string>>(() => new Set());

  const recentReports = useMemo(() => {
    const since = nowSecs() - WEEK_SECS;
    return (reports ?? []).filter((r) => r.rumor.created_at >= since).length;
  }, [reports]);
  const needsAttention = alert || travelers.length > 0;

  const { approve } = gate;
  const onApprove = useCallback(
    (member: string, roleId?: string) => {
      setApproving((busy) => new Set(busy).add(member));
      approve(member, roleId)
        .then(() =>
          toast({
            title: t({ id: "overviewView.approved", defaultMessage: "Member approved" }),
            description: t({ id: "overviewView.approvedDescription", defaultMessage: "They can post as soon as their posting keys reach them, usually right away." }),
          }),
        )
        .catch((e: unknown) =>
          toast({
            title: t({ id: "overviewView.approveFailed", defaultMessage: "Couldn't approve them" }),
            description: e instanceof Error ? e.message : undefined,
            variant: "destructive",
          }),
        )
        .finally(() =>
          setApproving((busy) => {
            const next = new Set(busy);
            next.delete(member);
            return next;
          }),
        );
    },
    [approve],
  );

  const rowActions = { revoke, revoking: isRevoking, onKick, onBan };

  return (
    <div className="space-y-6">
      <SettingsGroup title={intl.formatMessage({ id: "overviewView.glance", defaultMessage: "At a glance" })}>
        <SettingsRow
          icon={Users}
          tone="accent2"
          label={intl.formatMessage({ id: "overviewView.members", defaultMessage: "Members" })}
          value={memberCount}
          chevron={access.members}
          onClick={access.members ? () => onSelect("members") : undefined}
        />
        {access.reports && (
          <SettingsRow
            icon={Flag}
            tone="warning"
            label={intl.formatMessage({ id: "overviewView.reports", defaultMessage: "Reports this week" })}
            value={recentReports}
            chevron
            onClick={() => onSelect("reports")}
          />
        )}
        {access.safety && (
          <SettingsRow
            icon={needsAttention ? ShieldAlert : ShieldCheck}
            tone={needsAttention ? "destructive" : "success"}
            label={intl.formatMessage({ id: "overviewView.safety", defaultMessage: "Suspicious activity" })}
            value={needsAttention
              ? intl.formatMessage({ id: "overviewView.safetyAttention", defaultMessage: "Needs a look" })
              : intl.formatMessage({ id: "overviewView.safetyClear", defaultMessage: "All clear" })}
            chevron
            onClick={() => onSelect("safety")}
          />
        )}
        {access.safety && (
          <SettingsRow
            icon={Ban}
            tone="muted"
            label={intl.formatMessage({ id: "overviewView.banned", defaultMessage: "Banned" })}
            value={folded?.banned.size ?? 0}
            chevron
            onClick={() => onSelect("safety")}
          />
        )}
      </SettingsGroup>

      {gate.on && (
        <SettingsGroup
          title={intl.formatMessage({ id: "overviewView.pending", defaultMessage: "Waiting for approval ({count})" }, { count: pending.length })}
          footer={gate.canApprove
            ? intl.formatMessage({ id: "overviewView.pendingHintRole", defaultMessage: "They can read but not post. Approving gives them the role that lets members post." })
            : intl.formatMessage({ id: "overviewView.pendingNoPermissionRole", defaultMessage: "They can read but not post. Approving them takes the Manage roles permission, through a role ranked above the one they would get." })}
        >
          {pending.length === 0 ? (
            <EmptyRow>
              <FormattedMessage id="overviewView.noPending" defaultMessage="Nobody is waiting." />
            </EmptyRow>
          ) : (
            pending.map((m) => (
              <MemberReviewRow
                key={m.pubkey}
                member={m}
                revokeUrl={urlFor(m.invite)}
                canKick={canKick(m.pubkey)}
                canBan={canBan(m.pubkey)}
                {...rowActions}
                primary={gate.canApprove && gate.mayApproveMember(m.pubkey) ? { kind: "approve", onApprove, roles: gate.grantable, busy: approving.has(m.pubkey) } : undefined}
              />
            ))
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        title={intl.formatMessage({ id: "overviewView.newMembers", defaultMessage: "New members" })}
        info={intl.formatMessage({ id: "overviewView.inviteInfo", defaultMessage: "The invite link shown is the one the member says they used. Armada can't check it, so treat it as a hint." })}
        footer={intl.formatMessage({ id: "overviewView.newMembersFooter", defaultMessage: "Joined in the last two weeks. Anyone who joined right after a ban, or through a banned member's invite link, comes first." })}
      >
        {members.length === 0 ? (
          <EmptyRow>
            <FormattedMessage id="overviewView.noNewMembers" defaultMessage="Nobody new to look at." />
          </EmptyRow>
        ) : (
          members.map((m) => (
            <MemberReviewRow
              key={m.pubkey}
              member={m}
              revokeUrl={urlFor(m.invite)}
              canKick={canKick(m.pubkey)}
              canBan={canBan(m.pubkey)}
              {...rowActions}
              primary={{ kind: "reviewed", onReviewed: markReviewed }}
            />
          ))
        )}
      </SettingsGroup>
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <SettingsRow>
      <p className="text-sm text-muted-foreground">{children}</p>
    </SettingsRow>
  );
}

type Primary =
  /** `roles` are the approval Roles the viewer may grant: with several, Approve asks which. */
  | { kind: "approve"; onApprove: (member: string, roleId?: string) => void; roles: readonly Role[]; busy: boolean }
  | { kind: "reviewed"; onReviewed: (member: NewMember) => void };

/** A member to look at: who they are, when and how they came, any warning, one main action and the rest behind "…". */
function MemberReviewRow({
  member,
  revokeUrl,
  revoke,
  revoking,
  canKick,
  canBan,
  onKick,
  onBan,
  primary,
}: {
  member: NewMember;
  revokeUrl: string | undefined;
  revoke: (url: string) => Promise<boolean>;
  revoking: boolean;
  canKick: boolean;
  canBan: boolean;
  onKick: (target: string) => void;
  onBan: (target: string) => void;
  primary: Primary | undefined;
}) {
  const intl = useIntl();
  const author = useAuthor(member.pubkey);
  const name = useScopedDisplayName(member.pubkey, author.data?.metadata);
  const warnings = warningsOf(intl, member);

  const revokeLink = async () => {
    if (!revokeUrl) return;
    try {
      if (!(await revoke(revokeUrl))) return;
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

  const hasMenu = canKick || canBan || Boolean(revokeUrl);

  return (
    <SettingsRow className="flex items-center gap-3">
      <UserAvatar
        pubkey={member.pubkey}
        metadata={author.data?.metadata}
        imeta={author.data?.imeta?.picture}
        name={name}
        className="size-8 shrink-0"
        fallbackClassName="text-xs"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate text-sm font-medium leading-tight">
          <DisplayName pubkey={member.pubkey} name={name} />
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <FormattedMessage id="overviewView.joined" defaultMessage="Joined {ago}" values={{ ago: relativeTime(Math.floor(member.joinedMs / 1000)) }} />
          {member.invite && (
            <>
              {" · "}
              <InviteText invite={member.invite} />
            </>
          )}
        </div>
        {warnings.length > 0 && (
          <div className="truncate text-xs font-medium text-destructive">{warnings.join(" · ")}</div>
        )}
      </div>

      {primary?.kind === "approve" && primary.roles.length <= 1 && (
        <Button size="sm" className="clip-corner-lg h-8 shrink-0 touch:h-11" disabled={primary.busy} onClick={() => primary.onApprove(member.pubkey)}>
          {primary.busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
          <FormattedMessage id="overviewView.approve" defaultMessage="Approve" />
        </Button>
      )}
      {primary?.kind === "approve" && primary.roles.length > 1 && (
        <DropdownMenu touchSheet>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="clip-corner-lg h-8 shrink-0 touch:h-11" disabled={primary.busy}>
              {primary.busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
              <FormattedMessage id="overviewView.approve" defaultMessage="Approve" />
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              <FormattedMessage id="overviewView.approveAs" defaultMessage="Give them" />
            </DropdownMenuLabel>
            {primary.roles.map((r) => (
              <DropdownMenuItem key={r.roleId} onSelect={() => primary.onApprove(member.pubkey, r.roleId)}>
                {r.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {primary?.kind === "reviewed" && (
        <Button size="sm" variant="secondary" className="clip-corner-lg h-8 shrink-0 touch:h-11" onClick={() => primary.onReviewed(member)}>
          <Check className="size-3.5" />
          <FormattedMessage id="overviewView.looksFine" defaultMessage="Looks fine" />
        </Button>
      )}

      {hasMenu && (
        <DropdownMenu touchSheet>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:text-foreground touch:size-11"
              aria-label={intl.formatMessage({ id: "overviewView.moreActions", defaultMessage: "More actions for {name}" }, { name })}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {revokeUrl && (
              <DropdownMenuItem disabled={revoking} onSelect={() => void revokeLink()}>
                <LinkIcon className="size-4" />
                <FormattedMessage id="overviewView.revokeLink" defaultMessage="Revoke link" />
              </DropdownMenuItem>
            )}
            {canKick && (
              <DropdownMenuItem onSelect={() => onKick(member.pubkey)}>
                <UserMinus className="size-4" />
                <FormattedMessage id="overviewView.kick" defaultMessage="Kick" />
              </DropdownMenuItem>
            )}
            {canBan && (
              <>
                {(canKick || revokeUrl) && <DropdownMenuSeparator />}
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onBan(member.pubkey)}>
                  <Ban className="size-4" />
                  <FormattedMessage id="overviewView.ban" defaultMessage="Ban" />
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SettingsRow>
  );
}

function warningsOf(intl: ReturnType<typeof useIntl>, member: NewMember): string[] {
  const out: string[] = [];
  if (member.afterBanMs !== undefined) {
    out.push(member.afterBanMs < 60 * 60 * 1000
      ? intl.formatMessage(
          { id: "overviewView.afterBanMinutes", defaultMessage: "{count, plural, one {Joined # minute after a ban} other {Joined # minutes after a ban}}" },
          { count: Math.max(1, Math.round(member.afterBanMs / 60_000)) },
        )
      : intl.formatMessage(
          { id: "overviewView.afterBanHours", defaultMessage: "{count, plural, one {Joined # hour after a ban} other {Joined # hours after a ban}}" },
          { count: Math.round(member.afterBanMs / 3_600_000) },
        ));
  }
  if (member.sameLinkAsBanned) {
    out.push(intl.formatMessage({ id: "overviewView.sameLink", defaultMessage: "Same invite link as a banned member" }));
  }
  return out;
}

function InviteText({ invite }: { invite: { creator: string; label?: string } }) {
  const author = useAuthor(invite.creator);
  const creator = useScopedDisplayName(invite.creator, author.data?.metadata);
  const name = <DisplayName pubkey={invite.creator} name={creator} />;
  return invite.label ? (
    <FormattedMessage id="overviewView.viaLabelInline" defaultMessage="via “{label}” by {creator}" values={{ label: invite.label, creator: name }} />
  ) : (
    <FormattedMessage id="overviewView.viaCreatorInline" defaultMessage="via a link by {creator}" values={{ creator: name }} />
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
