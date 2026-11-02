import { AtSign, Bell, CheckCheck, MailPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunity, useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { useConcordMentions } from "@/concord/hooks/useConcordMentions";
import { useInviteInbox } from "@/concord/hooks/useDirectInvites";
import type { CommunityListEntry } from "@/concord/lib/communityList";
import { DisplayName } from "@/components/DisplayName";
import { ServerRail } from "@/components/layout/ServerRail";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { useAuthor } from "@/hooks/useAuthor";
import { FormattedMessage, defineMessages, useIntl } from "@/i18n";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import {
  channelReadKey,
  concordInviteReadKey,
  concordMentionReadKey,
  useReadState,
} from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInbox } from "@/hooks/useRelayInbox";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { shortTimeAgo } from "@/lib/formatTime";
import { nip29ThreadRootOf } from "@/lib/nip29Threads";
import { cleanContent, truncate } from "@/lib/notificationPreview";
import { chatRoute } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { AvatarInitial } from "@/components/AvatarInitial";

type CenterItem =
  | {
      kind: "mention";
      id: string;
      createdAt: number;
      unread: boolean;
      readKey: string;
      route: string;
      author: string;
      body: string;
      source: string;
    }
  | {
      kind: "invite";
      id: string;
      createdAt: number;
      unread: boolean;
      readKey: string;
      route: string;
      author: string;
      body: string;
      source: string;
    };

type SourceReporter = (source: string, items: CenterItem[] | null) => void;

const messages = defineMessages({
  all: { id: "notificationsPage.filter.all", defaultMessage: "All" },
  unread: { id: "notificationsPage.unread", defaultMessage: "Unread" },
  mentionedYou: { id: "notificationsPage.mentionedYou", defaultMessage: "Mentioned you" },
});

function relayName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messagePreview(content: string | undefined, fallback: string): string {
  const clean = truncate(cleanContent(content ?? ""));
  return clean || fallback;
}

function focusedRoute(
  base: { kind: "nip29"; relayUrl: string; groupId: string } |
    { kind: "concord"; communityId: string; channelId: string },
  event: { id: string; kind: number; tags: string[][] },
): string {
  const threadRoot = base.kind === "nip29"
    ? nip29ThreadRootOf(event)
    : event.tags.find(([name, value]) => name === "E" && value)?.[1];
  return chatRoute({ ...base, messageId: event.id, ...(threadRoot ? { threadRoot } : {}) });
}

/** Report one NIP-29 server's locally-known mentions into the aggregate page. */
function RelayNotificationSource({ relayUrl, report }: { relayUrl: string; report: SourceReporter }) {
  const { data: groups } = useRelayGroups(relayUrl);
  const { data: info } = useRelayInfo(relayUrl);
  const groupIds = useMemo(() => (groups ?? []).map((group) => group.id), [groups]);
  const nameById = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group.name])),
    [groups],
  );
  const { items } = useRelayInbox(relayUrl, groupIds);
  const sourceName = info?.name || relayName(relayUrl);
  const intl = useIntl();

  const reported = useMemo<CenterItem[]>(
    () => items.map(({ event, groupId, unread }) => ({
      kind: "mention",
      id: `nip29:${event.id}`,
      createdAt: event.created_at,
      unread,
      readKey: channelReadKey(relayUrl, groupId),
      route: focusedRoute({ kind: "nip29", relayUrl, groupId }, event),
      author: event.pubkey,
      body: messagePreview(event.content, intl.formatMessage(messages.mentionedYou)),
      source: `${sourceName} · #${nameById.get(groupId) ?? groupId}`,
    })),
    [items, relayUrl, sourceName, nameById, intl],
  );

  useEffect(() => {
    const source = `nip29:${relayUrl}`;
    report(source, reported);
    return () => report(source, null);
  }, [relayUrl, reported, report]);
  return null;
}

