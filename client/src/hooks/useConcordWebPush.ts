/**
 * useConcordWebPush
 *
 * PWA / browser Web Push for the notifications the relay's own gateway can't
 * produce: Concord (E2E) channel messages and direct messages. Registers VAPID
 * Web Push subscriptions with the shared nostr-push server — the same server and
 * the same logical subscriptions the native Android FCM path uses
 * (useFcmNotifications), just over the `type: "web"` transport.
 *
 * Why this exists: the relay's Web Push gateway (server/push.go) only notifies
 * for events it can attribute to a recipient (group chat, mentions, reactions,
 * replies, DMs it stores). It cannot handle Concord, whose events are addressed
 * by rotating `#z` pseudonyms the relay can't map to a user. nostr-push CAN
 * match `#z` generically, and the client holds the pseudonyms — so a PWA
 * registers those filters here and gets a generic "New message in #channel".
 *
 * This works on installed iOS PWAs (iOS 16.4+, Home Screen), which is the only
 * way iOS delivers Web Push at all.
 *
 * Flow:
 *   enable():  request Notification permission → fetch nostr-push's per-domain
 *              VAPID key → pushManager.subscribe() → register web subscriptions.
 *   disable(): delete the server records and unsubscribe the browser.
 *
 * RPC events are signed with an ephemeral per-device key (see nostrPush.ts), so
 * the user's real signer is never prompted.
 */

import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { NostrPushClient, type WebPushSubscription } from "@/lib/nostrPush";
import { buildConcordSubs, type ConcordSub } from "@/concord-v1/lib/concordNotifications";
import { buildDesiredPushSubs, pushSubsSignature } from "@/lib/pushSubscriptions";
import { APP_RELAYS } from "@/lib/platform";

// ─── Config ─────────────────────────────────────────────────────────────────

/** The shared nostr-push server's pubkey (hex). Empty → web push unsupported. */
const SERVER_PUBKEY: string = import.meta.env.VITE_NOSTR_PUSH_PUBKEY ?? "";

/**
 * Domain used to key subscriptions server-side (per-app namespace) AND to fetch
 * the per-domain VAPID key. Must match the value in useFcmNotifications so the
 * two paths share one server namespace.
 */
const DOMAIN = "armada.app";

/** Relays used for the RPC channel to nostr-push (overlap with the server's). */
const RPC_RELAYS: string[] = APP_RELAYS.length > 0
  ? APP_RELAYS
  : ["wss://relay.ditto.pub/", "wss://relay.dreamith.to/"];

