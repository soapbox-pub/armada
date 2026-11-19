import { Hash, Lock, MessageCircle, MessagesSquare } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useNavigate } from "react-router-dom";

import { ChatContent } from "@/components/chat/ChatContent";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EventStoreContext } from "@/contexts/EventStoreContext";
import { useCommunity, useCommunityList } from "@/concord/hooks/useCommunityList";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { openedToStored, queryRumorsByIds } from "@/concord/lib/rumorStore";
import { useAuthor } from "@/hooks/useAuthor";
import { useIsBlocked } from "@/lib/blocklistStore";
import { shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { useLocalGroupMeta } from "@/hooks/useLocalGroupMeta";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";

import type { ComponentType, ReactNode } from "react";
import type { ChatRoute, Concord2Route, DmRoute, Nip29Route } from "@/lib/routes";
import type { NostrRumor } from "@/lib/nostrRumor";

interface ChatRouteEmbedProps {
  url: string;
  /** The parsed destination (see `parseSelfLink`). */
  route: ChatRoute;
  path: string;
  className?: string;
}

/**
 * In-app preview card for a link into this app, navigating via the router.
 * Resolved from LOCAL state only: destinations are encrypted or membership-
 * gated, so a network fetch would reveal nothing. DMs read the `main` store,
 * NIP-29 its relay tenant, Concord the community's own tenant.
 */
export function ChatRouteEmbed({ url, route, path, className }: ChatRouteEmbedProps) {
  switch (route.kind) {
    case "dm":
      return <DmRouteCard url={url} route={route} path={path} className={className} />;
    case "concord":
      return <ConcordRouteCard url={url} route={route} path={path} className={className} />;
    case "nip29":
      return <Nip29RouteCard url={url} route={route} path={path} className={className} />;
  }
}

/** `role="link"`, not `<a>`: no status-bar URL or "open in new tab". */
function RouteCardShell({
  url,
  path,
  className,
  children,
}: {
  url: string;
  path: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const open = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    navigate(path);
  };
  return (
    <div
      role="link"
      tabIndex={0}
      title={url}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e);
      }}
      className={cn(
        "block max-w-md w-full clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--background)/0.4] [--fill-hover:var(--secondary)/0.4] overflow-hidden cursor-pointer my-1.5",
        "focus:outline-none focus-visible:[--edge:var(--primary)]",
        className,
      )}
    >
      <div className="px-3 py-2 space-y-1 min-w-0">{children}</div>
    </div>
  );
}

function CardLabel({
  Icon,
  label,
}: {
  Icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground min-w-0">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </p>
  );
}

function PlaceRow({
  name,
  iconUrl,
  channel,
}: {
  name: string;
  iconUrl?: string | null;
  channel?: string;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Avatar className="size-5 clip-corner shrink-0">
        {iconUrl && <AvatarImage src={iconUrl} alt="" className="object-cover" />}
        <AvatarFallback className="clip-corner bg-primary/20 text-primary text-3xs">
          {name.trim().charAt(0).toUpperCase() || "·"}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-semibold truncate">{name}</span>
      {channel && <span className="text-xs text-muted-foreground truncate">· #{channel}</span>}
    </div>
  );
}

function MessageBody({ rumor }: { rumor: NostrRumor }) {
  return (
    <>
      <SenderRow rumor={rumor} />
      <ChatContent
        event={rumor}
        className="text-sm leading-relaxed"
        disableNoteEmbeds
        clampLines={3}
      />
    </>
  );
}

function SenderRow({ rumor }: { rumor: NostrRumor }) {
  const author = useAuthor(rumor.pubkey);
  const name = getDisplayName(author.data?.metadata, rumor.pubkey);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm font-semibold truncate"><DisplayName pubkey={rumor.pubkey} name={name} /></span>
      <span className="text-xs text-muted-foreground shrink-0">
        · {shortTimeAgo(rumor.created_at)}
      </span>
    </div>
  );
}

function NotCachedNote() {
  return (
    <p className="text-sm text-muted-foreground">
      <FormattedMessage id="chatRouteEmbed.notCached" defaultMessage="Open to load this message." />
    </p>
  );
}

function DmRouteCard({
  url,
  route,
  path,
  className,
}: {
  url: string;
  route: DmRoute;
  path: string;
  className?: string;
}) {
  const intl = useIntl();
  const rumor = useMainStoreRumor(route.messageId);
  return (
    <RouteCardShell url={url} path={path} className={className}>
      <CardLabel
        Icon={MessageCircle}
        label={
          route.messageId
            ? intl.formatMessage({ id: "chatRouteEmbed.directMessage", defaultMessage: "Direct message" })
            : intl.formatMessage({ id: "chatRouteEmbed.directMessages", defaultMessage: "Direct messages" })
        }
      />
      {rumor ? <MessageBody rumor={rumor} /> : route.messageId ? <NotCachedNote /> : null}
    </RouteCardShell>
  );
}

/**
 * NIP-17 plaintext from the `main` tenant. Nullable context: degrades instead
 * of throwing when mounted without providers.
 */
