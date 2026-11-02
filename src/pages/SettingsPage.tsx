import {
  Activity,
  ArrowLeft,
  Bell,
  ChevronLeft,
  ChevronRight,
  Download,
  Gem,
  Info,
  LifeBuoy,
  MessageSquare,
  MessageSquareLock,
  Mic,
  Monitor,
  Palette,
  Search,
  ShieldCheck,
  Smile,
  SpellCheck,
  UserCircle,
  UserRound,
  UserX,
  Waypoints,
  Zap,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { NotificationSettings } from "@/components/NotificationSettings";
import { ProfileSettings } from "@/components/ProfileSettings";
import { AboutSettings, SupportSettings } from "@/components/settings/AboutSettings";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { ChatSettings } from "@/components/settings/ChatSettings";
import { DesktopSettings } from "@/components/settings/DesktopSettings";
import { DiagnosticsSettings } from "@/components/settings/DiagnosticsSettings";
import { DirectMessageSettings } from "@/components/settings/DirectMessageSettings";
import { EmojiPackSettings } from "@/components/settings/EmojiPackSettings";
import { FontScaleSettings } from "@/components/settings/FontScaleSettings";
import { MotionSettings } from "@/components/settings/MotionSettings";
import { LanguageSettings } from "@/components/settings/LanguageSettings";
import { MutedPeopleSettings } from "@/components/settings/MutedPeopleSettings";
import { MutedWordsSettings } from "@/components/settings/MutedWordsSettings";
import { PrivacySettings } from "@/components/settings/PrivacySettings";
import { RelaysSettings } from "@/components/settings/RelaysSettings";
import {
  SettingsGroup,
  SettingsIcon,
  SettingsRow,
  type SettingsTone,
} from "@/components/settings/SettingsSection";
import {
  resolveSettingsSection,
  SETTINGS_PAGE_PARENT,
  SettingsNavContext,
  SettingsPageTitleContext,
  SettingsSearchingContext,
  type SettingsNav,
  type SettingsPageId,
} from "@/components/settings/settingsNav";
import { useSettingsFilter } from "@/components/settings/settingsSearch";
import { UltraSettings } from "@/components/settings/UltraSettings";
import { VoiceSettings } from "@/components/settings/VoiceSettings";
import { WalletSettings } from "@/components/settings/WalletSettings";
import { ThemeSelector } from "@/components/ThemeSelector";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useAuthor } from "@/hooks/useAuthor";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { useMyUltra } from "@/hooks/useUltra";
import { common, useIntl } from "@/i18n";
import { appVersionLabel } from "@/lib/appVersion";
import { getAvatarShape } from "@/lib/avatarShape";
import { isDesktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface PageDef {
  title: string;
  icon: LucideIcon;
  tone: SettingsTone;
  /** One line under the title in the root list, as Android's settings do. */
  summary?: string;
  render: () => ReactNode;
}

/** The pane is wide enough for a sidebar beside the page (macOS System Settings), measured on the pane itself. */
const WIDE_PX = 860;

/** Which pages exist for this user and build, and how the root list groups them. */
function useSettingsPages(): { pages: Partial<Record<SettingsPageId, PageDef>>; groups: SettingsPageId[][] } {
  const { user } = useCurrentUser();
  const intl = useIntl();
  const ultra = !!useMyUltra().ultra;
  return useMemo(() => {
    const profiling = import.meta.env.VITE_PROFILE === "1";
    const pages: Partial<Record<SettingsPageId, PageDef>> = {
      account: {
        title: intl.formatMessage({ id: "settingsPage.account.title", defaultMessage: "Account" }),
        icon: UserCircle,
        tone: "primary",
        summary: user
          ? intl.formatMessage({ id: "settingsPage.account.summary", defaultMessage: "Keys, sync and account standing" })
          : intl.formatMessage({ id: "settingsPage.account.summaryLoggedOut", defaultMessage: "Log in or create an account" }),
        render: () => <AccountSettings />,
      },
      notifications: {
        title: intl.formatMessage({ id: "settingsPage.notifications.title", defaultMessage: "Notifications" }),
        icon: Bell,
        tone: "destructive",
        summary: intl.formatMessage({ id: "settingsPage.notifications.summary", defaultMessage: "Mentions, replies and messages" }),
        render: () => <NotificationSettings />,
      },
      privacy: {
        title: intl.formatMessage({ id: "settingsPage.privacy.title", defaultMessage: "Privacy & safety" }),
        icon: ShieldCheck,
        tone: "accent2",
        summary: user
          ? intl.formatMessage({ id: "settingsPage.privacy.summary", defaultMessage: "Blocking, muted words and media" })
          : intl.formatMessage({ id: "settingsPage.privacy.summaryLoggedOut", defaultMessage: "Media, links and Discover" }),
        render: () => <PrivacySettings />,
      },
      appearance: {
        title: intl.formatMessage({ id: "settingsPage.appearance.title", defaultMessage: "Appearance" }),
        icon: Palette,
        tone: "primary",
        summary: intl.formatMessage({ id: "settingsPage.appearance.summary", defaultMessage: "Theme, language, text size and effects" }),
        render: () => (
          <>
            <SettingsGroup id="appearance">
              <SettingsRow>
                <ThemeSelector />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title={intl.formatMessage({ id: "settingsPage.appearance.text", defaultMessage: "Text" })}>
              <LanguageSettings />
              <FontScaleSettings />
            </SettingsGroup>
            <SettingsGroup title={intl.formatMessage({ id: "settingsPage.appearance.motion", defaultMessage: "Motion & effects" })}>
              <MotionSettings />
            </SettingsGroup>
          </>
        ),
      },
      chat: {
        title: intl.formatMessage({ id: "settingsPage.chat.title", defaultMessage: "Chats" }),
        icon: MessageSquare,
        tone: "success",
        summary: intl.formatMessage({ id: "settingsPage.chat.summary", defaultMessage: "Sending, typing and reactions" }),
        render: () => <ChatSettings />,
      },
      dms: {
        title: intl.formatMessage({ id: "settingsPage.dms.title", defaultMessage: "Direct messages" }),
        icon: MessageSquareLock,
        tone: "accent2",
        summary: intl.formatMessage({ id: "settingsPage.dms.summary", defaultMessage: "Requests and previews" }),
        render: () => <DirectMessageSettings />,
      },
      voice: {
        title: intl.formatMessage({ id: "settingsPage.voice.title", defaultMessage: "Voice" }),
        icon: Mic,
        tone: "warning",
        summary: intl.formatMessage({ id: "settingsPage.voice.summary", defaultMessage: "Devices and noise filtering" }),
        render: () => <VoiceSettings />,
      },
      relays: {
        title: intl.formatMessage({ id: "settingsPage.relays.title", defaultMessage: "Relays" }),
        icon: Waypoints,
        tone: "accent2",
        summary: intl.formatMessage({ id: "settingsPage.relays.summary", defaultMessage: "Where your account and uploads live" }),
        render: () => <RelaysSettings />,
      },
      support: {
        title: intl.formatMessage({ id: "settingsPage.support.title", defaultMessage: "Help & support" }),
        icon: LifeBuoy,
        tone: "success",
        summary: intl.formatMessage({ id: "settingsPage.support.summary", defaultMessage: "Safety guide and contact" }),
        render: () => <SupportSettings />,
      },
      about: {
        title: intl.formatMessage({ id: "settingsPage.about.title", defaultMessage: "About Armada" }),
        icon: Info,
        tone: "muted",
        summary: appVersionLabel(),
        render: () => <AboutSettings />,
      },
    };
    if (user) {
      pages.ultra = {
        title: "Armada Ultra",
        icon: Gem,
        tone: "accent2",
        summary: ultra
          ? intl.formatMessage({ id: "settingsPage.ultra.summaryActive", defaultMessage: "Active. Thanks for being Ultra" })
          : intl.formatMessage({ id: "settingsPage.ultra.summary", defaultMessage: "Premium, for $0.00" }),
        render: () => <UltraSettings />,
      };
      pages.profile = {
        title: intl.formatMessage({ id: "settingsPage.profile.title", defaultMessage: "Profile" }),
        icon: UserRound,
        tone: "primary",
        render: () => (
          <SettingsGroup id="profile" bare>
            <div>
              <ProfileSettings />
            </div>
          </SettingsGroup>
        ),
      };
      pages.blocked = {
        title: intl.formatMessage({ id: "settingsPage.blocked.title", defaultMessage: "Blocked people" }),
        icon: UserX,
        tone: "destructive",
        render: () => (
          <SettingsGroup
            id="muted"
            footer={intl.formatMessage({ id: "settingsPage.blocked.footer", defaultMessage: "Hidden everywhere in Armada. They are never told." })}
          >
            <MutedPeopleSettings />
          </SettingsGroup>
        ),
      };
      pages["muted-words"] = {
        title: intl.formatMessage({ id: "settingsPage.mutedWords.title", defaultMessage: "Muted words" }),
        icon: SpellCheck,
        tone: "warning",
        render: () => (
          <SettingsGroup id="muted-words">
            <MutedWordsSettings />
          </SettingsGroup>
        ),
      };
      pages.emojis = {
        title: intl.formatMessage({ id: "settingsPage.emojis.title", defaultMessage: "Emoji packs" }),
        icon: Smile,
        tone: "warning",
        summary: intl.formatMessage({ id: "settingsPage.emojis.summary", defaultMessage: "Custom emoji you made or added" }),
        render: () => (
          <SettingsGroup
            id="emojis"
            footer={intl.formatMessage({
              id: "settingsPage.emojis.footer",
              defaultMessage: "Packs you publish or add show up in the emoji picker on every device.",
            })}
          >
            <EmojiPackSettings />
          </SettingsGroup>
        ),
      };
      // Reachable even with zaps off, since its enable toggle lives inside.
      pages.wallet = {
        title: intl.formatMessage({ id: "settingsPage.wallet.title", defaultMessage: "Wallet" }),
        icon: Zap,
        tone: "warning",
        summary: intl.formatMessage({ id: "settingsPage.wallet.summary", defaultMessage: "Lightning wallet and zaps" }),
        render: () => (
          <SettingsGroup id="wallet">
            <WalletSettings />
          </SettingsGroup>
        ),
      };
    }
    if (isDesktop()) {
      pages.desktop = {
        title: intl.formatMessage({ id: "settingsPage.desktop.title", defaultMessage: "Desktop" }),
        icon: Monitor,
        tone: "muted",
        summary: intl.formatMessage({ id: "settingsPage.desktop.summary", defaultMessage: "Startup and the tray" }),
        render: () => (
          <SettingsGroup id="desktop">
            <DesktopSettings />
          </SettingsGroup>
        ),
      };
    }
    if (profiling) {
      pages.diagnostics = {
        title: intl.formatMessage({ id: "settingsPage.diagnostics.title", defaultMessage: "Diagnostics" }),
        icon: Activity,
        tone: "muted",
        summary: intl.formatMessage({ id: "settingsPage.diagnostics.summary", defaultMessage: "Profiling build tools" }),
        render: () => (
          <SettingsGroup id="diagnostics">
            <DiagnosticsSettings />
          </SettingsGroup>
        ),
      };
    }
    const groups: SettingsPageId[][] = [
      ["ultra"],
      ["account", "notifications", "privacy"],
      ["appearance", "chat", "dms", "voice", "emojis"],
      ["relays", "wallet", "desktop", "diagnostics"],
      ["support", "about"],
    ];
    return { pages, groups: groups.map((ids) => ids.filter((id) => pages[id])).filter((ids) => ids.length > 0) };
  }, [user, intl, ultra]);
}

/** The root list's identity card: the account at a glance, opening Profile (or Account when logged out). */
function ProfileCard({ compact, active, onOpen }: { compact?: boolean; active?: boolean; onOpen: (id: SettingsPageId) => void }) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const author = useAuthor(user?.pubkey);
  const metadata = author.data?.metadata;
  const name = metadata?.name || metadata?.display_name;
  const npub = user ? nip19.npubEncode(user.pubkey) : "";

  return (
    <button
      type="button"
      onClick={() => onOpen(user ? "profile" : "account")}
      className={cn(
        "gutter-tick flex w-full items-center gap-3 bg-chrome clip-corner-lg text-left transition-colors hover:bg-accent/40 active:bg-accent/60",
        compact ? "px-3 py-3" : "px-4 py-4",
        active && "is-active bg-accent/50",
      )}
    >
      <span className="relative shrink-0">
        <Avatar shape={getAvatarShape(metadata)} className={compact ? "size-10" : "size-14"}>
          {user && <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name ?? ""} />}
          <AvatarFallback className="bg-primary/20 text-primary">
            {name ? name.charAt(0).toUpperCase() : <UserRound className="size-5" />}
          </AvatarFallback>
        </Avatar>
        {user && !author.isLoading && !name && (
          <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className={cn("block truncate font-semibold leading-tight", compact ? "text-sm" : "text-base", !name && "text-muted-foreground")}>
          {user
            ? (name ?? (author.isLoading
              ? "\u00a0"
              : intl.formatMessage({ id: "settingsPage.profileCard.setName", defaultMessage: "Set your name" })))
            : intl.formatMessage({ id: "settingsPage.profileCard.logIn", defaultMessage: "Log in or sign up" })}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {user
            ? <span className="font-mono">{npub.slice(0, 12)}…{npub.slice(-6)}</span>
            : intl.formatMessage({
              id: "settingsPage.profileCard.loggedOutHint",
              defaultMessage: "Sync your settings and join communities",
            })}
        </span>
      </span>
      {!compact && <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />}
    </button>
  );
}

function RootList({
  pages,
  groups,
  compact,
  active,
  onOpen,
}: {
  pages: Partial<Record<SettingsPageId, PageDef>>;
  groups: SettingsPageId[][];
  compact?: boolean;
  active?: SettingsPageId;
  onOpen: (id: SettingsPageId) => void;
}) {
  const intl = useIntl();
  const { canInstall, install, needsManualInstall } = useInstallPrompt();
  const showInstall = canInstall || needsManualInstall;

  return (
    <nav aria-label={intl.formatMessage(common.settings)} className={compact ? "space-y-4" : "space-y-6"}>
      <ProfileCard compact={compact} active={active === "profile" || (!pages.profile && active === "account")} onOpen={onOpen} />
      {groups.map((ids, index) => (
        <div
          key={ids.join()}
          className="bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t"
        >
          {index === groups.length - 1 && showInstall && (
            <SettingsRow
              icon={Download}
              tone="primary"
              label={intl.formatMessage({ id: "settingsPage.install.label", defaultMessage: "Install Armada" })}
              description={compact ? undefined : needsManualInstall
                ? intl.formatMessage({ id: "settingsPage.install.manual", defaultMessage: "Add to your Home Screen from Safari." })
                : intl.formatMessage({
                  id: "settingsPage.install.description",
                  defaultMessage: "Add to your home screen or desktop for a standalone app.",
                })}
              info={needsManualInstall
                ? intl.formatMessage({
                  id: "settingsPage.install.manualInfo",
                  defaultMessage: "In Safari, tap Share → Add to Home Screen, keep Open as Web App on, then launch Armada from its new icon.",
                })
                : undefined}
              onClick={canInstall ? () => install() : undefined}
              className={compact ? "min-h-11 py-2" : undefined}
            />
          )}
          {ids.map((id) => {
            const page = pages[id]!;
            const isActive = active === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onOpen(id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "gutter-tick flex w-full items-center gap-3 px-4 text-left transition-colors hover:bg-accent/40 active:bg-accent/60",
                  compact ? "min-h-11 py-2" : "min-h-[3.75rem] py-2.5 touch:min-h-16",
                  isActive && "is-active bg-accent/50",
                )}
              >
                <SettingsIcon icon={page.icon} tone={page.tone} className={compact ? "size-7" : undefined} />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-sm font-medium leading-tight">{page.title}</span>
                  {!compact && page.summary && (
                    <span className="block truncate text-xs text-muted-foreground leading-snug">{page.summary}</span>
                  )}
                </span>
                {!compact && <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />}
              </button>
            );
          })}
        </div>
      ))}
      {!compact && (
        <div className="pt-2 pb-2">
          <div className="flex w-full items-center gap-2 px-6">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/20 to-primary/30" />
            <svg width="22" height="22" viewBox="0 0 128 128" fill="none" aria-hidden className="text-primary/30 shrink-0">
              <path d="M64 4.225l-39.97 88.5h17.13l2.31-5.2 2.76-6.22-2.22-1.43-1.42-12.84h9.99l4.89-11.01L64 41.335l11.42 25.7h9.99l-1.43 12.84-2.22 1.43 2.77 6.22 2.31 5.2h17.13z" fill="currentColor" />
            </svg>
            <div className="h-px flex-1 bg-gradient-to-l from-transparent via-primary/20 to-primary/30" />
          </div>
        </div>
      )}
    </nav>
  );
}

