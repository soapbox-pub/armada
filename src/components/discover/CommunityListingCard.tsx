import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Loader2, MoreHorizontal, ShieldCheck, Skull, Trash2 } from "lucide-react";
import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { UserAvatar } from "@/components/UserAvatar";
import { ThumbImg } from "@/components/ui/ThumbImg";
import { AVATAR_LOOPS } from "@/components/ui/avatarLoops";
import { observeIntersection } from "@/lib/sharedIntersection";
import { BoostedBy } from "@/components/discover/BoostedBy";
import { DiscoverBoostsContext } from "@/components/discover/discoverBoosts";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { readCachedBundle, resolveBundle } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useCommunityEntry } from "@/concord/hooks/useCommunityList";
import { probeCommunityDissolved, useControlFold } from "@/concord/hooks/useControlPlane";
import { useUnlistAnnouncements } from "@/concord/hooks/useDiscoverListings";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import {
  discoverStreamAuthors,
  type DiscoverActivityTarget,
} from "@/concord/lib/discoverActivity";
import {
  enqueueDiscoverControlPeek,
  peekDiscoverControl,
  readCachedControlPeek,
} from "@/concord/lib/discoverControlPeek";
import {
  inviteUrlToLocalRoute,
  listingAuthorized,
  listingIdsOf,
  type DiscoveredInvite,
  type ListingStanding,
} from "@/concord/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord/lib/invite";
import { isStaff } from "@/concord/lib/roles";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { defineMessage, FormattedMessage, t, useIntl } from "@/i18n";
import { useIsBlocked } from "@/lib/blocklistStore";
import { writeClipboardText } from "@/lib/clipboard";
import { boostsFor, vouchingBoosts, type Boost } from "@/lib/discoverBoost";
import { shortTimeAgoPhrase } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

interface CommunityListingCardProps {
  invite: DiscoveredInvite;
  className?: string;
  /** Matched against the RESOLVED name, since the announcement has no metadata. Non-matches render nothing. */
  filter?: string;
  /** Here only for a boost (a stranger's listing): rendered only once a voucher other than the owner is confirmed. */
  needsBoost?: boolean;
  /**
   * Reports the bundle's self-certified `community_id`, verified `owner` and how
   * current the link is, so the grid can keep one card per community and rank by
   * owner. The announcement itself carries no verifiable identity.
   */
  onResolved?: (linkSigner: string, standing: ListingStanding) => void;
  /** Another link to the same community stands in for this one: render nothing. */
  suppressed?: boolean;
  /** The announcements whose boosts count here; the listing's own and its copies' by default. */
  boostListings?: readonly string[];
  /** Reports the probe target for the batched last-active REQ, or `null` to withdraw it. */
  onActivityTarget?: (linkSigner: string, target: DiscoverActivityTarget | null) => void;
  /** Newest kind-1059 wrap `created_at` (unix seconds) from the batched probe. */
  lastActiveAt?: number;
}

/**
 * "Active" is the newest wrap across derivable stream addresses (guestbook,
 * Control, vended/peeked channels): community activity, not message activity.
 */
const ACTIVITY_HINT = defineMessage({
  id: "communityListingCard.activityHint",
  defaultMessage:
    "Newest activity on the streams this invite can see: channel messages, join requests and admin changes.",
});

export function CommunityListingCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col w-full p-px clip-hairline-lg [--fill:var(--card)] [--fill-hover:var(--card)] overflow-hidden",
        className,
      )}
      aria-hidden
    >
      <Skeleton className="aspect-[3/1] w-full rounded-none" />
      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="mt-auto h-9 w-full" />
      </div>
    </div>
  );
}

/**
 * A public Concord community from an announcement: resolved banner/icon/name
 * (decrypted from the invite bundle with the link's secret), sharer and Join.
 * Skeleton until the bundle settles.
 */
/**
 * Reads Discover's boosts here, so the card itself re-renders only when its own boosts
 * change: the shared map is replaced as each card comes into view, and every mounted
 * card re-rendered for each.
 */
export function CommunityListingCard(props: CommunityListingCardProps) {
  const { boosts: byListing, vouchers } = useContext(DiscoverBoostsContext);
  const boosts = useSameBoosts(boostsFor(byListing, props.boostListings ?? listingIdsOf(props.invite)));
  return <ListingCard {...props} boosts={boosts} vouchers={useSameSet(vouchers)} />;
}

