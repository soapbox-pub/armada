/**
 * Concord Invites — CORD-05.
 *
 * URL = public locator (naddr of the bundle `(kind 33301, link_signer, d="")`)
 * + secret `#fragment` (16-byte token + up to 3 bootstrap relays, base64url).
 * The token derives only the bundle's decrypt key. Each link has its own LINK
 * SIGNER keypair held by the creator, so a link-holder can join but never squat
 * or kill the link.
 */

import { hexToBytes } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

import { inviteBundleKey, verifyCommunityId } from "@/concord/lib/derive";
import { KIND_INVITE_BUNDLE, VSK_INVITE_LIVE, VSK_INVITE_REVOKED } from "@/concord/lib/kinds";
import { RELAY_DICTIONARY, STOCK_RELAYS } from "@/concord/lib/stockRelays";
import { MAX_BUNDLE_CHANNELS, capRelays, type ImagePointer } from "@/concord/lib/types";
import { finalizePowEvent } from "@/lib/pow";
import { nowSecs } from "@/lib/relayClock";

/** The link's unlock token: 16 random bytes (CORD-05 §2). */
export const TOKEN_BYTES = 16;
/** The fragment carries at most 3 bootstrap relays (CORD-05 §3). */
export const MAX_BOOTSTRAP_RELAYS = 3;
/** The fragment format/dictionary generation byte. Lower values are legacy. */
export const FRAGMENT_VERSION = 4;

/**
 * Bundle preview description cap, far below the 10,000-byte metadata cap (CORD-02
 * §6). Applied at build AND parse (hostile bundles are truncated, not refused).
 */
export const BUNDLE_DESCRIPTION_MAX_BYTES = 500;

/** Truncate to the byte cap on a UTF-8 code-point boundary. */
export function capBundleDescription(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= BUNDLE_DESCRIPTION_MAX_BYTES) return s;
  let end = BUNDLE_DESCRIPTION_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export interface InviteBundle {
  community_id: string;
  owner: string;
  owner_salt: string;
  community_root: string;
  root_epoch: number;
  /**
   * The Control Plane's signer pubkey at `root_epoch` (CORD-02 §5). Absent = a
   * legacy pre-split Community (CORD-06 §3). Taken on trust: a wrong one only
   * harms the joiner's view; a later verified rotation corrects it (CORD-05 §1).
   */
  control_pk?: string;
  /** The granted (private) Channels. */
  channels: Array<{ id: string; key: string; epoch: number; name: string }>;
  relays: string[];
  /** Preview, so a parked invite can render; the Control fold is the authority. */
  name: string;
  icon?: ImagePointer;
  banner?: ImagePointer;
  /** Preview of the Community description, capped at {@link BUNDLE_DESCRIPTION_MAX_BYTES}. */
  description?: string;
  /** Optional, unix ms: past it the preview still renders, joining refuses. */
  expires_at?: number;
  /** Optional attribution, echoed in the joiner's Guestbook Join. */
  creator_npub?: string;
  label?: string;
  [k: string]: unknown;
}

