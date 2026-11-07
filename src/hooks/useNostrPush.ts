import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generalReadRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMediaPolicyConfig } from "@/hooks/useMediaPolicy";
import { usePushWatchSet } from "@/hooks/usePushWatchSet";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import { installCrossTabAccountExit } from "@/lib/crossTabAccountExit";
import { isDesktop } from "@/lib/desktop";
import {
  carryForwardWatches,
  forgetLastPushSet,
  loadLastPushSet,
  NAPP_LIMITS,
  nappPushApi,
  NOSTR_PUSH2_LIMITS,
  saveLastPushSet,
  toNappSubscriptions,
  type NappLimits,
  type NappPush,
  type NappSubscription,
  type PushPlane,
} from "@/lib/nappPush";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import {
  base64urlToBytes,
  isUnknownClientError,
  loadNostrPush2Identity,
  NostrPush2Client,
  webPushConnection,
  type NostrPush2Identity,
  type PushRelayPool,
} from "@/lib/nostrPush2";
import {
  isNativeRuntime,
  NOSTR_PUSH2_PUBKEY,
  NOSTR_PUSH2_RELAYS,
  nostrPush2Configured,
} from "@/lib/platform";
import type { PushPrefs, UsePushNotificationsReturn } from "@/lib/pushPrefs";
import { loadPushIntent, savePushIntent, savePushPrefs } from "@/lib/pushRegistry";
import { LatestSerialRunner } from "@/lib/pushRegistration";
import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";
import { clearPushDisabledFlag, writePushDisabledFlag } from "@/lib/swPushDisabled";
import { clearSwPushConfig, writeSwPushConfig } from "@/lib/swPushConfig";
import { useIntl } from "@/i18n";
import { notificationLocale } from "@/i18n/locales";
import {
  acquireWebPushSubscription,
  activateRegisteredWebPush,
  finishWebPushAccountExit,
  matchesWebPushServerKey,
  retireWebPushEndpoint,
} from "@/lib/webPushEndpoint";
import {
  notificationPermissionOf,
  webPushUnavailableReason,
} from "@/lib/webPushSupport";

/**
 * Closed-app notifications for the web build, over whichever of two
 * transports this page has:
 *
 *   - `window.napp.push`, when Armada is an nsite inside Tenna (tenna/NAPP.md).
 *     The host holds the subscriptions and wakes the worker itself.
 *   - Web Push through a nostr-push2 gateway (`nostrPush2.ts`) everywhere else.
 *
 * Both take the same `NappSubscription[]` and deliver the same
 * `napp.push.payload` to `sw.js`, so only the {@link PushTarget} differs: the
 * watch set (`usePushWatchSet`, shared with Android and iOS), the sealed decrypt
 * config, the kill switch and the account-exit ordering are shared.
 */

/**
 * Where the subscription list goes. `set` replaces it whole; keeping an
 * incomplete snapshot from pruning happens before, in `mutatePushRegistrations`.
 */
export interface PushTarget {
  kind: "web" | "napp" | "apns";
  limits: NappLimits;
  /** Hand the list over. False when superseded before it landed. */
  set(
    subscriptions: NappSubscription[],
    isCurrent: () => boolean,
    gestureSubscription?: PushSubscription,
  ): Promise<boolean>;
  /** Remove everything this install is subscribed to. */
  clear(): Promise<void>;
  /**
   * Lift the worker's kill switch now that the list is this account's, after
   * sealing this account's config. False when that could not be done safely.
   */
  activate(prepareConfig: () => Promise<void>, isCurrent: () => boolean): Promise<boolean>;
}

interface PreparedWeb {
  registration: ServiceWorkerRegistration;
  key: ArrayBuffer;
  options: PushSubscriptionOptionsInit;
  identity: NostrPush2Identity;
}

