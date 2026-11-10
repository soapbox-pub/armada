import { Check, Copy, Gem, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Confetti } from "@/components/Confetti";
import { BoostedBy } from "@/components/discover/BoostedBy";
import { DisplayName } from "@/components/DisplayName";
import { GiftStage } from "@/components/gift/GiftStage";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useCommunityDiscoverListings } from "@/concord/hooks/useDiscoverListings";
import { useAuthor } from "@/hooks/useAuthor";
import { useCommunityBoosts } from "@/hooks/useDiscover";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import { BOOST_LEVELS, BOOST_WINDOW_SECONDS, boostLevel } from "@/lib/discoverBoost";
import { playFanfare } from "@/lib/fanfare";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import type { Community } from "@/concord/lib/types";

/** Renewing is offered once a boost has this long left. */
const RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60;
const TOP_LEVEL = BOOST_LEVELS[BOOST_LEVELS.length - 1];
const BOOST_GRADIENT = "bg-gradient-to-r from-[#ff73fa] to-primary";

/**
 * Boost a listed community from inside it (`lib/discoverBoost.ts`). Only members'
 * boosts count toward its level here.
 */
export function CommunityDiscoverDialog({
  open,
  onOpenChange,
  community,
  members,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  community: Community | undefined;
  members: ReadonlySet<string>;
}) {
  const intl = useIntl();
  const { data: folded } = useControlFold(community);
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);
  const name = folded?.metadata?.name?.trim()
    || intl.formatMessage({ id: "communityDiscoverDialog.thisCommunity", defaultMessage: "this community" });
  const { listings, isLoading: listingsLoading } = useCommunityDiscoverListings(community);
  const listingIds = useMemo(() => listings.map((l) => l.source.id), [listings]);
  const { boosts, mine, isLoading: boostsLoading, boost, unboost } = useCommunityBoosts(listingIds);
  const memberBoosts = useMemo(() => boosts.filter((b) => members.has(b.pubkey)), [boosts, members]);
  const until = mine ? (mine.event.created_at + BOOST_WINDOW_SECONDS) * 1000 : undefined;
  const renewable = until !== undefined && until - Date.now() < RENEW_WITHIN_SECONDS * 1000;
  const busy = boost.isPending || unboost.isPending;
  const [celebration, setCelebration] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const failed = (e: unknown) => toast({
    title: t({ id: "communityDiscoverDialog.boostFailed", defaultMessage: "Couldn't update your boost" }),
    description: e instanceof Error ? e.message : undefined,
    variant: "destructive",
  });

  const onBoost = async () => {
    // Made inside the click, or the autoplay policy keeps it suspended.
    let audio: AudioContext | undefined;
    try {
      audio = new AudioContext();
    } catch { /* no Web Audio: confetti only */ }
    try {
      await boost.mutateAsync();
    } catch (e) {
      void audio?.close().catch(() => {});
      failed(e);
      return;
    }
    if (audio) playFanfare(audio);
    if (mounted.current) setCelebration((n) => n + 1);
  };

  const onUnboost = async () => {
    try {
      await unboost.mutateAsync();
    } catch (e) {
      failed(e);
    }
  };

  const listed = listings.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "communityDiscoverDialog.title", defaultMessage: "Boost {name}" }, { name })}
        className="sm:max-w-sm"
        contentClassName="overflow-hidden p-0 sm:p-0"
      >
        {celebration > 0 && <Confetti key={celebration} />}
        <div className="relative flex flex-col items-center px-6 pb-6 pt-10 text-center">
          <GiftStage stars={false} />
          <CommunityGem iconUrl={iconUrl} name={name} />
          {/* Visual title; the accessible one is the chrome's. */}
          <p aria-hidden className="relative mt-5 text-2xl font-black tracking-tight">
            <FormattedMessage id="communityDiscoverDialog.title" defaultMessage="Boost {name}" values={{ name }} />
          </p>
          <DialogDescription className="relative mt-1 text-sm text-foreground/70">
            <FormattedMessage
              id="communityDiscoverDialog.pitch"
              defaultMessage="Show it on Discover to people who follow you, and help it level up."
            />
          </DialogDescription>
        </div>

        <div className="space-y-5 px-6 pb-6 pt-5">
          {listingsLoading || !listed ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              {boostsLoading ? <Skeleton className="h-14 w-full" /> : <LevelTrack count={memberBoosts.length} />}

              {memberBoosts.length > 0 ? (
                <div className="flex justify-center">
                  <BoostedBy boosts={memberBoosts} named={memberBoosts} showLevel={false} />
                </div>
              ) : !boostsLoading && (
                <p className="text-center text-xs text-muted-foreground">
                  <FormattedMessage id="communityDiscoverDialog.beFirst" defaultMessage="Nobody's boosting it yet. Be the first." />
                </p>
              )}

              {mine && !boost.isPending ? (
                <div className="space-y-2 text-center">
                  <p className="inline-flex items-center gap-1.5 rounded-full bg-[#ff73fa]/15 px-3 py-1 text-xs font-semibold text-[#ff73fa]">
                    <Gem className="size-3.5" aria-hidden />
                    <FormattedMessage
                      id="communityDiscoverDialog.boostedUntil"
                      defaultMessage="Boosting until {date}"
                      values={{ date: until !== undefined ? intl.formatDate(until, { dateStyle: "medium" }) : "" }}
                    />
                  </p>
                  <div className="flex justify-center gap-1">
                    {renewable && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onBoost()}>
                        <FormattedMessage id="communityDiscoverDialog.renew" defaultMessage="Boost again" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => void onUnboost()}>
                      {unboost.isPending && <Loader2 className="size-3.5 animate-spin" />}
                      <FormattedMessage id="communityDiscoverDialog.unboost" defaultMessage="Remove boost" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Button
                    className={cn("h-11 w-full clip-corner-lg text-base font-bold text-white shadow-lg shadow-[#ff73fa]/25 hover:opacity-90", BOOST_GRADIENT)}
                    disabled={busy}
                    onClick={() => void onBoost()}
                  >
                    {boost.isPending ? <Loader2 className="size-5 animate-spin" /> : <Gem className="size-5" />}
                    {boost.isPending ? (
                      <FormattedMessage id="communityDiscoverDialog.boosting" defaultMessage="Boosting…" />
                    ) : (
                      <FormattedMessage id="communityDiscoverDialog.boost" defaultMessage="Boost" />
                    )}
                  </Button>
                  <p className="text-center text-2xs text-muted-foreground">
                    <FormattedMessage
                      id="communityDiscoverDialog.boostHint"
                      defaultMessage="Takes a few seconds of work. Lasts 30 days."
                    />
                  </p>
                </div>
              )}

              <div className="space-y-1 border-t border-border/50 pt-3">
                {listings.map((listing) => (
                  <ListingRow key={listing.source.id} listing={listing} />
                ))}
              </div>
            </>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

