import { useQueryClient } from "@tanstack/react-query";
import { Hash, Loader2, MessageCircle, Server, Settings } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { DeferredRow } from "@/components/DeferredRow";
import { DmAvatar } from "@/components/DmAvatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppContext } from "@/hooks/useAppContext";
import { common, defineMessage, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useClosedDms } from "@/hooks/useClosedDms";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useDmConversationName } from "@/hooks/useDmConversationName";
import { useDMConversations } from "@/hooks/useDirectMessages";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { shortTimeAgo } from "@/lib/formatTime";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";
import { SettingsOverlayContext } from "@/lib/settingsOverlay";
import {
  buildDmSwitcherEntries,
  buildSwitcherEntries,
  nextChannelRoute,
  searchSwitcherMessages,
  switcherLiveKeys,
  type DmSwitcherEntry,
  type MessageEntry,
  type MessageScope,
  type SwitcherContext,
  type SwitcherEntries,
} from "@/lib/switcher";
import { AvatarInitial } from "@/components/AvatarInitial";

const EMPTY_ENTRIES: SwitcherEntries = { spaces: [], channels: [] };
/** Keep a blank launcher cheap; searching mounts every row so every name can match. */
const EAGER_DM_RESULTS = 12;
const DM_RESULT_HEIGHT = 52;

/** Result categories; `messages` is channel/community chat, `dms` direct messages. */
type Scope = "all" | "channels" | "servers" | "messages" | "dms";

const SCOPE_TABS: Array<{ value: Scope; label: MessageDescriptor }> = [
  { value: "all", label: defineMessage({ id: "quickSwitcher.scope.all", defaultMessage: "All" }) },
  { value: "messages", label: defineMessage({ id: "quickSwitcher.scope.messages", defaultMessage: "Messages" }) },
  { value: "dms", label: defineMessage({ id: "quickSwitcher.scope.dms", defaultMessage: "DMs" }) },
  { value: "channels", label: defineMessage({ id: "quickSwitcher.scope.channels", defaultMessage: "Channels" }) },
  { value: "servers", label: defineMessage({ id: "quickSwitcher.scope.servers", defaultMessage: "Servers" }) },
];

/** Message corpus for a scope, or null. `dmsDisabled` excludes DMs entirely. */
function messageScopeFor(scope: Scope, dmsDisabled: boolean): MessageScope | null {
  switch (scope) {
    case "all":
      return dmsDisabled ? "channels" : "all";
    case "messages":
      return "channels";
    case "dms":
      return dmsDisabled ? null : "dms";
    default:
      return null;
  }
}

/** Message hit. The cmdk `value` embeds the snippet so cmdk's own filter keeps it. */
function MessageResult({ message, onSelect }: { message: MessageEntry; onSelect: () => void }) {
  const author = useAuthor(message.authorPubkey);
  const name = useScopedDisplayName(message.authorPubkey, author.data?.metadata);
  return (
    <CommandItem value={`${message.content} ${message.key}`} onSelect={onSelect}>
      <Avatar className="mr-2 size-7 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="text-xs"><AvatarInitial name={name} /></AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{message.content}</span>
        <span className="truncate text-xs text-muted-foreground">
          <DisplayName pubkey={message.authorPubkey} name={name} />
          {" · "}
          {message.dmPeers ? (
            <FormattedMessage
              id="quickSwitcher.dmMessageSource"
              defaultMessage="Direct message · {conversation}"
              values={{ conversation: <DmMessageSource peers={message.dmPeers} /> }}
            />
          ) : (
            message.source
          )}
          {" · "}
          {shortTimeAgo(message.createdAt)}
        </span>
      </div>
    </CommandItem>
  );
}

function DmMessageSource({ peers }: { peers: readonly string[] }) {
  const { user } = useCurrentUser();
  const { name } = useDmConversationName(peers, user?.pubkey);
  return <>{name}</>;
}

function DmResult({
  conversation,
  self,
  onSelect,
}: {
  conversation: DmSwitcherEntry;
  self: string | undefined;
  onSelect: () => void;
}) {
  const { name, searchText } = useDmConversationName(conversation.peers, self);
  return (
    <CommandItem
      value={`${name} ${searchText} ${conversation.key}`}
      onSelect={onSelect}
    >
      <DmAvatar
        peers={conversation.peers}
        selfPubkey={self}
        sizePx={28}
        className="mr-2 size-7"
      />
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {conversation.peers.length > 1 ? (
            <FormattedMessage
              id="quickSwitcher.peopleCount"
              defaultMessage="{count, plural, one {# person} other {# people}}"
              values={{ count: conversation.peers.length }}
            />
          ) : (
            <FormattedMessage id="quickSwitcher.directMessage" defaultMessage="Direct message" />
          )}
        </span>
      </div>
    </CommandItem>
  );
}

