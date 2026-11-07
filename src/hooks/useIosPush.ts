import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useMediaPolicyConfig } from "@/hooks/useMediaPolicy";
import {
  mutatePushRegistrations,
  type PushMutationJob,
  type PushMutationResult,
  type PushTarget,
} from "@/hooks/useNostrPush";
import { usePushWatchSet } from "@/hooks/usePushWatchSet";
import { useIntl, languageOf } from "@/i18n";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import { NOSTR_PUSH2_LIMITS, type PushPlane } from "@/lib/nappPush";
import {
  ArmadaPush,
  clearIosPushConfig,
  hasIosPush,
  writeIosPushConfig,
  recordPushStatus,
} from "@/lib/nativePush";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import {
  isUnknownClientError,
  loadNostrPush2ClientKey,
  NostrPush2Client,
  type ApnsConnection,
  type PushRelayPool,
} from "@/lib/nostrPush2";
import {
  NOSTR_PUSH2_PUBKEY,
  NOSTR_PUSH2_RELAYS,
  nostrPush2Configured,
} from "@/lib/platform";
import {
  type PushPrefs,
  type UsePushNotificationsReturn,
} from "@/lib/pushPrefs";
import { LatestSerialRunner } from "@/lib/pushRegistration";
import { loadPushIntent, savePushIntent, savePushPrefs } from "@/lib/pushRegistry";

/**
 * Background notifications for the iOS app through the same nostr-push2
 * gateway as the web: the APNs token is this install's connection, and the
 * subscription list is the web's (`usePushWatchSet` → `mutatePushRegistrations`).
 * The Notification Service Extension (`ios/App/NotificationService`) opens the
 * event and rewrites the notification; `writeIosPushConfig` gives it what it
 * needs, since it has no WebView or localStorage.
 */

/** Retries for a transient sync failure, matching the web controller. */
const MAX_SYNC_RETRIES = 3;

/** Max wait on the DM store for the authored-conversations set before writing without it. */
const MINE_PEERS_TIMEOUT_MS = 3_000;

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim();
}

/**
 * APNs as a {@link PushTarget}. The token is re-taken on every hand-over,
 * since APNs may rotate it silently; `register()` prompts for nothing after
 * the first authorization.
 */
export function apnsPushTarget(
  client: NostrPush2Client,
  onPermission: (permission: NotificationPermission) => void,
): PushTarget {
  // What the gateway was last told by this target. `create` is repeated when
  // the token changes, and once per session regardless, so a client the
  // gateway reaped is recreated without waiting for an error.
  let created: string | undefined;

  return {
    kind: "apns",
    limits: NOSTR_PUSH2_LIMITS,
    async set(subscriptions, isCurrent) {
      const registration = await ArmadaPush.register();
      if (!registration.granted) {
        onPermission("denied");
        throw new Error("Notification permission not granted");
      }
      if (!registration.token || !registration.bundleId) {
        throw new Error(registration.error || "APNs returned no device token");
      }
      onPermission("granted");
      if (!isCurrent()) return false;

      const connection: ApnsConnection = {
        method: "apn",
        token: registration.token,
        topic: registration.bundleId,
        environment: registration.environment ?? "production",
      };
      const status = `env=${connection.environment} token=…${connection.token.slice(-6)}`;
      try {
        const fingerprint = `${connection.token}\0${connection.topic}\0${connection.environment}`;
        if (created !== fingerprint) {
          await client.create(connection);
          created = fingerprint;
        }
        try {
          await client.set(subscriptions);
        } catch (err) {
          if (!isUnknownClientError(err)) throw err;
          await client.create(connection);
          await client.set(subscriptions);
        }
      } catch (err) {
        await recordPushStatus(`FAILED ${status} — ${errorText(err)}`);
        throw err;
      }
      // The gateway's answer is otherwise unobservable on the device.
      await recordPushStatus(`ok ${subscriptions.length} subs ${status}`);
      return isCurrent();
    },
    async clear() {
      created = undefined;
      await client.delete();
    },
    // The extension's config is written by its own effect, which needs no
    // kill switch: without a config the extension opens nothing.
    async activate(prepareConfig, isCurrent) {
      await prepareConfig();
      return isCurrent();
    },
  };
}

