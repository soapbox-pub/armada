/**
 * useFcmNotifications
 *
 * Registers Firebase Cloud Messaging (FCM) push with a shared nostr-push server
 * on native Android. This is the battery-free, OS-delivered alternative to the
 * "persistent" foreground-service relay connection (useNativeNotifications):
 * the OS holds the push socket and wakes the app only when a push arrives.
 *
 * What FCM can cover (given the server matches events on its own relays and
 * can't decrypt anything):
 *   - Direct messages (kind 4, #p = you): NIP-04 encrypted, so a static
 *     "New direct message" body — exactly what the persistent path shows.
 *   - Concord channel messages (kind 3300, #z = channel pseudonym): the server
 *     can't open the sealed message, so a generic "New message" in the real
 *     channel — mirroring the persistent path's opaque fallback. One
 *     subscription per channel epoch; re-registered when epochs rotate.
 *
 * NIP-29 group messages (#h) are intentionally NOT covered here — the shared
 * server neither matches #h nor monitors per-group relays. Those stay on the
 * persistent path.
 *
 * RPC events are signed with an ephemeral per-device keypair (see nostrPush.ts)
 * so the user's real signer is never prompted. Only meaningful on native
 * Android with Firebase configured; elsewhere `supported` is false and all
 * methods no-op.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { NostrPushClient, type FcmPushSubscription, type PushFilter } from "@/lib/nostrPush";
import { buildConcordSubs, type ConcordSub } from "@/concord-v1/lib/concordNotifications";
import { APP_RELAYS } from "@/lib/platform";

// ─── Native plugin interface (FCM token accessor) ──────────────────────────────

interface ArmadaNotificationFcmPlugin {
  /**
   * Returns this device's FCM registration token and the Firebase project ID
   * from google-services.json. Rejects if Firebase is not configured or Google
   * Play Services is unavailable.
   */
  getFcmToken(): Promise<{ token: string; projectId: string }>;
}

const ArmadaNotification = registerPlugin<ArmadaNotificationFcmPlugin>("ArmadaNotification");

// ─── Config ─────────────────────────────────────────────────────────────────

/** The shared nostr-push server's pubkey (hex). Empty → FCM unsupported. */
const SERVER_PUBKEY: string = import.meta.env.VITE_NOSTR_PUSH_PUBKEY ?? "";

/**
 * Domain used to key subscriptions server-side (per-app namespace). Armada is a
 * hostless native client, so we use a fixed logical domain rather than
 * window.location.hostname (which is "localhost" in the APK).
 */
const DOMAIN = "armada.app";

/**
 * Relays used for the RPC channel to nostr-push. The server listens on its own
 * RELAYS set; Armada's default APP_RELAYS (relay.ditto.pub / relay.dreamith.to)
 * overlap with it, so RPC round-trips land.
 */
const RPC_RELAYS: string[] = APP_RELAYS.length > 0
  ? APP_RELAYS
  : ["wss://relay.ditto.pub/", "wss://relay.dreamith.to/"];

/** localStorage key for the base subscription ID (stable per install). */
const SUBSCRIPTION_ID_KEY = "armada:fcm-subscription-id";
/** localStorage flag: FCM subscriptions are currently registered. */
const FCM_ENABLED_KEY = "armada:fcm-enabled";

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
    localStorage.setItem(FCM_ENABLED_KEY, String(on));
  } catch {
    // ignore
  }
}