function useMainStoreRumor(id: string | undefined, relay?: string): NostrRumor | undefined {
  const storePromise = useContext(EventStoreContext);
  const { data } = useQuery<NostrRumor | null>({
    queryKey: ["self-link-rumor", id ?? "", relay ?? ""],
    enabled: !!storePromise && !!id,
    queryFn: async () => {
      const store = await storePromise!;
      const [found] = await store.query([{ ids: [id!], limit: 1 }], relay ? { relay } : undefined);
      return found ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });
  return data ?? undefined;
}

/**
 * Concord membership is possession of keys (kind-33302 vault), a local question.
 * Non-members see only that they aren't members. Assert non-membership only
 * once the list has resolved and decrypted (a pending remote signer looks empty).
 */
function ConcordRouteCard({
  url,
  route,
  path,
  className,
}: {
  url: string;
  route: Concord2Route;
  path: string;
  className?: string;
}) {
  const intl = useIntl();
  const isBlocked = useIsBlocked();
  const blocked = isBlocked(route.communityId);
  // A blocked community's stored name, icon and messages are never shown.
  const held = useCommunity(route.communityId);
  const community = blocked ? undefined : held;
  const { data: listData, isLoading: listLoading } = useCommunityList();
  const membershipResolved = Boolean(listData && !listData.decryptFailed && !listLoading);

  // `active: false`: a pasted link must not arm a control sweep.
  const { data: folded } = useControlFold(community, false);
  const channels = useChannels(community, false);
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);

  const targetId = route.messageId ?? route.threadRoot;
  const idHex = community?.idHex;
  const { data: rumor } = useQuery<NostrRumor | null>({
    queryKey: ["self-link-c2-rumor", idHex ?? "", targetId ?? ""],
    enabled: !!idHex && !!targetId,
    queryFn: async ({ signal }) => {
      const [found] = await queryRumorsByIds(idHex!, [targetId!], { signal });
      return found ? openedToStored(found) : null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const encryptedCommunity = intl.formatMessage({
    id: "chatRouteEmbed.encryptedCommunity",
    defaultMessage: "Encrypted community",
  });
  const label = route.messageId
    ? intl.formatMessage({ id: "chatRouteEmbed.communityMessage", defaultMessage: "Community message" })
    : route.channelId
      ? intl.formatMessage({ id: "chatRouteEmbed.communityChannel", defaultMessage: "Community channel" })
      : encryptedCommunity;

  if (!community) {
    return (
      <RouteCardShell url={url} path={path} className={className}>
        <CardLabel Icon={MessagesSquare} label={encryptedCommunity} />
        {blocked ? (
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="communityBlocked.title" defaultMessage="This community is unavailable in Armada" />
          </p>
        ) : membershipResolved ? (
          <div className="flex items-start gap-2 min-w-0 text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0" />
            <p className="text-sm">
              <FormattedMessage
                id="chatRouteEmbed.notMember"
                defaultMessage="You're not a member of this community, so it holds nothing you can read. Ask a member for an invite link."
              />
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="chatRouteEmbed.open" defaultMessage="Open" />
          </p>
        )}
      </RouteCardShell>
    );
  }

  const channelName = route.channelId
    ? channels.find((c) => c.idHex === route.channelId)?.name
    : undefined;

  return (
    <RouteCardShell url={url} path={path} className={className}>
      <CardLabel Icon={MessagesSquare} label={label} />
      <PlaceRow
        name={folded?.metadata?.name || community.name}
        iconUrl={iconUrl}
        channel={channelName}
      />
      {rumor ? <MessageBody rumor={rumor} /> : targetId ? <NotCachedNote /> : null}
    </RouteCardShell>
  );
}

/**
 * NIP-29 metadata (kind 39000) is plaintext, but read from the relay's own
 * tenant (see `relayScope.ts`) so a pasted link opens no socket.
 */
function Nip29RouteCard({
  url,
  route,
  path,
  className,
}: {
  url: string;
  route: Nip29Route;
  path: string;
  className?: string;
}) {
  const intl = useIntl();
  const group = useLocalGroupMeta(route.relayUrl, route.groupId);
  const rumor = useMainStoreRumor(route.messageId ?? route.threadRoot, route.relayUrl);

  let host = route.relayUrl;
  try {
    host = new URL(route.relayUrl).host;
  } catch {
    // parseChatRoute vetted the relay param; the host is a nicety only.
  }

  const label = route.messageId
    ? intl.formatMessage(
        { id: "chatRouteEmbed.groupMessageAt", defaultMessage: "Group message · {host}" },
        { host },
      )
    : route.groupId
      ? intl.formatMessage({ id: "chatRouteEmbed.groupAt", defaultMessage: "Group · {host}" }, { host })
      : intl.formatMessage({ id: "chatRouteEmbed.serverAt", defaultMessage: "Server · {host}" }, { host });

  return (
    <RouteCardShell url={url} path={path} className={className}>
      <CardLabel Icon={Hash} label={label} />
      {route.groupId && (
        <PlaceRow
          name={group?.name || route.groupId}
          iconUrl={sanitizeImageSrc(group?.picture)}
        />
      )}
      {rumor ? <MessageBody rumor={rumor} /> : route.messageId ? <NotCachedNote /> : null}
    </RouteCardShell>
  );
}
