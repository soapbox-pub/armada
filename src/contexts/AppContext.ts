import { createContext } from "react";

import { APP_RELAYS, BROADCAST_RELAYS, COMMUNITY_RELAYS, normalizeRelayUrl, SEARCH_RELAYS } from "@/lib/platform";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/pushPrefs";
import { getPreferredVoiceServer } from "@/lib/voiceDevices";

import type { FloodSensitivity } from "@/concord/lib/floodPolicy";
import type { MediaAutoload } from "@/concord/lib/mediaTrust";
import type { BlossomServerMetadata } from "@/lib/blossom";
import type { PaymentTargetType } from "@/lib/paymentTargets";
import type { RailLayoutNode } from "@/lib/railLayout";
import type { SendOnEnterPref } from "@/lib/sendOnEnter";
import type { ThemeConfig } from "@/themes";

export type Theme = "light" | "dark" | "system" | "custom";

/** The newest message that existed when a DM was closed from the sidebar. */
export interface ClosedDmMarker {
  eventId?: string;
  createdAt: number;
}

/**
 * How money amounts are displayed and entered: `"usd"` converts sats at the
 * current BTC price; `"sats"` shows raw sats (ported from Ditto).
 */
export type CurrencyDisplay = "usd" | "sats";

/**
 * The user's NIP-65 (kind 10002) relay list plus sync timestamp, with per-relay
 * `read`/`write` markers (bare `r` = both). Synced from kind 10002 by NostrSync;
 * merged into the pool only when `useUserRelays` is on.
 */
export interface RelayMetadata {
  relays: { url: string; read: boolean; write: boolean }[];
  updatedAt: number;
  /** Winning kind-10002 id, for NIP-01's lower-id same-second tiebreak. */
  eventId?: string;
  /** Owner of this replaceable list; absent only on pre-migration local data. */
  pubkey?: string;
}

/**
 * Application configuration, persisted to localStorage by AppProvider. Holds no
 * NIP-29 server list: that lives in the user's kind 10009 (`useNip29Servers`).
 */
export const REPLY_GESTURES = ["off", "swipe", "doubleTap", "both"] as const;
export type ReplyGestures = (typeof REPLY_GESTURES)[number];