function loadEnabledFlag(): boolean {
  try {
    return localStorage.getItem(FCM_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * The set of nostr-push subscriptions this device should hold, derived from the
 * user + their Concord channels. Each has a stable-ish server id suffix so we
 * can register/update/delete idempotently.
 */
interface DesiredSub {
  /** Suffix appended to the base subscription id (`${baseId}-${idSuffix}`). */
  idSuffix: string;
  filter: PushFilter;
  title: string;
  body: string;
}

function buildDesiredSubs(
  userPubkey: string,
  concordSubs: ConcordSub[],
): DesiredSub[] {
  const subs: DesiredSub[] = [];

  // Direct messages (kind 4) addressed to me. NIP-04 encrypted → static body.
  subs.push({
    idSuffix: "dm",
    filter: { kinds: [4], "#p": [userPubkey] },
    title: "New direct message",
    body: "You have a new message",
  });

  // Concord channels (kind 3300) by #z pseudonym. The server can't decrypt, so
  // a generic body in the real channel. `#z` rotates per epoch, so we register
  // one subscription per channel carrying all its retained-epoch pseudonyms;
  // the id suffix is keyed by community+channel so re-registration on rotation
  // replaces the same server record rather than accumulating stale ones.
  const seen = new Set<string>();
  for (const sub of concordSubs) {
    if (sub.zs.length === 0) continue;
    const idSuffix = `concord-${sub.communityId}-${sub.channelName}`.slice(0, 56);
    if (seen.has(idSuffix)) continue;
    seen.add(idSuffix);
    const channel = sub.channelName || "channel";
    subs.push({
      idSuffix,
      filter: { kinds: [3300], "#z": sub.zs },
      title: sub.communityName ? `${sub.communityName} · #${channel}` : `#${channel}`,
      body: "New message",
    });
  }

  return subs;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseFcmNotificationsReturn {
  /** Whether FCM push is available (native Android + server configured). */
  supported: boolean;
  /** Whether FCM subscriptions are currently registered. */
  enabled: boolean;
  /** Whether an enable/disable/sync op is in flight. */
  busy: boolean;
  /** Fetch the FCM token and register DM + Concord subscriptions. */
  enable: () => Promise<void>;
  /** Delete all FCM subscriptions from nostr-push. */
  disable: () => Promise<void>;
}

export function useFcmNotifications(): UseFcmNotificationsReturn {
  const supported = Capacitor.getPlatform() === "android" && !!SERVER_PUBKEY;

  const { user } = useCurrentUser();
  const { data: concordData } = useConcordList();

  const [enabled, setEnabled] = useState<boolean>(supported && loadEnabledFlag());
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<NostrPushClient | null>(null);

  // Concord channel subscriptions (relays + #z pseudonyms + names).
  const concordSubs = useMemo<ConcordSub[]>(
    () => buildConcordSubs(concordData?.list),
    [concordData],
  );

  // Create the RPC client once on mount (native only).
  useEffect(() => {
    if (!supported) return;
    const client = NostrPushClient.create(SERVER_PUBKEY, RPC_RELAYS);
    clientRef.current = client;
    return () => {
      client.destroy();
      clientRef.current = null;
    };
  }, [supported]);

  const registerAll = useCallback(async (userPubkey: string) => {
    const client = clientRef.current;
    if (!client) {
      console.warn("[fcm] NostrPushClient not initialized yet");
      return;
    }

    const { token, projectId } = await ArmadaNotification.getFcmToken();
    if (!token || !projectId) {
      throw new Error("[fcm] Native layer returned no FCM token / project ID");
    }

    const pushSubscription: FcmPushSubscription = {
      type: "fcm",
      device_token: token,
      project_id: projectId,
    };

    const baseId = getOrCreateSubscriptionId();
    const desired = buildDesiredSubs(userPubkey, concordSubs);

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
              icon: "/icon-192.png",
              badge: "/icon-192.png",
            },
            push_subscription: pushSubscription,
          })
          .catch((err) => console.error(`[fcm] register ${d.idSuffix} failed:`, err)),
      ),
    );
  }, [concordSubs]);

  // Re-register whenever the Concord channel set changes while enabled (epoch
  // rotation adds/removes #z pseudonyms). Debounced via a serialized signature.
  const lastSig = useRef<string>("");
  useEffect(() => {
    if (!supported || !enabled || !user) return;
    const desired = buildDesiredSubs(user.pubkey, concordSubs);
    const sig = JSON.stringify(desired.map((d) => [d.idSuffix, d.filter]));
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    registerAll(user.pubkey).catch((err) => console.warn("[fcm] re-register failed:", err));
  }, [supported, enabled, user, concordSubs, registerAll]);

  const enable = useCallback(async () => {
    if (!supported || !user) return;
    setBusy(true);
    try {
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
        const desired = buildDesiredSubs(user.pubkey, concordSubs);
        await Promise.allSettled(
          desired.map((d) =>
            client
              .deleteSubscription({ subscription_id: `${baseId}-${d.idSuffix}`, domain: DOMAIN })
              .catch((err) => console.error(`[fcm] delete ${d.idSuffix} failed:`, err)),
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

  return { supported, enabled, busy, enable, disable };
}
