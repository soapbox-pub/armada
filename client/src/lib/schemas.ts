import { z } from "zod";

import { defaultConfig } from "@/contexts/AppContext";

/** An HSL string like "228 20% 10%". */
const HslStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/, "Expected an HSL string like '228 20% 10%'");

export const CoreThemeColorsSchema = z.object({
  background: HslStringSchema,
  text: HslStringSchema,
  primary: HslStringSchema,
});

export const ThemeConfigSchema = z.object({
  title: z.string().optional(),
  colors: CoreThemeColorsSchema,
});

export const ThemesConfigSchema = z.object({
  light: ThemeConfigSchema,
  dark: ThemeConfigSchema,
});

/**
 * Validates the persisted AppConfig. Used field-by-field in AppProvider so a
 * single corrupt key never wipes the entire config.
 */
export const AppConfigSchema = z.object({
  theme: z.enum(["light", "dark", "system", "custom"]).catch("dark"),
  customTheme: ThemeConfigSchema.optional().catch(undefined),
  themes: ThemesConfigSchema.optional().catch(undefined),
  addedRelays: z.array(z.string()).catch([]),
  serverOrder: z.array(z.string()).catch([]),
  appRelays: z.array(z.string()).catch(defaultConfig.appRelays),
  searchRelays: z.array(z.string()).catch(defaultConfig.searchRelays),
  useOwnDmRelays: z.boolean().catch(defaultConfig.useOwnDmRelays),
  dmRelays: z.array(z.string()).catch(defaultConfig.dmRelays),
  lastChannelByServer: z.record(z.string(), z.string()).catch({}),
  meshIncognito: z.boolean().catch(defaultConfig.meshIncognito),
  meshChannels: z
    .array(
      z.object({
        id: z.string(),
        key: z.string(),
        name: z.string(),
        color: z.string(),
        createdAt: z.number(),
      }),
    )
    .catch([]),
});

/**
 * Encrypted app settings synced across devices via a NIP-78 (kind 30078)
 * event, NIP-44-encrypted to self. A loose object so unknown future keys are
 * preserved rather than rejected.
 */
export const EncryptedSettingsSchema = z.looseObject({
  theme: z.enum(["light", "dark", "system", "custom"]).optional(),
  customTheme: ThemeConfigSchema.optional(),
  themes: ThemesConfigSchema.optional(),
  /** General-purpose app relays. */
  appRelays: z.array(z.string()).optional(),
  /** NIP-50 search relays. */
  searchRelays: z.array(z.string()).optional(),
  /** Whether DMs use the user's own relays instead of the app relays. */
  useOwnDmRelays: z.boolean().optional(),
  /** The user's custom DM relays. */
  dmRelays: z.array(z.string()).optional(),
  /**
   * Per-conversation last-read timestamps (unix seconds), keyed by a stable
   * conversation id (e.g. `${relayUrl}::${groupId}` for channels, `dm:${pubkey}`
   * for direct messages). Drives unread/mention badges across devices.
   */
  readState: z.record(z.string(), z.number()).optional(),
  /** ms timestamp of the last write, used to resolve sync conflicts. */
  lastSync: z.number().optional(),
});

export type EncryptedSettings = z.infer<typeof EncryptedSettingsSchema>;