export interface AppConfig {
  theme: Theme;
  /** Custom theme colors, used when `theme === "custom"`. */
  customTheme?: ThemeConfig;
  // Deliberately NO `addedRelays`: the kind 10009 event is the single source of
  // truth (a synced copy would resurrect removed servers).
  /**
   * The community rail's layout: ordered items (relay URLs, `c2:` / `dm:` keys) and
   * folders; unlisted items append via `mergeLayout`. The only field of the
   * `${APP_ID}/rail` document. The legacy `railOrder` is read once to seed it.
   */
  railLayout: RailLayoutNode[];
  /** Expanded rail folder ids. Per-device, not synced. */
  railOpenFolders: string[];
  /**
   * Collapsed channel categories, `communityIdHex` → casefolded category keys
   * (`channelCategory.ts`). Per-device. Keyed by name (categories have no ids), so
   * a rename un-collapses it.
   */
  collapsedChannelCategories: Record<string, string[]>;
  /**
   * Whether the desktop member-list panel is shown. `undefined` = per-device
   * default (shown on desktop, hidden on touch); an explicit choice is stored.
   * Per-device, not synced.
   */
  memberListVisible?: boolean;
  /** Desktop channel-list and member-list widths in px, dragged by the user. Per-device. */
  channelListWidth?: number;
  memberListWidth?: number;
  /**
   * App relays for non-NIP-29 traffic (profiles, lists…). Seeded from
   * APP_RELAYS; user-editable. Group-scoped events never route here.
   */
  appRelays: string[];
  /**
   * Write-only relays: everything `eventRouter` publishes also goes here, but
   * nothing is read from them (absent from every read set). Seeded from
   * BROADCAST_RELAYS; gated with the app relays by `useAppRelays`. Group and
   * Concord traffic never route here.
   */
  broadcastRelays: string[];
  /**
   * Home relays a NEW Concord community is minted on (create-dialog default).
   * Seeded from COMMUNITY_RELAYS (the CORD stock set unless a deployment
   * names its own `RELAYS`); emptied → falls back to `RESCUE_RELAYS`. Separate
   * from `appRelays` (account traffic).
   */
  communityRelays: string[];
  /** NIP-50 search relays (seeded from SEARCH_RELAYS); empty falls back to app relays. */
  searchRelays: string[];
  /** Host for starting empty Concord/DM voice calls; an account preference synced via NIP-78. */
  preferredVoiceServer: string;
  /**
   * Whether this install auto-syncs encrypted settings. Device-local, or one
   * client could toggle every other. Manual "Sync now" always works.
   */
  automaticSettingsSync: boolean;
  /**
   * Whether app relays join the general pool (default on). Off with no other
   * relays leaves the pool empty and account data unloadable. Joined NIP-29
   * servers aren't gated by this.
   */
  useAppRelays: boolean;
  /** Whether the user's NIP-65 relays join the general pool (default off, like Ditto). */
  useUserRelays: boolean;
  /**
   * The user's NIP-65 list, synced by NostrSync and edited only via the relay-list
   * editor. An empty/failed read never clears it.
   */
  relayMetadata: RelayMetadata;
  /** Mirror of the user's kind 10050 DM inbox; never app defaults. */
  dmRelays: string[];
  /**
   * Mirror of the user's kind 10063 Blossom list (BUD-03); empty means uploads
   * go to the app servers (`uploadTargets`).
   */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * Last open channel per server/community: `relayUrl` → groupId, `c:${communityId}`
   * → channel id hex.
   */
  lastChannelByServer: Record<string, string>;
  /**
   * Muted communities by rail key (relay URL or `c2:${communityId}`): silences
   * notifications and unread badges. Synced.
   */
  mutedCommunities: string[];
  /** Muted rooms by conversation key (`${relayUrl}::${groupId}`). Synced. */
  mutedChannels: string[];
  /**
   * Per-conversation notification level, keyed like the mute sets:
   *   - community: relay URL (NIP-29) or `c2:${communityId}`
   *   - NIP-29 channel: `${relayUrl}::${groupId}`
   *   - Concord channel: `c2:${communityId}::${channelIdHex}`
   *   - DM: `dm:${pubkey}`
   * Levels: `all`, `mentions` (DMs always count), `nothing` (legacy mutes
   * migrate here). Missing entries inherit channel → community → global prefs.
   * Supersedes the mute sets (still written for older clients and the push
   * gateway's `muted_groups`). Synced.
   */
  notifLevels: Record<string, "all" | "mentions" | "nothing">;
  /** Account-global notification categories, shared by every delivery path. */
  pushPrefs: PushPrefs;
  /**
   * Per-peer DM transport override, keyed `dm:${pubkey}`:
   *   - `auto` (default): NIP-17, NIP-04 only on explicit opt-in.
   *   - `nip17`: always NIP-17 (best-effort to shared relays without a 10050).
   *   - `nip04`: always legacy kind 4 (a deliberate privacy downgrade).
   * Synced.
   */
  dmProtocol: Record<string, "auto" | "nip17" | "nip04">;
  /**
   * Typing indicators everywhere — DMs (`useDmTyping`), Concord channels
   * (`useTyping`) and Buzz channels (`useBuzzTyping`) — default on. They reveal a
   * conversation is live right now; off stops sending AND receiving. Synced; the
   * key keeps its `dm` spelling so existing settings documents still apply.
   */
  dmTypingIndicators: boolean;
  /**
   * Turn DMs off entirely (default off). Drops every standing DM subscription by
   * emptying the DM relay set — saves bandwidth and refuses inbound at the network
   * level. Doesn't delete stored conversations or the 10050. Synced.
   */
  dmsDisabled: boolean;
  /** Pinned DM peers (hex pubkeys), shown in their own section; a set, order meaningless. Synced. */
  pinnedDms: string[];
  /**
   * DMs dismissed from the sidebar, keyed by peer pubkey. The marker identifies
   * the newest message present when the row was closed; any later/different
   * newest message makes the row visible again. Synced privately across devices.
   */
  closedDms: Record<string, ClosedDmMarker>;
  /**
   * DM peers let through the request tier (hex). Written when the user replies or
   * composes — writing IS accepting (see useAcceptedDms). Deliberately not the
   * public follow list. Sticky across unfollows. Synced.
   */
  acceptedDms: string[];
  /**
   * DM peers opened before any message exists (e.g. the `/<user>` chat link), so
   * the empty row survives navigating away. Closing hides it (`closedDms`). Capped
   * at {@link MAX_STARTED_DMS}, newest kept. Synced.
   */
  startedDms: string[];
  /**
   * Whether unknown-sender DMs appear in "Requests" (default on). Display only;
   * deep links still open the thread. Synced.
   */
  showDmRequests: boolean;
  /**
   * Whether DM list rows show the latest message's text (default on). Off also
   * keeps it out of the at-rest list snapshot and skips NIP-04 preview decrypts. Synced.
   */
  showDmPreviews: boolean;
  /**
   * Words and phrases whose messages are hidden from timelines, threads and
   * forum comments (whole-word, case-insensitive; never the user's own). Synced.
   */
  mutedWords: string[];
  /**
   * Whether the rail shows the recent-unread DM strip (capped at
   * {@link MAX_RAIL_RECENT_DMS}; default on). Display only. Synced.
   */
  showRecentRailDms: boolean;
  /**
   * Override for Discover's curated author source (`BUILD_DISCOVER_CURATION`):
   * an `naddr` list, an npub/hex (their follows), or `none`. Empty = build default. Synced.
   */
  discoverCuration: string;
  /**
   * Strip tracking parameters (`si=`, `fbclid`, `utm_*`…) from sent and rendered
   * links (default on); see `lib/trackingParams.ts`. Synced.
   */
     stripTrackingParams: boolean;
  /**
   * Media proxy templates for sender-named media (see `lib/mediaPolicy.ts`), so
   * hosts see the proxy's IP, not the viewer's. Ditto `corsProxy` convention:
   * `{href}` = percent-encoded URL, `{+href}` raw. Empty = off (default). The FIRST
   * is used by native writers and single-image sites; the web client spreads
   * across all with fallback. Synced.
   */
  mediaProxies: string[];
  /**
   * Whose images, videos and link previews load without a click in Concord
   * communities (`concord/lib/mediaTrust.ts`): `trusted` (default) holds media from
   * authors the reader has no reason to trust yet; held media is never fetched. Synced.
   */
  communityMediaAutoload: MediaAutoload;
  /**
   * Also hold community media hosted anywhere but the viewer's Blossom servers,
   * {@link trustedMediaHosts} and the built-in Nostr hosts (`lib/knownMediaHosts.ts`),
   * in every mode but `always`; a media proxy satisfies it. Default on. Synced.
   */
  communityMediaKnownHostsOnly: boolean;
  /** Hosts the viewer chose to load media from without asking ("Always load"). Synced. */
  trustedMediaHosts: string[];
  /**
   * Whether Enter sends (Shift+Enter = newline) versus Ctrl/Cmd+Enter. Keyed by
   * device CLASS and synced; unset = auto (sends on keyboards, newline on touch).
   * Resolve with `sendsOnEnter()`. Document editing always uses Ctrl/Cmd+Enter.
   */
  sendOnEnter?: SendOnEnterPref;
  /**
   * Whether hovering a message shows its action strip on desktop (default on).
   * Off, reactions and actions live in the right-click menu only. Synced.
   */
  messageHoverActions: boolean;
  /**
   * Touch reply gestures: swipe a message, double-tap it, both, or neither
   * (reply stays in the message's menu). Default swipe. Synced.
   */
  replyGestures: ReplyGestures;
  /**
   * Whether bursts of near-identical Concord messages fold into one expandable
   * "Similar messages" row (default on; `floodCluster.ts`). Off shows every
   * message; a community pause still collapses. Synced.
   */
  foldSimilarMessages: boolean;
  /** How readily that folding fires (`FloodSensitivity`, default standard). Synced. */
  spamSensitivity: FloodSensitivity;
  /** Never fold messages bridged from another network (NIP-48 `proxy`; default off). Synced. */
  spamExemptBridged: boolean;
  /** Whether message headers show the clock time instead of "2h" (default off). Synced. */
  absoluteTimestamps: boolean;
  /** Whether the rail shows the Discover button (default on). Display only; /discover still opens. Synced. */
  showDiscover: boolean;
  /**
   * Bluetooth-mesh incognito (default on): announce `anon<peerid>` instead of the
   * display name, like bitchat. Per-device.
   */
  meshIncognito: boolean;
  /**
   * Whether Bluetooth mesh is on (default off: it prompts for permissions and runs
   * a foreground service). Per-device.
   */
  meshEnabled: boolean;
  /**
   * Android back from a revealed list pane (default on): leave the app, as from
   * a root screen. Off walks history back through earlier chats. Per-device.
   */
  androidBackLeavesApp: boolean;
  /** Unit money amounts are shown/entered in. Synced (wallet connections stay local). */
  currencyDisplay: CurrencyDisplay;
  /**
   * Default zap method ('lightning', 'bitcoin', …); falls back if the recipient
   * doesn't accept it (pickDefaultZapMethod). 'bitcoin' default: every pubkey can
   * receive it. Synced.
   */
  defaultZapMethod: PaymentTargetType;
  /** Whether zap/wallet features are shown. Synced. */
  zapsEnabled: boolean;
  /** Whether Account Standing has been opened (clears the nag dot). Synced. */
  accountStandingSeen: boolean;
  /**
   * NIP-13 proof-of-work bits on every published event (`lib/pow.ts`). Unset =
   * the deployment's `POW_DIFFICULTY`. Per-device: what a phone can mine is not what a desktop can.
   */
  powDifficulty?: number;
}

