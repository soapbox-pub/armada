import { AtSign, Bot, ChevronDown, Copy, Crown, IdCard, MessageSquareText, MoreVertical, Music, Shield, Smile, UserCog, UserPlus, X } from "lucide-react";

import { memo, useCallback, useMemo, useRef, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BotPill } from "@/components/BotPill";
import { UltraPill } from "@/components/UltraPill";
import { DeferredRow } from "@/components/DeferredRow";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { StatusDialog } from "@/components/dialogs/StatusDialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { UserModerationMenuSection } from "@/components/chat/ModerationMenuSection";
import { RolePickerItems, type RolePickerOption } from "@/components/chat/RolePickerItems";
import { useUserModeration } from "@/hooks/useUserModeration";
import { DisplayName } from "@/components/DisplayName";
import { SearchField } from "@/components/ui/search-field";
import { useAuthor } from "@/hooks/useAuthor";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useMemberNameOrder, useMemberSearch } from "@/hooks/useMemberSearch";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { isStatusExpired, useUserStatus } from "@/hooks/useUserStatus";
import { requestMention } from "@/hooks/useMentionBus";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { tryNpubEncode } from "@/lib/safeNip19";
import { useFrameCss, nameStyleCss, readUltra, ULTRA_LIST_NAME_CLASS } from "@/lib/ultra";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";
import { FormattedMessage, t, useIntl } from "@/i18n";

import type { Nip29Admin } from "@/lib/nip29";
import type { ComponentType, ReactNode } from "react";
import { AvatarInitial } from "@/components/AvatarInitial";

const ROLE_OWNER = "owner";
const ROLE_ADMIN = "admin";
const ROLE_MODERATOR = "moderator";
/** Buzz roles carried on the 39002 members event. */
const ROLE_BOT = "bot";
const ROLE_GUEST = "guest";

/** Menu primitives shared by the ⋮ dropdown and right-click menu (compatible Radix props). */
interface MenuParts {
  Item: ComponentType<{ className?: string; onSelect?: (e: Event) => void; children?: ReactNode }>;
  Separator: ComponentType<{ className?: string }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>;
  CheckboxItem: ComponentType<{
    className?: string;
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    onSelect?: (e: Event) => void;
    children?: ReactNode;
  }>;
}

const roleTint = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

/** Device-local: which roster sections (role id, or "admins"/"members") are folded. */
const COLLAPSED_SECTIONS_KEY = "armada:memberSectionsCollapsed";
const NO_COLLAPSED: string[] = [];
const ADMINS_SECTION = "admins";
const MEMBERS_SECTION = "members";

function SectionHeader({ collapsed, onToggle, color, children }: {
  collapsed: boolean;
  onToggle: () => void;
  color?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="group/section flex h-10 w-full items-center gap-1 px-3 text-left text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3
        className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider"
        style={color ? { color: roleTint(color) } : undefined}
      >
        {children}
      </h3>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 opacity-0 transition-transform group-hover/section:opacity-100 touch:opacity-100",
          collapsed && "-rotate-90 opacity-100",
        )}
      />
    </button>
  );
}

const ROW_MIN_H = 48;
/** Below this many members the panel shows no search field. */
const SEARCH_MIN_MEMBERS = 10;
/**
 * Offscreen rows are viewport-gated at every roster size: each row's `useAuthor`
 * demands a profile, so ungated rows put a kind-0 REQ for the whole roster on
 * the wire alongside the room's first chat REQ. Searches render every row (the
 * matcher reads names a row populates once mounted).
 */

interface MemberRowProps {
  pubkey: string;
  roles?: string[];
  /** Live presence dot (Buzz relays). Undefined = unknown (no dot). */
  presence?: "online" | "away";
  currentUserPubkey?: string;
  /** Per-server nickname/label editor (viewer's own row only). */
  onEditProfile?: () => void;
  /** Buzz relays: kind 41010. */
  onMessage?: (pubkey: string) => void;
  /** Custom-role chip for members without a tier badge. */
  customBadge?: { name: string; color: number };
}