/** Report one Concord community's decrypted mention index into the page. */
function ConcordNotificationSource({
  entry,
  report,
}: {
  entry: CommunityListEntry;
  report: SourceReporter;
}) {
  const community = useCommunity(entry.community_id);
  const { data: folded } = useControlFold(community, false);
  const channels = useChannels(community, false);
  const { mentions } = useConcordMentions(community, channels);
  const { getLastRead } = useReadState();
  const nameById = useMemo(
    () => new Map(channels.map((channel) => [channel.idHex, channel.name])),
    [channels],
  );
  const readKey = community ? concordMentionReadKey(community.idHex) : undefined;
  const readAt = readKey ? getLastRead(readKey) : 0;
  const communityName = folded?.metadata?.name || entry.current.name;
  const intl = useIntl();

  const reported = useMemo<CenterItem[]>(() => {
    if (!readKey) return [];
    return mentions.flatMap((message) => {
      const channelId = message.tags.find(([name, value]) => name === "channel" && value)?.[1];
      if (!channelId) return [];
      return [{
        kind: "mention" as const,
        id: `concord:${message.id}`,
        createdAt: message.created_at,
        unread: message.created_at > readAt,
        readKey,
        route: focusedRoute(
          { kind: "concord", communityId: entry.community_id, channelId },
          message,
        ),
        author: message.pubkey,
        body: messagePreview(message.content, intl.formatMessage(messages.mentionedYou)),
        source: `${communityName} · #${nameById.get(channelId) ?? intl.formatMessage({
          id: "notificationsPage.unknownChannel",
          defaultMessage: "unknown channel",
        })}`,
      }];
    });
  }, [mentions, readKey, readAt, entry.community_id, communityName, nameById, intl]);

  useEffect(() => {
    const source = `concord:${entry.community_id}`;
    report(source, reported);
    return () => report(source, null);
  }, [entry.community_id, reported, report]);
  return null;
}

function NotificationRow({ item, onOpen }: { item: CenterItem; onOpen: (item: CenterItem) => void }) {
  const intl = useIntl();
  const author = useAuthor(item.author);
  const metadata = author.data?.metadata;
  const authorName = metadata?.display_name || metadata?.name
    || intl.formatMessage({ id: "notificationsPage.anonymous", defaultMessage: "Anonymous" });
  const title = item.kind === "invite"
    ? intl.formatMessage({ id: "notificationsPage.inviteFrom", defaultMessage: "Invite from {name}" }, { name: authorName })
    : authorName;
  const Icon = item.kind === "invite" ? MailPlus : AtSign;

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "group flex w-full items-start gap-3 px-3 py-3 text-left transition-colors clip-corner-lg",
        item.unread ? "bg-primary/[0.07] hover:bg-primary/[0.11]" : "hover:bg-foreground/5",
      )}
    >
      <Avatar className="size-10 shrink-0">
        <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={authorName} />
        <AvatarFallback className="bg-primary/20 text-sm text-primary">
          <AvatarInitial name={authorName} />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("truncate text-sm", item.unread ? "font-semibold" : "font-medium")}>
            {item.kind === "invite" ? title : (
              <DisplayName pubkey={item.author} name={title} />
            )}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {shortTimeAgo(item.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.source}</p>
        <p className={cn("mt-1 line-clamp-2 break-words text-sm", !item.unread && "text-muted-foreground")}>
          {item.body}
        </p>
      </div>
      {item.unread && (
        <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label={intl.formatMessage(messages.unread)} />
      )}
    </button>
  );
}

/**
 * Account-level Notification Center: cross-community mentions and pending
 * Concord invites, newest first. Rows reuse the existing mention/invite read
 * keys so badges stay in sync.
 */
