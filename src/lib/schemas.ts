import { z } from "zod";

import { defaultConfig } from "@/contexts/AppContext";
import { PAYMENT_METHOD_LIST, type PaymentTargetType } from "@/lib/paymentTargets";
import { MAX_POW_DIFFICULTY } from "@/lib/pow";

import type { RailLayoutNode } from "@/lib/railLayout";

/** Zap method types from the payment-target registry; unknown stored values fall back via `.catch`. */
const PAYMENT_METHOD_TYPES = PAYMENT_METHOD_LIST.map((m) => m.type) as [
  PaymentTargetType,
  ...PaymentTargetType[],
];

/** An HSL string like "228 20% 10%". */
const HslStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/, "Expected an HSL string like '228 20% 10%'");

export const CoreThemeColorsSchema = z.object({
  background: HslStringSchema,
  text: HslStringSchema,
  primary: HslStringSchema,
});

export const ThemeBackgroundSchema = z.object({
  // Rendered only through the media policy; the parse layer (`sanitizeUrl`) already required https.
  url: z.url(),
  mode: z.enum(["cover", "tile"]).optional(),
  mimeType: z.string().optional(),
  dimensions: z.string().optional(),
  blurhash: z.string().optional(),
});

export const ThemeSourceSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  identifier: z.string().optional(),
});

export const ThemeFontSchema = z.object({
  family: z.string().min(1).max(100),
  url: z.url().optional(),
});

export const ThemeConfigSchema = z.object({
  title: z.string().optional(),
  colors: CoreThemeColorsSchema,
  // `.catch` so a bad optional field drops alone instead of the whole theme.
  font: ThemeFontSchema.optional().catch(undefined),
  titleFont: ThemeFontSchema.optional().catch(undefined),
  background: ThemeBackgroundSchema.optional().catch(undefined),
  source: ThemeSourceSchema.optional().catch(undefined),
});

/** The user's Blossom server list + kind 10063 sync timestamp (BUD-03). */
export const BlossomServerMetadataSchema = z.object({
  servers: z.array(z.string()),
  updatedAt: z.number(),
  eventId: z.string().optional(),
});

/** The user's NIP-65 relay list + kind 10002 sync timestamp. */
export const RelayMetadataSchema = z.object({
  relays: z.array(
    z.object({ url: z.string(), read: z.boolean(), write: z.boolean() }),
  ),
  updatedAt: z.number(),
  eventId: z.string().optional(),
  pubkey: z.string().optional(),
});

/** Account-global notification categories shared by every delivery path. */
export const PushPrefsSchema = z.object({
  mentions: z.boolean(),
  reactions: z.boolean(),
  replies: z.boolean(),
  directMessages: z.boolean(),
  allGroupMessages: z.boolean(),
  dmRequests: z.enum(["off", "generic", "full"]),
});

/** A rail layout node: an item or a folder. See lib/railLayout.ts. */
export const RailLayoutNodeSchema: z.ZodType<RailLayoutNode> = z.union([
  z.object({ type: z.literal("item"), key: z.string() }),
  z.object({
    type: z.literal("folder"),
    id: z.string(),
    name: z.string(),
    keys: z.array(z.string()),
  }),
]);

/** Quick-reaction frequency entry; `url` only for custom `:shortcode:` emoji. */
export const FrequentReactionSchema = z.object({
  key: z.string(),
  url: z.string().optional(),
  pickerId: z.string().optional(),
  count: z.number(),
  usedAt: z.number(),
});

const ClosedDmMarkerSchema = z.object({
  eventId: z.string().optional(),
  createdAt: z.number(),
});

/** Send-on-Enter override, keyed by device class (see AppConfig.sendOnEnter). */
const SendOnEnterSchema = z.object({
  touch: z.boolean().optional(),
  desktop: z.boolean().optional(),
});