const PUSH_ANIMATION = "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-6 motion-safe:duration-200";
const POP_ANIMATION = "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-6 motion-safe:duration-200";

/**
 * App settings, laid out as a native settings app: a root list of pages that
 * drill down, or on a wide pane a sidebar beside the open page.
 */
export function SettingsPage({
  section,
  onClose,
}: {
  /** Set when drawn as an overlay (`lib/settingsOverlay.ts`), where `useLocation()` is the page underneath. */
  section?: string;
  onClose?: () => void;
} = {}) {
  const intl = useIntl();
  const back = useBackOrHome();
  const close = onClose ?? back;
  // Deep-linked section (e.g. /settings#profile) opens its page and scrolls to its group.
  const routedSection = useLocation().hash.slice(1);
  const targetSection = section ?? routedSection;
  const { pages, groups } = useSettingsPages();

  const [stack, setStack] = useState<SettingsPageId[]>(() => resolveSettingsSection(targetSection)?.stack ?? []);
  const [anchor, setAnchor] = useState(() => resolveSettingsSection(targetSection)?.anchor);
  const [motion, setMotion] = useState<"push" | "pop" | null>(null);
  useEffect(() => {
    const resolved = resolveSettingsSection(targetSection);
    if (!resolved) return;
    setMotion(null);
    setStack(resolved.stack);
    setAnchor(resolved.anchor);
  }, [targetSection]);

  const mainRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const measure = () => setWide(el.clientWidth >= WIDE_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);
  const searching = query.trim() !== "";
  const resultsRef = useRef<HTMLDivElement>(null);
  const visibleSections = useSettingsFilter(resultsRef, query);

  // A page this user can't see (logged out, another build) falls back to the root.
  const validStack = stack.filter((id) => pages[id]);
  const defaultPage: SettingsPageId = pages.profile ? "profile" : "account";
  const shown = wide && validStack.length === 0 ? [defaultPage] : validStack;
  const current = shown.at(-1);
  const canPop = shown.length > (wide ? 1 : 0);

  const nav = useMemo<SettingsNav>(() => ({
    open: (id) => {
      closeSearch();
      setMotion("push");
      setAnchor(undefined);
      setStack((prev) => {
        // From the root list or the sidebar, a page replaces the stack; from a page, it pushes.
        const base = prev.filter((p) => p !== id);
        return SETTINGS_PAGE_PARENT[id] ? [...base, id] : [id];
      });
    },
  }), [closeSearch]);

  const pop = useCallback(() => {
    setMotion("pop");
    setAnchor(undefined);
    setStack((prev) => prev.slice(0, -1));
  }, []);

  // Back steps out of a page before it leaves Settings (the overlay's own handler is beneath this one).
  useAndroidBack(() => {
    pop();
    return true;
  }, canPop && !searchOpen, "overlay");

  useEffect(() => {
    if (!canPop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
      // A dialog, menu or listbox open over Settings takes Escape first.
      const panel = mainRef.current?.closest("[role='dialog']");
      const stacked = document.querySelectorAll("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']");
      if (Array.from(stacked).some((el) => el !== panel && !panel?.contains(el))) return;
      event.preventDefault();
      pop();
    };
    // Capture, so this runs ahead of the overlay's own Escape-to-close.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [canPop, pop]);

  useEffect(() => {
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`settings-${anchor}`)?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, current]);

  const searchLabel = intl.formatMessage({ id: "settingsPage.searchLabel", defaultMessage: "Search settings" });
  const parentId = current ? SETTINGS_PAGE_PARENT[current] : undefined;
  const parent = parentId ? pages[parentId] : undefined;
  const page = current ? pages[current] : undefined;
  const headerTitle = !wide && page && !searching ? page.title : intl.formatMessage(common.settings);

  const pageView = page && current && (
    <SettingsPageTitleContext.Provider value={page.title}>
      <div
        key={current}
        className={cn(
          "mx-auto max-w-2xl space-y-6 px-4 pt-4 pb-12 sm:px-6",
          motion === "push" && PUSH_ANIMATION,
          motion === "pop" && POP_ANIMATION,
        )}
      >
        {wide && (
          <div className="space-y-1 px-1 pt-1">
            {parent && parentId && (
              <button
                type="button"
                onClick={pop}
                className="-ml-1.5 flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
                {parent.title}
              </button>
            )}
            <h2 className="text-2xl font-semibold tracking-tight">{page.title}</h2>
          </div>
        )}
        {page.render()}
      </div>
    </SettingsPageTitleContext.Provider>
  );

  // Every page at once, so search can match any row; each heading opens its page.
  const searchResults = (
    <SettingsSearchingContext.Provider value>
      <div ref={resultsRef} className="mx-auto max-w-2xl space-y-8 px-4 pt-4 pb-12 sm:px-6">
        {visibleSections === 0 && (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            {intl.formatMessage(
              { id: "settingsPage.noMatch", defaultMessage: "No settings match “{query}”." },
              { query: query.trim() },
            )}
          </p>
        )}
        {(Object.keys(pages) as SettingsPageId[]).map((id) => {
          const result = pages[id]!;
          return (
            <section key={id} data-settings-group className="space-y-3">
              <button
                type="button"
                onClick={() => {
                  closeSearch();
                  setMotion(null);
                  setAnchor(undefined);
                  setStack(resolveSettingsSection(id)?.stack ?? [id]);
                }}
                className="flex items-center gap-2.5 px-1 text-left text-sm font-semibold transition-colors hover:text-primary"
              >
                <SettingsIcon icon={result.icon} tone={result.tone} className="size-7" />
                {result.title}
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
              <SettingsPageTitleContext.Provider value={result.title}>
                <div className="space-y-5">{result.render()}</div>
              </SettingsPageTitleContext.Provider>
            </section>
          );
        })}
      </div>
    </SettingsSearchingContext.Provider>
  );

  const rootList = (
    <RootList
      pages={pages}
      groups={groups}
      compact={wide}
      active={wide && !searching ? shown[0] : undefined}
      onOpen={nav.open}
    />
  );

  return (
    <SettingsNavContext.Provider value={nav}>
      <main ref={mainRef} className="flex-1 min-w-0 flex flex-col safe-area-top">
        <header
          className={cn(
            "relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 w-[calc(100%-2*var(--gutter))] sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome",
            wide ? "max-w-5xl" : "max-w-2xl",
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            aria-label={intl.formatMessage(common.back)}
            onClick={canPop && !searchOpen ? pop : close}
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="min-w-0 flex-1 font-semibold truncate leading-tight">{headerTitle}</h1>
          {(wide || !current) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={searchLabel}
              aria-pressed={searchOpen}
              className="size-9 shrink-0 text-muted-foreground"
              onClick={() => setSearchOpen(true)}
            >
              <Search className="size-4" />
            </Button>
          )}
          <ChatSearchBar
            open={searchOpen}
            value={query}
            onChange={setQuery}
            onClose={closeSearch}
            placeholder={intl.formatMessage({ id: "settingsPage.searchPlaceholder", defaultMessage: "Search settings…" })}
            label={searchLabel}
          />
        </header>

        {wide ? (
          <div className="mx-auto flex w-full max-w-5xl flex-1 min-h-0">
            <div className="w-72 shrink-0 overflow-y-auto pl-gutter pr-2 pt-4 pb-8">
              {rootList}
            </div>
            <div className="flex-1 min-w-0 overflow-y-auto pb-safe">
              {searching ? searchResults : pageView}
            </div>
          </div>
        ) : (
          <>
            <div
              className={cn(
                "flex-1 min-h-0 overflow-y-auto pb-safe",
                current && !searching && "hidden",
                !current && motion === "pop" && POP_ANIMATION,
              )}
            >
              {searching ? searchResults : (
                <div className="mx-auto max-w-2xl px-4 pt-4 pb-12 sm:px-6">{rootList}</div>
              )}
            </div>
            {current && !searching && (
              <div className="flex-1 min-h-0 overflow-y-auto pb-safe">{pageView}</div>
            )}
          </>
        )}
      </main>
    </SettingsNavContext.Provider>
  );
}
