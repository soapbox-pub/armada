import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MailPlus,
  Radio,
  ShieldCheck,
  UserRoundCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as nip19 from "nostr-tools/nip19";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BannedFromCommunityError, DissolvedCommunityError, bundleToEntry } from "@/concord/hooks/useCommunityActions";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import {
  useAcceptDirectInvite,
  useDeclineDirectInvite,
  useInviteInbox,
  type InviteInboxItem,
  type ParkedInvite,
} from "@/concord/hooks/useDirectInvites";
import { InviteTide } from "@/concord/components/InviteTide";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import { directInviteExpired } from "@/concord/lib/directInvite";
import type { InviteBundle } from "@/concord/lib/invite";
import type { Community, ImagePointer } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useFollowList } from "@/hooks/useFollowList";
import { concordInviteReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { relativeTime, shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";
import { usePageCovered } from "@/lib/settingsOverlay";
import { AvatarInitial } from "@/components/AvatarInitial";

/** The seal-verified sender as a short npub, shown beside the (self-chosen) profile. */
function senderLabel(pubkeyHex: string): string {
  try {
    return `${nip19.npubEncode(pubkeyHex).slice(0, 16)}…`;
  } catch {
    return `${pubkeyHex.slice(0, 16)}…`;
  }
}

/**
 * A stable hue (0-359) from the community id, for fallback artwork. djb2, as in
 * `meshIdentity.ts`.
 */
function communityHue(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 33) + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/** The generated wash behind a community's monogram tile / banner strip. */
function communityWash(hue: number, strength = 1): string {
  return (
    `linear-gradient(135deg, hsl(${hue} 70% 52% / ${0.42 * strength}) 0%,`
    + ` hsl(${(hue + 48) % 360} 72% 46% / ${0.16 * strength}) 55%,`
    + ` hsl(${(hue + 96) % 360} 70% 40% / ${0.06 * strength}) 100%)`
  );
}

/** Private channels this bundle hands over, read off the bundle (no Control sweep). */
function channelCount(invite: ParkedInvite): number {
  return Array.isArray(invite.bundle.channels) ? invite.bundle.channels.length : 0;
}

/** The community icon, decrypted with the invite's key; initial on the wash as fallback. */
function CommunityAvatar({
  name,
  communityId,
  icon,
  held = false,
  className,
}: {
  name: string;
  communityId: string;
  icon: ImagePointer | undefined;
  /** A stranger's invite: its art isn't fetched (it is theirs to choose), the wash stands in. */
  held?: boolean;
  className?: string;
}) {
  const iconUrl = useDecryptedImage(held ? undefined : icon);

  return (
    <span
      style={iconUrl ? undefined : { backgroundImage: communityWash(communityHue(communityId)) }}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden clip-corner-lg bg-secondary font-bold uppercase leading-none text-foreground/80",
        className,
      )}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-full object-cover" />
      ) : (
        name.trim().charAt(0).toUpperCase() || "·"
      )}
    </span>
  );
}

/**
 * Who's already in there, from the Guestbook Plane (CORD-02 §5) with the invite's
 * keys — for the SELECTED invite only (it connects to the community's relays).
 * Feeds only the friend stack; there's deliberately no member count, since a
 * slow cold sweep would make it wrong or a spinner.
 */
function useInviteMembers(community: Community | undefined) {
  const { coalesced } = useGuestbook(community);
  return useMemo(
    () =>
      [...coalesced.values()]
        .filter((m) => m.state === "join")
        .sort((a, b) => a.ms - b.ms)
        .map((m) => m.pubkey),
    [coalesced],
  );
}

/** The community's relays from the bundle — the hosts this account will connect to. */
function RelayList({ relays }: { relays: string[] }) {
  return (
    <>
      <p className="px-3.5 pb-1.5 pt-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <FormattedMessage id="invitesPage.hostedOn" defaultMessage="Hosted on" />
      </p>
      <div className="max-h-80 overflow-y-auto pb-2.5">
        {relays.map((url) => (
          <p
            key={url}
            className="break-all px-3.5 py-1.5 font-mono text-xs leading-snug text-muted-foreground"
          >
            {url}
          </p>
        ))}
      </div>
    </>
  );
}

