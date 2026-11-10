/**
 * nostr-push2 client (kind 25742 + NIP-44; see nostr-push2's NIP.md).
 *
 * Stands in for `window.napp.push` in a plain browser and on iOS: takes the
 * same `NappSubscription[]` (`nappPush.ts`), watches its own relays, and
 * delivers the same `napp.push.payload` a Tenna host would — by Web Push to
 * the worker, or by APNs to the Notification Service Extension.
 *
 *   - The client is an EPHEMERAL per-install key, never the person's own, so
 *     requests need no signer prompt or login NIP-44 (bunker and extension
 *     logins get push too) and the gateway learns nothing about whose device
 *     it is.
 *   - A browser install generates its own VAPID key once and hands the private
 *     half over in `create`; the browser subscription is made against it.
 *
 * `set` replaces the list whole; keeping a partial snapshot from pruning is the
 * caller's job (`carryForwardWatches`).
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools";

import { PowNSecSigner } from "@/lib/pow";
import { clockNowMs } from "@/lib/relayClock";

import type { NostrEvent, NostrFilter } from "@nostrify/types";
import type { NappSubscription } from "@/lib/nappPush";

/** Requests and responses both. Ephemeral: relays pass it on, store nothing. */
export const KIND_NOSTR_PUSH2_RPC = 25742;

const RPC_TIMEOUT_MS = 20_000;

