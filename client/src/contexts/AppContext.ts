import { createContext } from "react";

import { APP_RELAYS, SEARCH_RELAYS } from "@/lib/platform";

import type { ThemeConfig, ThemesConfig } from "@/themes";

export type Theme = "light" | "dark" | "system" | "custom";

/**
 * Application configuration, persisted to localStorage by AppProvider.
 *
 * Armada is an internal-infrastructure tool: the base server list is pinned
 * at build time (VITE_PLATFORM_RELAYS) and users may extend it with
 * additional internal relay URLs.
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
   */
  serverOrder: string[];
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
   * The last channel/room the user had open in each server/community, so we
   * can re-open it on return instead of dumping them on a channel list. Keyed
   * by `relayUrl` (NIP-29 servers, value = groupId) and by `c:${communityId}`
   * (Concord communities, value = channel id hex). Falls back to a "general"
   * channel or the first channel when there's no record.
   */
  lastChannelByServer: Record<string, string>;
  /**
   * Bluetooth-mesh incognito mode. When on (the default), this device announces
   * a derived `anon<peerid>` nickname over the mesh rather than the user's
   * Armada display name — matching bitchat's anonymous-by-default behavior.
   * Toggling it off announces the real display name. Persisted per-device.
   */
  meshIncognito: boolean;
  /**
   * Private Bluetooth-mesh channels the user has created or joined, persisted
   * per-device. Each entry holds the shared channel key — the membership secret
   * — so anyone with this device can read/post that channel. The mesh has no
   * history replay, so this local list is the only record a channel exists.
   * Stored locally only (never synced to a relay): the keys must not leave the
   * device through the Nostr account.
   */
  meshChannels: import("@/lib/meshChannel").MeshChannel[];
}

export interface AppContextType {
  config: AppConfig;
  /** Merge a partial config and persist. */
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

export const defaultConfig: AppConfig = {
  theme: "dark",
  addedRelays: [],
  serverOrder: [],
  appRelays: [...APP_RELAYS],
  searchRelays: [...SEARCH_RELAYS],
  useOwnDmRelays: false,
  dmRelays: [...APP_RELAYS],
  lastChannelByServer: {},
  meshIncognito: true,
  meshChannels: [],
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