/** Web Push via nostr-push2. The browser endpoint is made and repaired here. */
export function webPushTarget(
  client: NostrPush2Client,
  prepared: () => PreparedWeb | undefined,
): PushTarget {
  let subscription: PushSubscription | undefined;
  // The endpoint the gateway was last told about by this target. `create` is
  // repeated whenever it changes, and once per session regardless, so a client
  // the gateway reaped is recreated without waiting for an error.
  let created: string | undefined;

  return {
    kind: "web",
    limits: NOSTR_PUSH2_LIMITS,
    async set(subscriptions, isCurrent, gestureSubscription) {
      const ready = prepared();
      if (!ready) throw new Error("Push not ready");
      const sub = await acquireWebPushSubscription(
        ready.registration,
        ready.key,
        ready.options,
        gestureSubscription,
        isCurrent,
      );
      if (!sub || !isCurrent()) return false;
      subscription = sub;

      const connection = webPushConnection(sub, ready.identity);
      const fingerprint = `${connection.endpoint}\0${connection.p256dh}\0${connection.auth}`;
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
      return isCurrent();
    },
    async clear() {
      created = undefined;
      await client.delete();
    },
    activate(prepareConfig, isCurrent) {
      if (!subscription) return Promise.resolve(false);
      return activateRegisteredWebPush({
        subscription,
        registered: true,
        prepareConfig,
        isCurrent,
      });
    },
  };
}

/** Tenna's `window.napp.push`. The host owns the sockets and the consent prompt. */
export function nappPushTarget(api: NappPush): PushTarget {
  return {
    kind: "napp",
    limits: NAPP_LIMITS,
    async set(subscriptions, isCurrent) {
      await api.set(subscriptions);
      return isCurrent();
    },
    clear: () => api.set([]),
    async activate(prepareConfig, isCurrent) {
      // No endpoint to prove retired: `set` just replaced the host's whole list
      // with this account's, so the only thing left is the worker's policy.
      await prepareConfig();
      if (!isCurrent()) return false;
      await clearPushDisabledFlag();
      if (isCurrent()) return true;
      await writePushDisabledFlag();
      return false;
    },
  };
}

export interface PushSyncJob {
  kind: "sync";
  target: PushTarget;
  pubkey: string;
  specs: PushSubscriptionSpec[];
  /** Whether the account's notification policy (NIP-78/local opt-out) is trusted. */
  notificationSettingsReady: boolean;
  /** Which planes of `specs` are complete; the rest keep what was last set. */
  planes: Record<PushPlane, boolean>;
  /** Seal this account's policy/keys before the kill switch may lift. */
  prepareConfig: (isCurrent: () => boolean) => Promise<void>;
  gestureSubscription?: PushSubscription;
}

interface PushClearJob {
  kind: "clear";
  target: PushTarget;
}

export type PushMutationJob = PushSyncJob | PushClearJob;

export interface PushMutationResult {
  /** False when a newer generation superseded this mutation. */
  completed: boolean;
  /** The worker kill switch was lifted for this account. */
  activated: boolean;
  /** Subscriptions past the transport's ceiling that were not handed over. */
  dropped: number;
}

const NOT_COMPLETED: PushMutationResult = { completed: false, activated: false, dropped: 0 };

/** One serialized, generation-aware hand-over of the subscription list. */
export async function mutatePushRegistrations(
  job: PushMutationJob,
  isCurrent: () => boolean,
): Promise<PushMutationResult> {
  if (job.kind === "clear") {
    await job.target.clear();
    forgetLastPushSet();
    return { completed: true, activated: false, dropped: 0 };
  }

  // A partial watch set may be additive, but its policy is not. Until the
  // NIP-78 settings represented in the sealed worker config are trusted,
  // registering default-derived filters and lifting the kill switch could
  // expose notifications the account explicitly disabled.
  if (!job.notificationSettingsReady) return NOT_COMPLETED;

  const watches = carryForwardWatches(job.specs, loadLastPushSet(job.pubkey), job.planes);
  const { subscriptions, dropped } = toNappSubscriptions(watches, job.target.limits);
  if (dropped > 0) {
    console.warn(`[push] ${dropped} subscription(s) exceed the ${job.target.kind} limit and were not registered`);
  }

  const landed = await job.target.set(subscriptions, isCurrent, job.gestureSubscription);
  if (!landed || !isCurrent()) return NOT_COMPLETED;
  saveLastPushSet(job.pubkey, watches);

  const activated = await job.target.activate(() => job.prepareConfig(isCurrent), isCurrent);
  if (!activated) {
    if (isCurrent()) {
      throw new Error(
        "The previous account's push endpoint could not be retired safely. Disable and re-enable notifications to retry.",
      );
    }
    return NOT_COMPLETED;
  }
  return { completed: true, activated: true, dropped };
}