export interface PushRelayPool {
  relay(url: string): {
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
    req(
      filters: NostrFilter[],
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<(string | NostrEvent)[]>;
  };
}

/** How the gateway reaches a browser: `PushSubscription.toJSON()` plus our VAPID key. */
export interface WebPushConnection {
  method: "web";
  endpoint: string;
  /** base64url, 65 bytes. */
  p256dh: string;
  /** base64url, 16 bytes. */
  auth: string;
  /** base64url, 32 bytes: the JWK `d` of the key the browser subscribed with. */
  vapid_private_key: string;
}

/**
 * How the gateway reaches the iOS app. A token is minted against exactly one
 * APNs host, so `environment` comes from the build's `aps-environment`.
 */
export interface ApnsConnection {
  method: "apn";
  /** 64 hex characters. */
  token: string;
  /** The bundle id. */
  topic: string;
  environment: "sandbox" | "production";
}

export type PushConnection = WebPushConnection | ApnsConnection;

export class NostrPush2Error extends Error {}

/** The gateway forgot this client (30 idle days, or a Gone endpoint). */
export function isUnknownClientError(err: unknown): boolean {
  return err instanceof NostrPush2Error && /unknown client/i.test(err.message);
}

export interface NostrPush2ClientOptions {
  servicePubkey: string;
  /** Where requests are published and responses awaited. */
  relays: string[];
  /** The install's own client key. */
  secretKey: Uint8Array;
  pool: PushRelayPool;
  now?: () => number;
  timeoutMs?: number;
}

type RpcResponse = { id: string; result: unknown } | { id: string; error: string };

function requestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export class NostrPush2Client {
  readonly #service: string;
  readonly #relays: string[];
  readonly #signer: PowNSecSigner;
  readonly #pool: PushRelayPool;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(opts: NostrPush2ClientOptions) {
    this.#service = opts.servicePubkey;
    this.#relays = opts.relays;
    this.#signer = new PowNSecSigner(opts.secretKey);
    this.#pool = opts.pool;
    this.#now = opts.now ?? clockNowMs;
    this.#timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  }

  /** Register, or replace, how this client is reached. Keeps its subscriptions. */
  async create(connection: PushConnection): Promise<void> {
    await this.call("create", connection);
  }

  /** Replace every subscription. An empty list clears them. */
  async set(subscriptions: NappSubscription[]): Promise<void> {
    await this.call("set", { subscriptions });
  }

  async get(): Promise<NappSubscription[]> {
    const result = await this.call("get");
    const subs = (result as { subscriptions?: unknown })?.subscriptions;
    return Array.isArray(subs) ? subs as NappSubscription[] : [];
  }

  /** Remove the client and its subscriptions. Not an error when absent. */
  async delete(): Promise<void> {
    await this.call("delete");
  }

  async ping(): Promise<void> {
    await this.call("ping");
  }

  private async call(method: string, params?: unknown): Promise<unknown> {
    const pubkey = await this.#signer.getPublicKey();
    const id = requestId();
    const content = await this.#signer.nip44.encrypt(
      this.#service,
      JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
    );
    const request = await this.#signer.signEvent({
      kind: KIND_NOSTR_PUSH2_RPC,
      content,
      tags: [["p", this.#service]],
      created_at: Math.floor(this.#now() / 1000),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      // The kind is ephemeral: a response published before our REQ is open is
      // gone for good, so listen first.
      const reply = this.awaitReply(pubkey, id, controller.signal);
      await Promise.allSettled(
        this.#relays.map((url) => this.#pool.relay(url).event(request, { signal: controller.signal })),
      );
      const response = await reply;
      if ("error" in response) {
        throw new NostrPush2Error(String(response.error || `Push ${method} failed`));
      }
      return response.result;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private awaitReply(pubkey: string, id: string, signal: AbortSignal): Promise<RpcResponse> {
    const filter: NostrFilter = {
      kinds: [KIND_NOSTR_PUSH2_RPC],
      authors: [this.#service],
      "#p": [pubkey],
      since: Math.floor(this.#now() / 1000) - 5,
    };

    return new Promise<RpcResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      signal.addEventListener("abort", () =>
        finish(() => reject(new NostrPush2Error("The push service did not answer"))));

      const drain = async (url: string) => {
        try {
          for await (const msg of this.#pool.relay(url).req([filter], { signal })) {
            if (settled) return;
            if (msg[0] !== "EVENT") continue;
            const event = msg[2] as { content: string };
            let response: RpcResponse;
            try {
              response = JSON.parse(await this.#signer.nip44.decrypt(this.#service, event.content));
            } catch {
              continue;
            }
            if (response?.id !== id) continue;
            finish(() => resolve(response));
            return;
          }
        } catch {
          // This relay closed or aborted; another may still answer.
        }
      };
      for (const url of this.#relays) void drain(url);
    });
  }
}

/**
 * What this install is to the gateway: its client key, and the VAPID key its
 * browser subscription is made against. Neither is the person's; both are
 * generated here once and kept, since a new VAPID key means a new browser
 * subscription. Logout's storage purge takes them, and the next session starts
 * as a new install.
 */
export interface NostrPush2Identity {
  secretKey: Uint8Array;
  /** base64url JWK `d`. */
  vapidPrivateKey: string;
  /** base64url uncompressed point, the browser's `applicationServerKey`. */
  vapidPublicKey: string;
}

const IDENTITY_KEY = "armada:nostr-push2-identity:v1";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let memoryIdentity: NostrPush2Identity | undefined;

export async function loadNostrPush2Identity(): Promise<NostrPush2Identity> {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as { sk?: unknown; vapidPrivateKey?: unknown; vapidPublicKey?: unknown };
      if (
        typeof stored.sk === "string" && /^[0-9a-f]{64}$/.test(stored.sk)
        && typeof stored.vapidPrivateKey === "string"
        && typeof stored.vapidPublicKey === "string"
      ) {
        return {
          secretKey: hexToBytes(stored.sk),
          vapidPrivateKey: stored.vapidPrivateKey,
          vapidPublicKey: stored.vapidPublicKey,
        };
      }
    }
  } catch {
    // Unreadable: mint a new one below.
  }
  // Storage unavailable (private mode): one identity for the session, rather
  // than a new VAPID key, and so a new browser subscription, per call.
  if (memoryIdentity) return memoryIdentity;

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (!jwk.d) throw new Error("WebCrypto returned no private scalar");
  const identity: NostrPush2Identity = {
    secretKey: generateSecretKey(),
    vapidPrivateKey: jwk.d,
    vapidPublicKey: base64url(publicRaw),
  };
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({
      sk: bytesToHex(identity.secretKey),
      vapidPrivateKey: identity.vapidPrivateKey,
      vapidPublicKey: identity.vapidPublicKey,
    }));
  } catch {
    memoryIdentity = identity;
  }
  return identity;
}

const CLIENT_KEY = "armada:nostr-push2-client:v1";
let memoryClientKey: Uint8Array | undefined;

/**
 * The client key alone, for an install that needs no VAPID key (iOS, whose
 * connection is an APNs token). Kept and purged like the identity above.
 */
export function loadNostrPush2ClientKey(): Uint8Array {
  try {
    const stored = localStorage.getItem(CLIENT_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return hexToBytes(stored);
  } catch {
    // Unreadable: mint a new one below.
  }
  if (memoryClientKey) return memoryClientKey;
  const key = generateSecretKey();
  try {
    localStorage.setItem(CLIENT_KEY, bytesToHex(key));
  } catch {
    memoryClientKey = key;
  }
  return key;
}

/** The `create` params for a browser subscription made against `identity`. */
export function webPushConnection(
  subscription: PushSubscription,
  identity: NostrPush2Identity,
): WebPushConnection {
  const json = subscription.toJSON();
  return {
    method: "web",
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
    vapid_private_key: identity.vapidPrivateKey,
  };
}