/** NIP-13 difficulty in bits (see `lib/pow.ts`). */
const PowDifficultySchema = z.number().int().min(0).max(MAX_POW_DIFFICULTY);

/** Persisted AppConfig, validated field-by-field so one corrupt key never wipes the config. */
export const AppConfigSchema = z.object({
  theme: z.enum(["light", "dark", "system", "custom"]).catch("dark"),
  customTheme: ThemeConfigSchema.optional().catch(undefined),
  railLayout: z.array(RailLayoutNodeSchema).catch([]),
  railOpenFolders: z.array(z.string()).catch([]),
  collapsedChannelCategories: z.record(z.string(), z.array(z.string())).catch({}),
  memberListVisible: z.boolean().optional().catch(undefined),
  channelListWidth: z.number().optional().catch(undefined),
  memberListWidth: z.number().optional().catch(undefined),
  appRelays: z.array(z.string()).catch(defaultConfig.appRelays),
  broadcastRelays: z.array(z.string()).catch(defaultConfig.broadcastRelays),
  communityRelays: z.array(z.string()).catch(defaultConfig.communityRelays),
  searchRelays: z.array(z.string()).catch(defaultConfig.searchRelays),
  preferredVoiceServer: z.string().catch(defaultConfig.preferredVoiceServer),
  automaticSettingsSync: z.boolean().catch(defaultConfig.automaticSettingsSync),
  useAppRelays: z.boolean().catch(defaultConfig.useAppRelays),
  useUserRelays: z.boolean().catch(defaultConfig.useUserRelays),
  relayMetadata: RelayMetadataSchema.catch(defaultConfig.relayMetadata),
  dmRelays: z.array(z.string()).catch(defaultConfig.dmRelays),
  blossomServerMetadata: BlossomServerMetadataSchema.catch(defaultConfig.blossomServerMetadata),
  lastChannelByServer: z.record(z.string(), z.string()).catch({}),
  mutedCommunities: z.array(z.string()).catch([]),
  mutedChannels: z.array(z.string()).catch([]),
  notifLevels: z.record(z.string(), z.enum(["all", "mentions", "nothing"])).catch({}),
  pushPrefs: PushPrefsSchema.catch(defaultConfig.pushPrefs),
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).catch({}),
  dmTypingIndicators: z.boolean().catch(defaultConfig.dmTypingIndicators),
  dmsDisabled: z.boolean().catch(defaultConfig.dmsDisabled),
  pinnedDms: z.array(z.string()).catch([]),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).catch({}),
  acceptedDms: z.array(z.string()).catch([]),
  startedDms: z.array(z.string()).catch([]),
  showDmRequests: z.boolean().catch(defaultConfig.showDmRequests),
  showDmPreviews: z.boolean().catch(defaultConfig.showDmPreviews),
  mutedWords: z.array(z.string()).catch([]),
  showRecentRailDms: z.boolean().catch(defaultConfig.showRecentRailDms),
  discoverAllContent: z.boolean().catch(defaultConfig.discoverAllContent),
  discoverCuration: z.string().catch(defaultConfig.discoverCuration),
  stripTrackingParams: z.boolean().catch(defaultConfig.stripTrackingParams),
  mediaProxies: z.array(z.string()).catch(defaultConfig.mediaProxies),
  communityMediaAutoload: z.enum(["always", "trusted", "never"]).catch(defaultConfig.communityMediaAutoload),
  communityMediaKnownHostsOnly: z.boolean().catch(defaultConfig.communityMediaKnownHostsOnly),
  trustedMediaHosts: z.array(z.string()).catch(defaultConfig.trustedMediaHosts),
  sendOnEnter: SendOnEnterSchema.optional().catch(undefined),
  messageHoverActions: z.boolean().catch(defaultConfig.messageHoverActions),
  replyGestures: z.boolean().catch(defaultConfig.replyGestures),
  foldSimilarMessages: z.boolean().catch(defaultConfig.foldSimilarMessages),
  absoluteTimestamps: z.boolean().catch(defaultConfig.absoluteTimestamps),
  showDiscover: z.boolean().catch(defaultConfig.showDiscover),
  currencyDisplay: z.enum(["usd", "sats"]).catch(defaultConfig.currencyDisplay),
  defaultZapMethod: z.enum(PAYMENT_METHOD_TYPES).catch(defaultConfig.defaultZapMethod),
  zapsEnabled: z.boolean().catch(defaultConfig.zapsEnabled),
  accountStandingSeen: z.boolean().catch(defaultConfig.accountStandingSeen),
  powDifficulty: PowDifficultySchema.optional().catch(undefined),
  meshIncognito: z.boolean().catch(defaultConfig.meshIncognito),
  meshEnabled: z.boolean().catch(defaultConfig.meshEnabled),
  androidBackLeavesApp: z.boolean().catch(defaultConfig.androidBackLeavesApp),
});