export function useIosPush(): UsePushNotificationsReturn {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const { config, updateConfig } = useAppContext();

  const unavailableReason = !hasIosPush()
    ? "native-runtime" as const
    : !nostrPush2Configured()
      ? "gateway" as const
      : undefined;
  const supported = unavailableReason === undefined;

  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [configError, setConfigError] = useState<string>();
  const prefs = config.pushPrefs;
  const [nonce, setNonce] = useState(0);

  const {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    dmBunker,
    configReady,
    notificationSettingsReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
  } = usePushWatchSet(prefs);
  const mediaPolicy = useMediaPolicyConfig();
  // The extension has no catalog of the app's choice; a language switch rewrites its config.
  const locale = languageOf(useIntl().locale);

  // Keep the extension's config current; cleared whenever push is off or logged out so no key
  // lingers.
  useEffect(() => {
    if (!supported || !user || !enabled) {
      void clearIosPushConfig();
      return;
    }
    // Writing while the roster loads would freeze an empty known set on disk.
    if (!configReady) return;
    let cancelled = false;
    (async () => {
      // Mirror useKnownDmPeers' `mine` dimension (`acceptedDms` is device-local). Raced against a
      // timeout: a slow/wedged store must not block the config write.
      let mineConversationKeys: string[] = [];
      try {
        const rows = await Promise.race([
          queryDm17Conversations(user.pubkey),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), MINE_PEERS_TIMEOUT_MS)),
        ]);
        // An authored group doesn't make its participants trusted in unrelated 1:1s.
        if (rows) {
          const muted = new Set(dmMutedPeers);
          mineConversationKeys = rows
            .filter((row) => row.mine && row.peers.every((peer) => !muted.has(peer)))
            .map((row) => row.key);
        }
      } catch {
        // Store unavailable — the durable synced/pinned roster still applies.
      }
      if (cancelled) return;
      await writeIosPushConfig({
        policy: prefs.dmRequests,
        directMessages: prefs.directMessages,
        dmLevels,
        self: user.pubkey,
        knownPeers: dmKnownPeers,
        knownConversations: [
          ...new Set([...dmKnownConversationKeys, ...mineConversationKeys]),
        ].sort(),
        mutedPeers: dmMutedPeers,
        // One entry per watched channel's CURRENT epoch; the wrap-signing secret stays in the page,
        // and a rekey rewrites the set.
        concord: concord.flatMap((sub) =>
          sub.streams.map((stream) => ({
            pk: stream.pk,
            convKey: stream.convKey,
            epoch: stream.epoch,
            communityId: sub.communityId,
            channelId: sub.channelId,
            banned: sub.banned,
            mentionEveryoneAuthors: sub.mentionEveryoneAuthors,
            mentionEveryoneAnyone: sub.mentionEveryoneAnyone,
            roleMentions: sub.roleMentions,
            roleMentionAuthors: sub.roleMentionAuthors,
            clockOffsetMs: sub.clockOffsetMs,
            sendDenied: sub.sendDenied,
            postAuthors: sub.postAuthors,
            timeouts: sub.timeouts,
            nicknames: sub.nicknames,
            joinedAtMs: sub.joinedAtMs,
            mentionOnly: sub.mentionOnly,
            muted: sub.muted,
          }))
        ),
        // nsec logins decrypt on device; bunker logins hand over the client key. Never both.
        ...(dmSk ? { sk: dmSk } : {}),
        ...(!dmSk && dmBunker ? { nip46: dmBunker } : {}),
        mediaPolicy,
        locale,
      });
      if (!cancelled) setConfigError(undefined);
    })().catch((err) => {
      if (cancelled) return;
      // NOT swallowed: without a config every notification silently degrades to static text.
      console.warn("[ios-push] writing the extension config failed:", err);
      setConfigError(
        `Armada couldn't hand its notification extension the keys it needs, so `
        + `notifications can't show who a message is from. ${errorText(err)}`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    supported,
    user,
    enabled,
    configReady,
    prefs.dmRequests,
    prefs.directMessages,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    dmBunker,
    concord,
    mediaPolicy,
    locale,
  ]);

  const target = useMemo(() => {
    if (!supported || !user || !NOSTR_PUSH2_PUBKEY) return undefined;
    return apnsPushTarget(
      new NostrPush2Client({
        servicePubkey: NOSTR_PUSH2_PUBKEY,
        relays: NOSTR_PUSH2_RELAYS,
        secretKey: loadNostrPush2ClientKey(),
        pool: nostr as unknown as PushRelayPool,
      }),
      setPermission,
    );
  }, [supported, user, nostr]);

  const runnerRef = useRef<LatestSerialRunner<PushMutationJob, PushMutationResult> | null>(null);
  if (!runnerRef.current) runnerRef.current = new LatestSerialRunner(mutatePushRegistrations);
  const runner = runnerRef.current;

  useEffect(() => {
    if (!notificationSettingsReady) runner.invalidate();
  }, [notificationSettingsReady, runner]);

  // Read authorization without prompting; enable needn't be gesture-bound.
  useEffect(() => {
    if (!supported) {
      setReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { status } = await ArmadaPush.permission();
      if (cancelled) return;
      setPermission(status === "default" ? "default" : status);
      setReady(true);
    })().catch(() => {
      if (cancelled) return;
      // Plugin present but unresponsive: a recoverable failure, not an unsupported platform.
      setReady(false);
      setError("Armada couldn't check its notification permission. Try again.");
    });
    return () => {
      cancelled = true;
    };
  }, [supported, nonce]);

  const planes = useMemo<Record<PushPlane, boolean>>(() => ({
    groups: groupPlaneReady,
    dm: dmPlaneReady,
    concord: concordPlaneReady,
  }), [groupPlaneReady, dmPlaneReady, concordPlaneReady]);

  // Empty while nothing has loaded is "not loaded", never an instruction to clear.
  const nothingLoaded = !watchSetReady
    && specs.length === 0
    && !groupPlaneReady
    && !dmPlaneReady
    && !concordPlaneReady;

  const sync = useCallback(async () => {
    if (!target || !user) throw new Error("Push not ready");
    if (!notificationSettingsReady || nothingLoaded) return undefined;
    return runner.run({
      kind: "sync",
      target,
      pubkey: user.pubkey,
      specs,
      notificationSettingsReady,
      planes,
      prepareConfig: async () => {},
    });
  }, [target, user, notificationSettingsReady, nothingLoaded, runner, specs, planes]);

  const clearTarget = useCallback(async () => {
    if (!target) return;
    await runner.runExclusive({ kind: "clear", target });
  }, [target, runner]);

  // Logout purges storage and a switch reloads, both too fast for a
  // render-driven cleanup. The extension's keys go first and locally; the
  // gateway's list is best-effort, and a client it never hears from again
  // expires on its own.
  useEffect(() => {
    if (!user || !supported) return;
    return registerBeforeAccountExit(async () => {
      runner.invalidate();
      await clearIosPushConfig();
      await clearTarget();
    });
  }, [user, supported, runner, clearTarget]);

  // Auto-(re)sync on every load and whenever the watch set changes, while intent + permission
  // hold. Every load hands the list over at least once, which also keeps the gateway's client
  // from expiring.
  const syncSig = useMemo(
    () => JSON.stringify({
      pubkey: user?.pubkey,
      notificationSettingsReady,
      planes,
      authoritative: watchSetReady,
      specs,
    }),
    [user?.pubkey, notificationSettingsReady, planes, watchSetReady, specs],
  );
  const lastSynced = useRef<string | null>(null);
  const retry = useRef(0);
  useEffect(() => {
    if (!supported || !ready || !target || !user) return;
    if (permission !== "granted") return;
    if (!loadPushIntent()) return;
    if (!notificationSettingsReady || nothingLoaded) return;
    if (lastSynced.current === syncSig) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const outcome = await sync();
        if (cancelled || !outcome?.completed) return;
        lastSynced.current = syncSig;
        retry.current = 0;
        setError(undefined);
        setEnabled(true);
      } catch (err) {
        if (cancelled) return;
        console.warn("[ios-push] sync failed:", err);
        if (retry.current < MAX_SYNC_RETRIES) {
          const delay = 10_000 * 2 ** retry.current;
          retry.current += 1;
          timer = setTimeout(() => setNonce((n) => n + 1), delay);
        } else {
          setError("Armada couldn't refresh background notifications. Check your connection and retry.");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    supported,
    ready,
    permission,
    target,
    user,
    notificationSettingsReady,
    nothingLoaded,
    syncSig,
    sync,
    nonce,
  ]);

  // On foreground: clear the badge and delivered notifications, and recheck permission.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void ArmadaPush.clearBadge().catch(() => {});
      ArmadaPush.permission()
        .then(({ status }) => {
          if (cancelled) return;
          setPermission(status === "default" ? "default" : status);
          setEnabled(status === "granted" && loadPushIntent());
        })
        .catch(() => {});
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [supported]);

  const enable = useCallback(async () => {
    if (!supported || !ready || !user || !target) return;
    setBusy(true);
    setError(undefined);
    try {
      savePushIntent(true);
      lastSynced.current = null;
      const outcome = await sync();
      if (outcome?.completed) {
        lastSynced.current = syncSig;
        setEnabled(true);
      } else {
        // Nothing default-derived is handed over before the notification
        // settings are authoritative; the standing sync effect finishes then.
        setEnabled(false);
        setError("Armada is still restoring your notification settings. Background notifications will finish enabling automatically.");
      }
    } catch (err) {
      // A refused prompt is the user's answer, not a fault.
      const { status } = await ArmadaPush.permission().catch(() => ({ status: permission }));
      setPermission(status === "default" ? "default" : status);
      if (status !== "denied") {
        console.warn("[ios-push] enable failed:", err);
        setError("Armada couldn't enable background notifications. Check your connection and retry.");
      }
    } finally {
      setBusy(false);
    }
  }, [supported, ready, user, target, sync, syncSig, permission]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      // Intent first and locally: "off" must not depend on the gateway honoring deletes.
      savePushIntent(false);
      runner.invalidate();
      // The identity key must not outlive the session that could use it.
      await clearIosPushConfig();
      await clearTarget().catch((err) => {
        console.warn("[ios-push] clearing subscriptions failed:", err);
      });
      await ArmadaPush.unregister().catch(() => {});
      lastSynced.current = null;
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [runner, clearTarget]);

  const setPrefs = useCallback(async (next: PushPrefs) => {
    savePushPrefs(next, user?.pubkey);
    updateConfig((current) => ({ ...current, pushPrefs: next }));
    // The specs recompute from `prefs`; force the sync effect to re-run.
    lastSynced.current = null;
    setNonce((n) => n + 1);
  }, [updateConfig, user?.pubkey]);

  const retrySetup = useCallback(() => {
    setError(undefined);
    lastSynced.current = null;
    retry.current = 0;
    setNonce((n) => n + 1);
  }, []);

  return {
    supported,
    unavailableReason,
    ready,
    error: error ?? configError,
    permission,
    enabled,
    busy: busy || (supported && !ready && !error),
    prefs,
    enable,
    disable,
    setPrefs,
    retry: retrySetup,
  };
}
