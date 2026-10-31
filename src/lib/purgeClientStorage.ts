import { clearImageDims } from "@/components/chat/imageDims";
import { clearRevealedMedia } from "@/components/chat/revealedMedia";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { clearAudioMetadata } from "@/hooks/useAudioMetadata";
import { clearRecentDecrypts } from "@/lib/AppSigner";
import { clearCharacterCardCache } from "@/lib/characterCard";
import { ARMADA_DB_NAME, purgeArmadaDB } from "@/lib/db/armadaDB";
import { resetKvCaches } from "@/lib/db/kvCache";
import { resetDecryptConsent } from "@/lib/decryptConsent";
import { clearEvictedMediaMemory } from "@/lib/evictMessageMedia";
import { FONT_SCALE_KEY } from "@/lib/fontScale";
import { closeDmEphemeralSubs } from "@/lib/nip17/ephemeralInbox";
import { clearFoldedMemory } from "@/lib/foldedCache";
import { clearDeferredFoldMemory } from "@/concord/hooks/useDeferredFold";
import { clearIconThumbMemory } from "@/concord/lib/iconThumbs";
import { clearSightingsMemory } from "@/concord/lib/mediaTrust";
import { clearOutgoingMemory } from "@/concord/lib/outgoing";
import { clearOutgoingVerifyMemory } from "@/concord/lib/outgoingVerify";
import { clearPendingGuestbookJoinMemory } from "@/concord/lib/pendingGuestbookJoin";
import { clearPendingJoins } from "@/concord/lib/pendingJoins";
import { clearRumorStoreMemory } from "@/concord/lib/rumorStore";
import { clearCommunityListMemory } from "@/concord/hooks/useCommunityList";
import { clearControlPlaneMemory } from "@/concord/hooks/useControlPlane";
import { clearTimelineSnapshotMemory } from "@/concord/hooks/timelineSnapshot";
import { clearChannelSyncContexts } from "@/concord/lib/channelSync";
import { clearChatDecodeMemo } from "@/concord/lib/chat";
import { clearControlMemos } from "@/concord/lib/control";
import { clearGroupKeyMemory } from "@/concord/lib/groupKeyPersist";
import { clearStreamAuthRegistry } from "@/concord/lib/streamAuth";
import { clearBuzzMediaCache } from "@/buzz/media";
import { clearDm17SessionState } from "@/hooks/useDm17";
import { resetFrequentReactionsCache } from "@/hooks/useFrequentReactions";
import { clearMuteListMemos } from "@/hooks/useMuteList";
import { resetSettingsKeysAnnouncements } from "@/hooks/useSettingsKeys";
import { clearGroupListMemo } from "@/hooks/useUserGroupList";
import { clearAttachmentCache } from "@/lib/encryptedMedia";
import { clearMediaCacheMemory } from "@/lib/mediaCache";
import { closeAllNip46Transports } from "@/lib/nip46Transport";
import { PUSH_STATE_DB_NAME } from "@/lib/pushState";
import { clearDm17ThreadSnapshotMemory } from "@/lib/nip17/threadSnapshot";
import { clearSettingsRootMemory } from "@/lib/settingsRootStore";
import { clearProfileSyncMemory } from "@/sync/profileSync";
import { haltSyncManager } from "@/sync/syncManager";
import { clearShareShortcuts } from "@/lib/shareTarget";
import { writePushDisabledFlag } from "@/lib/swPushDisabled";
import { WEB_PUSH_RETIREMENT_KEY } from "@/lib/webPushEndpoint";
import { LOCALE_KEY } from "@/i18n/language";
import { STAGING_DIR as CALL_RECORDING_STAGING_DIR } from "@/lib/callRecording/protocol";

/**
 * localStorage keys that survive a purge. `armada:login` is mutated by
 * `removeLogin` in the same tick; wiping it here would race that and
 * resurrect a stale session.
 */
const PRESERVE_LOCAL_STORAGE_KEYS = new Set<string>([
  "armada:login",
  // The next account needs to know whether the old browser endpoint was retired.
  WEB_PUSH_RETIREMENT_KEY,
  // A device accessibility setting, not account data; the login screen needs it too.
  FONT_SCALE_KEY,
  // Likewise the interface language.
  LOCALE_KEY,
]);

/**
 * Pre-ArmadaDB databases. Upgraded installs may still hold them (undrained, with
 * decrypted data), so logout keeps deleting them.
 */
const RETIRED_DATABASES = [
  "armada-concord-cache",
  "armada-decrypt-cache",
  "armada-concord-invites",
  "armada-dm17-rumors",
  "armada-concord-rumors",
  "armada-events",
  "armada-relay-provenance",
  "armada-concord-pending",
];