const MemberRow = memo(function MemberRow({
  pubkey,
  roles,
  presence,
  currentUserPubkey,
  onEditProfile,
  onMessage,
  customBadge,
}: MemberRowProps) {
  const intl = useIntl();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const ultra = useMemo(() => readUltra(metadata), [metadata]);
  const frameStyle = useFrameCss(ultra?.frame);
  const { displayName, color } = useScopedIdentity(pubkey, metadata);
  const status = useUserStatus(pubkey).data?.status;
  const rawMusicStatus = useUserStatus(pubkey, "music").data?.status;
  // NIP-40 expiration passed: the track ended.
  const musicStatus = isStatusExpired(rawMusicStatus) ? undefined : rawMusicStatus;
  const [statusOpen, setStatusOpen] = useState(false);
  const moderation = useUserModeration(pubkey);

  const roleSet = new Set((roles ?? []).map((r) => r.toLowerCase()));
  const isOwner = roleSet.has(ROLE_OWNER);
  // The owner holds every permission implicitly, even without the "admin" role string.
  const isAdmin = isOwner || roleSet.has(ROLE_ADMIN);
  const isModerator = roleSet.has(ROLE_MODERATOR);
  const isSelf = currentUserPubkey === pubkey;

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    writeClipboardText(npub).then(
      () => toast({ title: t({ id: "memberList.copiedNpub", defaultMessage: "Copied npub" }) }),
      () => toast({ title: t({ id: "memberList.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" }),
    );
  };

  const { rolePicker } = moderation;

  const renderMenuItems = ({ Item, Separator, Sub, SubTrigger, SubContent, CheckboxItem }: MenuParts) => (
    <>
      <Item onSelect={() => requestMention(pubkey)}>
        <AtSign className="size-4" />
        <FormattedMessage id="memberList.mention" defaultMessage="Mention" />
      </Item>
      {onMessage && !isSelf && (
        <Item onSelect={() => onMessage(pubkey)}>
          <MessageSquareText className="size-4" />
          <FormattedMessage id="memberList.message" defaultMessage="Message" />
        </Item>
      )}
      <Item onSelect={copyNpub}>
        <Copy className="size-4" />
        <FormattedMessage id="memberList.copyNpub" defaultMessage="Copy npub" />
      </Item>

      {isSelf && (
        <Item onSelect={() => setStatusOpen(true)}>
          <Smile className="size-4" />
          <FormattedMessage id="memberList.setStatus" defaultMessage="Set status" />
        </Item>
      )}

      {isSelf && onEditProfile && (
        <Item onSelect={onEditProfile}>
          <IdCard className="size-4" />
          <FormattedMessage id="memberList.serverIdentity" defaultMessage="Server identity" />
        </Item>
      )}

      {rolePicker && (
        <>
          <Separator />
          <Sub>
            <SubTrigger>
              <UserCog className="size-4" />
              <FormattedMessage id="memberList.roles" defaultMessage="Roles" />
            </SubTrigger>
            <SubContent className="w-56 max-h-72 overflow-y-auto">
              <RolePickerItems
                CheckboxItem={CheckboxItem}
                pubkey={pubkey}
                catalog={rolePicker.catalog}
                heldRoleIds={rolePicker.heldRoleIds}
                isToggling={rolePicker.isToggling}
                onToggle={rolePicker.onToggle}
              />
            </SubContent>
          </Sub>
        </>
      )}

      {moderation.actions.length > 0 && (
        <>
          {!rolePicker && <Separator />}
          <UserModerationMenuSection parts={{ Item, Sub, SubTrigger, SubContent }} actions={moderation.actions} />
        </>
      )}
    </>
  );

  return (
    <>
    <ContextMenu>
    <ContextMenuTrigger className="block">
    <div className="member-row gutter-tick group flex items-center gap-2.5 pl-3 pr-2 py-2 clip-corner-lg transition-colors hover:bg-accent/50 hover:text-foreground">
      <ProfilePreviewCard pubkey={pubkey}>
        <button type="button" className="relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={frameStyle}>
          <Avatar shape={getAvatarShape(metadata)} className="size-8 cursor-pointer transition-opacity hover:opacity-90">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-3xs">
              <AvatarInitial name={displayName} pubkey={pubkey} />
            </AvatarFallback>
          </Avatar>
          {presence && (
            <span
              aria-label={presence === "online"
                ? intl.formatMessage({ id: "memberList.online", defaultMessage: "Online" })
                : intl.formatMessage({ id: "memberList.away", defaultMessage: "Away" })}
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[hsl(var(--chrome))]",
                presence === "online" ? "bg-success" : "bg-warning",
              )}
            />
          )}
        </button>
      </ProfilePreviewCard>
      <ProfilePreviewCard pubkey={pubkey}>
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus:outline-none"
        >
          <span
            className={cn("block text-sm truncate", !color && ultra?.name && ULTRA_LIST_NAME_CLASS)}
            style={color ? { color } : nameStyleCss(ultra?.name)}
          >
            <DisplayName pubkey={pubkey} name={displayName} />
          </span>
          {status?.content && (
            <span
              className="block text-xs text-muted-foreground truncate"
              title={status.content}
            >
              <EmojifiedText tags={status.event.tags}>{status.content}</EmojifiedText>
            </span>
          )}
          {musicStatus?.content && (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground truncate"
              title={musicStatus.content}
            >
              <Music className="size-3 shrink-0" />
              <span className="truncate">
                <EmojifiedText tags={musicStatus.event.tags}>{musicStatus.content}</EmojifiedText>
              </span>
            </span>
          )}
        </button>
      </ProfilePreviewCard>
      {isOwner ? (
        <span
          title={intl.formatMessage({ id: "memberList.role.owner", defaultMessage: "Owner" })}
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-3xs font-medium text-amber-500"
        >
          <Crown className="size-3" aria-hidden />
          <span className="member-pill-label"><FormattedMessage id="memberList.role.owner" defaultMessage="Owner" /></span>
        </span>
      ) : isAdmin ? (
        <span
          title={intl.formatMessage({ id: "memberList.role.admin", defaultMessage: "Admin" })}
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary"
        >
          <Shield className="size-3" aria-hidden />
          <span className="member-pill-label"><FormattedMessage id="memberList.role.admin" defaultMessage="Admin" /></span>
        </span>
      ) : isModerator ? (
        <span
          title={intl.formatMessage({ id: "memberList.role.moderator", defaultMessage: "Moderator" })}
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
        >
          <Shield className="size-3" aria-hidden />
          <span className="member-pill-label"><FormattedMessage id="memberList.role.mod" defaultMessage="Mod" /></span>
        </span>
      ) : customBadge ? (
        <span
          title={customBadge.name}
          className={cn(
            "min-w-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium max-w-24",
            !customBadge.color && "bg-muted text-muted-foreground",
          )}
          style={customBadge.color ? { color: roleTint(customBadge.color), backgroundColor: `${roleTint(customBadge.color)}26` } : undefined}
        >
          <span className="truncate">{customBadge.name}</span>
        </span>
      ) : roleSet.has(ROLE_BOT) ? (
        <span
          title={intl.formatMessage({ id: "memberList.role.agent", defaultMessage: "Agent" })}
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary"
        >
          <Bot className="size-3" aria-hidden />
          <span className="member-pill-label"><FormattedMessage id="memberList.role.agent" defaultMessage="Agent" /></span>
        </span>
      ) : roleSet.has(ROLE_GUEST) ? (
        <span
          title={intl.formatMessage({ id: "memberList.role.guest", defaultMessage: "Guest" })}
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
        >
          <FormattedMessage id="memberList.role.guest" defaultMessage="Guest" />
        </span>
      ) : null}
      <BotPill metadata={metadata} labelClassName="member-pill-label" />
      {ultra && <UltraPill force labelClassName="member-pill-label" />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={intl.formatMessage({ id: "memberList.manage", defaultMessage: "Manage {name}" }, { name: displayName })}
            className="size-6 shrink-0 touch:size-10 opacity-0 group-hover:opacity-100 touch:opacity-100 data-[state=open]:opacity-100 text-muted-foreground hover:text-foreground"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {renderMenuItems({
            Item: DropdownMenuItem,
            Separator: DropdownMenuSeparator,
            Sub: DropdownMenuSub,
            SubTrigger: DropdownMenuSubTrigger,
            SubContent: DropdownMenuSubContent,
            CheckboxItem: DropdownMenuCheckboxItem,
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-56">
      {renderMenuItems({
        Item: ContextMenuItem,
        Separator: ContextMenuSeparator,
        Sub: ContextMenuSub,
        SubTrigger: ContextMenuSubTrigger,
        SubContent: ContextMenuSubContent,
        CheckboxItem: ContextMenuCheckboxItem,
      })}
    </ContextMenuContent>
    </ContextMenu>
    {isSelf && <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} />}
    {moderation.dialogs}
    </>
  );
});

interface MemberListProps {
  admins: Nip29Admin[];
  members: string[];
  currentUserPubkey?: string;
  /** Per-member role labels (Buzz: member/guest/bot). */
  memberRoles?: Record<string, string>;
  /** Live presence (Buzz: ephemeral kind-20001 heartbeats). */
  presence?: Record<string, "online" | "away">;
  onClose?: () => void;
  onEditProfile?: () => void;
  /** Buzz relays: kind 41010. */
  onMessage?: (pubkey: string) => void;
  roleCatalog?: RolePickerOption[];
  memberRoleIds?: Record<string, string[]>;
  /** Hoisted role sections above Admins; their members appear only there. */
  roleSections?: Array<{ id: string; name: string; color: number; members: string[] }>;
  /** Concord: add-members for the active private channel; set only when the viewer may grant access. */
  onAddMembers?: () => void;
  className?: string;
}

/**
 * Right-hand member panel. Memoized: the page re-renders on every store write
 * and a roster render walks a row per member.
 */
export const MemberList = memo(function MemberList({
  admins,
  members,
  currentUserPubkey,
  memberRoles,
  presence,
  onClose,
  onEditProfile,
  onMessage,
  roleCatalog,
  memberRoleIds,
  roleSections,
  onAddMembers,
  className,
}: MemberListProps) {
  const intl = useIntl();
  const { mutedPubkeys } = useMutedPubkeys();
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsedList, setCollapsedList] = useLocalStorage<string[]>(COLLAPSED_SECTIONS_KEY, NO_COLLAPSED);
  const collapsedSet = useMemo(() => new Set(collapsedList), [collapsedList]);
  const toggleSection = useCallback((id: string) => {
    setCollapsedList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, [setCollapsedList]);

  const adminMap = new Map(admins.map((a) => [a.pubkey, a.roles] as const));
  // Stable arrays so memoized rows get stable `roles` identities.
  const buzzRoles = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [pubkey, role] of Object.entries(memberRoles ?? {})) m.set(pubkey, [role]);
    return m;
  }, [memberRoles]);
  const sectioned = new Set((roleSections ?? []).flatMap((s) => s.members));
  // First (highest-position) server-scope custom role; tier badges win in MemberRow.
  const customBadgeOf = (pubkey: string): { name: string; color: number } | undefined => {
    const held = memberRoleIds?.[pubkey];
    if (!held?.length || !roleCatalog) return undefined;
    return roleCatalog.find((r) => r.channelName === undefined && held.includes(r.id));
  };
  const byName = useMemberNameOrder(intl.locale);
  // Owner first, then by name (`p` tag and grant order mean nothing to a reader).
  const isOwnerRole = (a: Nip29Admin) => a.roles.some((r) => r.toLowerCase() === "owner");
  // Muted people leave the roster entirely, filtered at the source so counts and
  // empty states agree.
  const sortedAdmins = [...admins]
    .filter((a) => !mutedPubkeys.has(a.pubkey))
    .sort((a, b) => {
      const ao = isOwnerRole(a) ? 0 : 1;
      const bo = isOwnerRole(b) ? 0 : 1;
      return ao - bo || byName(a.pubkey, b.pubkey);
    });
  const allRegulars = members
    .filter((pubkey) => !adminMap.has(pubkey) && !mutedPubkeys.has(pubkey))
    .sort(byName);

  const roster = useMemo(
    () => [...sortedAdmins.map((a) => a.pubkey), ...allRegulars],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedAdmins.map((a) => a.pubkey).join(","), allRegulars.join(",")],
  );
  const matched = useMemberSearch(roster, query);
  const searching = matched !== null;
  const virtualize = !searching;
  // A search shows its matches whatever is folded.
  const isCollapsed = (id: string) => !searching && collapsedSet.has(id);

  const visibleAdmins = sortedAdmins.filter(
    (a) => !sectioned.has(a.pubkey) && (!matched || matched.has(a.pubkey)),
  );
  const regulars = allRegulars.filter(
    (pubkey) => !sectioned.has(pubkey) && (!matched || matched.has(pubkey)),
  );
  const visibleSections = (roleSections ?? []).map((section) => ({
    ...section,
    members: section.members
      .filter((pubkey) => !mutedPubkeys.has(pubkey) && (!matched || matched.has(pubkey)))
      .sort(byName),
  }));
  const noMatches =
    searching &&
    visibleAdmins.length === 0 &&
    regulars.length === 0 &&
    visibleSections.every((section) => section.members.length === 0);

  // A list short enough to read at a glance needs no search; kept while a query is live.
  const showSearch = roster.length >= SEARCH_MIN_MEMBERS || query !== "";

  return (
    <aside
      className={cn(
        "flex flex-col flex-1 min-w-0 overflow-hidden",
        "mt-stack mb-2 sidebar:mb-3 mx-gutter sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome",
        className,
      )}
    >
      {onClose && (
        <div className="flex items-center justify-between px-2 py-1 shrink-0 sidebar:hidden">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <FormattedMessage id="memberList.members" defaultMessage="Members" />
          </h3>
          <Button variant="ghost" size="icon" aria-label={intl.formatMessage({ id: "memberList.close", defaultMessage: "Close members" })} className="size-6 touch:size-10" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {onAddMembers && (
        <button
          type="button"
          onClick={onAddMembers}
          className="flex w-full shrink-0 items-center gap-2.5 pl-3 pr-2 py-2 mb-1 clip-corner-lg text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserPlus className="size-4" aria-hidden />
          </span>
          <FormattedMessage id="memberList.addMembers" defaultMessage="Add members" />
        </button>
      )}

      {showSearch && (
        <div className="shrink-0 pb-1.5">
          <SearchField
            // Not type="search": WebKit/Blink add their own cancel button.
            type="text"
            value={query}
            onChange={setQuery}
            placeholder={intl.formatMessage({ id: "memberList.search", defaultMessage: "Search members" })}
            className="text-sm"
          />
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {noMatches && (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          <FormattedMessage
            id="memberList.noMatches"
            defaultMessage="No members match “{query}”."
            values={{ query: query.trim() }}
          />
        </p>
      )}
      {/* Every section opens with the same 40px heading band: under the search, the
          first member row lands on the 168px line (banner bottom, first community). */}
      {visibleAdmins.length > 0 && (
        <>
          <SectionHeader collapsed={isCollapsed(ADMINS_SECTION)} onToggle={() => toggleSection(ADMINS_SECTION)}>
            <FormattedMessage
              id="memberList.adminsHeading"
              defaultMessage="Admins · {count}"
              values={{ count: visibleAdmins.length }}
            />
          </SectionHeader>
          {!isCollapsed(ADMINS_SECTION) && visibleAdmins.map((admin) => (
            <DeferredRow key={admin.pubkey} active={virtualize} minHeight={ROW_MIN_H} rootRef={scrollRef}>
            <MemberRow
              pubkey={admin.pubkey}
              roles={admin.roles}
              presence={presence?.[admin.pubkey]}
              currentUserPubkey={currentUserPubkey}
              onEditProfile={onEditProfile}
              onMessage={onMessage}
              customBadge={customBadgeOf(admin.pubkey)}
            />
            </DeferredRow>
          ))}
        </>
      )}

      {visibleSections.map((section) =>
        !searching || section.members.length > 0 ? (
          <div key={section.id}>
            <SectionHeader collapsed={isCollapsed(section.id)} onToggle={() => toggleSection(section.id)} color={section.color}>
              {section.name} · {section.members.length}
            </SectionHeader>
            {!isCollapsed(section.id) && section.members.map((pubkey) => (
              <DeferredRow key={pubkey} active={virtualize} minHeight={ROW_MIN_H} rootRef={scrollRef}>
              <MemberRow
                pubkey={pubkey}
                roles={adminMap.get(pubkey)}
                presence={presence?.[pubkey]}
                currentUserPubkey={currentUserPubkey}
                onEditProfile={onEditProfile}
                onMessage={onMessage}
              />
              </DeferredRow>
            ))}
          </div>
        ) : null,
      )}

      {(!searching || regulars.length > 0) && (
        <SectionHeader collapsed={isCollapsed(MEMBERS_SECTION)} onToggle={() => toggleSection(MEMBERS_SECTION)}>
          <FormattedMessage
            id="memberList.membersHeading"
            defaultMessage="Members · {count}"
            values={{ count: regulars.length }}
          />
        </SectionHeader>
      )}
      {isCollapsed(MEMBERS_SECTION) ? null : regulars.length === 0 ? (
        !searching && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <FormattedMessage
              id="memberList.noneVisible"
              defaultMessage="No visible members. The relay may hide the member list."
            />
          </p>
        )
      ) : (
        regulars.map((pubkey) => (
          <DeferredRow key={pubkey} active={virtualize} minHeight={ROW_MIN_H} rootRef={scrollRef}>
          <MemberRow
            pubkey={pubkey}
            roles={buzzRoles.get(pubkey)}
            presence={presence?.[pubkey]}
            currentUserPubkey={currentUserPubkey}
            onEditProfile={onEditProfile}
            onMessage={onMessage}
            customBadge={customBadgeOf(pubkey)}
          />
          </DeferredRow>
        ))
      )}
      </div>
    </aside>
  );
});
