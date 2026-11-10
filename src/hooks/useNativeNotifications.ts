import { useNostrLogin } from "@nostrify/react/login";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMediaPolicyConfig } from "@/hooks/useMediaPolicy";
import { concordLevelPolicy, useNotifLevels } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  savePushPrefs,
  type PushPrefs,
} from "@/lib/pushPrefs";
import {
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";
import {
  ArmadaNotification,
  type NativeNotificationHealth,
} from "@/lib/nativeNotifications";
import { SELF_SYNC_DTAGS } from "@/lib/selfSyncKinds";
import { nativeSelfDocs } from "@/lib/settingsKeys";
import { useSettingsKeys } from "@/hooks/useSettingsKeys";
import { useConcordSubsState } from "@/concord/hooks/useConcordSubs";
import { withoutNudge } from "@/lib/signerWithNudge";
import { signStreamAuthsChunked } from "@/concord/lib/streamAuth";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { effectiveDmRelays, selfStateRelays } from "@/contexts/AppContext";
import {
  hasNativeNotificationService,
  isGitAnnouncementDiscoveryRelay,
  normalizeRelayUrl,
} from "@/lib/platform";
import { useWireGitTicketRoots } from "@/hooks/useWireGitTicketRoots";
import type { GitRepositoryWireInput } from "@/wire/spec";
import { useEventStore } from "@/hooks/useEventStore";
import { GIT_REPOSITORY_ANNOUNCEMENT_KIND, parseGitRepositoryAnnouncement } from "@/lib/gitActivity";
import { registerBeforeAccountExit } from "@/lib/beforeAccountExit";
import { setNativeServiceWatching } from "@/lib/backgroundQuiet";
import {
  nativeNotificationConfigAction,
  type NativeNotificationEnablement,
} from "@/lib/nativeNotificationConfig";
import { getLanguage, useIntl, languageOf } from "@/i18n";
import { nowSecs } from "@/lib/relayClock";

const NATIVE_INTENT_KEY = "armada:native-notif-intent";

function loadIntent(): boolean {
  try {
    const raw = localStorage.getItem(NATIVE_INTENT_KEY);
    // Opt-out: intended-on by default; starts only once OS permission is granted.
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

function saveIntent(on: boolean): void {
  try {
    localStorage.setItem(NATIVE_INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

export function nativeNotificationIntent(): boolean {
  return loadIntent();
}

// Shared `enabled` state: the hook mounts more than once (headless + Settings), and
// per-instance state would double-prompt for permission.

// `unknown` is load-bearing: treating the async permission check as `false` would erase the
// only config the headless service can restart from.
let enabledState: NativeNotificationEnablement = "unknown";
const enabledListeners = new Set<() => void>();

function setEnabledShared(next: NativeNotificationEnablement): void {
  if (enabledState === next) return;
  enabledState = next;
  for (const l of enabledListeners) l();
}

function subscribeEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  return () => {
    enabledListeners.delete(listener);
  };
}

/**
 * Request OS permission and, on grant, enable for every mounted instance. Called from the
 * post-login setup tap; not fired on launch.
 */
export async function enableNativeNotifications(): Promise<boolean> {
  if (!hasNativeNotificationService()) return false;
  const { granted } = await ArmadaNotification.requestPermission();
  if (!granted) {
    setEnabledShared("disabled");
    return false;
  }
  saveIntent(true);
  setEnabledShared("enabled");
  return true;
}

let autoChecked = false;

// Serialize + dedupe native writes across instances so a second mount doesn't rebuild every socket.
let lastRequestedConfig = "";
let configureQueue: Promise<void> = Promise.resolve();
let lastForcedConfig = "";
let lastForcedConfigAt = 0;

function configureNative(
  payload: Parameters<typeof ArmadaNotification.configure>[0],
  force = false,
): Promise<void> {
  const key = JSON.stringify(payload);
  if (key === lastRequestedConfig && !force) return configureQueue;
  if (force) {
    const now = Date.now();
    // One repair attempt per stopped snapshot; later polls may retry an OEM-refused FGS.
    if (key === lastForcedConfig && now - lastForcedConfigAt < 5_000) {
      return configureQueue;
    }
    lastForcedConfig = key;
    lastForcedConfigAt = now;
  }
  lastRequestedConfig = key;
  configureQueue = configureQueue
    .catch(() => {})
    .then(() => ArmadaNotification.configure(payload))
    .then(() => setNativeServiceWatching(payload.enabled === true))
    .catch((err) => {
      if (lastRequestedConfig === key) lastRequestedConfig = "";
      throw err;
    });
  return configureQueue;
}

/**
 * Awaitable account-exit barrier: clears the outgoing account's sealed signer, watches and tray
 * entries before reload, preserving the on/off intent.
 */
export async function disableNativeNotificationsForAccountExit(): Promise<void> {
  if (!hasNativeNotificationService()) return;
  // Close the gate synchronously so a rerender can't re-enqueue the outgoing account's payload.
  // Intent is unchanged.
  setEnabledShared("disabled");
  await configureNative({ enabled: false, locale: getLanguage() });
}

// One module-wide account-exit subscription so the native teardown doesn't run twice.
let accountExitMounts = 0;
let unregisterAccountExit: (() => void) | undefined;

function retainAccountExitHandler(): () => void {
  accountExitMounts++;
  if (accountExitMounts === 1) {
    unregisterAccountExit = registerBeforeAccountExit(
      disableNativeNotificationsForAccountExit,
    );
  }
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    accountExitMounts--;
    if (accountExitMounts === 0) {
      unregisterAccountExit?.();
      unregisterAccountExit = undefined;
    }
  };
}

export interface UseNativeNotificationsReturn {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  prefs: PushPrefs;
  /** Android's non-secret permission/channel/service/socket diagnostics. */
  health?: NativeNotificationHealth;
  refreshHealth: () => Promise<void>;
  openSettings: (channel?: "messages" | "calls" | "service") => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  /** Re-configures the running service. */
  setPrefs: (next: PushPrefs) => Promise<void>;
}

/**
 * Android APK background notifications: a foreground service holds persistent REQs (the
 * System WebView has no Web Push). This hook configures it. Inert on web and iOS
 * ({@link hasNativeNotificationService}).
 */
export function useNativeNotifications(): UseNativeNotificationsReturn {
  const supported = hasNativeNotificationService();
  const { user } = useCurrentUser();
  const storedNotificationSettingsReady = useNotificationSettingsReady(user?.pubkey);
  const { config, updateConfig } = useAppContext();
  // With settings sync disabled, local AppConfig is the policy source — session-local only.
  const notificationSettingsReady = storedNotificationSettingsReady
    || config.automaticSettingsSync === false;
  const groupListQuery = useUserGroupList();
  const groupList = groupListQuery.data;
  const {
    knownPeers: dmKnownPeers,
    knownConversationKeys: dmKnownConversations,
    mutedPeers: dmMutedPeers,
    configurationReady: dmPeersConfigReady,
  } = useKnownDmPeers();
  const { channelLevel, concordChannelLevel } = useNotifLevels();
  // Part of the deduped payload, so a language switch re-words the native side.
  const locale = languageOf(useIntl().locale);

  const enablement = useSyncExternalStore(
    subscribeEnabled,
    () => enabledState,
    () => "unknown" as const,
  );
  const enabled = enablement === "enabled";
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<NativeNotificationHealth>();
  const [permissionCheckAttempt, setPermissionCheckAttempt] = useState(0);
  const prefs = config.pushPrefs;

  useEffect(() => {
    if (!supported) return;
    return retainAccountExitHandler();
  }, [supported]);

  // Relays from the user's kind 10009 list; a hostless device has no build-time fallback.
  const relayUrls = useMemo(() => {
    const set = new Set<string>();
    for (const g of groupList?.groups ?? []) {
      const n = normalizeRelayUrl(g.relay);
      if (n) set.add(n);
    }
    for (const url of groupList?.servers ?? []) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    // Sorted so a reorder doesn't churn the native config (rebuilding every connection).
    return [...set].sort();
  }, [groupList]);

  // The documents under keys derived from the settings root, for the self-state watch.
  const { keys: settingsKeys } = useSettingsKeys();
  const selfDocs = useMemo(() => nativeSelfDocs(settingsKeys.keyring), [settingsKeys.keyring]);
  // Where the user's own documents live (app relays + NIP-65 read, like `poolGeneralRelays`),
  // for the self-state watch. Separate from `relayUrls`, which is NIP-29 only.
  const selfRelays = useMemo(
    () => selfStateRelays(config, user?.pubkey).sort(),
    [config, user?.pubkey],
  );

  // `nothing` groups are omitted; `mentions` groups are watched but flagged in
  // `mentionOnlyGroupIds`.
  const groupIds = useMemo(
    () =>
      [
        ...new Set(
          (groupList?.groups ?? [])
            .filter((g) => channelLevel(g.relay, g.id) !== "nothing")
            .map((g) => g.id),
        ),
      ].sort(),
    [groupList, channelLevel],
  );

  const mentionOnlyGroupIds = useMemo(
    () =>
      [
        ...new Set(
          (groupList?.groups ?? [])
            .filter((g) => channelLevel(g.relay, g.id) === "mentions")
            .map((g) => g.id),
        ),
      ].sort(),
    [groupList, channelLevel],
  );

  // A NIP-29 group lives on one relay, so each relay's REQ covers only its groups.
  const groupSubs = useMemo(() => {
    const seen = new Set<string>();
    const subs: Array<{ relay: string; id: string; mentionOnly: boolean }> = [];
    for (const g of groupList?.groups ?? []) {
      const level = channelLevel(g.relay, g.id);
      if (level === "nothing") continue;
      const relay = normalizeRelayUrl(g.relay);
      if (!relay) continue;
      const key = `${relay}\u0000${g.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subs.push({ relay, id: g.id, mentionOnly: level === "mentions" });
    }
    subs.sort((a, b) => a.relay.localeCompare(b.relay) || a.id.localeCompare(b.id));
    return subs;
  }, [groupList, channelLevel]);

  // DM relays unioned with the published kind-10050 inbox (like WireSync and useDm17), where
  // NIP-17 senders deliver.
  const {
    relays: publishedDmRelays,
    isReady: dmRelaysReady,
  } = useDmRelayList();
  // `dmsDisabled` → no DM REQ, even with the app dead.
  const dmRelays = useMemo(() => {
    if (config.dmsDisabled) return [];
    const set = new Set<string>();
    for (const url of [...effectiveDmRelays(config), ...publishedDmRelays]) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config, publishedDmRelays]);

  // `dmFollows` is the historical payload name; it carries every established legacy-DM author.
  const dmFollows = dmKnownPeers;

  // Only explicit DM overrides; native falls back to the global pref. Group keys are exact
  // participant sets.
  const dmLevels = useMemo(() => {
    const entries = Object.entries(config.notifLevels)
      .filter(([scope, level]) =>
        scope.startsWith("dm:") &&
        /^(?:[0-9a-f]{64})(?:,[0-9a-f]{64})*$/.test(scope.slice(3)) &&
        (level === "all" || level === "mentions" || level === "nothing"),
      )
      .map(([scope, level]) => [scope.slice(3), level] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries) as Record<string, "all" | "mentions" | "nothing">;
  }, [config.notifLevels]);

  // Same avatar policy as the WebView.
  const mediaPolicy = useMediaPolicyConfig();

  // Signer credential shared with the service (Keystore-sealed, wiped on disable/logout) to open
  // gift wraps and answer NIP-42 with the app dead: nsec key, NIP-55 package, or NIP-46 session. See
  // NativeSigner.java.
  const { logins } = useNostrLogin();
  const login = logins[0];
  const signerCfg = useMemo(():
    | { type: "key"; sk: string }
    | { type: "amber"; packageName: string }
    | { type: "nip46"; clientSk: string; bunkerPk: string; relays: string[] }
    | undefined => {
    try {
      if (login?.type === "nsec") {
        const decoded = nip19.decode(login.data.nsec);
        if (decoded.type === "nsec") return { type: "key", sk: bytesToHex(decoded.data) };
      }
      if (login?.type === "bunker") {
        const decoded = nip19.decode(login.data.clientNsec);
        if (decoded.type === "nsec") {
          return {
            type: "nip46",
            clientSk: bytesToHex(decoded.data),
            bunkerPk: login.data.bunkerPubkey,
            relays: login.data.relays,
          };
        }
      }
      if (login?.type === "x-android-signer") {
        const { packageName } = login.data as { packageName: string };
        if (packageName) return { type: "amber", packageName };
      }
    } catch {
      // Malformed login data — the service just gets no signer.
    }
    return undefined;
  }, [login]);

  const prefsRecord = useMemo<Record<string, boolean>>(
    () => ({
      mentions: prefs.mentions,
      reactions: prefs.reactions,
      replies: prefs.replies,
      directMessages: prefs.directMessages,
      allGroupMessages: prefs.allGroupMessages,
    }),
    [prefs],
  );

  // Concord kind-1059 streams + conversation keys (see useConcordSubs); same `nothing`/`mentions`
  // handling as groups.
  const {
    subs: allConcordSubs,
    ready: concordSubsReady,
    left: concordLeftCommunities,
  } = useConcordSubsState();
  const concordSubs = useMemo(
    () =>
      allConcordSubs
        .map((sub) => ({
          sub,
          level: concordChannelLevel("c2", sub.communityId, sub.channelId),
        }))
        .filter(({ level }) => level !== "nothing")
        .map(({ sub, level }) => ({ ...sub, mentionOnly: level === "mentions" })),
    [allConcordSubs, concordChannelLevel],
  );
  const concordLevels = useMemo(
    () => concordLevelPolicy(config.notifLevels, config.mutedCommunities, config.mutedChannels, prefs),
    [config.notifLevels, config.mutedCommunities, config.mutedChannels, prefs],
  );
  // The route stays local and is never copied into relay filters.
  const gitRepositories = useMemo<GitRepositoryWireInput[]>(() => {
    const byAddress = new Map<string, GitRepositoryWireInput>();
    for (const sub of concordSubs) {
      // Git events have no mention signal, so mentions-only channels get no Git alerts.
      if (sub.mentionOnly) continue;
      for (const attachment of sub.gitAttachments) {
        let repository = byAddress.get(attachment.address.coordinate);
        if (!repository) {
          repository = { address: attachment.address.coordinate, relays: [], attachments: [] };
          byAddress.set(repository.address, repository);
        }
        repository.relays.push(...attachment.relayHints);
        repository.attachments.push({ channelId: sub.channelId, communityId: sub.communityId, attachment });
      }
    }
    return [...byAddress.values()].map((repository) => ({ ...repository, relays: [...new Set(repository.relays)].sort() }));
  }, [concordSubs]);
  const gitTicketRoots = useWireGitTicketRoots(gitRepositories);
  const eventStore = useEventStore();
  const gitAnnouncements = useQuery({
    queryKey: ["native-notifications", "git-announcements", gitRepositories.map((repository) => repository.address).join("|")],
    enabled: gitRepositories.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const store = await eventStore;
      const identifiers = [...new Set(gitRepositories.map((repository) => repository.address.split(":")[2]!))];
      const events = await store.query([{ kinds: [GIT_REPOSITORY_ANNOUNCEMENT_KIND], "#d": identifiers, limit: 1_000 }]);
      return new Map(events.map(parseGitRepositoryAnnouncement).filter((repository): repository is NonNullable<typeof repository> => Boolean(repository)).map((repository) => [repository.address.coordinate, repository]));
    },
  });
  const gitSubs = useMemo(() => gitRepositories.map((repository) => ({
    address: repository.address,
    relays: repository.relays.filter((relay) => !isGitAnnouncementDiscoveryRelay(relay)),
    owner: repository.address.split(":")[1]!,
    // Only a parsed announcement with the exact coordinate contributes trust.
    maintainers: gitAnnouncements.data?.get(repository.address)?.maintainers ?? [],
    attachments: repository.attachments.map(({ channelId, communityId, attachment }) => ({ communityId: communityId ?? "", channelId, attachedAt: attachment.attachedAt, ...(attachment.detachedAt !== undefined ? { detachedAt: attachment.detachedAt } : {}) })),
    ticketRoots: gitTicketRoots.filter((event) => event.tags.some(([name, value]) => name === "a" && value === repository.address)).map((event) => ({ id: event.id, author: event.pubkey, kind: event.kind as 1618 | 1621 })),
  })), [gitRepositories, gitTicketRoots, gitAnnouncements.data]);

  // Readiness per plane: the bridge replaces ready planes and additively merges unready ones.
  useEffect(() => {
    if (!supported) return;

    const loggedOut = !user;
    // A boot-fold seed can't REPLACE native config until the 10009 relay read completes.
    const groupListReady = groupList !== undefined && !groupList.decryptFailed &&
      groupList.wireReady === true;
    // Policy-derived planes wait for the notification document (or local last-good).
    const groupPlaneReady = groupListReady && notificationSettingsReady;
    const concordPlaneReady = concordSubsReady && notificationSettingsReady;
    const gitReady = concordPlaneReady &&
      (gitRepositories.length === 0 || gitAnnouncements.data !== undefined);
    const allReady = notificationSettingsReady && groupListReady && dmPeersConfigReady &&
      dmRelaysReady && concordSubsReady && gitReady;
    const nothingToWatch =
      relayUrls.length === 0 &&
      concordSubs.length === 0 &&
      dmRelays.length === 0 &&
      // `selfRelays` counts too: the self-state subscription keeps the user's documents on disk.
      selfRelays.length === 0;

    const action = nativeNotificationConfigAction({
      loggedOut,
      enablement,
      allReady,
      nothingToWatch,
      persistedConfigEnabled: health?.configEnabled,
    });

    let payload: Parameters<typeof ArmadaNotification.configure>[0];
    if (action === "disable") {
      payload = { enabled: false, locale };
    } else if (action === "preserve") {
      return;
    } else {
      payload = {
        enabled: true,
        locale,
        userPubkey: user!.pubkey,
        groupPlaneReady,
        dmRelayPlaneReady: dmRelaysReady,
        dmRosterPlaneReady: dmPeersConfigReady,
        concordPlaneReady,
        gitPlaneReady: gitReady,
        policyPlaneReady: notificationSettingsReady,
        concordLeftCommunities,
        dmRelays,
        dmFollows,
        dmKnownPeers,
        dmKnownConversations,
        dmMutedPeers,
        selfRelays,
        selfDTags: SELF_SYNC_DTAGS,
        selfDocs,
        signer: signerCfg,
        ...(notificationSettingsReady ? {
          relayUrls,
          groupIds,
          groupSubs,
          mentionOnlyGroupIds,
          prefs: prefsRecord,
          concordSubs,
          concordLevels,
          dmLevels,
          dmRequests: prefs.dmRequests,
          gitSubs,
          mediaPolicy,
        } : {}),
      };
    }

    const nativeNeedsRepair = action === "configure" && health !== undefined && (
      !health.configEnabled ||
      !health.serviceRunning ||
      health.loadedConfigRevision !== health.configRevision
    );
    configureNative(payload, nativeNeedsRepair).catch((err) => {
      console.warn("[native-notif] configure failed:", err);
    });
  }, [supported, enablement, user, notificationSettingsReady, selfDocs, relayUrls, groupIds, groupSubs, mentionOnlyGroupIds, prefsRecord, concordSubs, concordLevels, concordSubsReady, concordLeftCommunities, dmRelays, dmRelaysReady, dmFollows, dmKnownPeers, dmKnownConversations, dmLevels, dmMutedPeers, dmPeersConfigReady, prefs.dmRequests, selfRelays, signerCfg, gitSubs, mediaPolicy, groupList, gitRepositories.length, gitAnnouncements.data, health, locale]);

  // Auto-enable on launch only if intended AND already granted; never prompts here (LoginSetup
  // and Settings do).
  useEffect(() => {
    if (!supported || enablement !== "unknown" || busy || autoChecked) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    autoChecked = true;
    if (!loadIntent()) {
      setEnabledShared("disabled");
      return;
    }
    (async () => {
      try {
        const { granted } = await ArmadaNotification.checkPermission();
        setEnabledShared(granted ? "enabled" : "disabled");
      } catch {
        // An unavailable bridge isn't "off": keep the persisted config and retry.
        autoChecked = false;
        if (!cancelled) {
          retryTimer = window.setTimeout(() => {
            setPermissionCheckAttempt((attempt) => attempt + 1);
          }, 5_000);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [supported, enablement, busy, permissionCheckAttempt]);

  const refreshHealth = useCallback(async () => {
    if (!supported) return;
    try {
      const next = await ArmadaNotification.getHealth();
      setNativeServiceWatching(next.serviceRunning && next.configEnabled);
      setHealth(next);
    } catch {
      // Older APK with a newer WebView: diagnostics are optional.
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    void refreshHealth();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshHealth();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshHealth();
    }, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [supported, refreshHealth]);

  const openSettings = useCallback(async (
    channel?: "messages" | "calls" | "service",
  ) => {
    if (!supported) return;
    await ArmadaNotification.openNotificationSettings({ channel });
  }, [supported]);

  // Used to validate AUTH challenges: only sign kind-22242 for relays we configured.
  const knownRelays = useMemo(() => {
    const set = new Set<string>(relayUrls);
    for (const url of dmRelays) set.add(url);
    for (const sub of concordSubs) {
      for (const url of sub.relays) {
        const n = normalizeRelayUrl(url);
        if (n) set.add(n);
      }
    }
    return set;
  }, [relayUrls, dmRelays, concordSubs]);

  // NIP-42: the service bridges AUTH challenges here; no key enters native code.
  // A background sign, so never the approval nudge (as NostrProvider's own AUTH).
  const signer = useMemo(() => (user?.signer ? withoutNudge(user.signer) : undefined), [user?.signer]);
  useEffect(() => {
    if (!supported || !signer) return;
    let handle: { remove: () => void } | undefined;
    let cancelled = false;
    ArmadaNotification.addListener("authChallenge", async ({ relayUrl, challenge, user: signUser, streams }) => {
      // Ignore challenges for unconfigured relays.
      const normalized = normalizeRelayUrl(relayUrl);
      if (!normalized || !knownRelays.has(normalized)) {
        console.warn("[native-notif] ignoring AUTH for unknown relay:", relayUrl);
        return;
      }
      // Concord stream auth first (local derived keys, see streamAuth.ts), scoped to keys THIS relay
      // hosts; signed in the EC worker pool in batches. The service asks for them only where the
      // relay walled the Concord sub (absent flags: an older service that always wanted both).
      if (streams !== false) {
        try {
          for await (const chunk of signStreamAuthsChunked(challenge, relayUrl)) {
            for (const event of chunk) {
              await ArmadaNotification.submitAuth({ relayUrl, event });
            }
          }
        } catch (err) {
          console.warn("[native-notif] stream AUTH signing failed:", err);
        }
      }
      if (signUser === false) return;
      try {
        const event = await signer.signEvent({
          kind: 22242,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: nowSecs(),
        });
        await ArmadaNotification.submitAuth({ relayUrl, event });
      } catch (err) {
        console.warn("[native-notif] AUTH signing failed:", err);
      }
    }).then((h) => {
      if (cancelled) h.remove();
      else handle = h;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [supported, signer, knownRelays]);

  const enable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      await enableNativeNotifications();
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      saveIntent(false);
      setEnabledShared("disabled");
      await configureNative({ enabled: false, locale });
    } finally {
      setBusy(false);
    }
  }, [supported, locale]);

  const setPrefs = useCallback(async (next: PushPrefs) => {
    savePushPrefs(next, user?.pubkey);
    updateConfig((current) => ({ ...current, pushPrefs: next }));
  }, [updateConfig, user?.pubkey]);

  return {
    supported,
    enabled,
    busy,
    prefs,
    health,
    refreshHealth,
    openSettings,
    enable,
    disable,
    setPrefs,
  };
}