export class InviteError extends Error {
  constructor(
    public code: "bad-link" | "bad-fragment" | "bad-bundle" | "owner-mismatch" | "revoked" | "expired" | "bounds",
    message: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

/**
 * Bound an attacker-crafted bundle before allocating (CORD-05 §1): sane
 * channel count, relays truncated to the Community cap.
 */
function boundBundle(bundle: InviteBundle): InviteBundle {
  if (!Array.isArray(bundle.channels)) bundle.channels = [];
  if (bundle.channels.length > MAX_BUNDLE_CHANNELS) {
    throw new InviteError("bounds", `bundle carries ${bundle.channels.length} channels (cap ${MAX_BUNDLE_CHANNELS})`);
  }
  bundle.relays = capRelays(Array.isArray(bundle.relays) ? bundle.relays : []);
  if (bundle.description !== undefined) {
    if (typeof bundle.description === "string") bundle.description = capBundleDescription(bundle.description);
    else delete bundle.description;
  }
  return bundle;
}

/**
 * Validate a decrypted bundle however it arrived (CORD-05 §6): §1 bounds, and
 * `community_id` must reproduce from (owner, salt). Throws `bounds` /
 * `owner-mismatch`; expiry is the caller's concern.
 */
export function validateBundle(bundle: InviteBundle): InviteBundle {
  boundBundle(bundle);
  if (!verifyCommunityId(bundle.community_id, bundle.owner, bundle.owner_salt)) {
    throw new InviteError("owner-mismatch", "bundle's owner does not reproduce its community_id");
  }
  return bundle;
}

/**
 * Re-post every live link's coordinate carrying the CURRENT `bundle` (CORD-05 §2).
 * Each Invite List entry supplies `token` + `signer_sk`; per-link `expires_at`/
 * `label` are kept. Malformed entries are skipped.
 */
export async function buildRefreshedBundleEvents(
  bundle: InviteBundle,
  entries: Array<{ token: string; signer_sk: string; expires_at?: number; label?: string }>,
): Promise<NostrEvent[]> {
  const events: NostrEvent[] = [];
  for (const entry of entries) {
    try {
      const perLink: InviteBundle = {
        ...bundle,
        ...(inviteExpirySecs(entry.expires_at) !== undefined ? { expires_at: inviteExpirySecs(entry.expires_at)! * 1000 } : {}),
        ...(entry.label ? { label: entry.label } : {}),
      };
      events.push(await buildBundleEvent(perLink, hexToBytes(entry.token), hexToBytes(entry.signer_sk)));
    } catch {
      // Malformed stored entry; skip it.
    }
  }
  return events;
}

/** Build the addressable bundle event: `(33301, link_signer, d="")`, marked live. */
export function buildBundleEvent(bundle: InviteBundle, token: Uint8Array, linkSignerSk: Uint8Array): Promise<NostrEvent> {
  const content = nip44Encrypt(JSON.stringify(bundle), inviteBundleKey(token));
  return finalizePowEvent(
    {
      kind: KIND_INVITE_BUNDLE,
      content,
      tags: [
        ["d", ""],
        ["vsk", VSK_INVITE_LIVE],
      ],
      created_at: nowSecs(),
    },
    linkSignerSk,
  );
}

/** Re-post the coordinate as a revocation tombstone (creator only — needs the signer). */
export function buildRevocationEvent(linkSignerSk: Uint8Array): Promise<NostrEvent> {
  return finalizePowEvent(
    {
      kind: KIND_INVITE_BUNDLE,
      content: "",
      tags: [
        ["d", ""],
        ["vsk", VSK_INVITE_REVOKED],
      ],
      created_at: nowSecs(),
    },
    linkSignerSk,
  );
}

/**
 * Verify + decrypt a fetched bundle event. Re-checks signature and author
 * against `expectedSigner`. Throws `revoked`, `expired`, or `owner-mismatch`.
 */
export function parseBundleEvent(
  event: NostrEvent,
  expectedSigner: string,
  token: Uint8Array,
  nowMs: number,
): InviteBundle {
  if (event.kind !== KIND_INVITE_BUNDLE || event.pubkey !== expectedSigner || !verifyEvent(event)) {
    throw new InviteError("bad-bundle", "not a valid invite bundle event");
  }
  const vsk = event.tags.find((t) => t[0] === "vsk")?.[1];
  if (vsk === VSK_INVITE_REVOKED) {
    throw new InviteError("revoked", "this invite link has been revoked");
  }
  if (vsk !== VSK_INVITE_LIVE) {
    throw new InviteError("bad-bundle", `unknown bundle marker: ${vsk}`);
  }

  let bundle: InviteBundle;
  try {
    bundle = JSON.parse(nip44Decrypt(event.content, inviteBundleKey(token))) as InviteBundle;
  } catch (e) {
    throw new InviteError("bad-bundle", `bundle decrypt: ${e instanceof Error ? e.message : e}`);
  }

  validateBundle(bundle);
  if (typeof bundle.expires_at === "number" && nowMs > bundle.expires_at) {
    throw new InviteError("expired", "this invite link has expired");
  }
  return bundle;
}

/** Re-exported from the leaf `stockRelays.ts`; part of the CORD-05 codec's surface. */
export { RELAY_DICTIONARY, STOCK_RELAYS } from "@/concord/lib/stockRelays";

/** flags bit 0: the stock set is in use, zero relay bytes follow. */
const FLAG_STOCK_SET = 0x01;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const DICT_BY_URL = new Map(Object.entries(RELAY_DICTIONARY).map(([id, url]) => [url, Number(id)]));

/**
 * Encode the invite fragment: `[version][flags][relays?][token:16]` as
 * base64url, no padding. The stock set costs zero relay bytes; otherwise each
 * relay is a dictionary id byte, a wss-implied literal (`0, len, host`), or a
 * verbatim literal (`255, len, url`).
 */
export function encodeFragment(token: Uint8Array, relays: string[]): string {
  if (token.length !== TOKEN_BYTES) throw new InviteError("bad-fragment", `token must be ${TOKEN_BYTES} bytes`);
  // The stock set is flag-selected (zero bytes), so exempt from the 3-relay cap.
  const isStock = relays.length === STOCK_RELAYS.length && relays.every((r, i) => r === STOCK_RELAYS[i]);
  const bounded = relays.slice(0, MAX_BOOTSTRAP_RELAYS);

  const bytes: number[] = [FRAGMENT_VERSION];
  if (isStock) {
    bytes.push(FLAG_STOCK_SET);
  } else {
    bytes.push(0x00, bounded.length);
    const encoder = new TextEncoder();
    for (const relay of bounded) {
      const dictId = DICT_BY_URL.get(relay);
      if (dictId !== undefined) {
        bytes.push(dictId);
      } else if (relay.startsWith("wss://")) {
        const host = encoder.encode(relay.slice("wss://".length));
        if (host.length > 255) throw new InviteError("bad-fragment", "relay host too long");
        bytes.push(0, host.length, ...host);
      } else {
        const url = encoder.encode(relay);
        if (url.length > 255) throw new InviteError("bad-fragment", "relay URL too long");
        bytes.push(255, url.length, ...url);
      }
    }
  }
  bytes.push(...token);
  return toBase64Url(new Uint8Array(bytes));
}

/** Decode an invite fragment into its token + bootstrap relays. */
export function decodeFragment(fragment: string): { token: Uint8Array; relays: string[] } {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(fragment.trim());
  } catch {
    throw new InviteError("bad-fragment", "fragment is not base64url");
  }
  let o = 0;
  const need = (n: number) => {
    if (o + n > bytes.length) throw new InviteError("bad-fragment", "fragment truncated");
  };
  need(2);
  const version = bytes[o++];
  if (version < FRAGMENT_VERSION) {
    // Lower versions are rejected rather than decoded against the wrong dictionary (CORD-05 §3).
    throw new InviteError("bad-fragment", `legacy invite format (version ${version})`);
  }
  if (version > FRAGMENT_VERSION) {
    throw new InviteError("bad-fragment", `invite format ${version} is newer than this client`);
  }
  const flags = bytes[o++];

  const relays: string[] = [];
  if (flags & FLAG_STOCK_SET) {
    relays.push(...STOCK_RELAYS);
  } else {
    need(1);
    const count = bytes[o++];
    if (count > MAX_BOOTSTRAP_RELAYS) throw new InviteError("bad-fragment", "too many bootstrap relays");
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      need(1);
      const lead = bytes[o++];
      if (lead >= 1 && lead <= 254) {
        const url = RELAY_DICTIONARY[lead];
        if (url) relays.push(url);
        // An unknown dictionary id is skipped, not fatal: the dictionary grows.
      } else {
        need(1);
        const len = bytes[o++];
        need(len);
        const text = decoder.decode(bytes.slice(o, o + len));
        o += len;
        relays.push(lead === 255 ? text : `wss://${text}`);
      }
    }
  }

