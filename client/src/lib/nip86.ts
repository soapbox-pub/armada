/**
 * NIP-86 relay management RPC client (zooid flavour).
 *
 * zooid exposes per-community administration — bans, allow-lists, and the
 * recently-added dynamic member roles — over a NIP-86 JSON-RPC endpoint at the
 * community relay's *own* HTTP origin (the same host that serves the relay
 * websocket). The transport is a single POST with:
 *
 *   Content-Type: application/nostr+json+rpc
 *   Authorization: Nostr <base64(signed kind-27235 event)>
 *   body: {"method": "<name>", "params": [ ... ]}
 *
 * The auth event (kind 27235, NIP-98) must carry, per zooid/khatru's HandleNIP86:
 *   - ["u", <relay base url>]          (normalized-equal to the request URL)
 *   - ["payload", <hex sha256(body)>]  (hash of the exact request body bytes)
 *   - created_at within 30s of now
 *
 * Only a community admin (an owner / `can_manage` pubkey in the relay's TOML
 * config) is authorized; the relay rejects everyone else.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { KIND_HTTP_AUTH } from "@/lib/nip29";

import type { NostrSigner } from "@nostrify/nostrify";

/** Content-Type that selects khatru's NIP-86 RPC handler. */
const NIP86_CONTENT_TYPE = "application/nostr+json+rpc";

export interface Nip86Response<T = unknown> {
  result?: T;
  error?: string;
}

const encoder = new TextEncoder();

/**
 * Perform a signed NIP-86 RPC call against `relayHttpUrl` (the relay's HTTP
 * origin, e.g. `https://armada.example.com`). Throws on transport errors or a
 * non-empty `error` field in the response.
 */
export async function nip86Request<T = unknown>(
  signer: NostrSigner,
  relayHttpUrl: string,
  method: string,
  params: Array<string | number> = [],
): Promise<T> {
  const url = relayHttpUrl.replace(/\/$/, "");
  const body = JSON.stringify({ method, params });
  const payloadHash = bytesToHex(sha256(encoder.encode(body)));

  const auth = await signer.signEvent({
    kind: KIND_HTTP_AUTH,
    content: "",
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", payloadHash],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": NIP86_CONTENT_TYPE,
      Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
    },
    body,
  });

  let json: Nip86Response<T>;
  try {
    json = (await res.json()) as Nip86Response<T>;
  } catch {
    throw new Error(`Relay returned a non-JSON response (HTTP ${res.status})`);
  }

  if (json.error) throw new Error(json.error);
  if (!res.ok) throw new Error(`Relay management request failed (HTTP ${res.status})`);

  return json.result as T;
}