/**
 * Quick switcher (Ctrl/Cmd+K) across servers, communities, channels, DMs and
 * settings; also Alt+↑/↓ channel hopping. Mounted once in {@link MainLayout}.
 */
export function QuickSwitcher() {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  const liveServers = useNip29Servers();
  const communities = useLiveCommunities();
  // Globally mounted, so NIP-17 stays non-interactive: Ctrl+K must never prompt a signer.
  const { conversations: legacyDms, isLoading: legacyDmsLoading } = useDMConversations();
  const { conversations: dm17Dms, isLoading: dm17DmsLoading } = useDm17Conversations();
  const { isKnown, isLoading: dmTrustLoading } = useKnownDmPeers();
  const { reopen: reopenDm } = useClosedDms();
  const dmEntriesLoading =
    Boolean(user) && (legacyDmsLoading || dm17DmsLoading || dmTrustLoading);

  const dmEntries = useMemo(() => {
    if (!user || config.dmsDisabled || dmEntriesLoading) return [];
    return buildDmSwitcherEntries(legacyDms, dm17Dms, {
      self: user.pubkey,
      pinned: config.pinnedDms,
      started: config.startedDms,
      isKnown,
    });
  }, [
    user,
    legacyDms,
    dm17Dms,
    config.dmsDisabled,
    config.pinnedDms,
    config.startedDms,
    dmEntriesLoading,
    isKnown,
  ]);
  const allowedDmKeys = useMemo(() => new Set(dmEntries.map((entry) => entry.key)), [dmEntries]);

  // Same ordering as the ServerRail (layout with folders flattened).
  const orderedKeys = useMemo(() => {
    const liveKeys = switcherLiveKeys(liveServers, communities);
    const live = new Set(liveKeys);
    return flattenLayout(mergeLayout(config.railLayout, liveKeys)).filter((key) => live.has(key));
  }, [liveServers, communities, config.railLayout]);

  const ctx = useMemo<SwitcherContext>(
    () => ({
      queryClient,
      eventStore,
      communities: new Map(communities.map((c) => [c.community_id, c])),
      self: user?.pubkey,
    }),
    [queryClient, eventStore, communities, user?.pubkey],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Snapshot entries on open; async because Concord channels come from IndexedDB.
  const [entries, setEntries] = useState<SwitcherEntries>(EMPTY_ENTRIES);
  useEffect(() => {
    if (!open) {
      setEntries(EMPTY_ENTRIES);
      return;
    }
    let live = true;
    void buildSwitcherEntries(orderedKeys, ctx).then((e) => {
      if (live) setEntries(e);
    });
    return () => {
      live = false;
    };
  }, [open, orderedKeys, ctx]);

  // Message search is query-driven (too many to preload): debounced scan of on-device stores.
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope("all");
    }
  }, [open]);
  useEffect(() => {
    const needle = query.trim();
    const searchScope = messageScopeFor(scope, config.dmsDisabled);
    if (!open || !needle || !searchScope) {
      setMessages([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const handle = setTimeout(() => {
      void searchSwitcherMessages(needle, entries.channels, ctx, {
        scope: searchScope,
        // Filter request-tier DMs before the result caps so they can't crowd out real hits.
        allowedDmConversationKeys: allowedDmKeys,
      }).then((m) => {
        if (live) {
          setMessages(m);
          setSearching(false);
        }
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [open, query, scope, entries.channels, ctx, allowedDmKeys, config.dmsDisabled]);

  const scopeTabs = useMemo(
    () => (config.dmsDisabled ? SCOPE_TABS.filter((t) => t.value !== "dms") : SCOPE_TABS),
    [config.dmsDisabled],
  );
  const dmSectionActive = !config.dmsDisabled && (scope === "all" || scope === "dms");

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const settings = useContext(SettingsOverlayContext);
  const openSettings = () => {
    setOpen(false);
    settings.show();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const path = location.pathname;
        if (!path.startsWith("/s/") && !path.startsWith("/c/")) return;
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        void nextChannelRoute(path, dir, ctxRef.current).then((to) => {
          if (to) navigate(to);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [location.pathname, navigate]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={intl.formatMessage({ id: "quickSwitcher.placeholder", defaultMessage: "Where would you like to go?" })} onValueChange={setQuery} />
      {/* Prevent mousedown so the input keeps focus. */}
      <div
        className="flex flex-wrap gap-1 border-b border-chrome px-3 py-2"
        onMouseDown={(e) => e.preventDefault()}
      >
        <ToggleGroup
          type="single"
          value={scope}
          onValueChange={(v) => setScope((v || "all") as Scope)}
          className="flex flex-wrap justify-start gap-1"
        >
          {scopeTabs.map((t) => (
            <ToggleGroupItem
              key={t.value}
              value={t.value}
              className="h-auto px-3 py-1.5 touch:py-2.5 text-sm font-normal clip-corner-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-[state=on]:bg-primary data-[state=on]:font-medium data-[state=on]:text-primary-foreground"
            >
              <FormattedMessage {...t.label} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <CommandList>
        {/* An in-flight search isn't "no results". */}
        {!searching && !(dmEntriesLoading && dmSectionActive) && (
          <CommandEmpty>
            <FormattedMessage id="quickSwitcher.noResults" defaultMessage="No results found." />
          </CommandEmpty>
        )}
        {dmEntriesLoading && dmSectionActive && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <FormattedMessage id="quickSwitcher.loadingDms" defaultMessage="Loading direct messages…" />
          </div>
        )}
        {searching && messages.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <FormattedMessage id="quickSwitcher.searchingMessages" defaultMessage="Searching messages…" />
          </div>
        )}
        {dmSectionActive && dmEntries.length > 0 && (
          <CommandGroup heading={intl.formatMessage({ id: "quickSwitcher.heading.directMessages", defaultMessage: "Direct messages" })}>
            {dmEntries.map((conversation, index) => (
              <DeferredRow
                // Reset the latch when the search clears so the blank launcher stays cheap.
                key={`${conversation.key}:${query.trim() ? "search" : "idle"}`}
                active={!query.trim() && index >= EAGER_DM_RESULTS}
                minHeight={DM_RESULT_HEIGHT}
              >
                <DmResult
                  conversation={conversation}
                  self={user?.pubkey}
                  onSelect={() => {
                    // Explicit reopen, or it'd vanish again after navigating away.
                    reopenDm(conversation.key);
                    go(conversation.route);
                  }}
                />
              </DeferredRow>
            ))}
          </CommandGroup>
        )}
        {(scope === "all" || scope === "channels") && entries.channels.length > 0 && (
          <CommandGroup heading={intl.formatMessage({ id: "quickSwitcher.heading.channels", defaultMessage: "Channels" })}>
            {entries.channels.map((c) => (
              <CommandItem
                key={c.key}
                value={`${c.name} ${c.spaceName} ${c.id}`}
                onSelect={() => go(c.route)}
              >
                <Hash className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.name}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{c.spaceName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {messages.length > 0 && (
          <CommandGroup heading={
              scope === "dms"
                ? intl.formatMessage({ id: "quickSwitcher.heading.dmMessages", defaultMessage: "DM messages" })
                : intl.formatMessage({ id: "quickSwitcher.heading.messages", defaultMessage: "Messages" })
            }>
            {messages.map((m) => (
              <MessageResult
                key={m.key}
                message={m}
                onSelect={() => {
                  if (m.dmConversationKey) reopenDm(m.dmConversationKey);
                  go(m.route);
                }}
              />
            ))}
          </CommandGroup>
        )}
        {(scope === "all" || scope === "servers") && entries.spaces.length > 0 && (
          <CommandGroup heading={intl.formatMessage({ id: "quickSwitcher.heading.servers", defaultMessage: "Servers" })}>
            {entries.spaces.map((s) => (
              <CommandItem key={s.key} value={`${s.name} ${s.key}`} onSelect={() => go(s.route)}>
                <Server className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{s.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {scope === "all" && (
          <CommandGroup heading={intl.formatMessage({ id: "quickSwitcher.heading.goTo", defaultMessage: "Go to" })}>
            {!config.dmsDisabled && (
              <CommandItem value="direct messages dms" onSelect={() => go("/dm")}>
                <MessageCircle className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <FormattedMessage id="quickSwitcher.goTo.directMessages" defaultMessage="Direct messages" />
              </CommandItem>
            )}
            <CommandItem value="settings preferences" onSelect={openSettings}>
              <Settings className="mr-2 size-4 shrink-0 text-muted-foreground" />
              <FormattedMessage {...common.settings} />
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
