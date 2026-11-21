import { useCallback, useEffect, useReducer, useRef } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";
import { hasMigratedKeys, resolveLegacy } from "@/lib/settingsDocs";
import {
  markNotificationSettingsReady,
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";
import {
  configSnapshot,
  docToConfigPatch,
  notificationsDocFields,
  type ConfigDocName,
} from "@/lib/syncedConfig";

import type { AppConfig } from "@/contexts/AppContext";

/** Debounce for pushing local config changes to a NIP-78 settings document. */
const PUBLISH_DEBOUNCE_MS = 800;
/** Retry a durable local settings edit whose relay delivery failed. */
const PUBLISH_RETRY_MS = 5_000;
/** Cap for the doubling retry delay (each attempt is a fresh signed event). */
const PUBLISH_RETRY_MAX_MS = 5 * 60_000;

/**
 * Publish baselines of mounted {@link useConfigDocSync} instances, by document.
 * {@link markConfigSynced} lets NostrSync's list hydration (10002/10050/10063
 * mirrors) move baselines so it isn't broadcast as a user edit. Module-scoped
 * because those effects are siblings, not children.
 */
const publishBaselines = new Map<ConfigDocName, (config: AppConfig) => void>();

/** Record `config` as synced so the next diff doesn't treat it as a user edit (no-op before a baseline). */
export function markConfigSynced(config: AppConfig): void {
  for (const bump of publishBaselines.values()) bump(config);
}

/**
 * Keep one AppConfig slice and its encrypted NIP-78 document in sync both ways
 * (see `lib/syncedConfig.ts`). One instance per document, each with its own
 * applied-id guard, baseline and debounce.
 *
 * IN: apply each version once by event id; the store already keeps only the
 * newest (the legacy metadata document is handled by `resolveLegacy`).
 *
 * OUT: push only DIRECT user edits — the only automatic settings broadcast.
 * Boot/sync-driven changes keep `lastPublished` in lockstep.
 */
export function useConfigDocSync(name: ConfigDocName): void {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const { doc, event, isFetched, update, hasNip44Support } = useSettingsDoc(name);
  const notificationPolicyReady = useNotificationSettingsReady(user?.pubkey);
  const metadata = useSettingsDoc("metadata");
  const configRef = useRef(config);
  configRef.current = config;
  const [, recheckAfterPublish] = useReducer((value: number) => value + 1, 0);

  // The version we've most recently folded into local config.
  const appliedId = useRef<string | undefined>(undefined);
  // Its created_at, to refuse OLDER versions: the query cache can regress (a stale
  // refetch), and applying one would revert the newest edit for good.
  const appliedCreatedAt = useRef<number | undefined>(undefined);
  // Slice last known to match the remote document (skips no-op publishes).
  const lastPublished = useRef<string | undefined>(undefined);
  // Slice as the newest apply left it, for the notification readiness check.
  const appliedSnapshot = useRef<string | undefined>(undefined);
  // Pending debounced publish: non-null means a local edit is newer than disk.
  // Clearing the timeout must clear the ref too.
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Publishes past debounce but unsettled (seconds on NIP-46), during which a stale
  // version must not be applied. A counter balanced in `finally`, never reset;
  // stale completions are ignored via `accountGeneration`.
  const publishesInFlight = useRef(0);
  // Hold the notification document's event id until config has rendered it, so
  // background delivery never sees defaults as authority.
  const notificationApplyPending = useRef<string | undefined>(undefined);
  const accountGeneration = useRef(0);
  // Consecutive failures for exponential backoff; reset only on success or a fresh account/toggle.
  const retryCount = useRef(0);
  const cancelPublish = useCallback(() => {
    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = null;
  }, []);

  useEffect(() => {
    accountGeneration.current += 1;
    retryCount.current = 0;
    appliedId.current = undefined;
    appliedCreatedAt.current = undefined;
    lastPublished.current = undefined;
    appliedSnapshot.current = undefined;
    notificationApplyPending.current = undefined;
    // A debounced publish belongs to its account; cancel on switch (in-flight
    // completions are ignored via the generation).
    cancelPublish();
  }, [user?.pubkey, cancelPublish]);

  useEffect(() => {
    if (automaticSettingsSync) return;
    // Stop future automatic actions; the generation change neutralizes in-flight
    // completions (`publishesInFlight` drains on its own).
    accountGeneration.current += 1;
    retryCount.current = 0;
    cancelPublish();
  }, [automaticSettingsSync, cancelPublish]);

  useEffect(() => {
    publishBaselines.set(name, (synced) => {
      if (lastPublished.current === undefined) return;
      lastPublished.current = JSON.stringify(configSnapshot(synced, name));
    });
    return () => {
      publishBaselines.delete(name);
    };
  }, [name]);

  const split = doc && event ? { doc, event } : null;
  // The newest metadata copy still carrying this slice's fields: an older build wrote it.
  const legacy = (name === "metadata"
    ? undefined
    : metadata.sources.find((source) => hasMigratedKeys(source.doc, name)))
    ?? (metadata.doc && metadata.event ? { doc: metadata.doc, event: metadata.event } : null);
  const resolved = name === "metadata" ? split : resolveLegacy(name, split, legacy);
  const resolvedId = resolved?.event.id;

  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey || !resolved) return;
    if (appliedId.current === resolved.event.id) return;

    // …except while a local edit is debouncing or being written: applying over it
    // would revert it and suppress its publish (which supersedes this version).
    if (publishTimer.current || publishesInFlight.current > 0) return;

    // Never fold a version older than one already applied (cache regression).
    if (appliedCreatedAt.current !== undefined
      && resolved.event.created_at < appliedCreatedAt.current) return;

    appliedId.current = resolved.event.id;
    appliedCreatedAt.current = resolved.event.created_at;
    if (name === "notifications") {
      notificationApplyPending.current = resolved.event.id;
    }

    updateConfig((current: AppConfig) => {
      // Patch INSIDE the updater: the `dms` and `notifications` merges fold against `current`.
      const doc = resolved.doc as Record<string, unknown>;
      const patch = docToConfigPatch(name, doc, current, resolved.event);
      const next = { ...current, ...patch };
      appliedSnapshot.current = JSON.stringify(configSnapshot(next, name));
      // Mark as synced so it isn't echoed back out — except where the per-scope
      // merge kept a notification choice the document lacks: the baseline is then
      // what the document says, so the publish effect writes the merge back.
      lastPublished.current = name === "notifications"
        ? JSON.stringify(configSnapshot(
          { ...next, ...notificationsDocFields(doc, current, resolved.event).remote },
          name,
        ))
        : appliedSnapshot.current;
      return next;
    });
  }, [automaticSettingsSync, user?.pubkey, name, resolved, updateConfig]);

  useEffect(() => {
    if (name !== "notifications" || !user?.pubkey || !resolved) return;
    if (notificationApplyPending.current !== resolved.event.id) return;
    // Publish authority only once React has rendered the applied snapshot.
    if (appliedSnapshot.current !== JSON.stringify(configSnapshot(config, name))) return;
    notificationApplyPending.current = undefined;
    markNotificationSettingsReady(user.pubkey);
  }, [config, name, resolved, user?.pubkey]);

  // `metadata.doc === null` means the user has no Armada settings: publishing would
  // REPLACE real settings everywhere with a merge over `{}`, so don't. The metadata
  // document gates every slice (split documents are legitimately absent).
  useEffect(() => {
    if (!automaticSettingsSync || !user?.pubkey || !hasNip44Support || metadata.doc === null) {
      return;
    }
    // A publish carries the WHOLE slice, so it must not run before the stored
    // version is folded in: a field still at its local default would replace the
    // user's real value everywhere. For notifications, a store with no copy is
    // not proof of absence either (see notificationSettingsAuthority).
    if (!isFetched || (resolvedId && appliedId.current !== resolvedId)) return;
    if (name === "notifications" && !notificationPolicyReady) return;

    const snapshot = JSON.stringify(configSnapshot(config, name));
    if (lastPublished.current === undefined) {
      // First observation: adopt current state as the baseline.
      lastPublished.current = snapshot;
      return;
    }
    if (snapshot === lastPublished.current) return;
    if (publishesInFlight.current > 0) return;

    cancelPublish();
    const attempt = () => {
      publishTimer.current = null;
      publishesInFlight.current += 1;
      const generation = accountGeneration.current;
      const attemptSnapshot = JSON.stringify(configSnapshot(configRef.current, name));
      const patch = configSnapshot(configRef.current, name);
      let succeeded = false;
      update(patch)
        .then(() => {
          if (accountGeneration.current !== generation) return;
          retryCount.current = 0;
          lastPublished.current = attemptSnapshot;
          succeeded = true;
        })
        .catch((err) => {
          if (accountGeneration.current !== generation) return;
          const delay = Math.min(
            PUBLISH_RETRY_MS * 2 ** retryCount.current,
            PUBLISH_RETRY_MAX_MS,
          );
          retryCount.current += 1;
          console.warn(`Config sync failed for ${name}; retrying:`, err);
          publishTimer.current = setTimeout(attempt, delay);
        })
        .finally(() => {
          // Always decrement; the side effects below belong to the scheduling account.
          publishesInFlight.current -= 1;
          if (accountGeneration.current !== generation) return;
          // State may have changed mid-delivery; re-run both directions now.
          if (succeeded) recheckAfterPublish();
        });
    };
    publishTimer.current = setTimeout(attempt, PUBLISH_DEBOUNCE_MS);

    return cancelPublish;
  }, [
    automaticSettingsSync,
    user?.pubkey,
    hasNip44Support,
    isFetched,
    resolvedId,
    notificationPolicyReady,
    config,
    name,
    metadata.doc,
    update,
    cancelPublish,
  ]);
}

export type { ConfigDocName };
