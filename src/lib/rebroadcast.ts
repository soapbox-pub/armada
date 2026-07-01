import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * "Rebroadcastable post" wire format for the Bluetooth mesh.
 *
 * A Nostr event is atomic and self-authenticating: anyone holding it can push
 * it to a relay without signing anything. We exploit that to bridge offline →
 * online — a user with no internet runs `/post GM`, which signs a real **kind 1**
 * note locally and ships the *whole signed event* over the mesh. A nearby peer
 * who has internet can then hit "Rebroadcast" to relay it verbatim to their
 * configured relays (see `useRepublish`).
 *
 * The mesh transport only carries a string `content`, so the signed event is
 * embedded as `armada:rebroadcast:1:<json>`:
 *  - the marker disambiguates it from a literal chat message;
 *  - the `1` is a format version so the wire contract can evolve (e.g. swap the
 *    JSON body for a compact binary encoding) without breaking older clients;
 *  - the body is `JSON.stringify(event)` of the full signed Nostr event.
 *
 * Unlike ordinary mesh messages (which are never verified — their `pubkey` is a
 * mesh peer id, not a Nostr key), a rebroadcast envelope MUST be verified on
 * receipt: it claims a real Nostr author, so a forged one would let anyone
 * impersonate an npub. `parseRebroadcast` runs `verifyEvent` and returns null on
 * any failure, so callers can treat a non-null result as authentic.
 */

/** Marker + version prefix for a rebroadcastable post in a mesh `content` field. */
export const REBROADCAST_PREFIX = "armada:rebroadcast:1:";

/** The Nostr kind used for rebroadcastable posts (NIP-01 short text note). */
export const REBROADCAST_KIND = 1;

/** True if a mesh `content` string carries a rebroadcast envelope. */
export function isRebroadcastEnvelope(content: string): boolean {
  return content.startsWith(REBROADCAST_PREFIX);
}

/** Wrap a fully-signed Nostr event into a mesh `content` envelope string. */
export function encodeRebroadcast(event: NostrEvent): string {
  return REBROADCAST_PREFIX + JSON.stringify(event);
}

/**
 * Parse a mesh `content` envelope back into a Nostr event, verifying its
 * signature. Returns the event only when it is a well-formed, signature-valid
 * Nostr event; returns null for a non-envelope string, malformed JSON, a
 * missing field, or a bad signature.
 */
export function parseRebroadcast(content: string): NostrEvent | null {
  if (!isRebroadcastEnvelope(content)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(REBROADCAST_PREFIX.length));
  } catch {
    return null;
  }

  if (!isNostrEventShape(parsed)) return null;

  // Reject anything whose signature/id doesn't check out — the whole point of a
  // rebroadcast is that the receiver can trust the author without trusting the
  // mesh peer that carried it.
  try {
    if (!verifyEvent(parsed)) return null;
  } catch {
    return null;
  }

  return parsed;
}

/** Structural check before the (more expensive) signature verification. */
function isNostrEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.pubkey === "string" &&
    typeof e.sig === "string" &&
    typeof e.content === "string" &&
    typeof e.kind === "number" &&
    typeof e.created_at === "number" &&
    Array.isArray(e.tags)
  );
}
