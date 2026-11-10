/**
 * Buzz HTTP bridge auth: NIP-98 (kind-27235, with a `payload` SHA-256 tag for
 * bodies) sent as `Authorization: Nostr <base64>`.
 */

import type { NostrSigner } from "@nostrify/nostrify";
import { nowSecs } from "@/lib/relayClock";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function nip98AuthHeader(
  signer: NostrSigner,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (body !== undefined) tags.push(["payload", await sha256Hex(body)]);
  const event = await signer.signEvent({
    kind: 27235,
    content: "",
    tags,
    created_at: nowSecs(),
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/** POST JSON to a Buzz relay HTTP endpoint with NIP-98 auth. */
export async function buzzHttpPost<T>(
  signer: NostrSigner,
  url: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const body = JSON.stringify(payload);
  const auth = await nip98AuthHeader(signer, url, "POST", body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body,
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const message =
      (json as { error?: string; message?: string }).error ??
      (json as { error?: string; message?: string }).message ??
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}
