/**
 * Hands the Web Push service worker what it needs to OPEN inlined encrypted
 * events: DM policy, known peers, own pubkey, the nsec (nsec logins only, while
 * push is enabled) and per-channel Concord stream keys. Written to
 * `pushState.ts` (workers can't read localStorage); missing/stale entries degrade to a
 * generic wake-up. Display data is read from ArmadaDB at push time instead,
 * with `profileRelays` asked for any profile the device has never stored.
 *
 * SECURITY: AES-GCM sealed under a non-extractable WebCrypto key
 * (swSecretVault), wiped by {@link clearSwPushConfig}. Concord keys are
 * per-epoch READ keys only — never the wrap-signing key. No XSS defense.
 */

import type { MediaPolicyConfig } from "@/lib/mediaPolicy";
import type { DmRequestLevel } from "@/lib/pushPrefs";
import { deletePushState, writePushState } from "@/lib/pushState";
import { clearVault, sealConfig } from "@/lib/swSecretVault";

/** Must match `PUSH_CONFIG_KEY` in `src/sw/worker.ts`. */
const PUSH_CONFIG_KEY = "dm-config";

/** One Concord channel's current stream as the worker needs it (mirrors `ConcordStream`). */
export interface SwConcordStream {
  /** Stream address (x-only pubkey hex) — equals the wrap's `pubkey`. */
  pk: string;
  /** NIP-44 conversation key (hex) that decrypts this stream's wraps. */
  convKey: string;
  /** Epoch (decimal string) the rumor's `epoch` binding tag must equal. */
  epoch: string;
  /** Community id (hex) — the deep link and the ArmadaDB tenant. */
  communityId: string;
  /** Channel id (hex) — the deep link and the rumor's `channel` binding tag. */
  channelId: string;
  /**
   * Community's banned authors (CORD-04). Their messages are stored but must
   * not notify, so the worker drops them after decrypt.
   */
  banned?: string[];
  /** Authors allowed to issue a literal @everyone in this channel. */
  mentionEveryoneAuthors?: string[];
  /** Any author's literal @everyone counts. */
  mentionEveryoneAnyone?: boolean;
  /** The Roles the viewer holds and who may ping any Role (CORD-04 §8). */
  roleMentions?: { id: string; name: string; anyone: boolean }[];
  roleMentionAuthors?: string[];
  /** The relays' clock minus this device's (CORD-03 §3). */
  clockOffsetMs?: number;
  /** Authors whose posts readers collapse (CORD-04 §8): no SEND here, or a Timeout by window. */
  sendDenied?: string[];
  /** In a restricted Channel, the only authors whose posts ring (CORD-03 §1); reactions aside. */
  postAuthors?: string[];
  timeouts?: { pk: string; fromSecs: number; until: number }[];
  /** The Nicknames members go by in this Community (CORD-04 §10), by pubkey. */
  nicknames?: Record<string, string>;
  /** Membership start (ms); anything sent earlier never notifies. */
  joinedAtMs?: number;
  /** Drop non-mention messages after decrypting this encrypted stream. */
  mentionOnly?: boolean;
  /**
   * Muted channel/community. A lingering gateway subscription can still wake the
   * device, so the key stays here for the worker to open and DROP the wrap
   * (the gateway is content-blind).
   */
  muted?: boolean;
}

export interface SwPushConfig {
  /** How to notify for DMs from unknown senders. */
  policy: DmRequestLevel;
  /** The viewer's own pubkey (hex) — to drop self-sent copies. */
  self: string;
  /** follows ∪ accepted ∪ pinned (hex) — the "known" senders. */
  knownPeers: string[];
  /** Exact authored/pinned NIP-17 conversation keys (groups stay exact). */
  knownConversations?: string[];
  /** Peers whose presence suppresses their whole DM conversation. */
  mutedPeers?: string[];
  /** Global DM fallback when a conversation has no explicit level. */
  directMessages?: boolean;
  /** Explicit per-conversation notification levels, keyed by canonical DM key. */
  dmLevels?: Record<string, "all" | "mentions" | "nothing">;
  /** Whether the DM plane was authoritative; explicit `false` suppresses it, omission = legacy ready. */
  dmReady?: boolean;
  /** Same as `dmReady`, for the Concord stream set. */
  concordReady?: boolean;
  /** Decrypt key (hex). Present for nsec logins only. */
  sk?: string;
  /** Current-epoch stream per watched channel (retired epochs must not notify). */
  concord?: SwConcordStream[];
  /** Media policy for avatar/icon fetches; absent = default policy. */
  mediaPolicy?: MediaPolicyConfig;
  /** The pool's general read relays, asked for a kind 0 missing from ArmadaDB. */
  profileRelays?: string[];
  /** The interface language, with its `notification.*` messages; absent = English. */
  locale?: string;
  messages?: Record<string, string>;
}

/**
 * Write the worker's push config, sealed at rest. The result gates lifting the
 * worker kill switch: no enforceable policy, no activation.
 */
export async function writeSwPushConfig(config: SwPushConfig): Promise<boolean> {
  try {
    await writePushState(PUSH_CONFIG_KEY, await sealConfig(config));
    return true;
  } catch {
    return false;
  }
}

/** Remove the config blob AND destroy its key. Called on disable/logout. */
export async function clearSwPushConfig(): Promise<void> {
  try {
    await deletePushState(PUSH_CONFIG_KEY);
  } catch {
    // ignore
  }
  // Destroy the key even if the delete failed, leaving any blob unreadable.
  await clearVault();
}