/** A stats-line fact that opens something; plain text until hovered (its icon marks it). */
function StatPopover({
  icon: Icon,
  label,
  hint,
  width,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  width: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside pointerdown (capture phase): Radix defers touch dismissal
  // to a `click` iOS doesn't send for non-clickable targets, leaving it stuck open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          title={hint}
          className={cn(
            "inline-flex items-center gap-1 align-[-0.15em] transition-colors hover:text-foreground",
            className,
          )}
        >
          <Icon className="size-3.5 shrink-0" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        // Close explicitly: Radix skips `onDismiss` if anything prevented the default.
        onInteractOutside={() => setOpen(false)}
        className={cn(width, "p-0 [--vessel-fill:hsl(var(--chrome))]")}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** One face in the friend stack. */
function FriendFace({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);

  return (
    <Avatar
      shape={getAvatarShape(metadata)}
      title={name}
      className={cn("size-6 ring-2 ring-background", className)}
    >
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-monogram font-semibold text-primary">
        <AvatarInitial name={name} />
      </AvatarFallback>
    </Avatar>
  );
}

/** One name in the friend line, resolved the same way the faces are. */
function FriendName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  return <DisplayName pubkey={pubkey} name={getDisplayName(author.data?.metadata, pubkey)} />;
}

/**
 * Followed people who are in there: faces, then names (a count on narrow
 * screens). Renders NOTHING until there's someone to name, so the slow guestbook
 * sweep never holds up the screen.
 */
function FriendStack({ pubkeys }: { pubkeys: string[] }) {
  if (pubkeys.length === 0) return null;
  const faces = pubkeys.slice(0, 4);
  // Up to three fit as a list; past that it's two names and a remainder.
  const named = pubkeys.slice(0, pubkeys.length <= 3 ? pubkeys.length : 2);
  const rest = pubkeys.length - named.length;

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center">
        {faces.map((pubkey, i) => (
          <FriendFace key={pubkey} pubkey={pubkey} className={i > 0 ? "-ml-2" : undefined} />
        ))}
      </span>
      {/* Narrow screens get a count: names would truncate mid-word. */}
      <span className="shrink-0 sm:hidden">
        <FormattedMessage
          id="invitesPage.friendCount"
          defaultMessage="{count, plural, one {# friend is here} other {# friends are here}}"
          values={{ count: pubkeys.length }}
        />
      </span>
      <span className="hidden min-w-0 truncate sm:inline">
        <FriendLine
          names={named.map((pubkey) => (
            <span key={pubkey} className="font-medium text-foreground">
              <FriendName pubkey={pubkey} />
            </span>
          ))}
          rest={rest}
        />
      </span>
    </div>
  );
}

/** "A, B and 2 others are here" — one whole sentence per shape, so word order can move. */
function FriendLine({ names, rest }: { names: React.ReactNode[]; rest: number }) {
  const [a, b, c] = names;
  if (rest > 0) {
    return (
      <FormattedMessage
        id="invitesPage.friendsHere.twoAndRest"
        defaultMessage="{a}, {b} and {rest, plural, one {# other} other {# others}} are here"
        values={{ a, b, rest }}
      />
    );
  }
  if (names.length === 1) {
    return <FormattedMessage id="invitesPage.friendsHere.one" defaultMessage="{a} is here" values={{ a }} />;
  }
  if (names.length === 2) {
    return <FormattedMessage id="invitesPage.friendsHere.two" defaultMessage="{a} and {b} are here" values={{ a, b }} />;
  }
  return (
    <FormattedMessage id="invitesPage.friendsHere.three" defaultMessage="{a}, {b} and {c} are here" values={{ a, b, c }} />
  );
}

