import {
  Compass,
  Info,
  Loader2,
  Network,
  Palette,
  Plus,
  SlidersHorizontal,
  Smile,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import { lazy, memo, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

import {
  CommunityListingCard,
  CommunityListingCardSkeleton,
} from "@/components/discover/CommunityListingCard";
import { CreateCommunityCard } from "@/components/discover/CreateCommunityCard";
import { DiscoverBoostsContext } from "@/components/discover/discoverBoosts";
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { DeferredRow } from "@/components/DeferredRow";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiscoverActivityTarget } from "@/concord/lib/discoverActivity";
import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  useDiscoverCommunities,
  useDiscoverCuration,
  useDiscoverCommunityActivity,
  useDiscoverEmojiPacks,
  useDiscoverThemes,
  type DiscoverScope,
} from "@/hooks/useDiscover";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { vouchingBoosts } from "@/lib/discoverBoost";
import { SettingsOverlayContext } from "@/lib/settingsOverlay";
import { cn } from "@/lib/utils";
import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";

const EmojiPackDialog = lazy(() =>
  import("@/components/discover/EmojiPackDialog").then((m) => ({ default: m.EmojiPackDialog })),
);

const ShareToDiscoverDialog = lazy(() =>
  import("@/concord/components/ShareToDiscoverDialog").then((m) => ({
    default: m.ShareToDiscoverDialog,
  })),
);

const ThemeCreatorDialog = lazy(() =>
  import("@/components/discover/ThemeCreatorDialog").then((m) => ({ default: m.ThemeCreatorDialog })),
);

type DiscoverTab = "communities" | "emojis" | "themes";

const m = defineMessages({
  unfiltered: {
    id: "discoverPage.hint.everyone",
    defaultMessage: "Showing anyone's picks, unfiltered, on this device.",
  },
  communities: { id: "discoverPage.tab.communities", defaultMessage: "Communities" },
  communitiesPlaceholder: { id: "discoverPage.tab.communitiesPlaceholder", defaultMessage: "Search communities…" },
  communitiesBlurb: {
    id: "discoverPage.tab.communitiesBlurb",
    defaultMessage: "Encrypted communities you can join with a link.",
  },
  emojis: { id: "discoverPage.tab.emojis", defaultMessage: "Emojis" },
  emojisPlaceholder: { id: "discoverPage.tab.emojisPlaceholder", defaultMessage: "Search emoji packs…" },
  emojisBlurb: {
    id: "discoverPage.tab.emojisBlurb",
    defaultMessage: "Custom emoji packs shared across Nostr. Add one to your reactions.",
  },
  themes: { id: "discoverPage.tab.themes", defaultMessage: "Themes" },
  themesPlaceholder: { id: "discoverPage.tab.themesPlaceholder", defaultMessage: "Search themes…" },
  themesBlurb: {
    id: "discoverPage.tab.themesBlurb",
    defaultMessage: "Community-made color themes you can preview and apply in a tap.",
  },
  you: { id: "discoverPage.scope.you", defaultMessage: "You" },
  friends: { id: "discoverPage.scope.friends", defaultMessage: "Friends" },
  network: { id: "discoverPage.scope.network", defaultMessage: "Network" },
  relaysError: { id: "discoverPage.relaysError", defaultMessage: "Couldn't reach the relays. Try again." },
  whatDiscoverShows: { id: "discoverPage.whatDiscoverShows", defaultMessage: "What Discover shows" },
  discoverSettings: { id: "discoverPage.discoverSettings", defaultMessage: "Discover settings" },
});

type TabDef = Omit<PillTab<DiscoverTab>, "label"> & {
  label: MessageDescriptor;
  placeholder: MessageDescriptor;
  blurb: MessageDescriptor;
};

const TAB_DEFS: TabDef[] = [
  {
    id: "communities",
    label: m.communities,
    icon: Users,
    placeholder: m.communitiesPlaceholder,
    blurb: m.communitiesBlurb,
  },
  {
    id: "emojis",
    label: m.emojis,
    icon: Smile,
    placeholder: m.emojisPlaceholder,
    blurb: m.emojisBlurb,
  },
  {
    id: "themes",
    label: m.themes,
    icon: Palette,
    placeholder: m.themesPlaceholder,
    blurb: m.themesBlurb,
  },
];