export function NotificationsPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const { markRead } = useReadState();
  const servers = useNip29Servers();
  const communities = useLiveCommunities();
  const { items: invites } = useInviteInbox();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [sources, setSources] = useState<Record<string, CenterItem[]>>({});
  const filters = useMemo<PillTab<"all" | "unread">[]>(() => [
    { id: "all", label: intl.formatMessage(messages.all), icon: Bell },
    { id: "unread", label: intl.formatMessage(messages.unread), icon: AtSign },
  ], [intl]);

  const report = useCallback<SourceReporter>((source, items) => {
    setSources((current) => {
      if (items === null) {
        if (!(source in current)) return current;
        const next = { ...current };
        delete next[source];
        return next;
      }
      if (current[source] === items) return current;
      return { ...current, [source]: items };
    });
  }, []);

  const activity = useMemo<CenterItem[]>(() => {
    const pendingInvites: CenterItem[] = invites.map(({ invite, unread }) => ({
      kind: "invite",
      id: `invite:${invite.wrapId}`,
      createdAt: invite.receivedAt,
      unread,
      readKey: concordInviteReadKey(),
      route: "/invites",
      author: invite.sender,
      body: invite.catchUp
        ? intl.formatMessage(
          { id: "notificationsPage.sentUpdatedKeys", defaultMessage: "Sent updated keys for {name}" },
          { name: invite.name },
        )
        : intl.formatMessage(
          { id: "notificationsPage.invitedYou", defaultMessage: "Invited you to {name}" },
          { name: invite.name },
        ),
      source: intl.formatMessage({ id: "notificationsPage.concordInvite", defaultMessage: "Concord invite" }),
    }));
    return [...pendingInvites, ...Object.values(sources).flat()]
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, 300);
  }, [invites, sources, intl]);

  const unreadCount = activity.reduce((count, item) => count + Number(item.unread), 0);
  const visible = filter === "unread" ? activity.filter((item) => item.unread) : activity;

  const openItem = (item: CenterItem) => {
    markRead(item.readKey, item.createdAt);
    navigate(item.route);
  };
  const markAllRead = () => {
    for (const item of activity) {
      if (item.unread) markRead(item.readKey, item.createdAt);
    }
  };

  return (
    <>
      <ServerRail />
      <main className="flex flex-1 min-w-0 flex-col safe-area-top h-full bg-background">
        {servers.map((relayUrl) => (
          <RelayNotificationSource key={relayUrl} relayUrl={relayUrl} report={report} />
        ))}
        {communities.map((entry) => (
          <ConcordNotificationSource key={entry.community_id} entry={entry} report={report} />
        ))}

        <div className="mx-auto flex w-full max-w-3xl flex-1 min-h-0 flex-col px-2 sm:px-4">
          <header className="relative mt-1 sidebar:mt-3 flex h-12 touch:h-[3.25rem] shrink-0 items-center gap-2 px-3 clip-corner-lg bg-chrome">
            <Bell className="size-5 shrink-0 text-muted-foreground" />
            <h1 className="min-w-0 truncate font-semibold">
              <FormattedMessage id="notificationsPage.title" defaultMessage="Notifications" />
            </h1>
            {unreadCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold leading-none text-primary-foreground">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1.5"
              disabled={unreadCount === 0}
              onClick={markAllRead}
            >
              <CheckCheck className="size-4" />
              <span className="hidden sm:inline">
                <FormattedMessage id="notificationsPage.markAllRead" defaultMessage="Mark all read" />
              </span>
            </Button>
          </header>

          <div className="mt-3 shrink-0">
            <PillTabs<"all" | "unread"> tabs={filters} value={filter} onChange={setFilter} />
          </div>

          <div className="mt-3 flex-1 min-h-0 overflow-y-auto pb-safe">
            {visible.length > 0 ? (
              <div className="space-y-1 pb-4">
                {visible.map((item) => <NotificationRow key={item.id} item={item} onOpen={openItem} />)}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-muted-foreground">
                <Bell className="size-10 opacity-40" />
                <p className="max-w-sm text-sm">
                  {filter === "unread"
                    ? <FormattedMessage id="notificationsPage.allCaughtUp" defaultMessage="You're all caught up." />
                    : (
                      <FormattedMessage
                        id="notificationsPage.empty"
                        defaultMessage="No notifications yet. Mentions and Concord invites will appear here."
                      />
                    )}
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

export default NotificationsPage;
