import { AtSign, Check, Copy, Crown, IdCard, MoreVertical, Shield, ShieldOff, Tag, UserMinus, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { requestMention } from "@/hooks/useMentionBus";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";

import type { CommunityRole, Nip29Admin } from "@/lib/nip29";

const ROLE_ADMIN = "admin";
const ROLE_MODERATOR = "moderator";

interface MemberRowProps {
  pubkey: string;
  roles?: string[];
  canModerate: boolean;
  /** Whether the viewer is an admin (required to grant the admin role). */
  viewerIsAdmin: boolean;
  /** The viewer's own pubkey, to suppress self-moderation. */
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
  /** Open the per-server nickname/label editor (shown only on the viewer's own row). */
  onEditProfile?: () => void;
  /** Community-wide dynamic role catalog (zooid kind-33534), for the assign submenu. */
  communityRoles?: CommunityRole[];
  /** Role ids currently assigned to this member (from the kind-13534 list). */
  assignedRoleIds?: string[];
  /** Toggle a community role on/off for a member (NIP-86 assign/unassign). */
  onToggleCommunityRole?: (pubkey: string, roleId: string, assigned: boolean) => void;
}

function MemberRow({
  pubkey,
  roles,
  canModerate,
  viewerIsAdmin,
  currentUserPubkey,
  onRemove,
  onSetRole,
  onEditProfile,
  communityRoles,
  assignedRoleIds,
  onToggleCommunityRole,
}: MemberRowProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const { displayName, color } = useScopedIdentity(pubkey, metadata);

  const roleSet = new Set((roles ?? []).map((r) => r.toLowerCase()));
  const isAdmin = roleSet.has(ROLE_ADMIN);
  const isModerator = roleSet.has(ROLE_MODERATOR);
  const isSelf = currentUserPubkey === pubkey;
  // Moderation acts on others only; everyone gets the basic items.
  const canActOnUser = canModerate && !isSelf;
  const assigned = new Set(assignedRoleIds ?? []);
  const showCommunityRoles =
    canModerate && Boolean(onToggleCommunityRole) && (communityRoles?.length ?? 0) > 0;

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    navigator.clipboard?.writeText(npub).then(
      () => toast({ title: "Copied npub" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  return (
    <div className="gutter-tick group flex items-center gap-2.5 pl-3 pr-2 py-2 clip-corner-lg transition-colors hover:bg-accent/50 hover:text-foreground">
      <ProfilePreviewCard pubkey={pubkey}>
        <button type="button" className="shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar shape={getAvatarShape(metadata)} className="size-8 cursor-pointer transition-opacity hover:opacity-90">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
      </ProfilePreviewCard>
      <ProfilePreviewCard pubkey={pubkey}>
        <button
          type="button"
          className="text-sm truncate flex-1 text-left focus:outline-none"
          style={color ? { color } : undefined}
        >
          {displayName}
        </button>
      </ProfilePreviewCard>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Manage ${displayName}`}
            className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 text-muted-foreground hover:text-foreground"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-2">
          <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={() => requestMention(pubkey)}>
            <AtSign className="size-4" />
            Mention
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={copyNpub}>
            <Copy className="size-4" />
            Copy npub
          </DropdownMenuItem>

          {isSelf && onEditProfile && (
            <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={onEditProfile}>
              <IdCard className="size-4" />
              Server identity
            </DropdownMenuItem>
          )}

          {canActOnUser && (onSetRole || onRemove || showCommunityRoles) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80">
                Moderation
              </DropdownMenuLabel>

              {onSetRole && viewerIsAdmin && !isAdmin && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [ROLE_ADMIN])}
                >
                  <Crown className="size-4" />
                  Make admin
                </DropdownMenuItem>
              )}
              {onSetRole && !isModerator && !isAdmin && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [ROLE_MODERATOR])}
                >
                  <Shield className="size-4" />
                  Make moderator
                </DropdownMenuItem>
              )}
              {onSetRole && isAdmin && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [ROLE_MODERATOR])}
                >
                  <Shield className="size-4" />
                  Demote to moderator
                </DropdownMenuItem>
              )}
              {onSetRole && (isAdmin || isModerator) && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [])}
                >
                  <ShieldOff className="size-4" />
                  Remove role
                </DropdownMenuItem>
              )}

              {showCommunityRoles && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-3 px-3 py-2.5">
                    <Tag className="size-4" />
                    Community roles
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="p-1">
                    {communityRoles!.map((role) => {
                      const has = assigned.has(role.id);
                      return (
                        <DropdownMenuItem
                          key={role.id}
                          className="gap-3 px-3 py-2"
                          onClick={() => onToggleCommunityRole!(pubkey, role.id, has)}
                        >
                          <Check className={cn("size-4", has ? "opacity-100" : "opacity-0")} />
                          {role.label || role.id}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}

              {onRemove && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
                  onClick={() => onRemove(pubkey)}
                >
                  <UserMinus className="size-4" />
                  Remove from channel
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface MemberListProps {
  admins: Nip29Admin[];
  members: string[];
  canModerate: boolean;
  /** Whether the viewer is an admin (required to grant the admin role). */
  viewerIsAdmin?: boolean;
  /** The viewer's own pubkey, to suppress self-moderation. */
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
  /** Close the panel (mobile overlay close button). */
  onClose?: () => void;
  /** Open the per-server nickname/label editor for the current user. */
  onEditProfile?: () => void;
  /** Override the default desktop panel chrome (e.g. for the mobile drawer). */
  className?: string;
  /** Community-wide dynamic role catalog (zooid kind-33534). */
  communityRoles?: CommunityRole[];
  /** pubkey → assigned community role ids (kind-13534). */
  communityAssignments?: Map<string, string[]>;
  /** Toggle a community role for a member (NIP-86). */
  onToggleCommunityRole?: (pubkey: string, roleId: string, assigned: boolean) => void;
}

/** Right-hand member panel: admins (with roles) first, then regular members. */
export function MemberList({
  admins,
  members,
  canModerate,
  viewerIsAdmin = false,
  currentUserPubkey,
  onRemove,
  onSetRole,
  onClose,
  onEditProfile,
  className,
  communityRoles,
  communityAssignments,
  onToggleCommunityRole,
}: MemberListProps) {
  const adminMap = new Map(admins.map((a) => [a.pubkey, a.roles] as const));
  // NIP-29 relays don't guarantee a stable order for the `p` tags in the
  // members/admins events, so each 30s refetch could otherwise reshuffle the
  // roster. Sort by pubkey for a stable, deterministic display order.
  const sortedAdmins = [...admins].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  const regulars = members
    .filter((pubkey) => !adminMap.has(pubkey))
    .sort((a, b) => a.localeCompare(b));

  return (
    <aside
      className={cn(
        // Floating roster: detached by a margin, cut-corner card, same recessed
        // chrome shade as the rail/console/header. No border. Matches the thread
        // panel: full-screen card overlay on mobile, in-flow card on desktop.
        "flex flex-col flex-1 min-w-0 overflow-y-auto",
        "m-2 sidebar:my-3 sidebar:mr-2 sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome",
        className,
      )}
    >
      {/* Mobile close affordance (desktop hides via the header toggle). */}
      {onClose && (
        <div className="flex items-center justify-between px-2 py-1 shrink-0 sidebar:hidden">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Members</h3>
          <Button variant="ghost" size="icon" aria-label="Close members" className="size-6" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {admins.length > 0 && (
        <>
          <h3 className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Admins · {admins.length}
          </h3>
          {sortedAdmins.map((admin) => (
            <MemberRow
              key={admin.pubkey}
              pubkey={admin.pubkey}
              roles={admin.roles}
              canModerate={canModerate}
              viewerIsAdmin={viewerIsAdmin}
              currentUserPubkey={currentUserPubkey}
              onRemove={onRemove}
              onSetRole={onSetRole}
              onEditProfile={onEditProfile}
              communityRoles={communityRoles}
              assignedRoleIds={communityAssignments?.get(admin.pubkey)}
              onToggleCommunityRole={onToggleCommunityRole}
            />
          ))}
        </>
      )}

      <h3 className="px-2 py-1 mt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Members · {regulars.length}
      </h3>
      {regulars.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          No visible members. The relay may hide the member list.
        </p>
      ) : (
        regulars.map((pubkey) => (
          <MemberRow
            key={pubkey}
            pubkey={pubkey}
            canModerate={canModerate}
            viewerIsAdmin={viewerIsAdmin}
            currentUserPubkey={currentUserPubkey}
            onRemove={onRemove}
            onSetRole={onSetRole}
            onEditProfile={onEditProfile}
            communityRoles={communityRoles}
            assignedRoleIds={communityAssignments?.get(pubkey)}
            onToggleCommunityRole={onToggleCommunityRole}
          />
        ))
      )}
    </aside>
  );
}
