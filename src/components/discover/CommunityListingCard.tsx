import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Loader2, MoreHorizontal, ShieldCheck, Skull, Trash2 } from "lucide-react";
import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { BoostedBy } from "@/components/discover/BoostedBy";
import { DiscoverBoostsContext } from "@/components/discover/discoverBoosts";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord/lib/invite";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { defineMessage, FormattedMessage, t, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { useIsBlocked } from "@/lib/blocklistStore";
import { writeClipboardText } from "@/lib/clipboard";
import { boostsFor, vouchingBoosts, type Boost } from "@/lib/discoverBoost";
import { shortTimeAgoPhrase } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";
import { AvatarInitial } from "@/components/AvatarInitial";

interface CommunityListingCardProps {
  invite: DiscoveredInvite;
  className?: string;
  /** Matched against the RESOLVED name, since the announcement has no metadata. Non-matches render nothing. */
  filter?: string;
  /** Here only for a boost (a stranger's listing): rendered only once a voucher other than the owner is confirmed. */
  needsBoost?: boolean;
  /**
   * Reports the bundle's self-certified `community_id` and verified `owner`, so
   * the grid can dedupe links to the same community and rank by owner. The
   * announcement itself carries no verifiable identity.
   */
  onResolved?: (linkSigner: string, communityId: string, owner: string) => void;
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
export function CommunityListingCard({
  invite,
  className,
  filter,
  needsBoost = false,
  onResolved,
  onActivityTarget,
  lastActiveAt,
}: CommunityListingCardProps) {
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
  const { boosts: boostsByListing, vouchers } = useContext(DiscoverBoostsContext);
  const boosts = useMemo(() => boostsFor(boostsByListing, [invite.source.id]), [boostsByListing, invite.source.id]);
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
  const controlPeekKey = ["discover", "control-peek", bundle?.community_id] as const;
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
      const cached = await readCachedControlPeek(bundle.community_id);
      if (cancelled || !cached) return;
      if (queryClient.getQueryData(controlPeekKey) !== undefined) return;
      queryClient.setQueryData(controlPeekKey, cached, { updatedAt: 0 });
    })();
    return () => {
      cancelled = true;
    };
    // controlPeekKey's community_id is what matters; the array identity is stable per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.community_id, isMember, onScreen, queryClient]);

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

  useEffect(() => {
    // An unauthorized copy must not win the dedupe over the owner's own listing.
    if (bundle?.community_id && authorized) onResolved?.(invite.linkSigner, bundle.community_id, bundle.owner);
  }, [bundle?.community_id, bundle?.owner, authorized, invite.linkSigner, onResolved]);

  // Unlisted cards must stop being probed, or the REQ keeps asking about them.
  const needle = filter?.trim().toLowerCase();
  const listed =
    !bundleLoading
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

  if (bundleLoading || dissolvedChecking) return <CommunityListingCardSkeleton className={className} />;

  // Unresolvable links (revoked, expired, dead relays) are hidden; this is what
  // makes revoking a shared link an un-listing.
  if ((!listed && !husk) || !bundle || blocked) return null;

  return (
    <div
      ref={setCardEl}
      className={cn(
        "flex flex-col w-full p-px clip-hairline-lg [--fill:var(--card)] [--fill-hover:var(--card)] overflow-hidden",
        className,
      )}
    >
      {/* Bannerless communities still get the 3:1 strip (blurred icon or initial) so card heights match. */}
      {(() => {
        const bannerContent = bannerUrl ? (
          <img src={bannerUrl} alt="" className="size-full object-cover" />
        ) : (
          <>
            {iconUrl ? (
              <img
                src={iconUrl}
                alt=""
                aria-hidden
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
              <img src={iconUrl} alt="" className="size-full object-cover" />
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
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-monogram">
                <AvatarInitial name={displayName} pubkey={attributedPubkey} />
              </AvatarFallback>
            </Avatar>
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
            <DropdownMenu>
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
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);

  return seen;
}

const NO_BOOSTS: Boost[] = [];