/** localStorage key for the base subscription ID (stable per install). */
const SUBSCRIPTION_ID_KEY = "armada:webpush-subscription-id";
/** localStorage flag: web-push subscriptions are currently registered. */
const ENABLED_KEY = "armada:webpush-enabled";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreateSubscriptionId(): string {
  try {
    const existing = localStorage.getItem(SUBSCRIPTION_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(SUBSCRIPTION_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function getSubscriptionId(): string | null {
  try {
    return localStorage.getItem(SUBSCRIPTION_ID_KEY);
  } catch {
    return null;
  }
}

function setEnabledFlag(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(on));
  } catch {
    // ignore
  }
}

function loadEnabledFlag(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

/** base64url (VAPID public key) → ArrayBuffer for applicationServerKey. */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/** Extract the nostr-push `WebPushSubscription` shape from a browser subscription. */
function toWebPushSubscription(sub: PushSubscription): WebPushSubscription {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("web-push: browser subscription missing endpoint/keys");
  }
  return { type: "web", endpoint: json.endpoint, p256dh_key: p256dh, auth_key: auth };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseConcordWebPushReturn {
  /** Whether Concord/DM Web Push is available (browser + server configured). */
  supported: boolean;
  /** Current Notification permission. */
  permission: NotificationPermission;
  /** Whether subscriptions are currently registered. */
  enabled: boolean;
  /** Whether an enable/disable/sync op is in flight. */
  busy: boolean;
  /** Request permission, subscribe, and register DM + Concord subscriptions. */
  enable: () => Promise<void>;
  /** Delete all subscriptions from nostr-push and unsubscribe the browser. */
  disable: () => Promise<void>;
}

export function useConcordWebPush(): UseConcordWebPushReturn {
  const supported =
    !Capacitor.isNativePlatform() &&
    !!SERVER_PUBKEY &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  const { user } = useCurrentUser();
  const { data: concordData } = useConcordList();

  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState<boolean>(supported && loadEnabledFlag());
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<NostrPushClient | null>(null);

  const concordSubs = useMemo<ConcordSub[]>(
    () => buildConcordSubs(concordData?.list),
    [concordData],
  );

  // Create the RPC client once (web + server configured).
  useEffect(() => {
    if (!supported) return;
    const client = NostrPushClient.create(SERVER_PUBKEY, RPC_RELAYS);
    clientRef.current = client;
    return () => {
      client.destroy();
      clientRef.current = null;
    };
  }, [supported]);

  /**
   * Obtain (or reuse) the browser's VAPID subscription for nostr-push's key.
   * Kept separate from the relay-gateway subscription (usePushNotifications) by
   * using nostr-push's own per-domain VAPID key — a browser may hold one push
   * subscription per applicationServerKey.
   */
  const ensureBrowserSubscription = useCallback(async (): Promise<PushSubscription> => {
    const client = clientRef.current;
    if (!client) throw new Error("web-push: RPC client not ready");

    const reg = await navigator.serviceWorker.ready;
    const vapidKey = await client.getVapidKey(DOMAIN);

    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // Reuse only if it was created for nostr-push's key; otherwise it belongs
      // to the relay gateway (usePushNotifications) — leave that one alone and
      // fail loudly rather than clobbering it.
      const appKey = existing.options?.applicationServerKey;
      if (appKey && sameKey(appKey, vapidKey)) return existing;
    }

    return reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(vapidKey),
    });
  }, []);

  const registerAll = useCallback(async (userPubkey: string) => {
    const client = clientRef.current;
    if (!client) {
      console.warn("[webpush] NostrPushClient not initialized yet");
      return;
    }

    const browserSub = await ensureBrowserSubscription();
    const pushSubscription = toWebPushSubscription(browserSub);

    const baseId = getOrCreateSubscriptionId();
    const desired = buildDesiredPushSubs(userPubkey, concordSubs);

    await Promise.allSettled(
      desired.map((d) =>
        client
          .registerSubscription({
            subscription_id: `${baseId}-${d.idSuffix}`,
            domain: DOMAIN,
            filter: d.filter,
            notification: {
              title: d.title,
              body: d.body,
              icon: "/logo-192.png",
              badge: "/logo-192.png",
            },
            push_subscription: pushSubscription,
          })
          .catch((err) => console.error(`[webpush] register ${d.idSuffix} failed:`, err)),
      ),
    );
  }, [concordSubs, ensureBrowserSubscription]);

  // Restore enabled state on mount: if permission is granted and a subscription
  // already exists, we're enabled.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (existing && Notification.permission === "granted" && loadEnabledFlag()) {
          setEnabled(true);
        }
      } catch {
        // SW not ready — leave disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Re-register whenever the Concord channel set changes while enabled (epoch
  // rotation adds/removes #z pseudonyms). Debounced via a serialized signature.
  const lastSig = useRef<string>("");
  useEffect(() => {
    if (!supported || !enabled || !user) return;
    const desired = buildDesiredPushSubs(user.pubkey, concordSubs);
    const sig = pushSubsSignature(desired);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    registerAll(user.pubkey).catch((err) => console.warn("[webpush] re-register failed:", err));
  }, [supported, enabled, user, concordSubs, registerAll]);

  const enable = useCallback(async () => {
    if (!supported || !user) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;
      await registerAll(user.pubkey);
      setEnabledFlag(true);
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }, [supported, user, registerAll]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const client = clientRef.current;
      const baseId = getSubscriptionId();
      if (client && baseId && user) {
        const desired = buildDesiredPushSubs(user.pubkey, concordSubs);
        await Promise.allSettled(
          desired.map((d) =>
            client
              .deleteSubscription({ subscription_id: `${baseId}-${d.idSuffix}`, domain: DOMAIN })
              .catch((err) => console.error(`[webpush] delete ${d.idSuffix} failed:`, err)),
          ),
        );
      }
      setEnabledFlag(false);
      setEnabled(false);
      lastSig.current = "";
    } finally {
      setBusy(false);
    }
  }, [user, concordSubs]);

  return { supported, permission, enabled, busy, enable, disable };
}

/** Compare a browser `applicationServerKey` (ArrayBuffer) to a base64url VAPID key. */
function sameKey(appKey: ArrayBuffer, base64Vapid: string): boolean {
  try {
    const a = new Uint8Array(appKey);
    const b = new Uint8Array(urlBase64ToBuffer(base64Vapid));
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch {
    return false;
  }
}