/** The previous array while it holds the same boosts, in order. */
function useSameBoosts(next: Boost[]): Boost[] {
  const ref = useRef(next);
  const prev = ref.current;
  if (prev !== next && (prev.length !== next.length || prev.some((b, i) => b.event.id !== next[i].event.id))) ref.current = next;
  return ref.current;
}

/** The previous set while it holds the same members. */
function useSameSet(next: ReadonlySet<string> | null): ReadonlySet<string> | null {
  const ref = useRef(next);
  const prev = ref.current;
  if (prev !== next && (!prev || !next || prev.size !== next.size || [...next].some((m) => !prev.has(m)))) ref.current = next;
  return ref.current;
}

const ListingCard = memo(function ListingCard({
  invite,
  className,
  filter,
  needsBoost = false,
  onResolved,
  suppressed = false,
  onActivityTarget,
  lastActiveAt,
  boosts,
  vouchers,
}: CommunityListingCardProps & { boosts: Boost[]; vouchers: ReadonlySet<string> | null }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { nostr } = useNostr();
  const parsed = useMemo(() => parseInviteLink(invite.inviteUrl), [invite.inviteUrl]);
  const [copied, setCopied] = useState(false);

  // The home-relay second hop runs in the background; a fresher copy or a
  // revocation lands via the callback.
  const queryClient = useQueryClient();
  const { data: bundle, isLoading: bundleLoading, isError: bundleError } = useQuery({
    queryKey: ["discover", "invite-bundle", invite.linkSigner],
    enabled: !!parsed,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      resolveBundle(nostr, parsed!, parsed!.bootstrapRelays, {
        onSecondHop: (result) => {
          const key = ["discover", "invite-bundle", invite.linkSigner];
          if (result.bundle) queryClient.setQueryData(key, result.bundle);
          // Re-resolving hits the tombstoned floor and errors, hiding the card.
          else if (result.revoked) void queryClient.invalidateQueries({ queryKey: key });
        },
      }),
  });

  // Warm paint from the persisted floor, seeded STALE (`updatedAt: 0`) so the
  // network fetch (and any revocation) still runs; never over a network result.
  useEffect(() => {
    if (!parsed) return;
    let cancelled = false;
    void (async () => {
      const cached = await readCachedBundle(parsed);
      if (cancelled || !cached) return;
      const key = ["discover", "invite-bundle", invite.linkSigner];
      if (queryClient.getQueryData(key) !== undefined) return;
      queryClient.setQueryData(key, cached, { updatedAt: 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, invite.linkSigner, queryClient]);

  // Attribute to the verified bundle `owner`, not the announcement author (just the sharer).
  const attributedPubkey = bundle?.owner ?? invite.source.pubkey;
  const ownedByOwner = !!bundle?.owner;
  const author = useAuthor(attributedPubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, attributedPubkey);

  const isBlocked = useIsBlocked();
  const blocked = !!bundle?.community_id && isBlocked(bundle.community_id);
  // An owner boosting their own community vouches for nothing.
  const vouched = useMemo(
    () => (bundle ? vouchingBoosts(boosts, vouchers, bundle.owner) : NO_BOOSTS),
    [boosts, vouchers, bundle],
  );
  const authorized = !!bundle && listingAuthorized(bundle, invite.source.pubkey) && (!needsBoost || vouched.length > 0);

  // Dissolved communities' links keep resolving, so check the dissolved address
  // (derived from community_id, so non-members can check it too).
  const { data: dissolvedAtMs, isPending: dissolvedPending } = useQuery({
    queryKey: ["discover", "dissolved", bundle?.community_id],
    enabled: !!bundle?.community_id && !!bundle.owner && !blocked && authorized,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () =>
      (await probeCommunityDissolved(nostr, {
        communityId: bundle!.community_id,
        owner: bundle!.owner,
        relays: Array.isArray(bundle!.relays) ? bundle!.relays : [],
      })) ?? null,
  });
  const dissolved = dissolvedAtMs != null;
  // Hold the skeleton until answered so a dissolved card never paints then vanishes.
  const dissolvedChecking = !!bundle?.community_id && !!bundle.owner && !blocked && authorized && dissolvedPending;

  // NIP-09 deletes only count from the event's author.
  const { user } = useCurrentUser();
  const isAuthor = !!user && user.pubkey === invite.source.pubkey;
  const { unlistLinks } = useUnlistAnnouncements();
  const [removing, setRemoving] = useState(false);

  const memberEntry = useCommunityEntry(bundle?.community_id);
  const isMember = !!memberEntry;

  // Members prefer the authoritative control fold over the bundle preview,
  // which is only as fresh as the link creator's last re-post.
  const memberCommunity = useCommunity(memberEntry?.community_id);
  const { data: folded } = useControlFold(memberCommunity);

  // Peeks are serialized, so only cards that have been on screen queue one. Latched.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const onScreen = useSeenOnScreen(cardEl);

  // Non-member Control peek for channel count + public channel ids. Serialized globally.
  // Per epoch too: links to one community on different epochs read different planes.
  const controlPeekKey = ["discover", "control-peek", bundle?.community_id, bundle?.root_epoch] as const;
  const { data: controlPeek } = useQuery({
    queryKey: controlPeekKey,
    enabled: !!bundle && !isMember && !!bundle.community_id && onScreen && !blocked,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      enqueueDiscoverControlPeek(() => peekDiscoverControl(nostr, bundle!, signal)),
  });

  // Warm-seed last session's peek, STALE so the live peek still refreshes.
  useEffect(() => {
    if (!bundle?.community_id || isMember || !onScreen) return;
    let cancelled = false;
    void (async () => {
      const cached = await readCachedControlPeek(bundle.community_id, bundle.root_epoch);
      if (cancelled || !cached) return;
      if (queryClient.getQueryData(controlPeekKey) !== undefined) return;
      queryClient.setQueryData(controlPeekKey, cached, { updatedAt: 0 });
    })();
    return () => {
      cancelled = true;
    };
    // controlPeekKey's community_id and epoch are what matter; the array identity is stable per pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.community_id, bundle?.root_epoch, isMember, onScreen, queryClient]);

  const icon = folded?.metadata?.icon ?? bundle?.icon;
  const banner = folded?.metadata?.banner ?? bundle?.banner;
  const iconUrl = useDecryptedImage(icon);
  const bannerUrl = useDecryptedImage(banner);
  const name =
    folded?.metadata?.name?.trim()
    || bundle?.name?.trim()
    || intl.formatMessage({ id: "communityListingCard.fallbackName", defaultMessage: "Encrypted community" });
  const description = folded?.metadata?.description?.trim() || bundle?.description?.trim() || "";
  const initial = name.charAt(0).toUpperCase() || "·";
  // Fold > peek > bundle's vended channels as floor, so a member's count doesn't
  // drop to zero while the fold loads.
  const bundleChannelCount = Array.isArray(bundle?.channels) ? bundle.channels.length : 0;
  const channelCount = folded
    ? [...folded.channels.values()].filter((c) => !c.deleted).length
    : (controlPeek?.channelCount ?? bundleChannelCount);
  const stats: Array<{ key: string; text: string; hint?: string }> = [];
  if (channelCount > 0) {
    stats.push({
      key: "channels",
      text: intl.formatMessage(
        { id: "communityListingCard.channelCount", defaultMessage: "{count, plural, one {# channel} other {# channels}}" },
        { count: channelCount },
      ),
    });
  }
  if (lastActiveAt != null && lastActiveAt > 0) {
    stats.push({
      key: "active",
      text: intl.formatMessage(
        { id: "communityListingCard.activeAgo", defaultMessage: "Active {time}" },
        { time: shortTimeAgoPhrase(lastActiveAt) },
      ),
      hint: intl.formatMessage(ACTIVITY_HINT),
    });
  }
  const publicChannelIdHexes = useMemo(() => {
    if (folded) {
      return [...folded.channels.values()]
        .filter((c) => !c.deleted && !c.isPrivate)
        .map((c) => c.channelIdHex)
        .sort();
    }
    return controlPeek?.publicChannelIdHexes;
  }, [folded, controlPeek?.publicChannelIdHexes]);

  // A member judges the link by its own fold, a stranger by the peek of the link's epoch.
  const sharer = invite.source.pubkey;
  const linkSigner = invite.linkSigner;
  const bundleEpoch = bundle?.root_epoch;
  const memberEpoch = memberCommunity?.rootEpoch;
  const peek = controlPeek && controlPeek.epoch === bundleEpoch ? controlPeek : undefined;
  const retired = bundleEpoch !== undefined && (memberEpoch !== undefined ? BigInt(bundleEpoch) < memberEpoch : !!peek?.rotated);
  const sharerRank = !bundle
    ? 2
    : sharer === bundle.owner
      ? 0
      : (memberEpoch !== undefined ? !!folded && isStaff(folded.roster, sharer, folded.ownerHex) : !!peek?.staff?.includes(sharer))
        ? 1
        : 2;

  useEffect(() => {
    // An unauthorized copy must not win the dedupe over the owner's own listing.
    if (!bundle?.community_id || !authorized || bundleEpoch === undefined) return;
    onResolved?.(linkSigner, { communityId: bundle.community_id, owner: bundle.owner, epoch: bundleEpoch, sharerRank, retired });
  }, [bundle?.community_id, bundle?.owner, bundleEpoch, sharerRank, retired, authorized, linkSigner, onResolved]);

  // Unlisted cards must stop being probed, or the REQ keeps asking about them.
  const needle = filter?.trim().toLowerCase();
  const listed =
    !suppressed
    && !retired
    && !bundleLoading
    && !bundleError
    && !!parsed
    && !!bundle
    && !dissolvedChecking
    && !dissolved
    && !blocked
    && authorized
    && (!needle || name.toLowerCase().includes(needle));
  // A dissolved community stays visible to its listing author as a remove-only husk.
  const husk =
    dissolved
    && isAuthor
    && !bundleLoading
    && !bundleError
    && !!bundle
    && (!needle || name.toLowerCase().includes(needle));

  // Cleanup withdraws the target: on unmount that's the prune; on dep change
  // it's batched with the re-report.
  useEffect(() => {
    if (!onActivityTarget) return;
    if (!listed || !bundle) {
      onActivityTarget(invite.linkSigner, null);
      return;
    }
    onActivityTarget(invite.linkSigner, {
      linkSigner: invite.linkSigner,
      authors: discoverStreamAuthors(bundle, { publicChannelIdHexes }),
      relays: Array.isArray(bundle.relays) ? bundle.relays : [],
    });
    return () => onActivityTarget(invite.linkSigner, null);
  }, [listed, bundle, publicChannelIdHexes, invite.linkSigner, onActivityTarget]);

  const onJoin = () => navigate(inviteUrlToLocalRoute(invite.inviteUrl));
  const onOpen = () => navigate(`/c/${encodeURIComponent(bundle!.community_id)}`);
  const onRemove = async () => {
    setRemoving(true);
    try {
      // Discover keeps the newest copy per link, so unlist every copy.
      await unlistLinks([invite.linkSigner], [invite]);
      toast({
        title: t({ id: "communityListingCard.removedTitle", defaultMessage: "Removed from Discover" }),
        description: t(
          { id: "communityListingCard.removedDescription", defaultMessage: "{name} is no longer listed by you." },
          { name },
        ),
      });
    } catch (e) {
      toast({
        title: t({ id: "communityListingCard.removeFailed", defaultMessage: "Couldn't remove the listing" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRemoving(false);
    }
  };
  const onCopy = async () => {
    try {
      await writeClipboardText(invite.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: t({ id: "communityListingCard.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" });
    }
  };

  if (suppressed) return null;
  if (bundleLoading || dissolvedChecking) return <CommunityListingCardSkeleton className={className} />;

  // Unresolvable links (revoked, expired, dead relays) are hidden; this is what
  // makes revoking a shared link an un-listing. So are links rotated out.
  if ((!listed && !husk) || !bundle || blocked) return null;

  return (
    <div
      ref={setCardEl}
      className={cn(
        // Off-screen cards skip style, layout and paint: Discover keeps every loaded
        // page mounted, and each new page restyled them all on a phone.
        "flex flex-col w-full p-px clip-hairline-lg [--fill:var(--card)] [--fill-hover:var(--card)] overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_420px]",
        className,
      )}
    >
      {/* Bannerless communities still get the 3:1 strip (blurred icon or initial) so card heights match. */}
      {(() => {
        const bannerContent = bannerUrl ? (
          <ThumbImg src={bannerUrl} alt="" loading="lazy" loops={AVATAR_LOOPS} className="size-full object-cover" />
        ) : (
          <>
            {iconUrl ? (
              <ThumbImg
                src={iconUrl}
                alt=""
                aria-hidden
                loading="lazy"
                loops={AVATAR_LOOPS}
                className="size-full scale-125 object-cover opacity-50 blur-2xl"
              />
            ) : (
              <span
                aria-hidden
                className="flex size-full items-center justify-center text-7xl font-bold uppercase text-foreground/10"
              >
                {initial}
              </span>
            )}
            <span className="absolute inset-0 flex items-center justify-center px-4">
              <span className="min-w-0 truncate text-lg font-bold text-foreground/90 drop-shadow-sm">
                {name}
              </span>
            </span>
          </>
        );
        return isMember ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={intl.formatMessage({ id: "communityListingCard.openName", defaultMessage: "Open {name}" }, { name })}
            className="relative aspect-[3/1] w-full shrink-0 overflow-hidden bg-secondary"
          >
            {bannerContent}
          </button>
        ) : (
          <div className="relative aspect-[3/1] w-full shrink-0 overflow-hidden bg-secondary">
            {bannerContent}
          </div>
        );
      })()}
      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-success">
            {iconUrl ? (
              <ThumbImg src={iconUrl} alt="" loading="lazy" loops={AVATAR_LOOPS} className="size-full object-cover" />
            ) : (
              <span className="text-sm font-semibold">{initial}</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            {isMember ? (
              <button
                type="button"
                onClick={onOpen}
                className="block max-w-full truncate text-left font-semibold leading-tight hover:underline"
              >
                {name}
              </button>
            ) : (
              <p className="font-semibold truncate leading-tight">{name}</p>
            )}
            <p className="text-2xs leading-snug text-muted-foreground">
              <ShieldCheck className="mr-1 inline size-3 align-[-0.125em]" />
              {stats.map((stat, i) => (
                <Fragment key={stat.key}>
                  {i > 0 ? " · " : null}
                  <span title={stat.hint}>{stat.text}</span>
                </Fragment>
              ))}
            </p>
          </div>
        </div>

        {description && (
          <p className="text-xs text-muted-foreground line-clamp-2 break-words">{description}</p>
        )}

        <ProfilePreviewCard pubkey={attributedPubkey}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
          >
            <UserAvatar
              pubkey={attributedPubkey}
              metadata={metadata}
              imeta={author.data?.imeta?.picture}
              name={displayName}
              className="size-4 shrink-0"
              fallbackClassName="text-monogram"
            />
            <span className="truncate">
              <FormattedMessage
                id="communityListingCard.attribution"
                defaultMessage="{owned, select, true {owned by {name}} other {shared by {name}}}"
                values={{
                  owned: ownedByOwner ? "true" : "false",
                  name: <DisplayName pubkey={attributedPubkey} name={displayName} />,
                }}
              />
            </span>
          </button>
        </ProfilePreviewCard>

        {boosts.length > 0 && <BoostedBy boosts={boosts} named={vouched} />}

        <div className="mt-auto flex gap-2">
          {husk ? (
            <Button variant="secondary" className="min-w-0 flex-1 clip-corner-lg" disabled>
              <Skull className="size-4" />
              <FormattedMessage id="communityListingCard.dissolved" defaultMessage="Dissolved" />
            </Button>
          ) : isMember ? (
            <Button variant="secondary" className="min-w-0 flex-1 clip-corner-lg" onClick={onOpen}>
              <Check className="size-4" />
              <FormattedMessage id="communityListingCard.open" defaultMessage="Open" />
            </Button>
          ) : (
            <Button className="min-w-0 flex-1 clip-corner-lg" onClick={onJoin}>
              <FormattedMessage id="communityListingCard.join" defaultMessage="Join" />
              <ArrowRight className="size-4" />
            </Button>
          )}
          {!husk && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 clip-corner-lg"
              aria-label={intl.formatMessage({ id: "communityListingCard.copyInviteLink", defaultMessage: "Copy invite link" })}
              onClick={onCopy}
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          )}
          {isAuthor && (
            <DropdownMenu touchSheet>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 clip-corner-lg"
                  aria-label={intl.formatMessage({ id: "communityListingCard.listingOptions", defaultMessage: "Listing options" })}
                  disabled={removing}
                >
                  {removing ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => void onRemove()}
                >
                  <Trash2 className="mr-2 size-4" />
                  <FormattedMessage id="communityListingCard.removeFromDiscover" defaultMessage="Remove from Discover" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * Latches true the first time `el` comes within a screenful of the viewport.
 * Without IntersectionObserver it reports true, so the gate only ever delays work.
 */
function useSeenOnScreen(el: Element | null): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    if (!el) return;
    const stop = observeIntersection(el, (entry) => {
      if (!entry.isIntersecting) return;
      stop();
      setSeen(true);
    }, "300px");
    return stop;
  }, [el, seen]);

  return seen;
}

const NO_BOOSTS: Boost[] = [];