// Encrypted NIP-78 settings documents: one kind-30078 per domain, NIP-44 to self
// (see `lib/settingsDocs.ts`, `docs/settings-documents.md`). All schemas are
// LOOSE so unknown keys from newer builds survive read-modify-write.

/** Per-conversation notification level (all/mentions/nothing) — see AppConfig. */
const NotifLevelsSchema = z.record(z.string(), z.enum(["all", "mentions", "nothing"]));
/** Per-conversation last-read timestamps (unix seconds), keyed by conversation id. */
const ReadStateMapSchema = z.record(z.string(), z.number());

/** `${APP_ID}/metadata`: bounded preferences. Anything that grows lives in its own document. */
export const MetadataDocSchema = z.looseObject({
  theme: z.enum(["light", "dark", "system", "custom"]).optional(),
  customTheme: ThemeConfigSchema.optional(),
  appRelays: z.array(z.string()).optional(),
  /** Write-only relays for general pool publishes. */
  broadcastRelays: z.array(z.string()).optional(),
  /** Default home relays for newly created Concord communities. */
  communityRelays: z.array(z.string()).optional(),
  preferredVoiceServer: z.string().optional(),
  /** Whether app relays are in the general pool (foot-gun when off). */
  useAppRelays: z.boolean().optional(),
  useUserRelays: z.boolean().optional(),
  dmTypingIndicators: z.boolean().optional(),
  dmsDisabled: z.boolean().optional(),
  showDmRequests: z.boolean().optional(),
  showDmPreviews: z.boolean().optional(),
  mutedWords: z.array(z.string()).optional(),
  showRecentRailDms: z.boolean().optional(),
  discoverAllContent: z.boolean().optional(),
  discoverCuration: z.string().optional(),
  stripTrackingParams: z.boolean().optional(),
  /** Media proxy templates; empty = off. */
  mediaProxies: z.array(z.string()).optional(),
  /** Whose media loads without a click in Concord communities. */
  communityMediaAutoload: z.enum(["always", "trusted", "never"]).optional(),
  /** Also hold media from hosts outside the viewer's Blossom servers and known Nostr hosts. */
  communityMediaKnownHostsOnly: z.boolean().optional(),
  /** Hosts whose community media loads without asking. */
  trustedMediaHosts: z.array(z.string()).optional(),
  sendOnEnter: SendOnEnterSchema.optional(),
  /** Desktop hover action strip on messages. */
  messageHoverActions: z.boolean().optional(),
  /** Swipe (touch) / double-click (desktop) to reply. */
  replyGestures: z.boolean().optional(),
  /** Fold near-identical Concord bursts into "Similar messages". */
  foldSimilarMessages: z.boolean().optional(),
  /** Clock time instead of relative time in message headers. */
  absoluteTimestamps: z.boolean().optional(),
  /** The rail's Discover button. */
  showDiscover: z.boolean().optional(),
  currencyDisplay: z.enum(["usd", "sats"]).optional(),
  defaultZapMethod: z.enum(PAYMENT_METHOD_TYPES).optional(),
  zapsEnabled: z.boolean().optional(),
  accountStandingSeen: z.boolean().optional(),

  // Read-only legacy: `addedRelays`, `themes` and `lastChannelByServer` may remain
  // in older blobs; the loose schema passes them through and they're ignored.

  /**
   * Local mirrors of kinds 10007, 10050, 10002, 10063, written only by
   * pre-migration clients; read once by `useInitialSync` as a rescue. Never written.
   */
  searchRelays: z.array(z.string()).optional(),
  dmRelays: z.array(z.string()).optional(),
  relayMetadata: RelayMetadataSchema.optional(),
  blossomServerMetadata: BlossomServerMetadataSchema.optional(),

  /**
   * Fields moved to their own documents, still READ from older builds (see
   * `resolveLegacy` in `lib/settingsDocs.ts`). Stripped on every write, so their
   * presence proves an older build wrote this.
   */
  railOrder: z.array(z.string()).optional(),
  railLayout: z.array(RailLayoutNodeSchema).optional(),
  notifLevels: NotifLevelsSchema.optional(),
  mutedCommunities: z.array(z.string()).optional(),
  mutedChannels: z.array(z.string()).optional(),
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).optional(),
  pinnedDms: z.array(z.string()).optional(),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).optional(),
  acceptedDms: z.array(z.string()).optional(),
  startedDms: z.array(z.string()).optional(),
  frequentReactions: z.array(FrequentReactionSchema).optional(),
  readState: ReadStateMapSchema.optional(),

  /** ms timestamp of the last write, emitted only here: older builds order versions by it, not `created_at`. */
  lastSync: z.number().optional(),
});

