/**
 * Transport-agnostic model behind the quick switcher (Ctrl/Cmd+K) and Alt+↑/↓
 * channel hop. Each {@link Transport} (NIP-29, Concord) resolves spaces and
 * channels from local caches only — never the network — in rail order.
 */

import { matchPath } from "react-router-dom";

import { channelsView, visibleChannels } from "@/concord/lib/community";
import { replyTargetOf } from "@/concord/lib/chat";
import { rehydrateCommunity, type CommunityListEntry } from "@/concord/lib/communityList";
import { searchRumors } from "@/concord/lib/rumorStore";
import { readControlFold } from "@/concord/lib/control";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { dmRouteParam } from "@/lib/dmConversation";
import { searchDm17Rumors } from "@/lib/nip17/dm17Store";
import { dmConvKey, dmConvPeers } from "@/lib/nip17/conversation";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { chatRoute, parseChatRoute } from "@/lib/routes";

import type { QueryClient } from "@tanstack/react-query";
import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { relayInfoCache, type RelayInfoDocument, sanitizeRelayInfo } from "@/hooks/useRelayInfo";
import type { Nip29Group } from "@/lib/nip29";

/** A navigable space: a NIP-29 server or a Concord community. */
export interface SpaceEntry {
  /** Stable rail key: normalized relay URL (NIP-29) or `c2:<id>` (Concord). */
  key: string;
  name: string;
  route: string;
}

/** A navigable channel within some space. */
export interface ChannelEntry {
  /** Unique across the palette: `<spaceKey>::<channelId>`. */
  key: string;
  /** The channel's own id (NIP-29 group id / Concord `idHex`) — the route tail. */
  id: string;
  name: string;
  /** The parent space's display name, shown as a subtitle. */
  spaceName: string;
  route: string;
  /** Concord only: owning community id hex (rumor-store tenant). */
  communityIdHex?: string;
  /** NIP-29 only: hosting relay (event-store tenant; group ids are per-relay). */
  relayUrl?: string;
}

/** Everything the palette lists, in rail order. */
export interface SwitcherEntries {
  spaces: SpaceEntry[];
  channels: ChannelEntry[];
}

/** One existing DM conversation exposed as a launcher destination. */
export interface DmSwitcherEntry {
  /** Canonical participant-set key (`<peer>` for a 1:1, comma-joined for a group). */
  key: string;
  /** Everyone in the conversation except the viewer (`[self]` for Note to Self). */
  peers: string[];
  /** Canonical `/dm/<npub>[,<npub>...]` route. */
  route: string;
  /** Newest message time, or zero for a deliberately seeded empty conversation. */
  createdAt: number;
  /** Whether the viewer has authored a message in either DM transport. */
  mine: boolean;
}

/** The legacy kind-4 shape consumed by {@link buildDmSwitcherEntries}. */
export interface LegacyDmSwitcherSource {
  peer: string;
  latest: { id?: string; created_at: number };
  mine: boolean;
}

/** The NIP-17 shape consumed by {@link buildDmSwitcherEntries}. */
export interface Dm17SwitcherSource {
  key: string;
  peers: string[];
  latest: { rumorId: string; createdAt: number };
  mine: boolean;
}

/** Ambient reads a transport needs; both come straight from hooks in the view. */
export interface SwitcherContext {
  queryClient: QueryClient;
  /** community_id → live list entry (from `useLiveCommunities`). */
  communities: Map<string, CommunityListEntry>;
  /** The shared app event store (NIP-29 timelines + kind-0 profiles). */
  eventStore: EventStoreContextType;
  /** The viewer's pubkey — names the DM tenant to search. Absent: no DM hits. */
  self?: string;
}

/** The event store handle carried in {@link SwitcherContext} (see useEventStore). */
type EventStoreContextType = Promise<ArmadaEventStore>;

/** One switcher backend; local caches only (`channels` is async for Concord's IndexedDB fold). */
interface Transport {
  /** Whether this transport owns a given rail key. */
  owns(key: string): boolean;
  /** The space for a key, or null if it isn't resolvable yet (still loading). */
  space(key: string, ctx: SwitcherContext): SpaceEntry | null;
  /** The channels in a space, ordered exactly as the space's own view shows them. */
  channels(key: string, ctx: SwitcherContext): Promise<ChannelEntry[]>;
  /** Parse a router pathname into the space key + current channel id, if it's ours. */
  match(pathname: string): { key: string; channelId?: string } | null;
}

