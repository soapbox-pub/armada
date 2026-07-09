import { createContext } from "react";

import { APP_RELAYS, SEARCH_RELAYS } from "@/lib/platform";

import type { BlossomServerMetadata } from "@/lib/blossom";
import type { RailLayoutNode } from "@/lib/railLayout";
import type { ThemeConfig, ThemesConfig } from "@/themes";

export type Theme = "light" | "dark" | "system" | "custom";

/**
 * Application configuration, persisted to localStorage by AppProvider.
 *
 * The server list is the user's own: relays are added by following an
 * invite/server link or via the "+" add flow (`addedRelays`). A deployment's
 * platform relay (VITE_PLATFORM_RELAYS) is infrastructure, not an auto-joined
 * community — it enters the rail the same way, via its invite/server link,
 * unless an operator opts into pinning it (VITE_PIN_PLATFORM_RELAYS).
 */
export interface AppConfig {
  /** Display theme mode. */
  theme: Theme;
  /**
   * Custom theme colors, used when `theme === "custom"` (set by named
   * presets or the in-app theme builder).
   */
  customTheme?: ThemeConfig;
  /**
   * Optional per-mode overrides for the builtin light/dark themes. When set,
   * these replace the builtin core colors for the respective mode.
   */
  themes?: ThemesConfig;
  /**
   * Relay (server) URLs the user added on top of the pinned platform relays.
   *
   * This is a fast/offline **cache** of the user's NIP-29 server list, which
   * lives canonically in their kind 10009 event (`r` tags, NIP-51, NIP-44
   * encrypted to self). NostrSync hydrates this from the 10009 list on login;
   * AddDialog / ServerPage / Settings write through to both.
   */
  addedRelays: string[];
  /**
   * User-defined display order for the server rail, by relay URL. Covers both
   * pinned platform relays and user-added ones (the relay list itself does not
   * carry a rail order). Any server not listed here falls back to the default
   * order (pinned first, then added). Stored locally in app config.
   *
   * Legacy: superseded by `railOrder` (which orders NIP-29 servers *and*
   * Concord communities as one unified list). Still written alongside
   * `railOrder` for backward compatibility.
   */
  serverOrder: string[];
  /**
   * User-defined display order for the *entire* community rail as one list —
   * NIP-29 servers and Concord (V1/V2) communities intermixed in any order.
   * Entries are stable rail keys: a relay URL for NIP-29 servers,
   * `c1:${communityId}` for Concord V1, `c2:${communityId}` for Concord V2.
   * Any item not listed falls back to its default position (appended in
   * discovery order). Stored locally in app config.
   */
  railOrder: string[];
  /**
   * The community rail's structured layout: an ordered list of items (by
   * stable rail key — relay URLs and `c1:`/`c2:` community keys) and
   * Discord-style folders grouping them. Supersedes `railOrder` (which is
   * still written as the flattened order for backward compatibility and the
   * QuickSwitcher). Synced across devices via the encrypted settings event.
   */
  railLayout: RailLayoutNode[];
  /**
   * Ids of rail folders currently expanded. Per-device UI state (like
   * Discord, folder open/closed state does not sync).
   */
  railOpenFolders: string[];
  /**
   * App relays for non-NIP-29 traffic (kind 0 profiles, kind 10009 lists,
   * etc.) — Ditto's "app relays" concept. Seeded from VITE_APP_RELAYS
   * (default: relay.ditto.pub + relay.dreamith.to); user-editable.
   * Group-scoped events never route here.
   */
  appRelays: string[];
  /**
   * Search relays for NIP-50 queries (`search` filters: profile/mention
   * autocomplete, etc.). Ditto hardcodes these (DITTO_RELAYS); here they are
   * user-editable. Seeded from VITE_SEARCH_RELAYS. When empty, search falls
   * back to the app relays.
   */
  searchRelays: string[];
  /**
   * Whether to use the user's own DM relays (`dmRelays`) instead of the
   * default app relays for direct messages. Off by default — DMs use the
   * app relay unless the user opts in.
   */
  useOwnDmRelays: boolean;
  /**
   * The user's custom direct-message relays, used only when
   * `useOwnDmRelays` is true. Seeded from the app relays.
   */
  dmRelays: string[];
  /**
   * The user's personal Blossom file server list (BUD-03), mirroring Ditto's
   * blossomServerMetadata. `servers` is synced bidirectionally with the
   * user's kind 10063 event (NostrSync pulls newer lists; Settings edits
   * publish). App default servers (APP_BLOSSOM_SERVERS) are managed
   * separately.
   */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * Whether to use the app default Blossom servers in addition to the user's
   * kind 10063 servers. Mirrors Ditto's useAppBlossomServers (and the
   * useOwnDmRelays toggle pattern). On by default.
   */
  useAppBlossomServers: boolean;
  /**
   * The last channel/room the user had open in each server/community, so we
   * can re-open it on return instead of dumping them on a channel list. Keyed
   * by `relayUrl` (NIP-29 servers, value = groupId) and by `c:${communityId}`
   * (Concord communities, value = channel id hex). Falls back to a "general"
   * channel or the first channel when there's no record.
   */
  lastChannelByServer: Record<string, string>;
  /**
   * Muted communities, by stable rail key: a relay URL for NIP-29 servers,
   * `c1:${communityId}` for Concord V1, `c2:${communityId}` for Concord V2.
   * Muting silences all notifications from every room in the community
   * (push, native background service) and suppresses its unread badge —
   * without leaving. Synced across devices.
   */
  mutedCommunities: string[];
  /**
   * Muted individual channels/rooms, by stable conversation key
   * (`${relayUrl}::${groupId}` for NIP-29 channels — the same key scheme as
   * the read state). Same effect as a community mute, scoped to one room.
   * Synced across devices.
   */
  mutedChannels: string[];
  /**
   * Bluetooth-mesh incognito mode. When on (the default), this device announces
   * a derived `anon<peerid>` nickname over the mesh rather than the user's
   * Armada display name — matching bitchat's anonymous-by-default behavior.
   * Toggling it off announces the real display name. Persisted per-device.
   */
  meshIncognito: boolean;
  /**
   * Whether Bluetooth mesh chat is turned on. OFF by default — starting the
   * mesh prompts for Bluetooth permissions and runs a foreground service with
   * a persistent notification, which must never happen without the user asking
   * for it. Enabled from the Mesh page; persisted per-device.
   */
  meshEnabled: boolean;
  /**
   * Preselected zap amount (sats) in the zap dialog. Synced across devices —
   * it's a preference, not a secret (wallet connections, by contrast, stay
   * strictly local; see WalletProvider).
   */
  defaultZapAmount: number;
}