  need(TOKEN_BYTES);
  const token = bytes.slice(o, o + TOKEN_BYTES);
  o += TOKEN_BYTES;
  if (o !== bytes.length) throw new InviteError("bad-fragment", "trailing bytes in fragment");
  return { token, relays };
}

export const INVITE_PATH_PREFIX = "/invite/";

/** A parsed Concord invite link: the bundle coordinate + the fragment's secrets. */
export interface ParsedInviteLink {
  /** The link signer's pubkey (hex) — the bundle's coordinate author. */
  linkSigner: string;
  token: Uint8Array;
  bootstrapRelays: string[];
  naddr: string;
}

/** Build the bare naddr for a link signer's bundle coordinate (empty `d`). */
export function bundleNaddr(linkSignerPk: string): string {
  return nip19.naddrEncode({ kind: KIND_INVITE_BUNDLE, pubkey: linkSignerPk, identifier: "" });
}

/** Build a shareable invite URL on `base` (any deeplink domain works — the base is cosmetic). */
export function buildInviteUrl(base: string, linkSignerPk: string, token: Uint8Array, relays: string[]): string {
  return `${base.replace(/\/$/, "")}${INVITE_PATH_PREFIX}${bundleNaddr(linkSignerPk)}#${encodeFragment(token, relays)}`;
}

