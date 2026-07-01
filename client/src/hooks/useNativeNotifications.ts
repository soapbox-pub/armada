import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useFollowList } from "@/hooks/useFollowList";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import {
  DEFAULT_PUSH_PREFS,
  type PushPrefs,
} from "@/hooks/usePushNotifications";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { buildConcordSubs, type ConcordSub } from "@/concord-v1/lib/concordNotifications";
import { useConcord2Subs } from "@/concord-v2/hooks/useConcord2Subs";
import { signStreamAuths } from "@/concord-v2/lib/streamAuth";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { normalizeRelayUrl } from "@/lib/platform";
import { loadNotificationStyle, saveNotificationStyle, type NotificationStyle } from "@/lib/notificationStyle";

/** localStorage key for the native background-notification intent (toggle). */
const NATIVE_INTENT_KEY = "armada:native-notif-intent";
/** Shared per-type prefs with the web-push path. */
const PREFS_KEY = "armada:push-prefs";

/** True only inside the Capacitor native runtime (the APK), not web/PWA. */
export function isNativeRuntime(): boolean {
  return Capacitor.isNativePlatform();
}

function loadIntent(): boolean {
  try {
    const raw = localStorage.getItem(NATIVE_INTENT_KEY);
    // Opt-out: background notifications are intended-on by default. They only
    // actually start once the OS notification permission is granted (which may
    // need one tap on Android 13+); the intent persists across launches.
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

function loadPrefs(): PushPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PUSH_PREFS };
}

export interface UseNativeNotificationsReturn {
  /** Whether we're in the native APK (where this path applies). */
  supported: boolean;
  /** Whether the user has turned background notifications on. */
  enabled: boolean;
  /** Whether an enable/disable op is in flight. */
  busy: boolean;
  /** Current per-type prefs. */
  prefs: PushPrefs;
  /** Current delivery style. The persistent service only runs when "persistent". */
  style: NotificationStyle;
  /** Request notification permission, then start the background service. */
  enable: () => Promise<void>;
  /** Stop the background service. */
  disable: () => Promise<void>;
  /** Update per-type prefs (re-configures the running service). */
  setPrefs: (next: PushPrefs) => Promise<void>;
  /** Switch delivery style; tears the persistent service down when "push". */
  setStyle: (next: NotificationStyle) => void;
}

/**
 * Native (Android APK) background notifications.
 *
 * Instead of Web Push — which the Android System WebView doesn't support — the
 * APK runs a foreground service holding a persistent Nostr REQ to the relay,
 * firing local notifications instantly. This hook is the JS control surface:
 * it feeds the service the user's pubkey, relay URLs, joined group ids and
 * prefs, and re-configures it whenever any of those change.
 *
 * On web/PWA this hook is inert (`supported === false`); the web-push path
 * (usePushNotifications) handles those.
 */