async function webPermission(prepared: PreparedWeb): Promise<NotificationPermission> {
  if (typeof Notification !== "undefined") return Notification.permission;
  const existing = await prepared.registration.pushManager.getSubscription();
  if (existing) return "granted";
  if (typeof prepared.registration.pushManager.permissionState === "function") {
    const state = await prepared.registration.pushManager.permissionState(prepared.options);
    return notificationPermissionOf(state);
  }
  return "default";
}

/**
 * Tenna's page `Notification.permission` is real. Where a host has none, a
 * stored list is the only evidence the user ever said yes.
 */
function nappPermission(stored: NappSubscription[]): NotificationPermission {
  if (typeof Notification !== "undefined") return Notification.permission;
  return stored.length > 0 ? "granted" : "default";
}

/** What `window.napp.push.set` rejects with when the user declines its prompt. */
function isUserRejection(err: unknown): boolean {
  return err instanceof Error && /user rejected/i.test(err.message);
}

export function useNostrPush(): UsePushNotificationsReturn {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const { config, updateConfig } = useAppContext();

  // Fixed for the life of the page: Tenna defines it before any script runs.
  const napp = useMemo(() => nappPushApi(), []);

  const unavailableReason = napp
    ? undefined
    : isNativeRuntime()
      ? "native-runtime" as const
      : isDesktop()
        // Electron exposes window.PushManager and registers a service worker,
        // so the plain capability probe reports Web Push "supported" — but its
        // Chromium has no push service behind that API, so subscribe can only
        // fail. Report it unavailable so Settings offers the foreground
        // notifier — the only notifier the desktop shell has.
        ? "desktop" as const
        : webPushUnavailableReason(nostrPush2Configured());
  const supported = unavailableReason === undefined;

  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [prepareNonce, setPrepareNonce] = useState(0);
  const prefs = config.pushPrefs;
  const preparedRef = useRef<PreparedWeb | undefined>(undefined);
  /** Once account exit starts, this mounted instance may never write again. */
  const exitingRef = useRef(false);
  /** Serialize and expose config writes so exit can clear strictly after them. */
  const swConfigTailRef = useRef<Promise<void>>(Promise.resolve());
  const queueSwConfig = useCallback((operation: () => Promise<void>) => {
    const work = swConfigTailRef.current.then(operation, operation);
    swConfigTailRef.current = work.catch(() => undefined);
    return work;
  }, []);

  const {
    specs,
    concord,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmLevels,
    dmSk,
    notificationSettingsReady,
    dmConfigReady,
    concordConfigReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
  } = usePushWatchSet(prefs);
  const mediaPolicy = useMediaPolicyConfig();
  const { locale } = useIntl();
  const profileRelaysKey = generalReadRelays(config, user?.pubkey).join(",");
  const profileRelays = useMemo(
    () => (profileRelaysKey ? profileRelaysKey.split(",") : []),
    [profileRelaysKey],
  );
  const notificationSettingsReadyRef = useRef(notificationSettingsReady);
  notificationSettingsReadyRef.current = notificationSettingsReady;

  /**
   * Seal one current-account config snapshot. The generation check is repeated
   * before and inside the serialized write so neither a newer watch snapshot
   * nor account exit can let stale keys land last.
   */
  const writeCurrentSwConfig = useCallback(async (
    isCurrent: () => boolean = () => true,
  ) => {
    if (!user
      || !notificationSettingsReadyRef.current
      || exitingRef.current
      || !isCurrent()) {
      throw new Error("Push session changed before its config could be written");
    }

    // Mirror useKnownDmPeers' `mine` dimension. This local-store enhancement
    // is bounded: a wedged IndexedDB must not indefinitely hold the kill
    // switch or prevent otherwise-valid current-account registrations.
    let mineConversationKeys: string[] = [];
    try {
      const rows = await Promise.race([
        queryDm17Conversations(user.pubkey),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      if (rows) {
        const muted = new Set(dmMutedPeers);
        mineConversationKeys = rows
          .filter((row) => row.mine && row.peers.every((peer) => !muted.has(peer)))
          .map((row) => row.key);
      }
    } catch {
      // Store unavailable — the durable synced/pinned roster still applies.
    }
    if (!notificationSettingsReadyRef.current || exitingRef.current || !isCurrent()) {
      throw new Error("Push session changed before its config could be written");
    }

    await queueSwConfig(async () => {
      if (!notificationSettingsReadyRef.current || exitingRef.current || !isCurrent()) {
        throw new Error("Push session changed before its config could be written");
      }
      const written = await writeSwPushConfig({
        policy: prefs.dmRequests,
        self: user.pubkey,
        knownPeers: dmKnownPeers,
        knownConversations: [
          ...new Set([...dmKnownConversationKeys, ...mineConversationKeys]),
        ].sort(),
        mutedPeers: dmMutedPeers,
        dmReady: dmConfigReady,
        directMessages: prefs.directMessages,
        dmLevels,
        concordReady: concordConfigReady,
        concord: concord.flatMap((sub) =>
          sub.streams.map((s) => ({
            pk: s.pk,
            convKey: s.convKey,
            epoch: s.epoch,
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
        ...(dmSk ? { sk: dmSk } : {}),
        mediaPolicy,
        profileRelays,
        ...notificationLocale(locale),
      });
      if (!written) {
        throw new Error("The service worker notification policy could not be stored");
      }
    });
  }, [
    user,
    prefs.dmRequests,
    prefs.directMessages,
    dmKnownPeers,
    dmKnownConversationKeys,
    dmMutedPeers,
    dmConfigReady,
    dmLevels,
    concord,
    concordConfigReady,
    dmSk,
    mediaPolicy,
    profileRelays,
    locale,
    queueSwConfig,
  ]);

  // Keep the service worker's push config current (DM policy + known set, nsec decrypt
  // key, per-channel Concord stream keys); cleared whenever push is off or logged out so
  // no key outlives its session. Display data is deliberately NOT sealed: the worker
  // reads it from ArmadaDB at push time (`pushRuntime.ts`).
  useEffect(() => {
    // Clear only in states that MEAN no session should hold a key: logged out,
    // unsupported runtime, or the user's push intent turned off. `enabled` is
    // false during every session's PREPARATION, so clearing on it would delete
    // the worker's decrypt config at each app start.
    if (!supported || !user || !loadPushIntent()) {
      void queueSwConfig(clearSwPushConfig).catch(() => undefined);
      return;
    }
    if (exitingRef.current) return;
    if (!enabled) return;
    if (!notificationSettingsReady) return;
    let cancelled = false;
    writeCurrentSwConfig(() => !cancelled).catch((err) => {
      if (!cancelled && !exitingRef.current) {
        console.warn("[push] writing worker config failed:", err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    supported,
    user,
    enabled,
    notificationSettingsReady,
    queueSwConfig,
    writeCurrentSwConfig,
  ]);

  // An install subscribed before WebKit was refused: drop its endpoint so the
  // gateway's next delivery is a 410 and the registration goes with it.
  useEffect(() => {
    if (unavailableReason !== "webkit" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistration().then(async (registration) => {
      if (registration && await registration.pushManager?.getSubscription()) {
        await retireWebPushEndpoint(registration);
      }
    }).catch(() => undefined);
  }, [unavailableReason]);

  // ── Target ─────────────────────────────────────────────────────────────────

  const [identity, setIdentity] = useState<NostrPush2Identity>();
  useEffect(() => {
    if (napp || !supported) return;
    let cancelled = false;
    loadNostrPush2Identity().then((next) => {
      if (!cancelled) setIdentity(next);
    }).catch((err) => {
      if (cancelled) return;
      console.warn("[push] generating the push identity failed:", err);
      setError("Armada couldn't prepare background notifications in this browser.");
    });
    return () => {
      cancelled = true;
    };
  }, [napp, supported, prepareNonce]);

  const target = useMemo<PushTarget | undefined>(() => {
    if (!supported) return undefined;
    if (napp) return nappPushTarget(napp);
    if (!identity || !NOSTR_PUSH2_PUBKEY) return undefined;
    return webPushTarget(
      new NostrPush2Client({
        servicePubkey: NOSTR_PUSH2_PUBKEY,
        relays: NOSTR_PUSH2_RELAYS,
        secretKey: identity.secretKey,
        pool: nostr as unknown as PushRelayPool,
      }),
      () => preparedRef.current,
    );
  }, [supported, napp, identity, nostr]);

  const mutationRunnerRef = useRef<
    LatestSerialRunner<PushMutationJob, PushMutationResult> | null
  >(null);
  if (!mutationRunnerRef.current) {
    mutationRunnerRef.current = new LatestSerialRunner(mutatePushRegistrations);
  }
  const mutationRunner = mutationRunnerRef.current;

  // Supersede a hand-over as soon as policy authority is lost.
  // `writeCurrentSwConfig` also reads the ref immediately before its
  // serialized write, closing the async gap before this effect.
  useEffect(() => {
    if (!notificationSettingsReady) mutationRunner.invalidate();
  }, [notificationSettingsReady, mutationRunner]);

  // Prepare before showing an enable action. Web: PushManager.subscribe() has
  // to run directly from the user's tap on iOS, so the worker and the VAPID key
  // must be in hand first. Tenna: nothing to prepare but the current state.
  useEffect(() => {
    if (!target || !user || exitingRef.current) {
      preparedRef.current = undefined;
      setReady(false);
      return;
    }

    let cancelled = false;
    setReady(false);
    setError(undefined);
    (async () => {
      if (napp) {
        const stored = await napp.get();
        if (cancelled || exitingRef.current) return;
        const nextPermission = nappPermission(stored);
        setPermission(nextPermission);
        setEnabled(stored.length > 0 && nextPermission === "granted" && loadPushIntent());
        setReady(true);
        return;
      }

      if (!identity) return;
      const key = base64urlToBytes(identity.vapidPublicKey).buffer;
      const registration = await navigator.serviceWorker.ready;
      const options: PushSubscriptionOptionsInit = {
        userVisibleOnly: true,
        applicationServerKey: key,
      };

      // A subscription made against any other key — the retired gateway's, or
      // a previous identity's — cannot be pushed to by this install. Drop it
      // here so the next tap can subscribe as its first permission-sensitive
      // operation; its old gateway record then dies of a 410.
      const existing = await registration.pushManager.getSubscription();
      if (existing && !matchesWebPushServerKey(existing, key)) {
        await existing.unsubscribe().catch(() => false);
      }

      const prepared = { registration, key, options, identity };
      const nextPermission = await webPermission(prepared);
      const current = await registration.pushManager.getSubscription();
      if (cancelled || exitingRef.current) return;
      preparedRef.current = prepared;
      setPermission(nextPermission);
      setEnabled(Boolean(current && nextPermission === "granted" && loadPushIntent()));
      setReady(true);
    })().catch((err) => {
      if (cancelled) return;
      console.warn("[push] preparation failed:", err);
      preparedRef.current = undefined;
      setReady(false);
      setError("Armada couldn't prepare background notifications. Check your connection and try again.");
    });

    return () => {
      cancelled = true;
    };
  }, [target, napp, identity, user, prepareNonce]);

  const planes = useMemo<Record<PushPlane, boolean>>(() => ({
    groups: groupPlaneReady,
    dm: dmPlaneReady,
    concord: concordPlaneReady,
  }), [groupPlaneReady, dmPlaneReady, concordPlaneReady]);

  /** Queue one snapshot; incomplete planes keep what was last handed over. */
  const sync = useCallback(async (gestureSubscription?: PushSubscription) => {
    if (!target || !user) throw new Error("Push not ready");
    if (exitingRef.current || !notificationSettingsReady) return undefined;
    // Empty while nothing has loaded is "not loaded", never an instruction to
    // clear. A non-empty partial set is still useful and is handed over with
    // the unloaded planes carried forward.
    if (!watchSetReady
      && specs.length === 0
      && !groupPlaneReady
      && !dmPlaneReady
      && !concordPlaneReady) return undefined;
    return mutationRunner.run({
      kind: "sync",
      target,
      pubkey: user.pubkey,
      specs,
      notificationSettingsReady,
      planes,
      prepareConfig: writeCurrentSwConfig,
      ...(gestureSubscription ? { gestureSubscription } : {}),
    });
  }, [
    target,
    user,
    notificationSettingsReady,
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
    planes,
    mutationRunner,
    specs,
    writeCurrentSwConfig,
  ]);

  /** Remove this install's subscriptions in the same serial lane. */
  const clearTarget = useCallback(async () => {
    if (!target) return;
    await mutationRunner.runExclusive({ kind: "clear", target });
  }, [target, mutationRunner]);

  // Account switching hard-reloads, and final logout purges storage. Both
  // happen too quickly for a render-driven cleanup, so register with the
  // shared pre-exit choke point.
  useEffect(() => {
    if (!user) return;
    return registerBeforeAccountExit(async () => {
      // Stop every render-driven writer synchronously before the first await,
      // and supersede a queued/running hand-over.
      exitingRef.current = true;
      mutationRunner.invalidate();
      // Local safety comes before the bounded network cleanup on EVERY exit:
      // the worker stays deny-by-default until the next account's list lands.
      if (napp) {
        await writePushDisabledFlag();
        await queueSwConfig(clearSwPushConfig).catch(() => undefined);
        try {
          await clearTarget();
        } finally {
          await writePushDisabledFlag();
        }
        return;
      }
      await finishWebPushAccountExit({
        registration: preparedRef.current?.registration,
        clearConfig: () => queueSwConfig(clearSwPushConfig),
        deleteGatewayRecords: clearTarget,
      });
    });
  }, [user, napp, mutationRunner, queueSwConfig, clearTarget]);

  // The active-account marker is origin-global. A switch in another tab does
  // not reload this document, so without this fence its old session could
  // rewrite the shared worker config behind the new account.
  useEffect(() => {
    if (!user) return;
    return installCrossTabAccountExit({
      pubkey: user.pubkey,
      fence: () => {
        exitingRef.current = true;
        mutationRunner.invalidate();
      },
    });
  }, [user, mutationRunner]);

  // Auto-(re)sync on every load and whenever the watch set changes, as long as
  // the user intends push and permission is granted. Every load hands the list
  // over at least once, which is also what keeps an idle gateway client from
  // expiring. Transient failures retry with backoff.
  const syncSig = useMemo(
    () => JSON.stringify({
      pubkey: user?.pubkey,
      notificationSettingsReady,
      dmConfigReady,
      concordConfigReady,
      planes,
      authoritative: watchSetReady,
      specs,
    }),
    [
      user?.pubkey,
      notificationSettingsReady,
      dmConfigReady,
      concordConfigReady,
      planes,
      watchSetReady,
      specs,
    ],
  );
  const lastSynced = useRef<string | null>(null);
  const retry = useRef(0);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!supported || !ready || !target || !user) return;
    if (exitingRef.current) return;
    if (permission !== "granted") return;
    if (!loadPushIntent()) return;
    if (!notificationSettingsReady) return;
    if (!watchSetReady
      && specs.length === 0
      && !groupPlaneReady
      && !dmPlaneReady
      && !concordPlaneReady) return;
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
        console.warn("[push] sync failed:", err);
        if (retry.current < 3) {
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
    groupPlaneReady,
    dmPlaneReady,
    concordPlaneReady,
    watchSetReady,
    specs.length,
    syncSig,
    sync,
    nonce,
  ]);

  // A rotated browser subscription (SW pushsubscriptionchange → message) must
  // be handed to the gateway again.
  useEffect(() => {
    if (napp || !supported || !ready) return;
    const onMessage = (event: MessageEvent) => {
      if (exitingRef.current) return;
      if (event.data?.type !== "armada-push-changed") return;
      lastSynced.current = null;
      retry.current = 0;
      setNonce((n) => n + 1);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [napp, supported, ready]);

  // iOS can rotate or revoke a subscription while Armada is closed. Recheck
  // whenever the app becomes visible/online; granted intent with no current
  // subscription is repaired by the auto-sync effect above.
  useEffect(() => {
    if (napp || !supported || !ready) return;
    let cancelled = false;
    const recheck = async () => {
      if (exitingRef.current) return;
      if (document.visibilityState !== "visible") return;
      const prepared = preparedRef.current;
      if (!prepared) return;
      try {
        const [nextPermission, existing] = await Promise.all([
          webPermission(prepared),
          prepared.registration.pushManager.getSubscription(),
        ]);
        if (cancelled || exitingRef.current) return;
        setPermission(nextPermission);
        setEnabled(Boolean(existing && nextPermission === "granted" && loadPushIntent()));
        if (!existing && nextPermission === "granted" && loadPushIntent()) {
          lastSynced.current = null;
          retry.current = 0;
          setNonce((n) => n + 1);
        }
      } catch {
        // Leave the last known state; the explicit retry remains available.
      }
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("online", recheck);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("online", recheck);
    };
  }, [napp, supported, ready]);

  // ── Public actions ─────────────────────────────────────────────────────────

  const enable = useCallback(async () => {
    if (!supported || !ready || !user || !target || exitingRef.current) return;
    const prepared = preparedRef.current;
    if (!napp && !prepared) return;
    setBusy(true);
    setError(undefined);

    // Web: subscribe synchronously from the toggle's tap. Besides creating the
    // endpoint, this is the standards-based permission request; unlike
    // Notification.requestPermission(), it also works in iOS Home-Screen web
    // apps where window.Notification is absent. Tenna: `set` itself asks.
    const subscriptionPromise = prepared
      ? prepared.registration.pushManager.subscribe(prepared.options)
      : undefined;
    try {
      const subscription = await subscriptionPromise;
      savePushIntent(true);
      lastSynced.current = null;
      const outcome = await sync(subscription);
      if (outcome?.completed) {
        setPermission("granted");
        lastSynced.current = syncSig;
        setEnabled(true);
      } else {
        // The endpoint exists (the gesture cannot be replayed automatically on
        // iOS), but nothing default-derived was handed over. Once the
        // notification document becomes authoritative, the standing sync
        // effect finishes the job.
        if (subscription) setPermission("granted");
        setEnabled(false);
        setError("Armada is still restoring your notification settings. Background notifications will finish enabling automatically.");
      }
    } catch (err) {
      if (napp && isUserRejection(err)) {
        // Declined at Tenna's prompt. Don't let the auto-sync ask again on
        // every load; the toggle is still there.
        savePushIntent(false);
        setPermission(typeof Notification !== "undefined" ? Notification.permission : "default");
        return;
      }
      const nextPermission = prepared
        ? await webPermission(prepared).catch(() => permission)
        : typeof Notification !== "undefined" ? Notification.permission : permission;
      setPermission(nextPermission);
      if (nextPermission !== "denied") {
        console.warn("[push] enable failed:", err);
        setError("Armada couldn't enable background notifications. Check your connection and retry.");
      }
    } finally {
      setBusy(false);
    }
  }, [supported, ready, user, target, napp, sync, syncSig, permission]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      savePushIntent(false);
      mutationRunner.invalidate();
      // The worker's kill switch first: the network teardown below can fail.
      if (napp) {
        await writePushDisabledFlag();
      } else {
        await retireWebPushEndpoint(preparedRef.current?.registration);
      }
      await clearTarget().catch((err) => {
        console.warn("[push] clearing subscriptions failed:", err);
      });
      await queueSwConfig(clearSwPushConfig).catch(() => undefined);
      lastSynced.current = null;
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [napp, clearTarget, mutationRunner, queueSwConfig]);

  const setPrefs = useCallback(
    async (next: PushPrefs) => {
      savePushPrefs(next, user?.pubkey);
      updateConfig((current) => ({ ...current, pushPrefs: next }));
      // The specs recompute from `prefs`; force the sync effect to re-run.
      lastSynced.current = null;
      setNonce((n) => n + 1);
    },
    [updateConfig, user?.pubkey],
  );

  const retrySetup = useCallback(() => {
    setError(undefined);
    lastSynced.current = null;
    retry.current = 0;
    if (ready) setNonce((n) => n + 1);
    else setPrepareNonce((n) => n + 1);
  }, [ready]);

  return {
    supported,
    unavailableReason,
    ready,
    error,
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