/**
 * A stored invite URL re-based onto `base` when minted on a non-http origin
 * (the desktop shell's `app://armada`), which no recipient can resolve. The origin
 * is cosmetic (CORD-05 §2), so repair beats reminting a second live link.
 * http(s) origins are left as minted.
 */
export function shareableInviteUrl(base: string, url: string): string {
  if (/^https?:\/\//i.test(url.trim())) return url;
  const at = url.indexOf(INVITE_PATH_PREFIX);
  if (at < 0) return url;
  return `${base.replace(/\/$/, "")}${url.slice(at)}`;
}

/** Decode a bare naddr into the link-signer pubkey, or undefined if it isn't one. */
function naddrToSigner(naddr: string): string | undefined {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== "naddr") return undefined;
    const data = decoded.data;
    if (data.kind !== KIND_INVITE_BUNDLE || data.identifier !== "") return undefined;
    return data.pubkey;
  } catch {
    return undefined;
  }
}

/**
 * Whether `input` names an invite-bundle coordinate, with or without the
 * `#fragment` — routes secret-less links to the invite UI to explain, since the
 * encrypted bundle can't render as a plain event.
 */
export function isInviteUrl(input: string): boolean {
  const trimmed = input.trim();
  let naddr: string | undefined;
  if (/^naddr1[a-z0-9]+/i.test(trimmed)) {
    naddr = trimmed.split("#")[0];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return false;
    }
    if (!url.pathname.startsWith(INVITE_PATH_PREFIX)) return false;
    naddr = decodeURIComponent(url.pathname.slice(INVITE_PATH_PREFIX.length)).replace(/\/$/, "");
  }
  return !!naddr && naddrToSigner(naddr) !== undefined;
}

/**
 * Parse an invite from `…/invite/<naddr>#<fragment>` or bare `<naddr>#<fragment>`;
 * undefined if it isn't one.
 */
export function parseInviteLink(input: string): ParsedInviteLink | undefined {
  const trimmed = input.trim();

  let naddr: string | undefined;
  let fragment: string | undefined;

  if (/^naddr1[a-z0-9]+#.+$/i.test(trimmed)) {
    const [head, ...rest] = trimmed.split("#");
    naddr = head;
    fragment = rest.join("#");
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(INVITE_PATH_PREFIX)) return undefined;
    naddr = decodeURIComponent(url.pathname.slice(INVITE_PATH_PREFIX.length)).replace(/\/$/, "");
    fragment = url.hash.replace(/^#/, "");
  }

  if (!naddr || !fragment) return undefined;
  const linkSigner = naddrToSigner(naddr);
  if (!linkSigner) return undefined;
  let decoded: { token: Uint8Array; relays: string[] };
  try {
    decoded = decodeFragment(fragment);
  } catch {
    return undefined;
  }
  return { linkSigner, token: decoded.token, bootstrapRelays: decoded.relays, naddr };
}

/** Parse the invite parts as they arrive at the /invite/:naddr route. */
export function parseInviteRoute(naddr: string, fragment: string): ParsedInviteLink | undefined {
  const linkSigner = naddrToSigner(naddr);
  if (!linkSigner) return undefined;
  try {
    const { token, relays } = decodeFragment(fragment);
    return { linkSigner, token, bootstrapRelays: relays, naddr };
  } catch {
    return undefined;
  }
}

// The Invite List (CORD-05 §4, kind 13303)
export interface InviteListEntry {
  /** The link's unlock secret AND its merge key (hex). */
  token: string;
  /** The link_signer secret (hex): refreshing or retiring the bundle needs it. */
  signer_sk: string;
  community_id: string;
  url: string;
  label?: string;
  created_at: number;
  /** Unix seconds, like `created_at` (the bundle's is ms). */
  expires_at?: number;
  /** The root epoch it was minted at (CORD-06 §3 Severing); absent reads as 0. */
  epoch?: number;
  [k: string]: unknown;
}