/** The community's icon in a glowing frame, with the boost gem on its corner. */
function CommunityGem({ iconUrl, name }: { iconUrl: string | null; name: string }) {
  return (
    <span className="relative">
      <span className="flex size-24 items-center justify-center overflow-hidden clip-corner-lg bg-secondary shadow-[0_0_40px_-4px_#ff73fa]">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-full object-cover" />
        ) : (
          <span className="text-4xl font-black uppercase text-foreground/60">{name.charAt(0)}</span>
        )}
      </span>
      <span className={cn("absolute -bottom-2 -right-2 flex size-9 items-center justify-center rounded-full text-white ring-4 ring-chrome", BOOST_GRADIENT)}>
        <Gem className="size-4" aria-hidden />
      </span>
    </span>
  );
}

/** Level track: a milestone per level, filled up to `count`. */
function LevelTrack({ count }: { count: number }) {
  const intl = useIntl();
  const { level, next } = boostLevel(count);
  const fill = Math.min(1, count / TOP_LEVEL);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold">
          <FormattedMessage
            id="communityDiscoverDialog.count"
            defaultMessage="{count, plural, one {# boost} other {# boosts}}"
            values={{ count }}
          />
        </span>
        <span className="text-muted-foreground">
          {next === undefined ? (
            <FormattedMessage id="communityDiscoverDialog.maxLevel" defaultMessage="Top level" />
          ) : (
            <FormattedMessage
              id="communityDiscoverDialog.toNext"
              defaultMessage="{needed, plural, one {# more} other {# more}} for level {next}"
              values={{ needed: next - count, next: level + 1 }}
            />
          )}
        </span>
      </div>
      <div className="relative mx-2 h-6">
        <div
          role="progressbar"
          aria-label={intl.formatMessage({ id: "communityDiscoverDialog.levelProgress", defaultMessage: "Boost level progress" })}
          aria-valuemin={0}
          aria-valuemax={TOP_LEVEL}
          aria-valuenow={Math.min(count, TOP_LEVEL)}
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted"
        >
          <div className={cn("h-full rounded-full transition-[width] duration-500", BOOST_GRADIENT)} style={{ width: `${fill * 100}%` }} />
        </div>
        {BOOST_LEVELS.map((needed, i) => {
          const reached = count >= needed;
          return (
            <span
              key={needed}
              title={intl.formatMessage({ id: "boostedBy.levelTitle", defaultMessage: "Boost level {level}" }, { level: i + 1 })}
              className={cn(
                "absolute top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full ring-4 ring-background transition-colors",
                reached ? cn(BOOST_GRADIENT, "text-white") : "bg-muted text-muted-foreground",
              )}
              style={{ left: `${(needed / TOP_LEVEL) * 100}%` }}
            >
              <Gem className="size-3" aria-hidden />
            </span>
          );
        })}
      </div>
      <div className="relative mx-2 h-4 text-2xs text-muted-foreground">
        {BOOST_LEVELS.map((needed, i) => (
          <span
            key={needed}
            className={cn("absolute -translate-x-1/2 whitespace-nowrap", count >= needed && "font-semibold text-[#ff73fa]")}
            style={{ left: `${(needed / TOP_LEVEL) * 100}%` }}
          >
            <FormattedMessage id="boostedBy.level" defaultMessage="Lv {level}" values={{ level: i + 1 }} />
          </span>
        ))}
      </div>
    </div>
  );
}

function ListingRow({ listing }: { listing: DiscoveredInvite }) {
  const intl = useIntl();
  const sharer = listing.source.pubkey;
  const author = useAuthor(sharer);
  const name = getDisplayName(author.data?.metadata, sharer);
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await writeClipboardText(listing.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: t({ id: "communityDiscoverDialog.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" });
    }
  };
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        <FormattedMessage
          id="communityDiscoverDialog.listedBy"
          defaultMessage="On Discover via {name}'s invite"
          values={{ name: <DisplayName pubkey={sharer} name={name} /> }}
        />
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 touch:size-11 shrink-0"
        aria-label={intl.formatMessage({ id: "communityDiscoverDialog.copyInvite", defaultMessage: "Copy invite link" })}
        onClick={() => void onCopy()}
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}
