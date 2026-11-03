/**
 * The blocklist: one addressable kind-37307 event per entry, signed by a
 * moderation key this build pins, published with `armada-blocklist`. An entry
 * is a community or a user, and carries only a hash of its id, never the id, a
 * name or a reason:
 *
 *   entry hash = sha256(utf8("armada/blocklist/<scope>/v1") || 0x00 || id[32])
 *
 * where the scope is `community` (a community id) or `user` (a pubkey).
 *
 * Read entries with `{ kinds: [BLOCKLIST_KIND], authors: BLOCKLIST_AUTHORS }`,
 * never a community's by `#d`, which would tell the relay which community is
 * being opened. A user's may be read by `#d` when their profile opens: the
 * profile's own request already names them.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { verifyEvent } from "nostr-tools/pure";

import { config } from "./env";

import type { NostrEvent } from "nostr-tools/pure";

export const BLOCKLIST_KIND = 37307;

const VERSION = "1";
export type BlocklistScope = "community" | "user";
const LABELS: Record<BlocklistScope, Uint8Array> = {
  community: new TextEncoder().encode(`armada/blocklist/community/v${VERSION}`),
  user: new TextEncoder().encode(`armada/blocklist/user/v${VERSION}`),
};
const HEX64 = /^[0-9a-f]{64}$/;

/** Soapbox's moderation key, npub1ph0kcd0kr6cyqvtdq8mgmm2d8z6hnst5y0fxw90afzgst2vpjy9qfz24jj. */
const DEFAULT_BLOCKLIST_AUTHORS = "0ddf6c35f61eb040316d01f68ded4d38b579c17423d26715fd489105a981910a";

/**
 * Moderation keys whose entries count (hex). Unlike `RELEASE_AUTHORS` a host's
 * `window.ENV` may replace them: a deployment answers for what it serves.
 */
export const BLOCKLIST_AUTHORS: string[] = (config("BLOCKLIST_AUTHORS") ?? DEFAULT_BLOCKLIST_AUTHORS)
  .split(",")
  .map((pubkey: string) => pubkey.trim().toLowerCase())
  .filter((pubkey: string) => HEX64.test(pubkey));

export type BlocklistStatus = "blocked" | "lifted";

export interface BlocklistEntry {
  hash: string;
  scope: BlocklistScope;
  status: BlocklistStatus;
  createdAt: number;
  id: string;
}

/** The entry hash a community id, or with scope `user` a pubkey, is listed under. */
export function blocklistHash(id: string, scope: BlocklistScope = "community"): string {
  const hex = id.toLowerCase();
  if (!HEX64.test(hex)) throw new Error(`a ${scope === "user" ? "pubkey" : "community id"} is 64 hex characters`);
  const label = LABELS[scope];
  const input = new Uint8Array(label.length + 1 + 32);
  input.set(label, 0);
  input.set(hexToBytes(hex), label.length + 1);
  return bytesToHex(sha256(input));
}

const tag = (event: NostrEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];

/** A well-formed, validly signed entry by one of `authors`, else undefined. */
export function parseBlocklistEntry(event: NostrEvent, authors: readonly string[] = BLOCKLIST_AUTHORS): BlocklistEntry | undefined {
  if (event.kind !== BLOCKLIST_KIND || !authors.includes(event.pubkey)) return undefined;
  const hash = tag(event, "d");
  const scope = tag(event, "scope");
  const status = tag(event, "status");
  if (!hash || !HEX64.test(hash) || (scope !== "community" && scope !== "user") || tag(event, "v") !== VERSION) return undefined;
  if (status !== "blocked" && status !== "lifted") return undefined;
  if (!verifyEvent(event)) return undefined;
  return { hash, scope, status, createdAt: event.created_at, id: event.id };
}

/** The newest entry per hash, the tie going to the lower id. */
export function foldBlocklist(events: Iterable<NostrEvent>, authors: readonly string[] = BLOCKLIST_AUTHORS): Map<string, BlocklistEntry> {
  const latest = new Map<string, BlocklistEntry>();
  for (const event of events) {
    const entry = parseBlocklistEntry(event, authors);
    if (!entry) continue;
    const prev = latest.get(entry.hash);
    if (!prev || entry.createdAt > prev.createdAt || (entry.createdAt === prev.createdAt && entry.id < prev.id)) {
      latest.set(entry.hash, entry);
    }
  }
  return latest;
}

/** Whether the folded entries block `communityId`. */
export function isCommunityBlocked(entries: ReadonlyMap<string, BlocklistEntry>, communityId: string): boolean {
  const entry = entries.get(blocklistHash(communityId));
  return entry?.scope === "community" && entry.status === "blocked";
}

/** The hashes of the users the folded entries ban. */
export function bannedUserHashes(entries: ReadonlyMap<string, BlocklistEntry>): Set<string> {
  const hashes = new Set<string>();
  for (const entry of entries.values()) if (entry.scope === "user" && entry.status === "blocked") hashes.add(entry.hash);
  return hashes;
}