export interface InviteListTombstone {
  token: string;
  community_id: string;
  /** The retired link's `expires_at`, so the tombstone can be pruned with it (CORD-05 §4). */
  expires_at?: number;
  [k: string]: unknown;
}

export interface InviteList {
  entries: InviteListEntry[];
  tombstones: InviteListTombstone[];
  [k: string]: unknown;
}

export const EMPTY_INVITE_LIST: InviteList = { entries: [], tombstones: [] };

/**
 * Merge two Invite Lists without coordination: the token is the merge key, an
 * entry is immutable once minted, tombstones union, and a tombstone always
 * beats an entry — terminally, so a stale device can never resurrect a revoked
 * link (CORD-05 §4).
 */
export function mergeInviteLists(a: InviteList, b: InviteList): InviteList {
  const entries = new Map<string, InviteListEntry>();
  for (const e of [...a.entries, ...b.entries]) {
    if (!e || typeof e.token !== "string") continue;
    if (!entries.has(e.token)) entries.set(e.token, e);
  }
  const tombstones = new Map<string, InviteListTombstone>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    if (!t || typeof t.token !== "string") continue;
    if (!tombstones.has(t.token)) tombstones.set(t.token, t);
  }
  for (const token of tombstones.keys()) entries.delete(token);
  return {
    ...a,
    ...b,
    entries: [...entries.values()].sort((x, y) => x.token.localeCompare(y.token)),
    tombstones: [...tombstones.values()].sort((x, y) => x.token.localeCompare(y.token)),
  };
}

/** The root epoch an entry was minted at (CORD-05 §4): absent or malformed reads as 0. */
export function inviteEntryEpoch(entry: InviteListEntry): number {
  return typeof entry.epoch === "number" && Number.isSafeInteger(entry.epoch) && entry.epoch > 0 ? entry.epoch : 0;
}

/** A tombstone for an entry, carrying its expiry (CORD-05 §4). */
export function inviteTombstoneFor(entry: InviteListEntry): InviteListTombstone {
  return {
    token: entry.token,
    community_id: entry.community_id,
    ...(typeof entry.expires_at === "number" ? { expires_at: entry.expires_at } : {}),
  };
}

/**
 * Drop entries and tombstones past their `expires_at` (CORD-05 §4): an expired
 * link admits no one, so one a stale device brings back is as dead as a retired one.
 */
/**
 * An Invite List `expires_at` in unix seconds (CORD-05 §4). The list carries seconds;
 * a value past the year 5000 in seconds is an older Vector's milliseconds.
 */
export function inviteExpirySecs(expiresAt: unknown): number | undefined {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return undefined;
  return expiresAt >= 100_000_000_000 ? Math.floor(expiresAt / 1000) : expiresAt;
}

export function pruneExpiredInvites(list: InviteList, nowSec: number): InviteList {
  const live = (x: { expires_at?: unknown }) => {
    const at = inviteExpirySecs(x.expires_at);
    return at === undefined || at > nowSec;
  };
  const entries = list.entries.filter(live);
  const tombstones = list.tombstones.filter(live);
  if (entries.length === list.entries.length && tombstones.length === list.tombstones.length) return list;
  return { ...list, entries, tombstones };
}

/**
 * The registry's link signers that are this creator's live links in `communityIdHex`
 * (CORD-05 §5): an expired link, and one the Invite List no longer holds because it
 * pruned the expired entry, keep nothing Public. With no list read (`entries`
 * undefined) the signers pass through, so a cold read never empties the registry.
 */
export function liveRegistrySigners(linkSigners: string[], entries: InviteListEntry[] | undefined, communityIdHex: string, nowSec: number): string[] {
  if (!entries) return linkSigners;
  const live = new Set<string>();
  for (const e of entries) {
    const at = inviteExpirySecs(e.expires_at);
    if (e.community_id !== communityIdHex || (at !== undefined && at <= nowSec)) continue;
    const p = parseInviteLink(e.url);
    if (p) live.add(p.linkSigner);
  }
  return linkSigners.filter((s) => live.has(s));
}

export function mintLinkSigner(): { sk: Uint8Array; pk: string } {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

export function mintToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
}