/** One invite in the master list: which community, who sent it, and when. */
function InviteRow({
  item,
  selected,
  request = false,
  onOpen,
}: {
  item: InviteInboxItem;
  selected: boolean;
  /** From a sender the viewer doesn't know: no trust mark, no unread emphasis. */
  request?: boolean;
  onOpen: (item: InviteInboxItem) => void;
}) {
  const { invite } = item;
  const unread = item.unread && !request;
  const isCatchUp = Boolean(invite.catchUp);
  const channels = channelCount(invite);
  const sender = useAuthor(invite.sender);
  const senderName = getDisplayName(sender.data?.metadata, invite.sender);
  const intl = useIntl();

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors clip-corner-lg",
        selected ? "bg-primary/10" : "hover:bg-foreground/5",
        unread && !selected && "bg-primary/[0.06]",
      )}
    >
      <CommunityAvatar
        name={invite.name}
        communityId={invite.communityId}
        icon={invite.bundle.icon}
        held={request}
        className="size-11 text-lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("min-w-0 truncate", unread ? "font-semibold" : "font-medium")}>
            {invite.name}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {shortTimeAgo(invite.receivedAt)}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 flex min-w-0 items-center gap-1 text-xs",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {!request && <ShieldCheck className="size-3 shrink-0 text-success" />}
          <span className="truncate">
            {isCatchUp ? (
              <FormattedMessage id="invitesPage.row.keysBy" defaultMessage="Updated keys by {name}" values={{ name: senderName }} />
            ) : (
              <FormattedMessage id="invitesPage.row.invitedBy" defaultMessage="Invited by {name}" values={{ name: senderName }} />
            )}
          </span>
        </p>
        {channels > 0 && (
          <p className="mt-0.5 truncate text-2xs leading-snug text-muted-foreground/70">
            <FormattedMessage
              id="invitesPage.row.channelsIncluded"
              defaultMessage="{count, plural, one {# channel included} other {# channels included}}"
              values={{ count: channels }}
            />
          </p>
        )}
      </div>
      {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label={intl.formatMessage({ id: "invitesPage.row.unread", defaultMessage: "Unread" })} />}
    </button>
  );
}

/**
 * The invite preview / consent surface with explicit Accept/Decline.
 * PRESENTATIONAL: the caller owns the actions, so it serves both Direct Invites
 * (`InboxInviteDetail`) and invite links (`InvitePage`). Only Direct Invites name
 * a sender (seal-verified); a bundle's `creator_npub` is unverified and not shown.
 * Nothing but artwork and the friend stack waits on the network.
 */