/** Cap on message-less DM rows in {@link AppConfig.startedDms} (they ride in synced settings). */
export const MAX_STARTED_DMS = 50;

/**
 * Cap on the {@link ServerRail}'s recent-unread DM strip, so an active inbox
 * doesn't crowd out communities. Gated by {@link AppConfig.showRecentRailDms}.
 */
export const MAX_RAIL_RECENT_DMS = 3;

export interface AppContextType {
  config: AppConfig;
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

// AppConfig fields per encrypted NIP-78 settings document (see
// `lib/settingsDocs.ts`, `docs/settings-documents.md`). Unbounded or churny fields
// get their own document. Synced by NO document: mesh flags (per-device service),
// per-device UI/navigation state, and local mirrors of canonical list events
// (10007 / 10050 / 10002 / 10063).

/** `${APP_ID}/metadata` — bounded preferences, written when a user changes one. */
export const METADATA_CONFIG_KEYS = [
  "theme",
  "customTheme",
  "appRelays",
  "broadcastRelays",
  "communityRelays",
  "preferredVoiceServer",
  "useAppRelays",
  "useUserRelays",
  "dmTypingIndicators",
  "dmsDisabled",
  "showDmRequests",
  "showDmPreviews",
  "mutedWords",
  "showRecentRailDms",
  "discoverCuration",
  "stripTrackingParams",
  "mediaProxies",
  "communityMediaAutoload",
  "communityMediaKnownHostsOnly",
  "trustedMediaHosts",
  "sendOnEnter",
  "messageHoverActions",
  "replyGestures",
  "foldSimilarMessages",
  "spamSensitivity",
  "spamExemptBridged",
  "absoluteTimestamps",
  "showDiscover",
  "currencyDisplay",
  "defaultZapMethod",
  "zapsEnabled",
  "accountStandingSeen",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** `${APP_ID}/rail` — grows with every community; rewritten on every drag. */
export const RAIL_CONFIG_KEYS = ["railLayout"] as const satisfies ReadonlyArray<keyof AppConfig>;

/** `${APP_ID}/notifications` — one entry per conversation the user has tuned. */
export const NOTIF_CONFIG_KEYS = [
  "notifLevels",
  "mutedCommunities",
  "mutedChannels",
  "pushPrefs",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** `${APP_ID}/dms` — one entry per peer, in four maps that only ever grow. */
export const DM_CONFIG_KEYS = [
  "dmProtocol",
  "pinnedDms",
  "closedDms",
  "acceptedDms",
  "startedDms",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** Every synced AppConfig field, derived so it can't drift from the slices. */
export const SYNCED_CONFIG_KEYS = [
  ...METADATA_CONFIG_KEYS,
  ...RAIL_CONFIG_KEYS,
  ...NOTIF_CONFIG_KEYS,
  ...DM_CONFIG_KEYS,
] as const satisfies ReadonlyArray<keyof AppConfig>;
/** Local mirrors whose standard signed list events are the portable source. */
export const CANONICAL_LIST_CONFIG_KEYS = [
  "searchRelays",
  "dmRelays",
  "relayMetadata",
  "blossomServerMetadata",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** Deliberately device-specific config, never applied from another client. */
export const PER_DEVICE_CONFIG_KEYS = [
  "automaticSettingsSync",
  "railOpenFolders",
  "collapsedChannelCategories",
  "memberListVisible",
  "channelListWidth",
  "memberListWidth",
  "lastChannelByServer",
  "meshIncognito",
  "meshEnabled",
  "androidBackLeavesApp",
  "powDifficulty",
] as const satisfies ReadonlyArray<keyof AppConfig>;

export const defaultConfig: AppConfig = {
  theme: "dark",
  railLayout: [],
  railOpenFolders: [],
  collapsedChannelCategories: {},
  appRelays: [...APP_RELAYS],
  broadcastRelays: [...BROADCAST_RELAYS],
  communityRelays: [...COMMUNITY_RELAYS],
  searchRelays: [...SEARCH_RELAYS],
  preferredVoiceServer: getPreferredVoiceServer(),
  automaticSettingsSync: true,
  useAppRelays: true,
  useUserRelays: false,
  relayMetadata: { relays: [], updatedAt: 0 },
  dmRelays: [],
  blossomServerMetadata: { servers: [], updatedAt: 0 },
  lastChannelByServer: {},
  mutedCommunities: [],
  mutedChannels: [],
  notifLevels: {},
  // Account defaults must be pure: an origin-global mirror would leak between accounts.
  pushPrefs: { ...DEFAULT_PUSH_PREFS },
  dmProtocol: {},
  dmTypingIndicators: true,
  dmsDisabled: false,
  pinnedDms: [],
  closedDms: {},
  acceptedDms: [],
  startedDms: [],
  showDmRequests: true,
  showDmPreviews: true,
  mutedWords: [],
  showRecentRailDms: true,
  discoverCuration: "",
  stripTrackingParams: true,
  mediaProxies: [],
  communityMediaAutoload: "trusted",
  communityMediaKnownHostsOnly: true,
  trustedMediaHosts: [],
  messageHoverActions: true,
  replyGestures: "swipe",
  foldSimilarMessages: true,
  spamSensitivity: "standard",
  spamExemptBridged: false,
  absoluteTimestamps: false,
  showDiscover: true,
  meshIncognito: true,
  meshEnabled: false,
  androidBackLeavesApp: true,
  currencyDisplay: "usd",
  defaultZapMethod: "bitcoin",
  zapsEnabled: true,
  accountStandingSeen: false,
};

export const AppContext = createContext<AppContextType | undefined>(undefined);

/**
 * The DM relay set: the user's kind 10050 inbox plus the app relays (when
 * `useAppRelays`). Client-side only: app relays are never written into the
 * user's 10050; Armada senders also publish to their own set (useDm17), so
 * Armada↔Armada delivery works over shared app relays.
 */
export function effectiveDmRelays(config: AppConfig): string[] {
  const out = new Set<string>(config.dmRelays);
  if (config.useAppRelays) {
    for (const url of config.appRelays) out.add(url);
  }
  return [...out];
}

/**
 * Write-only relays the pool also publishes to (`broadcastRelays`), none when app
 * relays are off. Only for `NostrProvider`'s `poolWriteRelays`; the result must
 * never reach any read set — nothing may depend on a broadcast relay.
 */
export function broadcastWriteRelays(config: AppConfig): string[] {
  if (!config.useAppRelays) return [];
  const out = new Set<string>();
  for (const url of config.broadcastRelays) {
    const normalized = normalizeRelayUrl(url);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/**
 * The user's NIP-65 read relays for pool REQ routing, or none when
 * `useUserRelays` is off (app relays are added separately).
 */
export function userReadRelays(config: AppConfig, pubkey?: string): string[] {
  if (!config.useUserRelays) return [];
  if (pubkey && config.relayMetadata.pubkey && config.relayMetadata.pubkey !== pubkey) return [];
  return config.relayMetadata.relays.filter((r) => r.read).map((r) => r.url);
}

/** The user's NIP-65 write relays for pool EVENT routing; see `userReadRelays`. */
export function userWriteRelays(config: AppConfig, pubkey?: string): string[] {
  if (!config.useUserRelays) return [];
  if (pubkey && config.relayMetadata.pubkey && config.relayMetadata.pubkey !== pubkey) return [];
  return config.relayMetadata.relays.filter((r) => r.write).map((r) => r.url);
}

/**
 * The relays the pool reads general data such as profiles from: app relays
 * (unless off) plus the user's NIP-65 read and write relays. For readers
 * outside the pool, like the push worker.
 */
export function generalReadRelays(config: AppConfig, pubkey?: string): string[] {
  const urls = new Set<string>();
  const candidates = [
    ...(config.useAppRelays ? config.appRelays : []),
    ...userReadRelays(config, pubkey),
    ...userWriteRelays(config, pubkey),
  ];
  for (const url of candidates) {
    const normalized = normalizeRelayUrl(url);
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

/**
 * Relays holding the user's ACCOUNT-DATA singletons: app relays (unless off) plus
 * NIP-65 WRITE relays when `useUserRelays` is on. Excludes NIP-29 group relays:
 * `NPool.req` only EOSEs once every routed relay has, so one slow group relay would
 * make "list confirmed absent" unobservable.
 */
export function accountDataRelays(config: AppConfig, pubkey?: string): string[] {
  const urls = new Set<string>();
  if (config.useAppRelays) {
    for (const url of config.appRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
  }
  for (const url of userWriteRelays(config, pubkey)) {
    const normalized = normalizeRelayUrl(url);
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

/**
 * Relays carrying the user's portable self-state: the account-data set plus the
 * declared NIP-65 write relays even when `useUserRelays` is off, so settings
 * replication isn't severed. Also the live receive set.
 */
export function selfStateRelays(config: AppConfig, pubkey?: string): string[] {
  const urls = new Set(accountDataRelays(config, pubkey));
  // Strict attribution: an unstamped cached list may be a previous account's.
  // NostrSync stamps the owner on each kind-10002 hydrate.
  const ownsRelayList = !!pubkey && config.relayMetadata.pubkey === pubkey;
  if (ownsRelayList) {
    for (const relay of config.relayMetadata.relays) {
      if (!relay.write) continue;
      const normalized = normalizeRelayUrl(relay.url);
      if (normalized) urls.add(normalized);
    }
  }
  return [...urls];
}
