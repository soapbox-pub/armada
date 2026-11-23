import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BadgeCheck, Check, Copy, Loader2, MoreHorizontal, RefreshCw, ShieldCheck, Skull, Trash2, Waypoints } from "lucide-react";
import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { VectorMark } from "@/components/brand/VectorMark";
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
import { readCachedBundle, resolveBundle, useAdoptListedKeys } from "@/concord/hooks/useCommunityActions";
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
  refoundedPastEpoch,
} from "@/concord/lib/discoverControlPeek";
import {
  entryListingIds,
  inviteUrlToLocalRoute,
  linkCreator,
  listingAuthorized,
  type DiscoverEntry,
  type ListingOrigins,
  type ListingStanding,
} from "@/concord/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord/lib/invite";
import { VECTOR_HUB_PAGE } from "@/concord/lib/vectorHub";
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
  entry: DiscoverEntry;
  /** Where this community was listed, across all its links; the entry's own by default. */
  origins?: ListingOrigins;
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
  const boosts = useSameBoosts(boostsFor(byListing, props.boostListings ?? entryListingIds(props.entry)));
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
  entry,
  origins,
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
  const parsed = useMemo(() => parseInviteLink(entry.inviteUrl), [entry.inviteUrl]);
  const linkSigner = entry.linkSigner;
  // Who announced it on Nostr; a link only the Vector Hub lists has nobody here.
  const sharer = entry.invite?.source.pubkey;
  const [copied, setCopied] = useState(false);

  // The home-relay second hop runs in the background; a fresher copy or a
  // revocation lands via the callback.
  const queryClient = useQueryClient();
  const { data: bundle, isLoading: bundleLoading, isError: bundleError } = useQuery({
    queryKey: ["discover", "invite-bundle", linkSigner],
    enabled: !!parsed,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      resolveBundle(nostr, parsed!, parsed!.bootstrapRelays, {
        onSecondHop: (result) => {
          const key = ["discover", "invite-bundle", linkSigner];
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
      const key = ["discover", "invite-bundle", linkSigner];
      if (queryClient.getQueryData(key) !== undefined) return;
      queryClient.setQueryData(key, cached, { updatedAt: 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, linkSigner, queryClient]);

  // Attribute to the verified bundle `owner`, not the announcement author (just the sharer).
  const attributedPubkey = bundle?.owner ?? sharer;
  const ownedByOwner = !!bundle?.owner;
  const author = useAuthor(attributedPubkey);
  const metadata = author.data?.metadata;
  const displayName = attributedPubkey ? getDisplayName(metadata, attributedPubkey) : "";

  const isBlocked = useIsBlocked();
  const blocked = !!bundle?.community_id && isBlocked(bundle.community_id);
  // An owner boosting their own community vouches for nothing.
  const vouched = useMemo(
    () => (bundle ? vouchingBoosts(boosts, vouchers, bundle.owner) : NO_BOOSTS),
    [boosts, vouchers, bundle],
  );
  // A hub listing is the hub's claim, which it checks with the owner; an announcement must come from the owner or the link's creator.
  const authorized = !!bundle
    && (sharer ? listingAuthorized(bundle, sharer) : !!entry.hub)
    && (!needsBoost || vouched.length > 0);

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
  const isAuthor = !!user && !!sharer && user.pubkey === sharer;
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
  const shownOrigins = origins ?? ownOrigins(entry);
  const stats: Array<{ key: string; text: string; hint?: string }> = [];
  const hubMembers = shownOrigins.hub?.memberCount;
  if (hubMembers != null && hubMembers > 0) {
    stats.push({
      key: "members",
      text: intl.formatMessage(
        { id: "communityListingCard.memberCount", defaultMessage: "{count, plural, one {# member} other {# members}}" },
        { count: hubMembers },
      ),
      hint: intl.formatMessage({ id: "communityListingCard.memberCountHint", defaultMessage: "As counted by the Vector Hub" }),
    });
  }
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
  // A hub listing is ranked as shared by the link's creator.
  const rankedSharer = sharer ?? (bundle ? linkCreator(bundle) ?? bundle.owner : undefined);
  const bundleEpoch = bundle?.root_epoch;
  const memberEpoch = memberCommunity?.rootEpoch;
  const peek = controlPeek && controlPeek.epoch === bundleEpoch ? controlPeek : undefined;
  const retired = bundleEpoch !== undefined && (memberEpoch !== undefined ? BigInt(bundleEpoch) < memberEpoch : !!peek?.rotated);
  // The link is on newer keys than ours. Its epoch is only the link creator's claim,
  // so a Refounding past ours must be honored by our own epoch's fold (CORD-06 §2).
  const linkAhead = bundleEpoch !== undefined && memberEpoch !== undefined && BigInt(bundleEpoch) > memberEpoch;
  const { data: keysBehind = false } = useQuery({
    queryKey: ["discover", "keys-behind", memberCommunity?.idHex, memberEpoch?.toString()],
    enabled: linkAhead && !!memberCommunity && !!folded && onScreen,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      refoundedPastEpoch(
        nostr,
        memberCommunity!.relays,
        { communityId: memberCommunity!.id, root: memberCommunity!.root, epoch: memberCommunity!.rootEpoch },
        folded!,
        AbortSignal.any([AbortSignal.timeout(KEYS_BEHIND_TIMEOUT_MS), signal]),
      ),
  });
  const adoptKeys = useAdoptListedKeys();
  const sharerRank = !bundle
    ? 2
    : rankedSharer === bundle.owner
      ? 0
      : rankedSharer && (memberEpoch !== undefined ? !!folded && isStaff(folded.roster, rankedSharer, folded.ownerHex) : !!peek?.staff?.includes(rankedSharer))
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
      onActivityTarget(linkSigner, null);
      return;
    }
    onActivityTarget(linkSigner, {
      linkSigner: linkSigner,
      authors: discoverStreamAuthors(bundle, { publicChannelIdHexes }),
      relays: Array.isArray(bundle.relays) ? bundle.relays : [],
    });
    return () => onActivityTarget(linkSigner, null);
  }, [listed, bundle, publicChannelIdHexes, linkSigner, onActivityTarget]);

  const onJoin = () => navigate(inviteUrlToLocalRoute(entry.inviteUrl));
  const onOpen = () => navigate(`/c/${encodeURIComponent(bundle!.community_id)}`);
  const onUpdateKeys = async () => {
    try {
      const moved = await adoptKeys.mutateAsync({ invite: parsed!, bundle: bundle!, heldEpoch: memberEpoch! });
      if (!moved) return;
      toast({ title: t({ id: "communityListingCard.keysUpdated", defaultMessage: "Keys updated" }) });
      onOpen();
    } catch (e) {
      toast({
        title: t({ id: "communityListingCard.keysUpdateFailed", defaultMessage: "Couldn't update your keys" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };
  const onRemove = async () => {
    setRemoving(true);
    try {
      // Discover keeps the newest copy per link, so unlist every copy.
      await unlistLinks([linkSigner], entry.invite ? [entry.invite] : []);
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
      await writeClipboardText(entry.inviteUrl);
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
  const attributed = attributedPubkey ?? bundle.owner;

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

        <ListingOriginBadges origins={shownOrigins} />

        <ProfilePreviewCard pubkey={attributed}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
          >
            <UserAvatar
              pubkey={attributed}
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
                  name: <DisplayName pubkey={attributed} name={displayName} />,
                }}
              />
            </span>
          </button>
        </ProfilePreviewCard>

        {boosts.length > 0 && <BoostedBy boosts={boosts} named={vouched} />}

        {isMember && keysBehind && !husk && (
          <p className="text-2xs leading-snug text-warning">
            <FormattedMessage
              id="communityListingCard.keysBehind"
              defaultMessage="The community rotated its keys without reaching you, so you can't read new messages. This link is on newer keys."
            />
          </p>
        )}

        <div className="mt-auto flex gap-2">
          {husk ? (
            <Button variant="secondary" className="min-w-0 flex-1 clip-corner-lg" disabled>
              <Skull className="size-4" />
              <FormattedMessage id="communityListingCard.dissolved" defaultMessage="Dissolved" />
            </Button>
          ) : isMember && keysBehind ? (
            <Button className="min-w-0 flex-1 clip-corner-lg" onClick={() => void onUpdateKeys()} disabled={adoptKeys.isPending}>
              {adoptKeys.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              <FormattedMessage id="communityListingCard.updateKeys" defaultMessage="Update keys" />
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

/** An entry's own origins, for a card given none. */
function ownOrigins(entry: DiscoverEntry): ListingOrigins {
  return { nostr: !!entry.invite, hub: entry.hub };
}

const ORIGIN_BADGE = "inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 clip-corner text-2xs font-medium";

/** Where the community was listed: announced on Nostr, in the Vector Hub, or both. */
function ListingOriginBadges({ origins }: { origins: ListingOrigins }) {
  const intl = useIntl();
  const hub = origins.hub;
  if (!origins.nostr && !hub) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
      <span>
        <FormattedMessage id="communityListingCard.listedOn" defaultMessage="Listed on" />
      </span>
      {origins.nostr && (
        <span
          className={cn(ORIGIN_BADGE, "bg-foreground/5 text-foreground/80")}
          title={intl.formatMessage({
            id: "communityListingCard.origin.nostrHint",
            defaultMessage: "Announced on Nostr by someone Discover is showing you.",
          })}
        >
          <Waypoints className="size-3 shrink-0" aria-hidden />
          <FormattedMessage id="communityListingCard.origin.nostr" defaultMessage="Nostr" />
        </span>
      )}
      {/* Vector's mark may only appear as a link to an official Vector site. */}
      {hub && (
        <a
          href={VECTOR_HUB_PAGE}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(ORIGIN_BADGE, "bg-[#33DB98]/10 text-foreground/90 hover:bg-[#33DB98]/20 touch:min-h-11 touch:px-2.5")}
          title={intl.formatMessage({
            id: "communityListingCard.origin.vectorHubHint",
            defaultMessage: "Listed in the Vector Hub, Vector's community directory at vectorapp.io. Vector reviews its listings; Armada doesn't.",
          })}
        >
          <VectorMark className="h-3 w-auto shrink-0" />
          <span className="truncate">
            {hub.official ? (
              <FormattedMessage id="communityListingCard.origin.vectorHubOfficial" defaultMessage="Vector Hub · Official" />
            ) : (
              <FormattedMessage id="communityListingCard.origin.vectorHub" defaultMessage="Vector Hub" />
            )}
          </span>
          {hub.official && <BadgeCheck className="size-3 shrink-0 text-[#33DB98]" aria-hidden />}
        </a>
      )}
      {hub?.category && (
        <span className={cn(ORIGIN_BADGE, "bg-foreground/5")}>
          <span className="truncate">{hub.category}</span>
        </span>
      )}
    </div>
  );
}

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

/** How long the keys-behind check waits on the member's relays. */
const KEYS_BEHIND_TIMEOUT_MS = 8_000;