export interface AppContextType {
  config: AppConfig;
  /** Merge a partial config and persist. */
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

/**
 * AppConfig fields that sync across devices via the encrypted NIP-78 settings
 * event. Everything here is cross-device meaningful; `meshEnabled` and
 * `meshIncognito` are deliberately excluded — they gate a per-device Bluetooth
 * foreground service and must never be flipped on remotely.
 */
export const SYNCED_CONFIG_KEYS = [
  "theme",
  "customTheme",
  "themes",
  "addedRelays",
  "serverOrder",
  "railOrder",
  "railLayout",
  "appRelays",
  "searchRelays",
  "useOwnDmRelays",
  "dmRelays",
  "blossomServerMetadata",
  "useAppBlossomServers",
  "lastChannelByServer",
  "mutedCommunities",
  "mutedChannels",
  "defaultZapAmount",
] as const satisfies ReadonlyArray<keyof AppConfig>;

export type SyncedConfigKey = (typeof SYNCED_CONFIG_KEYS)[number];

export const defaultConfig: AppConfig = {
  theme: "dark",
  addedRelays: [],
  serverOrder: [],
  railOrder: [],
  railLayout: [],
  railOpenFolders: [],
  appRelays: [...APP_RELAYS],
  searchRelays: [...SEARCH_RELAYS],
  useOwnDmRelays: false,
  dmRelays: [...APP_RELAYS],
  blossomServerMetadata: { servers: [], updatedAt: 0 },
  useAppBlossomServers: true,
  lastChannelByServer: {},
  mutedCommunities: [],
  mutedChannels: [],
  meshIncognito: true,
  meshEnabled: false,
  defaultZapAmount: 100,
};

export const AppContext = createContext<AppContextType | undefined>(undefined);

/**
 * The relays direct messages read from and write to. Defaults to the app
 * relays; switches to the user's own DM relays only when they opt in (and
 * have configured at least one). Falls back to the app relays if the custom
 * list is empty.
 */
export function effectiveDmRelays(config: AppConfig): string[] {
  if (config.useOwnDmRelays && config.dmRelays.length > 0) {
    return config.dmRelays;
  }
  return config.appRelays;
}
