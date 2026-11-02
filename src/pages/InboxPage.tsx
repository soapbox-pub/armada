import { AtSign, CheckCheck, ChevronLeft, ExternalLink, Inbox, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChatScopeContext } from "@/contexts/ChatScopeContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEvent } from "@/hooks/useEvent";
import { useGroupMembership } from "@/hooks/useGroupMembership";
import { useGroupReactions } from "@/hooks/useReactions";
import { useGroupThreads, useSendThreadReply } from "@/hooks/useThread";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInbox, type InboxItem } from "@/hooks/useRelayInbox";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { nip29ThreadRootOf } from "@/lib/nip29Threads";
import { routeParamToRelay } from "@/lib/platform";
import { chatRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { NostrRumor } from "@/lib/nostrRumor";
import { AvatarInitial } from "@/components/AvatarInitial";

/** One inbox row: who mentioned you, where, and a preview — click to open it. */
function InboxRow({
  item,
  channelName,
  selected,
  onOpen,
}: {
  item: InboxItem;
  channelName: string;
  selected: boolean;
  onOpen: (item: InboxItem) => void;
}) {
  const intl = useIntl();
  const { event, unread } = item;
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const preview = event.content.replace(/https?:\/\/\S+/g, "📎").trim() || "📎";

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "group/inbox flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors clip-corner-lg",
        selected ? "bg-primary/10" : "hover:bg-foreground/5",
        unread && !selected && "bg-primary/[0.06]",
      )}
    >
      <Avatar className="size-9 shrink-0">
        <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-xs">
          <AvatarInitial name={displayName} pubkey={event.pubkey} />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>
            <DisplayName pubkey={event.pubkey} name={displayName} />
          </span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <AtSign className="size-3 shrink-0" />
            {channelName}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {shortTimeAgo(event.created_at)}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 line-clamp-2 break-words text-sm",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {preview}
        </p>
      </div>
      {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label={intl.formatMessage({ id: "inboxPage.unread", defaultMessage: "Unread" })} />}
    </button>
  );
}

/**
 * The mention's conversation via the shared {@link ThreadPanel}, rooted at the
 * thread a reply belongs to (`nip29ThreadRootOf`).
 */