const SCOPE_DEFS: (Omit<PillTab<DiscoverScope>, "label"> & { label: MessageDescriptor })[] = [
  { id: "you", label: m.you, icon: UserRound },
  { id: "friends", label: m.friends, icon: UsersRound },
  { id: "network", label: m.network, icon: Network },
];

/** {@link SCOPE_DEFS} in the current language, stable per language for `PillTabs`. */
function useScopes(): PillTab<DiscoverScope>[] {
  const intl = useIntl();
  return useMemo(
    () => SCOPE_DEFS.map((s) => ({ ...s, label: intl.formatMessage(s.label) })),
    [intl],
  );
}

/**
 * Discover: public directory events — opt-in Concord community listings, NIP-30
 * emoji packs, and themes.
 */
export function DiscoverPage() {
  const intl = useIntl();
  const { user } = useCurrentUser();
  // `?tab=` lets a link land on a tab.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<DiscoverTab>(() => {
    const requested = searchParams.get("tab");
    return TAB_DEFS.find((t) => t.id === requested)?.id ?? "communities";
  });
  // Independent query per tab so switching doesn't carry a stale search.
  const [queries, setQueries] = useState<Record<DiscoverTab, string>>({
    communities: "",
    emojis: "",
    themes: "",
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [themeCreateOpen, setThemeCreateOpen] = useState(false);
  const [chosenScope, setScope] = useState<DiscoverScope>("network");
  // "You" and "Friends" have nobody in them signed out.
  const scope = user ? chosenScope : "network";
  const { updateConfig } = useAppContext();
  const unfiltered = useDiscoverCuration().everyone && scope === "network";
  const query = queries[tab];
  const setQuery = (v: string) => setQueries((prev) => ({ ...prev, [tab]: v }));
  const active = TAB_DEFS.find((t) => t.id === tab)!;
  const tabs = useMemo(
    () => TAB_DEFS.map(({ placeholder: _p, blurb: _b, ...t }) => ({ ...t, label: intl.formatMessage(t.label) })),
    [intl],
  );

  return (
    <>
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 h-full safe-area-top">
        <div className="mx-auto flex w-full max-w-5xl flex-1 min-h-0 flex-col px-3 sm:px-4">
          {/* Dropped on phones, where the tab pills carry the page identity. */}
          <header className="relative h-12 touch:h-[3.25rem] mt-4 px-3 hidden sm:flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
            <Compass className="size-5 shrink-0 text-muted-foreground" />
            <h1 className="min-w-0 flex-1 truncate font-semibold leading-tight">
              <FormattedMessage id="discoverPage.title" defaultMessage="Discover" />
            </h1>
            {user && <DiscoverScopeToggle scope={scope} onChange={setScope} />}
            <DiscoverScopeInfo scope={scope} signedIn={!!user} />
          </header>

          <p className="hidden sm:block mt-3 px-1 text-sm text-muted-foreground">
            <FormattedMessage {...active.blurb} />
          </p>

          <div className="mt-3 flex shrink-0 flex-col gap-4 sm:mt-5 sm:flex-row sm:items-center sm:gap-3">
            <PillTabs
              tabs={tabs}
              value={tab}
              onChange={(id) => setTab(id)}
              className="h-12 sm:h-auto"
            />

            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* Matches the tab strip's height beside it. */}
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={intl.formatMessage(active.placeholder)}
                className="flex-1 h-12 touch:h-12 sm:h-9 touch:sm:h-9 sidebar:px-3"
              />

              {/* Phones have no header; the scope toggle and its hint fold into one button. */}
              <DiscoverScopeMenu
                scope={scope}
                onChange={setScope}
                signedIn={!!user}
                className="sm:hidden"
              />

              {/* Beside the search, not in the header, so it survives on phones. */}
              {tab === "communities" && user && (
                <Button
                  className="h-12 sm:h-9 shrink-0 clip-corner-lg"
                  onClick={() => setShareOpen(true)}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">
                    <FormattedMessage id="discoverPage.addCommunity" defaultMessage="Add your community" />
                  </span>
                  <span className="sr-only sm:hidden">
                    <FormattedMessage id="discoverPage.addCommunity" defaultMessage="Add your community" />
                  </span>
                </Button>
              )}
              {tab === "emojis" && user && (
                <Button
                  className="h-12 sm:h-9 shrink-0 clip-corner-lg"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">
                    <FormattedMessage id="discoverPage.newPack" defaultMessage="New pack" />
                  </span>
                  <span className="sr-only sm:hidden">
                    <FormattedMessage id="discoverPage.createEmojiPack" defaultMessage="Create emoji pack" />
                  </span>
                </Button>
              )}

              {tab === "themes" && user && (
                <Button
                  className="h-12 sm:h-9 shrink-0 clip-corner-lg"
                  onClick={() => setThemeCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">
                    <FormattedMessage id="discoverPage.newTheme" defaultMessage="New theme" />
                  </span>
                  <span className="sr-only sm:hidden">
                    <FormattedMessage id="discoverPage.createTheme" defaultMessage="Create theme" />
                  </span>
                </Button>
              )}
            </div>
          </div>

          {unfiltered && (
            <p className="mt-3 px-1 text-xs text-muted-foreground">
              <FormattedMessage {...m.unfiltered} />{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => updateConfig((current) => ({ ...current, discoverUnfiltered: false }))}
              >
                <FormattedMessage id="discoverPage.unfilteredOff" defaultMessage="Turn off" />
              </button>
            </p>
          )}

          {/* Top spacing is a MARGIN so the gap stays put while the grid scrolls. */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable mt-3 sm:mt-4 pb-8">
            {tab === "communities" && <CommunitiesTab query={query} scope={scope} />}
            {tab === "emojis" && <EmojisTab query={query} scope={scope} />}
            {tab === "themes" && <ThemesTab query={query} scope={scope} />}
          </div>
        </div>
      </main>

      {createOpen && (
        <Suspense fallback={null}>
          <EmojiPackDialog open={createOpen} onOpenChange={setCreateOpen} />
        </Suspense>
      )}

      {shareOpen && (
        <Suspense fallback={null}>
          <ShareToDiscoverDialog open={shareOpen} onOpenChange={setShareOpen} />
        </Suspense>
      )}

      {themeCreateOpen && (
        <Suspense fallback={null}>
          <ThemeCreatorDialog open={themeCreateOpen} onOpenChange={setThemeCreateOpen} />
        </Suspense>
      )}
    </>
  );
}

/** Whose content the feeds show. Signed-in only: signed out there's only the curated list. */
function DiscoverScopeToggle({
  scope,
  onChange,
  className,
}: {
  scope: DiscoverScope;
  onChange: (scope: DiscoverScope) => void;
  className?: string;
}) {
  const scopes = useScopes();
  return <PillTabs tabs={scopes} value={scope} onChange={onChange} className={cn("p-0.5", className)} />;
}

/**
 * Info popover on what the grid is drawn from, linking to the Discover settings.
 * A popover (not a tooltip) because it holds a focusable button.
 */
function DiscoverScopeInfo({
  scope,
  signedIn,
  className,
}: {
  scope: DiscoverScope;
  signedIn: boolean;
  className?: string;
}) {
  const intl = useIntl();
  const hint = useDiscoverScopeHint(scope, signedIn);
  const settings = useContext(SettingsOverlayContext);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage(m.whatDiscoverShows)}
          className={cn("size-8 touch:size-11 shrink-0 text-muted-foreground", className)}
        >
          <Info className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3 text-xs text-muted-foreground">
        <p className="leading-snug">{hint}</p>
        {scope === "network" && (
          <Button
            variant="secondary"
            size="sm"
            className="h-8 touch:h-11 w-full text-xs"
            onClick={() => {
              setOpen(false);
              settings.show("discover");
            }}
          >
            <SlidersHorizontal className="size-3.5" />
            {intl.formatMessage(m.discoverSettings)}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function useDiscoverScopeHint(scope: DiscoverScope, signedIn: boolean): string {
  const intl = useIntl();
  const curation = useDiscoverCuration();

  if (scope === "you") {
    return intl.formatMessage({ id: "discoverPage.hint.you", defaultMessage: "Showing only what you've shared." });
  }
  if (scope === "friends") {
    return intl.formatMessage({
      id: "discoverPage.hint.followed",
      defaultMessage: "Showing only what you and people you follow have shared.",
    });
  }
  if (scope === "network" && curation.everyone) return intl.formatMessage(m.unfiltered);
  if (!signedIn) {
    return curation.sources.length > 0
      ? intl.formatMessage({
        id: "discoverPage.hint.curatedSignedOut",
        defaultMessage: "Showing picks from a curated list. Sign in to also see what people you follow have shared.",
      })
      : intl.formatMessage({
        id: "discoverPage.hint.signedOut",
        defaultMessage: "Sign in to see picks from people you follow.",
      });
  }
  return curation.sources.length > 0
    ? intl.formatMessage({
      id: "discoverPage.hint.networkCurated",
      defaultMessage: "Showing picks from a curated list, from people you follow, and from people they follow. Nothing from anyone else is shown.",
    })
    : intl.formatMessage({
      id: "discoverPage.hint.network",
      defaultMessage: "Showing picks from people you follow and from people they follow. Nothing from anyone else is shown.",
    });
}

/**
 * The phone stand-in for the header's toggle and info popover: one button showing
 * the current scope, opening the choices and the hint. Signed out it's the hint alone.
 */
function DiscoverScopeMenu({
  scope,
  onChange,
  signedIn,
  className,
}: {
  scope: DiscoverScope;
  onChange: (scope: DiscoverScope) => void;
  signedIn: boolean;
  className?: string;
}) {
  const intl = useIntl();
  const scopes = useScopes();
  const hint = useDiscoverScopeHint(scope, signedIn);
  const settings = useContext(SettingsOverlayContext);
  const [open, setOpen] = useState(false);
  const current = scopes.find((s) => s.id === scope)!;
  const Icon = signedIn ? current.icon : Info;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          aria-label={
            signedIn
              ? intl.formatMessage(
                { id: "discoverPage.showingContentFrom", defaultMessage: "Showing content from: {scope}" },
                { scope: current.label },
              )
              : intl.formatMessage(m.whatDiscoverShows)
          }
          className={cn("size-12 shrink-0 clip-corner-lg", className)}
        >
          <Icon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-2 text-xs text-muted-foreground">
        {signedIn && (
          <div role="radiogroup" aria-label={intl.formatMessage({ id: "discoverPage.showContentFrom", defaultMessage: "Show content from" })} className="flex flex-col gap-1">
            {scopes.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={s.id === scope}
                onClick={() => {
                  onChange(s.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex h-11 items-center gap-2 px-3 text-sm clip-corner-lg",
                  s.id === scope
                    ? "bg-primary font-medium text-primary-foreground"
                    : "text-foreground hover:bg-foreground/5",
                )}
              >
                <s.icon className="size-4 shrink-0" />
                {s.label}
              </button>
            ))}
          </div>
        )}
        <p className="px-1 leading-snug">{hint}</p>
        {scope === "network" && (
          <Button
            variant="secondary"
            size="sm"
            className="h-11 w-full text-xs"
            onClick={() => {
              setOpen(false);
              settings.show("discover");
            }}
          >
            <SlidersHorizontal className="size-3.5" />
            {intl.formatMessage(m.discoverSettings)}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

const GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch";

/** Infinite-scroll sentinel after a grid ({@link useInfiniteScroll}); spinner while fetching. */
function LoadMore({
  sentinelRef,
  loading,
}: {
  sentinelRef: (node: Element | null) => void;
  loading: boolean;
}) {
  return (
    <div ref={sentinelRef} className="flex justify-center py-6" aria-hidden={!loading}>
      {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
    </div>
  );
}

/** Card-shaped placeholders so the grid keeps its shape while loading. */
function TabSkeleton() {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-40 w-full rounded-xl" />
      ))}
    </div>
  );
}

/** Centered empty / error state, in the cut-corner vessel idiom. */
function TabState({ icon: Icon, children }: { icon: typeof Users; children: ReactNode }) {
  return (
    <div className="mx-auto mt-6 flex max-w-sm flex-col items-center gap-3 clip-corner-lg bg-chrome px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center clip-corner-lg bg-foreground/5 text-muted-foreground">
        <Icon className="size-6" />
      </span>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function CommunitiesTab({ query, scope }: { query: string; scope: DiscoverScope }) {
  const {
    data,
    boosts,
    vouchers,
    boostOnly,
    packAuthors,
    trustedAuthors,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    pageCount,
  } = useDiscoverCommunities(scope);
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  // Announcements name no community/owner; each card reports its resolved
  // bundle's, for cross-link dedup and owner ranking.
  const [resolved, setResolved] = useState<Record<string, { communityId: string; owner: string }>>(
    {},
  );
  const onResolved = useCallback(
    (linkSigner: string, communityId: string, owner: string) =>
      setResolved((prev) => {
        const cur = prev[linkSigner];
        if (cur?.communityId === communityId && cur?.owner === owner) return prev;
        return { ...prev, [linkSigner]: { communityId, owner } };
      }),
    [],
  );

  // Activity-probe targets reported per card, batched into one last-wrap REQ.
  const [activityTargets, setActivityTargets] = useState<Record<string, DiscoverActivityTarget>>(
    {},
  );
  const onActivityTarget = useCallback(
    (linkSigner: string, target: DiscoverActivityTarget | null) => {
      setActivityTargets((prev) => {
        // Withdrawn (unmounted or filtered out): drop it from the REQ.
        if (!target) {
          if (!(linkSigner in prev)) return prev;
          const { [linkSigner]: _gone, ...rest } = prev;
          return rest;
        }
        const normalized: DiscoverActivityTarget = {
          ...target,
          authors: [...target.authors].sort(),
          relays: [...target.relays],
        };
        const cur = prev[linkSigner];
        if (
          cur
          && cur.authors.length === normalized.authors.length
          && cur.authors.every((a, i) => a === normalized.authors[i])
          && cur.relays.length === normalized.relays.length
          && cur.relays.every((r, i) => r === normalized.relays[i])
        ) {
          return prev;
        }
        return { ...prev, [linkSigner]: normalized };
      });
    },
    [],
  );
  const activityTargetList = useMemo(() => Object.values(activityTargets), [activityTargets]);
  const lastActiveBySigner = useDiscoverCommunityActivity(activityTargetList);

  // Order: communities boosted by someone the viewer trusts (most boosts first),
  // then curated-list owners, then the viewer and their follows, then the rest of
  // the network; newest-first otherwise. Until a bundle resolves, the announcement
  // author stands in for its owner.
  const ordered = useMemo(() => {
    if (!data) return data;
    const pack = new Set(packAuthors);
    const trusted = new Set(trustedAuthors);
    const boosted: Array<{ invite: DiscoveredInvite; count: number }> = [];
    const tiers: DiscoveredInvite[][] = [[], [], []];
    for (const invite of data) {
      const owner = resolved[invite.linkSigner]?.owner ?? invite.source.pubkey;
      const listingBoosts = boosts.get(invite.source.id) ?? [];
      if (vouchingBoosts(listingBoosts, vouchers, owner).length > 0) {
        boosted.push({ invite, count: listingBoosts.length });
        continue;
      }
      tiers[pack.has(owner) ? 0 : trusted.has(owner) ? 1 : 2].push(invite);
    }
    boosted.sort((a, b) => b.count - a.count);
    return [...boosted.map((b) => b.invite), ...tiers.flat()];
  }, [data, resolved, boosts, vouchers, packAuthors, trustedAuthors]);
  const boostContext = useMemo(() => ({ boosts, vouchers }), [boosts, vouchers]);

  // Drop later links resolving to an already-seen community (display order,
  // so pack-owned cards win).
  const duplicates = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const invite of ordered ?? []) {
      const communityId = resolved[invite.linkSigner]?.communityId;
      if (!communityId) continue;
      if (seen.has(communityId)) dup.add(invite.linkSigner);
      else seen.add(communityId);
    }
    return dup;
  }, [ordered, resolved]);

  if (isLoading && !data) {
    return (
      <div className={GRID}>
        <CreateCommunityCard />
        {Array.from({ length: 11 }, (_, i) => (
          <CommunityListingCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (isError) return <TabState icon={Users}>
    <FormattedMessage {...m.relaysError} />
  </TabState>;
  if (!data || data.length === 0) {
    return (
      <div className="space-y-4">
        <div className={GRID}>
          <CreateCommunityCard />
        </div>
        <TabState icon={Users}>
          {scope === "you" ? (
            <FormattedMessage
              id="discoverPage.communities.emptyYou"
              defaultMessage="You haven't listed a community yet. Add one and it'll show up here."
            />
          ) : scope === "friends" ? (
            <FormattedMessage
              id="discoverPage.communities.emptyFriends"
              defaultMessage="None of the people you follow have listed a community yet. Yours could be the first."
            />
          ) : (
            <FormattedMessage
              id="discoverPage.communities.emptyCurated"
              defaultMessage="None of the authors Discover is showing have listed a community yet. Yours could be the first."
            />
          )}
        </TabState>
      </div>
    );
  }
  return (
    <DiscoverBoostsContext.Provider value={boostContext}>
    <div className={GRID}>
      <CreateCommunityCard />
      {/* Search matches each card's RESOLVED name; misses render nothing. */}
      {(ordered ?? [])
        .filter((invite) => !duplicates.has(invite.linkSigner))
        .map((invite) => (
          <CommunityRow
            key={invite.linkSigner}
            invite={invite}
            query={query}
            needsBoost={boostOnly.has(invite.linkSigner)}
            onResolved={onResolved}
            onActivityTarget={onActivityTarget}
            lastActiveAt={lastActiveBySigner[invite.linkSigner]}
          />
        ))}
    </div>
    <LoadMore sentinelRef={sentinelRef} loading={isFetchingNextPage} />
    </DiscoverBoostsContext.Provider>
  );
}

/**
 * Memoized so one card reporting its bundle or activity target (grid state)
 * doesn't re-render every other card; all props are stable per card.
 */
const CommunityRow = memo(function CommunityRow({
  invite,
  query,
  needsBoost,
  onResolved,
  onActivityTarget,
  lastActiveAt,
}: {
  invite: DiscoveredInvite;
  query: string;
  needsBoost: boolean;
  onResolved: (linkSigner: string, communityId: string, owner: string) => void;
  onActivityTarget: (linkSigner: string, target: DiscoverActivityTarget | null) => void;
  lastActiveAt: number | undefined;
}) {
  return (
    // No windowing, so defer mounting to a screenful of lead time. Off
    // while searching: cards self-hide on a miss.
    <DeferredRow active={!query.trim()} minHeight={240}>
      <CommunityListingCard
        invite={invite}
        filter={query}
        needsBoost={needsBoost}
        onResolved={onResolved}
        onActivityTarget={onActivityTarget}
        lastActiveAt={lastActiveAt}
      />
    </DeferredRow>
  );
});

function EmojisTab({ query, scope }: { query: string; scope: DiscoverScope }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, pageCount } =
    useDiscoverEmojiPacks(query, scope);
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  if (isLoading && !data) return <TabSkeleton />;
  if (isError) return <TabState icon={Smile}>
    <FormattedMessage {...m.relaysError} />
  </TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState icon={Smile}>
        {query.trim() ? (
          <FormattedMessage id="discoverPage.emojis.noMatch" defaultMessage="No emoji packs matched your search." />
        ) : (
          <FormattedMessage
            id="discoverPage.emojis.empty"
            defaultMessage="No emoji packs found. Publish one with New pack and it'll show up here."
          />
        )}
      </TabState>
    );
  }
  return (
    <>
      <div className={GRID}>
        {/* Deferred mount like Communities; these cards never self-hide. */}
        {data.map((event) => (
          <DeferredRow key={event.id} active minHeight={160}>
            <EmojiPackCard event={event} className="my-0 max-w-none" />
          </DeferredRow>
        ))}
      </div>
      <LoadMore sentinelRef={sentinelRef} loading={isFetchingNextPage} />
    </>
  );
}

function ThemesTab({ query, scope }: { query: string; scope: DiscoverScope }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, pageCount } =
    useDiscoverThemes(query, scope);
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  if (isLoading && !data) return <TabSkeleton />;
  if (isError) return <TabState icon={Palette}>
    <FormattedMessage {...m.relaysError} />
  </TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState icon={Palette}>
        {query.trim() ? (
          <FormattedMessage id="discoverPage.themes.noMatch" defaultMessage="No themes matched your search." />
        ) : (
          <FormattedMessage
            id="discoverPage.themes.empty"
            defaultMessage="No shared themes found. Publish one with New theme and it'll show up here."
          />
        )}
      </TabState>
    );
  }
  return (
    <>
      <div className={GRID}>
        {data.map((event) => (
          <DeferredRow key={event.id} active minHeight={160}>
            <ThemeDiscoverCard event={event} />
          </DeferredRow>
        ))}
      </div>
      <LoadMore sentinelRef={sentinelRef} loading={isFetchingNextPage} />
    </>
  );
}

export default DiscoverPage;