/**
 * `${APP_ID}/rail`: the rail arrangement. The superseded flat `railOrder` is
 * read from legacy metadata only to seed a missing layout.
 */
export const RailDocSchema = z.looseObject({
  railLayout: z.array(RailLayoutNodeSchema).optional(),
});

/**
 * `${APP_ID}/read-state`: last-read timestamps by conversation id (e.g.
 * `${relayUrl}::${groupId}`, `dm:${pubkey}`). Unbounded but never pruned (a
 * dropped entry reads as all-unread). Merged per key, max wins.
 */
export const ReadStateDocSchema = z.looseObject({
  readState: ReadStateMapSchema.optional(),
});

/**
 * `${APP_ID}/notifications`: per-conversation levels. Legacy `mutedCommunities`/
 * `mutedChannels` are written in lockstep for older clients and the push
 * gateway. Replaced wholesale so clearing propagates.
 */
export const NotificationsDocSchema = z.looseObject({
  notifLevels: NotifLevelsSchema.optional(),
  mutedCommunities: z.array(z.string()).optional(),
  mutedChannels: z.array(z.string()).optional(),
  pushPrefs: PushPrefsSchema.optional(),
});

/**
 * `${APP_ID}/dms`: per-peer DM state. Additive maps (`closedDms`, `pinnedDms`,
 * `acceptedDms`, `startedDms`) are UNIONED on apply (`mergeDmMaps` in
 * `syncedConfig.ts`) so a stale device can't wipe another's edits; removals are
 * best-effort. `dmProtocol` is wholesale.
 */
export const DmsDocSchema = z.looseObject({
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).optional(),
  pinnedDms: z.array(z.string()).optional(),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).optional(),
  acceptedDms: z.array(z.string()).optional(),
  startedDms: z.array(z.string()).optional(),
});

/** `${APP_ID}/reactions`: quick-reaction frequencies (≤32), merged per key so devices don't reset each other. */
export const ReactionsDocSchema = z.looseObject({
  frequentReactions: z.array(FrequentReactionSchema).optional(),
});

export type MetadataDoc = z.infer<typeof MetadataDocSchema>;