/**
 * Server display name from NIP-11 query cache, then persisted doc, else the
 * host. Never fetches or awaits: the switcher must open instantly.
 */
function serverName(queryClient: QueryClient, relayUrl: string): string {
  const cached = queryClient.getQueryData<RelayInfoDocument>(["relay-info", relayUrl]);
  if (cached?.name) return cached.name;
  const persisted = sanitizeRelayInfo(relayInfoCache.get(relayUrl));
  if (persisted?.name) return persisted.name;
  return relayUrl.replace(/^wss?:\/\//, "").replace(/\/$/, "");
}

/** Channels already loaded for a server (query cache only, no fetch). */
function cachedGroups(queryClient: QueryClient, relayUrl: string): Nip29Group[] {
  return queryClient.getQueryData<Nip29Group[]>(["nip29", "groups", relayUrl]) ?? [];
}

const nip29Transport: Transport = {
  owns: (key) => !key.startsWith("c2:"),
  space(key, { queryClient }) {
    return { key, name: serverName(queryClient, key), route: `/s/${relayToRouteParam(key)}` };
  },
  channels(key, { queryClient }) {
    const spaceName = serverName(queryClient, key);
    return Promise.resolve(
      cachedGroups(queryClient, key).map((g) => ({
        key: `${key}::${g.id}`,
        id: g.id,
        name: g.name,
        spaceName,
        route: `/s/${relayToRouteParam(key)}/${encodeURIComponent(g.id)}`,
        relayUrl: key,
      })),
    );
  },
  match(pathname) {
    const withGroup = matchPath("/s/:server/:groupId", pathname);
    const m = withGroup ?? matchPath("/s/:server", pathname);
    const serverParam = m?.params.server;
    if (!serverParam) return null;
    const relay = routeParamToRelay(serverParam);
    if (!relay) return null;
    return { key: relay, channelId: withGroup?.params.groupId };
  },
};

const concordKey = (id: string) => `c2:${id}`;

const concordTransport: Transport = {
  owns: (key) => key.startsWith("c2:"),
  space(key, { communities }) {
    const id = key.slice("c2:".length);
    const entry = communities.get(id);
    if (!entry) return null;
    return { key, name: entry.current.name, route: `/c/${encodeURIComponent(id)}` };
  },
  async channels(key, { communities, self }) {
    const id = key.slice("c2:".length);
    const entry = communities.get(id);
    if (!entry) return [];
    // Like `useChannels`, but from the persisted fold: no decrypt, no network.
    const community = rehydrateCommunity(entry);
    if (!community) return [];
    const folded = await readControlFold(id);
    // A Channel the viewer can't view isn't offered (CORD-04 §8).
    return visibleChannels(channelsView(community, folded), folded, self).map((c) => ({
      key: `${key}::${c.idHex}`,
      id: c.idHex,
      name: c.name,
      spaceName: entry.current.name,
      route: `/c/${encodeURIComponent(id)}/${encodeURIComponent(c.idHex)}`,
      communityIdHex: community.idHex,
    }));
  },
  match(pathname) {
    const withChannel = matchPath("/c/:communityId/:channelId", pathname);
    const m = withChannel ?? matchPath("/c/:communityId", pathname);
    const communityId = m?.params.communityId;
    if (!communityId) return null;
    return { key: concordKey(communityId), channelId: withChannel?.params.channelId };
  },
};

const TRANSPORTS: Transport[] = [nip29Transport, concordTransport];

function transportForKey(key: string): Transport | undefined {
  return TRANSPORTS.find((t) => t.owns(key));
}

/**
 * The live rail keys for both transports — NIP-29 relay URLs plus a `c2:<id>`
 * for every joined Concord community — to seed {@link mergeLayout}/order.
 */
export function switcherLiveKeys(
  nip29Servers: string[],
  communities: CommunityListEntry[],
): string[] {
  return [...nip29Servers, ...communities.map((c) => concordKey(c.community_id))];
}

/** Snapshot spaces + channels in rail order; `keys` is the flattened live rail layout. */
export async function buildSwitcherEntries(
  keys: string[],
  ctx: SwitcherContext,
): Promise<SwitcherEntries> {
  const resolved = keys
    .map((key) => ({ key, transport: transportForKey(key) }))
    .filter((r): r is { key: string; transport: Transport } => Boolean(r.transport));

  const spaces = resolved
    .map(({ key, transport }) => transport.space(key, ctx))
    .filter((s): s is SpaceEntry => s !== null);

  // Promise.all preserves order, so channels stay grouped by rail position.
  const channelLists = await Promise.all(
    resolved.map(({ key, transport }) => transport.channels(key, ctx)),
  );

  return { spaces, channels: channelLists.flat() };
}

/**
 * Merge both DM transports into launcher destinations, mirroring DMsPage: a
 * kind-4 row and NIP-17 1:1 with the same peer are one conversation, `mine` is
 * sticky, newest wins. `isKnown` filters request-tier strangers; started
 * conversations and Note to Self are kept without messages. Pins only order
 * existing rows (never resurrect from stale settings).
 */
export function buildDmSwitcherEntries(
  legacy: readonly LegacyDmSwitcherSource[],
  nip17: readonly Dm17SwitcherSource[],
  opts: {
    self?: string;
    pinned?: readonly string[];
    started?: readonly string[];
    isKnown?: (peer: string, mine: boolean) => boolean;
  } = {},
): DmSwitcherEntry[] {
  type Pending = Omit<DmSwitcherEntry, "route">;
  const byKey = new Map<string, Pending>();

  for (const row of legacy) {
    const current = byKey.get(row.peer);
    if (!current) {
      byKey.set(row.peer, {
        key: row.peer,
        peers: [row.peer],
        createdAt: row.latest.created_at,
        mine: row.mine,
      });
      continue;
    }
    current.mine ||= row.mine;
    if (row.latest.created_at > current.createdAt) {
      current.createdAt = row.latest.created_at;
      current.peers = [row.peer];
    }
  }

  for (const row of nip17) {
    const current = byKey.get(row.key);
    if (!current) {
      byKey.set(row.key, {
        key: row.key,
        peers: row.peers.slice(),
        createdAt: row.latest.createdAt,
        mine: row.mine,
      });
      continue;
    }
    current.mine ||= row.mine;
    // Legacy wins a timestamp tie, matching the DMs page's merge.
    if (row.latest.createdAt > current.createdAt) {
      current.createdAt = row.latest.createdAt;
      current.peers = row.peers.slice();
    }
  }

  const pinned = new Set(opts.pinned ?? []);
  const destinations = new Set(opts.started ?? []);
  if (opts.self) destinations.add(opts.self);
  const synthesized = new Set<string>();
  for (const key of destinations) {
    if (byKey.has(key)) continue;
    const peers = dmConvPeers(key);
    if (peers.length === 0) continue;
    byKey.set(key, { key, peers, createdAt: 0, mine: key === opts.self });
    synthesized.add(key);
  }

  const out: DmSwitcherEntry[] = [];
  for (const entry of byKey.values()) {
    // A started marker bypasses Requests only when it's the row's sole source.
    const deliberate = entry.key === opts.self || synthesized.has(entry.key);
    if (
      !deliberate &&
      opts.isKnown &&
      !entry.peers.every((peer) => opts.isKnown!(peer, entry.mine))
    ) {
      continue;
    }
    try {
      out.push({
        ...entry,
        route: chatRoute({ kind: "dm", peer: dmRouteParam(entry.key) }),
      });
    } catch {
      // Malformed synced key: drop the row rather than break Ctrl+K.
    }
  }

  return out.sort((a, b) => {
    const pinOrder = Number(pinned.has(b.key)) - Number(pinned.has(a.key));
    return pinOrder || b.createdAt - a.createdAt || a.key.localeCompare(b.key);
  });
}

/** Route for the previous/next channel (wrapping) in the current space, or null. */
export async function nextChannelRoute(
  pathname: string,
  dir: 1 | -1,
  ctx: SwitcherContext,
): Promise<string | null> {
  for (const transport of TRANSPORTS) {
    const m = transport.match(pathname);
    if (!m) continue;
    const channels = await transport.channels(m.key, ctx);
    if (channels.length === 0) return null;
    const idx = channels.findIndex((c) => c.id === m.channelId);
    const next =
      idx === -1
        ? dir === 1
          ? channels[0]
          : channels[channels.length - 1]
        : channels[(idx + dir + channels.length) % channels.length];
    return next.route;
  }
  return null;
}

// Message search is query-driven over the local, already-decrypted stores
// (never network or signer); hits map to routes via the palette's SwitcherEntries.

/**
 * A matched message. Identities are PUBKEYS; the view renders them through
 * `useAuthor`/{@link DisplayName}.
 */
export interface MessageEntry {
  /** Unique across the palette: `msg:<rumor/event id>`. */
  key: string;
  /** The matched message text (whitespace-collapsed for a one-line snippet). */
  content: string;
  /** Who said it (pubkey hex). The view resolves name + avatar via useAuthor. */
  authorPubkey: string;
  /** The channel/DM route to open. */
  route: string;
  /** `created_at` (seconds) — for the "when" label and newest-first ordering. */
  createdAt: number;
  /** Channel hits: `#channel · Space`. DM hits leave it unset and set {@link dmPeers}. */
  source?: string;
  /** Canonical DM participant-set key, when the hit is a direct message. */
  dmConversationKey?: string;
  /** DM participants (hex pubkeys), when the hit is a direct message. */
  dmPeers?: string[];
}

/** Add a message focus to a canonical route (thread roots only for rooms). */
export function focusMessageRoute(route: string, messageId: string, threadRoot?: string): string {
  const parsed = parseChatRoute(route);
  if (!parsed) return route;
  switch (parsed.kind) {
    case "concord":
      return chatRoute({ ...parsed, threadRoot, messageId });
    case "nip29":
      return chatRoute({ ...parsed, threadRoot, messageId });
    case "dm":
      return chatRoute({ ...parsed, messageId });
  }
}

/** NIP-29 timeline kinds whose content is searchable (chat + NIP-88 polls). */
const NIP29_MESSAGE_KINDS = [KIND_GROUP_CHAT, 1068];
/** Newest-first store scan cap per NIP-29 search (content isn't indexed). */
const NIP29_SCAN_LIMIT = 2000;
/** Per-corpus match cap before the merged newest-first slice to `limit`. */
const PER_CORPUS_LIMIT = 40;

/** Collapse whitespace/newlines into a single-line snippet. */
function snippet(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/** Concord chat matches, mapped back to their channel via the loaded entries. */
async function searchConcordMessages(
  needle: string,
  byId: Map<string, ChannelEntry>,
  signal?: AbortSignal,
): Promise<MessageEntry[]> {
  if (byId.size === 0) return [];

  // One search per community (each is its own rumor-store tenant), so
  // PER_CORPUS_LIMIT caps per community.
  const byCommunity = new Map<string, string[]>();
  for (const ch of byId.values()) {
    if (!ch.communityIdHex) continue;
    const bucket = byCommunity.get(ch.communityIdHex);
    if (bucket) bucket.push(ch.id);
    else byCommunity.set(ch.communityIdHex, [ch.id]);
  }

  const hits = (
    await Promise.all(
      [...byCommunity].map(([communityIdHex, ids]) =>
        searchRumors(communityIdHex, ids, { query: needle, limit: PER_CORPUS_LIMIT, signal }),
      ),
    )
  ).flat();

  const out: MessageEntry[] = [];
  for (const h of hits) {
    const ch = byId.get(h.channelIdHex);
    if (!ch) continue;
    out.push({
      key: `msg:${h.rumorId}`,
      content: snippet(h.content),
      authorPubkey: h.author,
      source: `${ch.name} · ${ch.spaceName}`,
      route: focusMessageRoute(ch.route, h.rumorId, replyTargetOf(h)),
      createdAt: h.createdAt,
    });
  }
  return out;
}

/** NIP-29 timeline matches: an indexed `#h` scan filtered by content in memory. */
async function searchNip29Messages(
  needle: string,
  byId: Map<string, ChannelEntry>,
  eventStore: EventStoreContextType,
  signal?: AbortSignal,
): Promise<MessageEntry[]> {
  if (byId.size === 0) return [];
  const store = await eventStore;

  // One scan per relay (per-relay tenants), so NIP29_SCAN_LIMIT caps per relay.
  const byRelay = new Map<string, string[]>();
  for (const ch of byId.values()) {
    if (!ch.relayUrl) continue;
    const bucket = byRelay.get(ch.relayUrl);
    if (bucket) bucket.push(ch.id);
    else byRelay.set(ch.relayUrl, [ch.id]);
  }

  const events = (
    await Promise.all(
      [...byRelay].map(([relay, ids]) =>
        store.query([{ kinds: NIP29_MESSAGE_KINDS, "#h": ids, limit: NIP29_SCAN_LIMIT }], {
          signal,
          relay,
        }),
      ),
    )
  ).flat();

  const out: MessageEntry[] = [];
  for (const ev of events) {
    if (!ev.content.toLowerCase().includes(needle)) continue;
    const ch = byId.get(ev.tags.find((t) => t[0] === "h")?.[1] ?? "");
    if (!ch) continue;
    out.push({
      key: `msg:${ev.id}`,
      content: snippet(ev.content),
      authorPubkey: ev.pubkey,
      source: `${ch.name} · ${ch.spaceName}`,
      route: focusMessageRoute(ch.route, ev.id),
      createdAt: ev.created_at,
    });
    if (out.length >= PER_CORPUS_LIMIT) break;
  }
  return out;
}

/** DM matches; the author and partner are resolved to names by the view. */
async function searchDmMessages(
  self: string,
  query: string,
  signal?: AbortSignal,
  allowedConversationKeys?: ReadonlySet<string>,
): Promise<MessageEntry[]> {
  const hits = await searchDm17Rumors(self, query, {
    limit: PER_CORPUS_LIMIT,
    signal,
    allowedConversationKeys,
  });
  return hits.map((h) => {
    const conversationKey = dmConvKey(h.peers);
    return {
      key: `msg:${h.rumorId}`,
      content: snippet(h.content),
      authorPubkey: h.author,
      dmConversationKey: conversationKey,
      dmPeers: h.peers,
      route: focusMessageRoute(
        chatRoute({ kind: "dm", peer: dmRouteParam(conversationKey) }),
        h.rumorId,
      ),
      createdAt: h.createdAt,
    };
  });
}

/**
 * Which corpora {@link searchSwitcherMessages} scans. Narrowing gives the whole
 * `limit` to the wanted kind.
 */
export type MessageScope = "all" | "channels" | "dms";

/**
 * Search on-device Concord, NIP-29 and DM history for `query`, newest-first,
 * capped at `limit`. Only the palette's loaded `channels` are searchable.
 */
export async function searchSwitcherMessages(
  query: string,
  channels: ChannelEntry[],
  ctx: SwitcherContext,
  opts: {
    limit?: number;
    scope?: MessageScope;
    signal?: AbortSignal;
    /** Inbox-visible DM keys; request/muted hits are discarded before limiting. */
    allowedDmConversationKeys?: ReadonlySet<string>;
  } = {},
): Promise<MessageEntry[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const limit = opts.limit ?? 30;
  const scope = opts.scope ?? "all";
  const wantChannels = scope !== "dms";
  const wantDms = scope !== "channels";

  const concordById = new Map<string, ChannelEntry>();
  const nip29ById = new Map<string, ChannelEntry>();
  for (const c of channels) {
    if (c.route.startsWith("/c/")) concordById.set(c.id, c);
    else if (c.route.startsWith("/s/")) nip29ById.set(c.id, c);
  }

  const searches: [Promise<MessageEntry[]>, Promise<MessageEntry[]>, Promise<MessageEntry[]>] = [
    wantChannels
      ? searchConcordMessages(needle, concordById, opts.signal)
      : Promise.resolve([]),
    wantChannels
      ? searchNip29Messages(needle, nip29ById, ctx.eventStore, opts.signal)
      : Promise.resolve([]),
    wantDms && ctx.self
      ? searchDmMessages(ctx.self, query, opts.signal, opts.allowedDmConversationKeys)
      : Promise.resolve([]),
  ];
  const [concord, nip29, dms] = await Promise.all(searches);
  const visibleDms = opts.allowedDmConversationKeys
    ? dms.filter(
        (message) =>
          !message.dmConversationKey ||
          opts.allowedDmConversationKeys!.has(message.dmConversationKey),
      )
    : dms;

  return [concord, nip29, visibleDms]
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