function InboxThreadDetail({
  mention,
  relayUrl,
  groupId,
  onClose,
}: {
  mention: NostrRumor;
  relayUrl: string;
  groupId: string;
  onClose: () => void;
}) {
  const { user } = useCurrentUser();

  const rootId = nip29ThreadRootOf(mention) ?? mention.id;
  const needFetch = rootId !== mention.id;
  const { data: fetchedRoot } = useEvent(needFetch ? rootId : undefined, [relayUrl]);
  const root: NostrRumor | undefined = needFetch ? fetchedRoot ?? undefined : mention;

  const { threadRepliesFor } = useGroupThreads(relayUrl, groupId, root ? [root.id] : []);
  const replies = root ? threadRepliesFor(root.id) : [];
  const replyIdsSig = replies.map((r) => r.id).join(",");
  const tallyIds = useMemo(
    () => (root ? [root.id, ...(replyIdsSig ? replyIdsSig.split(",") : [])] : []),
    [root, replyIdsSig],
  );
  const { reactionsFor } = useGroupReactions(relayUrl, groupId, tallyIds);
  // Memoized: every message row reads this context.
  const chatScope = useMemo(() => ({ kind: "nip29" as const, relayUrl, groupId }), [relayUrl, groupId]);
  const sendThreadReply = useSendThreadReply(relayUrl, groupId);

  const { data: membership } = useGroupMembership(relayUrl, groupId);
  const canWrite = Boolean(user && membership?.isMember);

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: [],
      isLoading: false,
      canWrite,
      canModerate: false,
      threadRepliesFor,
      reactionsFor,
      sendThreadReply: async (r: ChatMsg, content: string, tags: string[][]) => {
        await sendThreadReply(r as NostrRumor, content, tags);
      },
    }),
    [canWrite, threadRepliesFor, reactionsFor, sendThreadReply],
  );

  return (
    <ChatScopeContext.Provider value={chatScope}>
      {root ? (
        <ThreadPanel
          root={root}
          transport={transport}
          relayUrl={relayUrl}
          groupId={groupId}
          canWrite={canWrite}
          onClose={onClose}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </ChatScopeContext.Provider>
  );
}

/**
 * A server's Inbox: messages across its channels that @-mention you, newest
 * first, with a master/detail pane. Works on any NIP-29 server.
 */
export function InboxPage() {
  const { server } = useParams<{ server: string }>();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const intl = useIntl();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { markRead } = useReadState();
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const { data: groups } = useRelayGroups(relayUrl);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups ?? []) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const { items, unreadCount } = useRelayInbox(relayUrl, groupIds);
  const selected = useMemo(
    () => items.find((it) => it.event.id === selectedId),
    [items, selectedId],
  );

  useEffect(() => {
    if (selectedId && !items.some((it) => it.event.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [items, selectedId]);

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  const selectItem = (item: InboxItem) => {
    markRead(channelReadKey(relayUrl, item.groupId), item.event.created_at);
    setSelectedId(item.event.id);
  };

  const openInChannel = (item: InboxItem) => {
    const root = nip29ThreadRootOf(item.event);
    navigate(chatRoute({ kind: "nip29", relayUrl, groupId: item.groupId, threadRoot: root }));
  };

  const markAllRead = () => {
    const latestByGroup = new Map<string, number>();
    for (const item of items) {
      if (!item.unread) continue;
      latestByGroup.set(
        item.groupId,
        Math.max(latestByGroup.get(item.groupId) ?? 0, item.event.created_at),
      );
    }
    for (const [groupId, ts] of latestByGroup) {
      markRead(channelReadKey(relayUrl, groupId), ts);
    }
  };

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            <ServerRail />
            <ChannelSidebar
              relayUrl={relayUrl}
              onNavigate={() => setChannelsOpen(false)}
              className="touch:max-sidebar:flex-1"
            />
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "inboxPage.backToChannels", defaultMessage: "Back to channels" })}
              className="size-9 touch:size-11 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <Inbox className="size-5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <h1 className="font-semibold truncate leading-tight">
                <FormattedMessage id="inboxPage.title" defaultMessage="Inbox" />
              </h1>
            </div>
            {selected && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={intl.formatMessage({ id: "inboxPage.openInChannel", defaultMessage: "Open in channel" })}
                    className="size-8 touch:size-11 text-muted-foreground"
                    onClick={() => openInChannel(selected)}
                  >
                    <ExternalLink className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <FormattedMessage id="inboxPage.openInChannel" defaultMessage="Open in channel" />
                </TooltipContent>
              </Tooltip>
            )}
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 touch:h-10 gap-1.5 text-xs text-muted-foreground"
                onClick={markAllRead}
              >
                <CheckCheck className="size-4" />
                <span className="hidden sidebar:inline">
                  <FormattedMessage id="inboxPage.markAllRead" defaultMessage="Mark all read" />
                </span>
              </Button>
            )}
          </header>

          <div className="flex-1 min-h-0 flex">
            <div
              className={cn(
                "min-h-0 min-w-0 flex-col overflow-y-auto px-2 py-2",
                selected
                  ? "hidden sidebar:flex sidebar:w-80 sidebar:shrink-0"
                  : "flex flex-1",
              )}
            >
              {!user ? (
                <div className="px-3 py-16 text-center text-sm text-muted-foreground">
                  <FormattedMessage id="inboxPage.signIn" defaultMessage="Sign in to see messages that mention you." />
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-3 py-16 text-center text-muted-foreground">
                  <Inbox className="size-10 opacity-40" />
                  <p className="text-sm">
                    <FormattedMessage
                      id="inboxPage.empty"
                      defaultMessage="No mentions yet. When someone @-mentions you in a channel here, it’ll show up in your inbox."
                    />
                  </p>
                </div>
              ) : (
                <div className={cn("space-y-0.5", !selected && "mx-auto w-full max-w-2xl")}>
                  {items.map((item) => (
                    <InboxRow
                      key={item.event.id}
                      item={item}
                      channelName={nameById.get(item.groupId) ?? item.groupId}
                      selected={item.event.id === selectedId}
                      onOpen={selectItem}
                    />
                  ))}
                </div>
              )}
            </div>

            {selected && (
              <div className="flex flex-1 min-h-0 min-w-0">
                <InboxThreadDetail
                  key={selected.event.id}
                  mention={selected.event}
                  relayUrl={relayUrl}
                  groupId={selected.groupId}
                  onClose={() => setSelectedId(undefined)}
                />
              </div>
            )}
          </div>
        </main>
      </SwipeReveal>
    </ServerScopeProvider>
  );
}

export default InboxPage;