/**
 * Remove the retired SQLite-WASM store's OPFS directory, still present on
 * upgraded devices, and any staged call recording (decrypted call audio).
 */
async function purgeOrphanedOpfs(): Promise<void> {
  for (const dir of [".armada-sqlite", CALL_RECORDING_STAGING_DIR]) {
    try {
      const root = await navigator.storage?.getDirectory?.();
      await root?.removeEntry(dir, { recursive: true });
    } catch {
      // best-effort — absent (the common case) or held open
    }
  }
}

/** Best-effort deletion of every IndexedDB database this origin owns. */
async function purgeIndexedDB(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    // `indexedDB.databases()` is unsupported on Firefox; fall back to known names.
    const known = [
      // Tenant DBs (`armada:t:<id>`) are deleted by `purgeArmadaDB`, which can close them first.
      `${ARMADA_DB_NAME}:kv`,
      PUSH_STATE_DB_NAME,
      ...RETIRED_DATABASES,
    ];
    const dbs =
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => Boolean(n))
        : known;
    await Promise.all(
      [...new Set([...dbs, ...known])].map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    // best-effort
  }
}

/** Best-effort deletion of every Cache Storage entry this origin owns. */
async function purgeCacheStorage(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // best-effort
  }
}

/** Wipe all Armada localStorage (everything except the preserved keys). */
function purgeLocalStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && !PRESERVE_LOCAL_STORAGE_KEYS.has(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

/** Session memos holding decrypted data or the account's keys; run before and after the purge. */
function clearSessionMemos(): void {
  clearStreamAuthRegistry();
  clearChannelSyncContexts();
  clearChatDecodeMemo();
  clearControlMemos();
  clearControlPlaneMemory();
  clearCommunityListMemory();
  clearTimelineSnapshotMemory();
  clearDm17ThreadSnapshotMemory();
  clearDm17SessionState();
  clearMuteListMemos();
  clearGroupListMemo();
  clearAttachmentCache();
  clearEvictedMediaMemory();
  clearCharacterCardCache();
  clearImageDims();
  clearMediaCacheMemory();
  clearBuzzMediaCache();
  clearProfileSyncMemory();
  resetFrequentReactionsCache();
  resetSettingsKeysAnnouncements();
}

/**
 * Purge all client-side persistence on logout (caches, decrypt cache, read
 * state, drafts, prefs, the push gateway's per-install client key, …).
 * `armada:login` is left to the caller's `removeLogin`.
 */
export async function purgeClientStorage(): Promise<void> {
  // Before anything is cleared: no sync round may decrypt or write past this point.
  haltSyncManager();
  // Latches group-key persistence off so no pending save rewrites
  // derived stream secrets into the store this purge empties.
  clearGroupKeyMemory();
  closeAllNip46Transports();
  clearSessionMemos();
  clearRenderedPlaintext();
  clearRecentDecrypts();
  clearFoldedMemory();
  clearRumorStoreMemory();
  clearDeferredFoldMemory();
  clearIconThumbMemory();
  clearAudioMetadata();
  clearPendingJoins();
  clearSightingsMemory();
  clearOutgoingMemory();
  clearOutgoingVerifyMemory();
  clearPendingGuestbookJoinMemory();
  clearRevealedMedia();
  // The settings root and every key derived from it.
  clearSettingsRootMemory();
  resetDecryptConsent();
  // Shared DM ephemeral REQs linger past their last consumer; close them.
  closeDmEphemeralSubs();
  // KV-backed caches hold in-memory copies that would otherwise leak into the next account.
  resetKvCaches();
  // Android share-sheet suggestions would keep naming the old account's rooms.
  // Not awaited: a rate-limitable system call nothing else depends on.
  void clearShareShortcuts();
  purgeLocalStorage();
  // ArmadaDB first: `deleteDatabase` is blocked by open connections.
  await purgeArmadaDB();
  await Promise.all([purgeIndexedDB(), purgeCacheStorage(), purgeOrphanedOpfs()]);
  // Recreate only the worker's kill switch, so a late push tears its endpoint
  // down instead of notifying a logged-out browser.
  await writePushDisabledFlag();
  // Again: in-flight warms/reads may have refilled caches from the old database.
  resetKvCaches();
  clearRecentDecrypts();
  clearFoldedMemory();
  clearRumorStoreMemory();
  clearIconThumbMemory();
  clearAudioMetadata();
  clearPendingJoins();
  clearSightingsMemory();
  clearOutgoingMemory();
  clearOutgoingVerifyMemory();
  clearPendingGuestbookJoinMemory();
  clearRevealedMedia();
  clearSettingsRootMemory();
  clearSessionMemos();
}