export function InviteDetail({
  bundle,
  communityId,
  name,
  sender,
  receivedAt,
  isCatchUp = false,
  isRequest = false,
  accepting,
  declining,
  onAccept,
  onDecline,
  onBack,
  signInSlot,
}: {
  bundle: InviteBundle;
  communityId: string;
  name: string;
  /** The seal-verified sender, when the invite arrived as a Direct Invite. */
  sender?: string;
  /** When it arrived (unix seconds) — a Direct Invite only; a link has none. */
  receivedAt?: number;
  /** A key update for a community already joined (Direct Invite catch-up). */
  isCatchUp?: boolean;
  /** The sender is someone the viewer doesn't know (the DM request rule). */
  isRequest?: boolean;
  accepting: boolean;
  declining: boolean;
  onAccept: () => void;
  onDecline: () => void;
  /** The mobile master→list back arrow; omitted where there is no list. */
  onBack?: () => void;
  /** Replaces the Accept button when signed out (a sign-in call to action). */
  signInSlot?: React.ReactNode;
}) {
  const busy = accepting || declining;
  const intl = useIntl();

  const hue = communityHue(communityId);
  const channels = Array.isArray(bundle.channels) ? bundle.channels.length : 0;
  const relayUrls = Array.isArray(bundle.relays) ? bundle.relays : [];
  const relays = relayUrls.length;
  const description = bundle.description?.trim();
  const expired = directInviteExpired(bundle);
  // A stranger's invite shows its art only on request, like a stranger's media in
  // a chat: an image they chose is otherwise fetched just by opening the invite.
  const [revealedArt, setRevealedArt] = useState<string | undefined>(undefined);
  const artHeld = isRequest && revealedArt !== communityId;
  const hasArt = Boolean(bundle.banner || bundle.icon);
  const bannerUrl = useDecryptedImage(artHeld ? undefined : bundle.banner);
  const iconUrl = useDecryptedImage(artHeld ? undefined : bundle.icon);

  const senderAuthor = useAuthor(sender);
  const senderMeta = senderAuthor.data?.metadata;
  const senderName = getDisplayName(senderMeta, sender);

  // The community the bundle describes, built as the accept paths do, so the
  // guestbook read opens the plane the keys actually grant.
  const previewCommunity = useMemo(() => {
    try {
      return rehydrateCommunity(bundleToEntry(bundle));
    } catch {
      return undefined;
    }
  }, [bundle]);

  const members = useInviteMembers(previewCommunity);

  // Whether the viewer follows the sender — the strongest trust signal here.
  const { data: followList } = useFollowList();
  const followsSender = Boolean(sender && followList?.pubkeys.includes(sender));
  // The subset of the room you already follow — the friend stack's whole input.
  const followedMembers = useMemo(() => {
    const following = new Set(followList?.pubkeys ?? []);
    return members.filter((pubkey) => following.has(pubkey));
  }, [followList, members]);

  // Middot-joined facts, so a link (no "Sent" time) doesn't strand a separator.
  const facts: React.ReactNode[] = [];
  if (channels > 0) {
    facts.push(
      <span
        key="channels"
        title={intl.formatMessage({
          id: "invitesPage.detail.channelsHint",
          defaultMessage: "Channels this invite gets you into. There may be more inside.",
        })}
      >
        <FormattedMessage
          id="invitesPage.detail.channels"
          defaultMessage="{count, plural, one {# channel} other {# channels}}"
          values={{ count: channels }}
        />
      </span>,
    );
  }
  if (relays > 0) {
    facts.push(
      <StatPopover
        key="relays"
        icon={Radio}
        label={intl.formatMessage(
          { id: "invitesPage.detail.relays", defaultMessage: "{count, plural, one {# relay} other {# relays}}" },
          { count: relays },
        )}
        hint={intl.formatMessage({
          id: "invitesPage.detail.relaysHint",
          defaultMessage: "Servers that carry this community's messages.",
        })}
        width="w-80"
      >
        <RelayList relays={relayUrls} />
      </StatPopover>,
    );
  }
  if (receivedAt !== undefined) {
    facts.push(
      <span key="sent">
        <FormattedMessage id="invitesPage.detail.sent" defaultMessage="Sent {time}" values={{ time: relativeTime(receivedAt) }} />
      </span>,
    );
  }
  if (expired) {
    facts.push(
      <span
        key="expired"
        title={intl.formatMessage({
          id: "invitesPage.detail.expiredHint",
          defaultMessage: "This invite can no longer be accepted.",
        })}
        className="text-destructive"
      >
        <FormattedMessage id="invitesPage.detail.expired" defaultMessage="Expired" />
      </span>,
    );
  }

  return (
    <div className="relative flex flex-1 flex-col min-h-0 safe-area-top h-full overflow-hidden">
      <InviteTide hue={hue} />
      <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "invitesPage.detail.backToInvites", defaultMessage: "Back to invites" })}
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <ShieldCheck className="size-5 text-success shrink-0" />
        <h1 className="font-semibold truncate leading-tight">
          {isCatchUp ? (
            <FormattedMessage id="invitesPage.detail.titleCatchUp" defaultMessage="Updated community keys" />
          ) : (
            <FormattedMessage id="invitesPage.detail.title" defaultMessage="Encrypted community invite" />
          )}
        </h1>
      </header>

      <div className="relative flex-1 min-h-0 overflow-y-auto">
        {/* The banner is the pane's top edge; falls back to a blurred icon, then the wash. */}
        <div
          className="relative h-40 w-full overflow-hidden bg-secondary sm:h-56"
          style={{
            ...(bannerUrl ? undefined : { backgroundImage: communityWash(hue) }),
            // Feather the top edge under the floating header.
            maskImage: "linear-gradient(to bottom, transparent 0%, black 15%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 15%)",
          }}
        >
          {bannerUrl ? (
            <img src={bannerUrl} alt="" className="size-full object-cover" />
          ) : iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="size-full scale-125 object-cover opacity-50 blur-2xl"
            />
          ) : (
            /* Wrapped rather than `aria-hidden`: the crest is a labelled `role="img"`. */
            <span
              aria-hidden
              className="pointer-events-none absolute -right-8 -top-6 opacity-[0.14]"
            >
              <ArmadaCrest size={240} />
            </span>
          )}
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
          />
        </div>

        <div className="mx-auto w-full max-w-2xl px-4 pb-8 sm:px-6">
          <div className="-mt-12 sm:-mt-14">
            <CommunityAvatar
              name={name}
              communityId={communityId}
              icon={bundle.icon}
              held={artHeld}
              className="size-20 text-3xl sm:size-24 sm:text-4xl"
            />
          </div>

          <h2 className="mt-3 break-words text-2xl font-bold leading-tight sm:text-3xl">
            {name}
          </h2>

          {facts.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {facts.map((fact, i) => (
                <Fragment key={i}>
                  {i > 0 && <span aria-hidden>·</span>}
                  {fact}
                </Fragment>
              ))}
            </p>
          )}

          {/* Followed members; absent until the guestbook finds someone. */}
          {followedMembers.length > 0 && (
            <div className="mt-3">
              <FriendStack pubkeys={followedMembers} />
            </div>
          )}

          {description && (
            <p className="mt-3.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}

          {/* Sender — Direct Invite only. The npub is the key that signed the seal. */}
          {sender && (
            <div className="mt-4 clip-corner-lg bg-secondary/40 p-3.5">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {isCatchUp ? (
                  <FormattedMessage id="invitesPage.detail.keysSentBy" defaultMessage="Keys sent by" />
                ) : (
                  <FormattedMessage id="invitesPage.detail.invitedBy" defaultMessage="Invited by" />
                )}
              </p>
              <ProfilePreviewCard pubkey={sender}>
                <button
                  type="button"
                  className="mt-2 flex w-full min-w-0 items-center gap-3 text-left"
                >
                  <div className="relative shrink-0">
                    <Avatar shape={getAvatarShape(senderMeta)} className="size-11">
                      <AvatarImage src={senderMeta?.picture} imeta={senderAuthor.data?.imeta?.picture} alt={senderName} />
                      <AvatarFallback className="bg-primary/20 font-semibold text-primary">
                        <AvatarInitial name={senderName} />
                      </AvatarFallback>
                    </Avatar>
                    {followsSender && (
                      <span
                        title={intl.formatMessage({ id: "invitesPage.detail.following", defaultMessage: "Following" })}
                        className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-success text-success-foreground ring-2 ring-background"
                      >
                        <UserRoundCheck className="size-2.5" />
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium leading-tight">
                      <DisplayName pubkey={sender} name={senderName} />
                    </p>
                    <p className="truncate font-mono text-2xs leading-snug text-muted-foreground">
                      {senderLabel(sender)}
                    </p>
                  </div>
                </button>
              </ProfilePreviewCard>
              {/* The sender's bio, wide screens only (pushes buttons off a phone). */}
              {senderMeta?.about?.trim() && (
                // Hide on the wrapper: `line-clamp` sets `display` too.
                <div className="hidden sm:block">
                  <p className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground">
                    {senderMeta.about.trim()}
                  </p>
                </div>
              )}
              {isRequest && (
                <p className="mt-2.5 text-xs leading-snug text-warning">
                  <FormattedMessage
                    id="invitesPage.detail.requestNotice"
                    defaultMessage="You don’t know this sender. Only accept invites from people you trust."
                  />
                  {artHeld && hasArt && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground"
                        onClick={() => setRevealedArt(communityId)}
                      >
                        <FormattedMessage id="invitesPage.detail.showArt" defaultMessage="Show the community’s images" />
                      </button>
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          <p className="mt-4 text-pretty text-sm leading-relaxed text-muted-foreground">
            {isCatchUp ? (
              <FormattedMessage
                id="invitesPage.detail.catchUpExplainer"
                defaultMessage="Someone sent you access to more channels in a community you’re already in. Accepting just adds those channels, and nothing else changes."
              />
            ) : (
              <FormattedMessage
                id="invitesPage.detail.explainer"
                defaultMessage="Accepting adds this community to your list. What’s said inside stays private to the people in it."
              />
            )}
          </p>

          {/* The decision sits directly under the copy (reading and tab order). */}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="ghost"
              className="h-12 min-w-0 flex-1 clip-corner-lg text-base"
              onClick={onDecline}
              disabled={busy}
            >
              {declining ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              {isCatchUp ? (
                <FormattedMessage id="invitesPage.detail.notNow" defaultMessage="Not now" />
              ) : (
                <FormattedMessage id="invitesPage.detail.decline" defaultMessage="Decline" />
              )}
            </Button>
            {signInSlot ?? (
              <Button
                className="h-12 min-w-0 flex-1 clip-corner-lg text-base font-medium"
                onClick={onAccept}
                disabled={busy || expired}
              >
                {accepting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                {expired
                  ? intl.formatMessage({ id: "invitesPage.detail.inviteExpired", defaultMessage: "Invite expired" })
                  : accepting
                    ? isCatchUp
                      ? intl.formatMessage({ id: "invitesPage.detail.adding", defaultMessage: "Adding…" })
                      : intl.formatMessage({ id: "invitesPage.detail.joining", defaultMessage: "Joining…" })
                    : isCatchUp
                      ? intl.formatMessage({ id: "invitesPage.detail.addChannels", defaultMessage: "Add channels" })
                      : intl.formatMessage({ id: "invitesPage.detail.acceptInvite", defaultMessage: "Accept invite" })}
              </Button>
            )}
          </div>
        </div>
      </div>
      <ArmadaCrestKeyframes />
    </div>
  );
}

/**
 * {@link InviteDetail} for a gift-wrapped Direct Invite: Accept records the vault
 * entry and announces a Guestbook Join; Decline tombstones — except a catch-up
 * (key update for a joined community), which is only dismissed locally.
 */
function InboxInviteDetail({
  invite,
  isRequest,
  onDone,
  onBack,
}: {
  invite: ParkedInvite;
  isRequest: boolean;
  /** The invite left the inbox (accepted or declined) — drop the selection. */
  onDone: () => void;
  /** Mobile back to the list. */
  onBack: () => void;
}) {
  const { mutateAsync: accept, isPending: accepting } = useAcceptDirectInvite();
  const { mutateAsync: decline, isPending: declining } = useDeclineDirectInvite();
  const navigate = useNavigate();
  const isCatchUp = Boolean(invite.catchUp);

  const handleDecline = async () => {
    // A CATCH-UP must NOT tombstone (that would leave the community).
    if (!isCatchUp) {
      try {
        await decline({ communityId: invite.communityId });
      } catch {
        // Best-effort; drop it from view regardless.
      }
    }
    onDone();
  };

  const handleAccept = async () => {
    try {
      const { communityId, name } = await accept({ invite });
      toast({ title: t({ id: "invitesPage.toast.joined", defaultMessage: "Joined encrypted community" }), description: name });
      navigate(`/c/${encodeURIComponent(communityId)}`);
    } catch (e) {
      if (e instanceof BannedFromCommunityError) {
        toast({
          title: t({ id: "invitesPage.toast.bannedTitle", defaultMessage: "You're banned" }),
          description: t({ id: "invitesPage.toast.bannedDescription", defaultMessage: "You can't join this community." }),
          variant: "destructive",
        });
        await handleDecline();
        return;
      }
      if (e instanceof DissolvedCommunityError) {
        toast({
          title: t({ id: "invitesPage.toast.dissolved", defaultMessage: "{name} was dissolved" }, { name: invite.name }),
          description: e.message,
          variant: "destructive",
        });
        await handleDecline();
        return;
      }
      toast({
        title: t({ id: "invitesPage.toast.joinFailed", defaultMessage: "Couldn't join" }),
        description: e instanceof Error ? e.message : t({ id: "invitesPage.toast.unknownError", defaultMessage: "Unknown error" }),
        variant: "destructive",
      });
    }
  };

  return (
    <InviteDetail
      bundle={invite.bundle}
      communityId={invite.communityId}
      name={invite.name}
      sender={invite.sender}
      receivedAt={invite.receivedAt}
      isCatchUp={isCatchUp}
      isRequest={isRequest}
      accepting={accepting}
      declining={declining}
      onAccept={handleAccept}
      onDecline={handleDecline}
      onBack={onBack}
    />
  );
}

/**
 * The direct-invite inbox (CORD-05 §6): pending gift-wrapped invites as a
 * master/detail list. Opening the page marks the inbox seen; accept/decline stays
 * an explicit per-invite action.
 */
export function InvitesPage() {
  const { items, requests, unreadCount } = useInviteInbox();
  const { markRead } = useReadState();
  const [selectedWrapId, setSelectedWrapId] = useState<string | undefined>(undefined);
  // Collapsed until asked, even when there is nothing else: strangers' invites are where spam lands.
  const [requestsOpen, setRequestsOpen] = useState(false);

  const all = useMemo(() => [...items, ...requests], [items, requests]);
  const selected = all.find((it) => it.invite.wrapId === selectedWrapId)?.invite;
  const selectedIsRequest = requests.some((it) => it.invite.wrapId === selectedWrapId);

  // Mark everything seen (one high-water mark) while on screen — not while
  // Settings covers the page. Seeing isn't accepting.
  const covered = usePageCovered();
  const newest = Math.max(items[0]?.invite.receivedAt ?? 0, requests[0]?.invite.receivedAt ?? 0);
  useEffect(() => {
    if (!covered && newest > 0) markRead(concordInviteReadKey(), newest);
  }, [covered, newest, markRead]);

  // Drop a stale selection when its invite leaves the inbox.
  useEffect(() => {
    if (selectedWrapId && !all.some((it) => it.invite.wrapId === selectedWrapId)) {
      setSelectedWrapId(undefined);
    }
  }, [all, selectedWrapId]);

  return (
    <SwipeReveal
      open={!selected}
      onReveal={() => setSelectedWrapId(undefined)}
      onClose={() => undefined}
      canClose={false}
      underlay={
        <>
          <ServerRail />
          <div className="flex flex-1 sidebar:flex-none sidebar:w-80 min-w-0 flex-col safe-area-top h-full">
            <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
              <MailPlus className="size-5 text-muted-foreground shrink-0" />
              <h1 className="font-semibold truncate leading-tight">
                <FormattedMessage id="invitesPage.title" defaultMessage="Invites" />
              </h1>
              {unreadCount > 0 && (
                <span className="ml-1 flex min-w-5 h-5 px-1.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold leading-none">
                  {unreadCount}
                </span>
              )}
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
              {all.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-3 py-16 text-center text-muted-foreground">
                  <MailPlus className="size-10 opacity-40" />
                  <p className="text-sm">
                    <FormattedMessage
                      id="invitesPage.empty"
                      defaultMessage="No invites. When someone hands you the keys to an encrypted community, it’ll show up here."
                    />
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <InviteRow
                      key={item.invite.wrapId}
                      item={item}
                      selected={item.invite.wrapId === selectedWrapId}
                      onOpen={(it) => setSelectedWrapId(it.invite.wrapId)}
                    />
                  ))}
                  {requests.length > 0 && (
                    <>
                      <button
                        type="button"
                        aria-expanded={requestsOpen}
                        onClick={() => setRequestsOpen(!requestsOpen)}
                        className="mt-2 flex w-full items-center gap-1.5 px-3 py-2 touch:py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", requestsOpen && "rotate-90")} />
                        <FormattedMessage
                          id="invitesPage.requests"
                          defaultMessage="Requests ({count, number})"
                          values={{ count: requests.length }}
                        />
                      </button>
                      {requestsOpen && requests.map((item) => (
                        <InviteRow
                          key={item.invite.wrapId}
                          item={item}
                          request
                          selected={item.invite.wrapId === selectedWrapId}
                          onOpen={(it) => setSelectedWrapId(it.invite.wrapId)}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      }
    >
      <main className="flex flex-1 min-w-0 flex-col bg-background h-full">
        {selected ? (
          <InboxInviteDetail
            key={selected.wrapId}
            invite={selected}
            isRequest={selectedIsRequest}
            onDone={() => setSelectedWrapId(undefined)}
            onBack={() => setSelectedWrapId(undefined)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3 max-w-sm">
              <MailPlus className="size-12 opacity-30" />
              <p className="text-sm">
                {all.length === 0 ? (
                  <FormattedMessage id="invitesPage.noPending" defaultMessage="You have no pending invites." />
                ) : (
                  <FormattedMessage id="invitesPage.selectInvite" defaultMessage="Select an invite to review it." />
                )}
              </p>
            </div>
          </div>
        )}
      </main>
    </SwipeReveal>
  );
}

export default InvitesPage;
