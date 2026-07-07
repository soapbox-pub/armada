/**
 * nostr-push RPC client
 *
 * Sends RPC calls to a shared nostr-push server via encrypted Nostr events
 * (kind 25742, NIP-44) and awaits a confirmation response. The server observes
 * matching events on its relays and delivers a push (FCM to native Android, or
 * VAPID Web Push to browsers / installed PWAs) to registered devices, so Armada
 * gets battery-free, OS-delivered notifications with the app closed — an
 * alternative to the persistent foreground-service relay connection.
 *
 * Uses an ephemeral keypair (generated once, persisted in localStorage) to sign
 * RPC events, so the user's real signer is never prompted. The key is
 * per-device and disposable: a leaked copy only reveals which events this device
 * wants pushed (e.g. its Concord `#z` pseudonyms), never the user's identity.
 *
 * Protocol:
 *   Request:  kind 25742, tags [["p", serverPubkey]]
 *             content: nip44Encrypt(serverPubkey, JSON.stringify({ method, params, request_id }))
 *
 *   Response: kind 25742, tags [["p", clientPubkey]], authored by serverPubkey
 *             content: nip44Encrypt(clientPubkey, JSON.stringify({ request_id, success, error? }))
 */

import { nip44, generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from "nostr-tools";
import type { Filter } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// ─── Ephemeral device key ─────────────────────────────────────────────────────

const DEVICE_KEY_STORAGE = "armada-push-device-key";

/**
 * Get or generate a persistent ephemeral key for this device, used to sign
 * nostr-push RPC events without prompting the user's signer.
 *
 * Stored in localStorage (Armada has no secure-storage abstraction). The key is
 * ephemeral and per-device, so a plaintext copy only leaks which Nostr events
 * this device wants pushed — not the user's identity.
 */
function getDeviceSecretKey(): Uint8Array {
  try {
    const stored = localStorage.getItem(DEVICE_KEY_STORAGE);
    if (stored) return hexToBytes(stored);
  } catch {
    // localStorage unavailable — fall through to a throwaway key.
  }
  const sk = generateSecretKey();
  try {
    localStorage.setItem(DEVICE_KEY_STORAGE, bytesToHex(sk));
  } catch {
    // ignore — key just won't persist across launches this session.
  }
  return sk;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Firebase Cloud Messaging subscription (Android native / iOS via Firebase). */
export interface FcmPushSubscription {
  type: "fcm";
  device_token: string;
  project_id: string;
}

/**
 * VAPID Web Push subscription (browsers / installed PWAs, including iOS 16.4+
 * Home-Screen PWAs). The three fields come straight from a
 * `PushSubscription.toJSON()` (`endpoint`, `keys.p256dh`, `keys.auth`). The
 * server signs a VAPID push to `endpoint` when a filter matches — so a PWA can
 * receive Concord / DM notifications the relay's own gateway can't produce.
 */
export interface WebPushSubscription {
  type: "web";
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}

/** Any transport nostr-push accepts (FCM for native Android, web for PWAs). */
export type PushSubscription_ = FcmPushSubscription | WebPushSubscription;

/**
 * A nostr-push subscription filter. Beyond the common fields, any single-letter
 * tag filter (`#z` for Concord channel pseudonyms, `#p` for DMs, etc.) is
 * passed through verbatim — the server matches them generically.
 */
export interface PushFilter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  "#e"?: string[];
  "#p"?: string[];
  "#t"?: string[];
  "#z"?: string[];
  [tag: `#${string}`]: string[] | undefined;
}

export interface RegisterSubscriptionParams {
  subscription_id: string;
  domain: string;
  filter: PushFilter;
  notification: {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
  };
  push_subscription: PushSubscription_;
}

export interface UpdateSubscriptionParams {
  subscription_id: string;
  domain: string;
  updates: {
    is_active?: boolean;
    filter?: PushFilter;
    notification?: RegisterSubscriptionParams["notification"];
    push_subscription?: PushSubscription_;
  };
}

export interface DeleteSubscriptionParams {
  subscription_id: string;
  domain: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

/** How long to wait for a server response before giving up. */
const RESPONSE_TIMEOUT_MS = 15_000;

export class NostrPushClient {
  private pool: SimplePool;
  private secretKey: Uint8Array;
  private publicKey: string;

  private constructor(
    /** The nostr-push server's pubkey (hex). */
    private readonly serverPubkey: string,
    /** Relays to publish RPC calls to. */
    private readonly relays: string[],
    secretKey: Uint8Array,
  ) {
    this.pool = new SimplePool();
    this.secretKey = secretKey;
    this.publicKey = getPublicKey(secretKey);
  }

  /** Create a new client, loading (or generating) the device key. */
  static create(serverPubkey: string, relays: string[]): NostrPushClient {
    return new NostrPushClient(serverPubkey, relays, getDeviceSecretKey());
  }

  /** Register (or replace) a push subscription. */
  async registerSubscription(params: RegisterSubscriptionParams): Promise<void> {
    await this.send("register_subscription", params);
  }

  /**
   * Fetch the server's VAPID public key for a domain (base64url). Web Push
   * clients must pass this as `applicationServerKey` to `pushManager.subscribe()`
   * BEFORE registering a `type: "web"` subscription — the key is generated
   * per-domain server-side, so the same `domain` must be used for both calls.
   */
  async getVapidKey(domain: string): Promise<string> {
    const result = (await this.send("get_vapid_key", { domain })) as
      | { vapid_public_key?: string }
      | undefined;
    const key = result?.vapid_public_key;
    if (!key) throw new Error("nostr-push: server returned no VAPID public key");
    return key;
  }

  /** Update an existing push subscription (e.g. activate/deactivate). */
  async updateSubscription(params: UpdateSubscriptionParams): Promise<void> {
    await this.send("update_subscription", params);
  }

  /** Delete a push subscription by its ID. */
  async deleteSubscription(params: DeleteSubscriptionParams): Promise<void> {
    await this.send("delete_subscription", params);
  }

  /** Close the relay pool. */
  destroy(): void {
    this.pool.close(this.relays);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async send(method: string, params: object): Promise<unknown> {
    const request_id = crypto.randomUUID();

    const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, this.serverPubkey);
    const encryptedContent = nip44.v2.encrypt(
      JSON.stringify({ method, params, request_id }),
      conversationKey,
    );

    const event = finalizeEvent(
      {
        kind: 25742,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.serverPubkey]],
        content: encryptedContent,
      },
      this.secretKey,
    );

    // Subscribe for the response BEFORE publishing so we don't miss a fast reply.
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.close();
        reject(new Error(`nostr-push: RPC timeout (${method})`));
      }, RESPONSE_TIMEOUT_MS);

      const responseFilter: Filter = {
        kinds: [25742],
        authors: [this.serverPubkey],
        "#p": [this.publicKey],
        since: Math.floor(Date.now() / 1000) - 5,
      };

      const sub = this.pool.subscribeMany(
        this.relays,
        responseFilter,
        {
          onevent: (responseEvent) => {
            try {
              const decrypted = nip44.v2.decrypt(responseEvent.content, conversationKey);
              const response = JSON.parse(decrypted) as {
                request_id: string;
                success: boolean;
                error?: string;
                result?: unknown;
              };

              if (response.request_id !== request_id) return;

              clearTimeout(timeout);
              sub.close();

              if (response.success) resolve(response.result);
              else reject(new Error(response.error ?? "RPC call failed"));
            } catch {
              // Ignore events we can't decrypt.
            }
          },
        },
      );
    });

    // Publish to relays — at least one must accept.
    await Promise.any(this.pool.publish(this.relays, event)).catch(() => {
      throw new Error("nostr-push: failed to publish RPC event to any relay");
    });

    return responsePromise;
  }
}