export function useNativeNotifications(): UseNativeNotificationsReturn {
  const supported = isNativeRuntime();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { data: groupList } = useUserGroupList();
  const { data: concordData } = useConcordList();
  const { data: followData } = useFollowList();

  // Start dormant; the auto-enable effect below flips this on at launch (after
  // requesting the OS permission if it hasn't been granted yet).
  const [enabled, setEnabled] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPrefs);
  const [style, setStyleState] = useState<NotificationStyle>(loadNotificationStyle);

  // The relays to hold open. A standalone Armada client has no host, so the
  // source of truth is the user's own kind 10009 list: the relays that host
  // their joined groups, plus any servers they've added. We deliberately do
  // NOT use PLATFORM_RELAYS here — that's a hosted-deployment / dev pin (it
  // defaults to ws://localhost), which is meaningless on a hostless device.
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
    // Sorted so a relay-list refetch that merely reorders doesn't churn the
    // native config (which would tear down + rebuild every connection).
    return [...set].sort();
  }, [groupList]);

  // Joined group ids (the `h` tag values) for the kind-9 filter.
  const groupIds = useMemo(
    () => [...new Set((groupList?.groups ?? []).map((g) => g.id))].sort(),
    [groupList],
  );

  // DM relays: where kind-4 DMs are read from (config.appRelays, or the user's
  // own DM relays if opted in). These are NOT the NIP-29 group relays — DMs
  // live on the general app relays and are addressed by #p, so they get their
  // own connection + filter.
  const dmRelays = useMemo(() => {
    const set = new Set<string>();
    for (const url of effectiveDmRelays(config)) {
      const n = normalizeRelayUrl(url);
      if (n) set.add(n);
    }
    return [...set].sort();
  }, [config]);

  // People the user follows (kind 3). The kind-4 DM subscription is scoped to
  // `authors:[...dmFollows]` so the service only fires DM notifications from
  // friends — matching the client's permanent friends-only DM view. Sorted so a
  // follow-list refetch that merely reorders doesn't churn the native config.
  const dmFollows = useMemo(
    () => [...new Set(followData?.pubkeys ?? [])].sort(),
    [followData?.pubkeys],
  );

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

  // Concord (E2E) channel subscriptions: relays + #z pseudonyms + display names.
  // Computed here (we hold the channel keys); the native service can't decrypt
  // so it only fires generic "New message in <community>/#<channel>".
  const concordSubs = useMemo<ConcordSub[]>(
    () => buildConcordSubs(concordData?.list),
    [concordData],
  );

  // Concord V2 channel subscriptions: kind-1059 stream addresses + the
  // conversation keys that open their wraps (see useConcord2Subs).
  const concord2Subs = useConcord2Subs();

  // Push the current config to the native service whenever the relevant inputs
  // change. Three cases:
  //   - turned off / logged out  → tear the service down ({enabled:false}).
  //   - on, but nothing to watch  → do nothing. The lists load async and
  //     transiently read empty; pushing an empty config here would clobber a
  //     working subscription and drop notifications.
  //   - on, with relays/concord   → push the full config.
  const lastConfig = useRef<string>("");
  useEffect(() => {
    if (!supported) return;

    const loggedOut = !user;
    const turnedOff = !enabled;
    // When the user chose FCM ("push"), the persistent foreground service must
    // NOT run — FCM delivers instead. Tear it down.
    const pushStyle = style === "push";
    const nothingToWatch =
      relayUrls.length === 0 &&
      concordSubs.length === 0 &&
      concord2Subs.length === 0 &&
      dmRelays.length === 0;

    let payload: Parameters<typeof ArmadaNotification.configure>[0];
    if (turnedOff || loggedOut || pushStyle) {
      payload = { enabled: false };
    } else if (nothingToWatch) {
      // Still loading the user's groups/communities — keep whatever's running.
      return;
    } else {
      payload = {
        enabled: true,
        userPubkey: user!.pubkey,
        relayUrls,
        groupIds,
        prefs: prefsRecord,
        concordSubs,
        concord2Subs,
        dmRelays,
        dmFollows,
      };
    }

    // Avoid redundant native round-trips.
    const key = JSON.stringify(payload);
    if (key === lastConfig.current) return;
    lastConfig.current = key;

    ArmadaNotification.configure(payload).catch((err) => {
      console.warn("[native-notif] configure failed:", err);
    });
  }, [supported, enabled, user, relayUrls, groupIds, prefsRecord, concordSubs, concord2Subs, dmRelays, dmFollows, style]);

  // Auto-enable on launch (opt-out, like Ditto): if the user hasn't turned it
  // off, start the background service. Android lets us request the OS
  // notification permission on launch without a user gesture (unlike the web,
  // which gates requestPermission() behind a click), so we surface the system
  // permission dialog directly here rather than via an in-app modal:
  //   - already granted          → enable silently.
  //   - still "default" (unasked) → fire the native OS prompt; enable on grant.
  //   - denied                    → checkPermission stays false, request is a
  //                                 no-op; the Settings toggle remains.
  // The intent persists across launches, so a user who dismisses the OS prompt
  // is re-asked next launch (until granted/denied), and once granted it sticks.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!supported || enabled || busy || autoTried.current) return;
    if (!loadIntent()) return;
    autoTried.current = true;
    (async () => {
      try {
        const { granted } = await ArmadaNotification.checkPermission();
        if (granted) {
          setEnabled(true);
          return;
        }
        // Not granted yet — surface the system permission dialog on launch.
        const res = await ArmadaNotification.requestPermission();
        if (res.granted) setEnabled(true);
      } catch {
        // Permission check/request failed — leave dormant.
      }
    })();
  }, [supported, enabled, busy]);

  // The complete set of relays we actually told the native service to watch.
  // Used to validate AUTH challenges before signing: we only sign a kind-22242
  // for a relay we configured, never one the native layer invents.
  const knownRelays = useMemo(() => {
    const set = new Set<string>(relayUrls);
    for (const url of dmRelays) set.add(url);
    for (const sub of concordSubs) {
      for (const url of sub.relays) {
        const n = normalizeRelayUrl(url);
        if (n) set.add(n);
      }
    }
    for (const sub of concord2Subs) {
      for (const url of sub.relays) {
        const n = normalizeRelayUrl(url);
        if (n) set.add(n);
      }
    }
    return set;
  }, [relayUrls, dmRelays, concordSubs, concord2Subs]);

  // NIP-42: the service can't sign, so it bridges each relay's AUTH challenge
  // here. We sign a kind-22242 with the user's signer (nsec / bunker /
  // extension — all handled in the WebView) and hand it back. No key ever
  // enters native code.
  const signer = user?.signer;
  useEffect(() => {
    if (!supported || !signer) return;
    let handle: { remove: () => void } | undefined;
    let cancelled = false;
    ArmadaNotification.addListener("authChallenge", async ({ relayUrl, challenge }) => {
      // Only sign for a relay we configured; ignore challenges for anything
      // else so a rogue/unexpected relay URL can't elicit a signature.
      const normalized = normalizeRelayUrl(relayUrl);
      if (!normalized || !knownRelays.has(normalized)) {
        console.warn("[native-notif] ignoring AUTH for unknown relay:", relayUrl);
        return;
      }
      // Concord V2 stream auth first: an auth-gating relay requires every
      // `authors` entry of the service's kind-1059 REQ to be authenticated on
      // that connection. These signatures are local (derived stream secret
      // keys, see streamAuth.ts), so they never wait on the user's signer.
      try {
        for (const event of signStreamAuths(challenge, relayUrl)) {
          await ArmadaNotification.submitAuth({ relayUrl, event });
        }
      } catch (err) {
        console.warn("[native-notif] stream AUTH signing failed:", err);
      }
      try {
        const event = await signer.signEvent({
          kind: 22242,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: Math.floor(Date.now() / 1000),
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
      const { granted } = await ArmadaNotification.requestPermission();
      if (!granted) return;
      saveIntent(true);
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      saveIntent(false);
      setEnabled(false);
      await ArmadaNotification.configure({ enabled: false });
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const setPrefs = useCallback(async (next: PushPrefs) => {
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const setStyle = useCallback((next: NotificationStyle) => {
    setStyleState(next);
    saveNotificationStyle(next);
  }, []);

  return { supported, enabled, busy, prefs, style, enable, disable, setPrefs, setStyle };
}
