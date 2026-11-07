/**
 * Pins — CORD-04 §7. A pin does not quote a message; it proves one.
 *
 * One Pin List per Channel on the Control Plane (vsk 11, `pins_locator(community_id,
 * channel_id)`), replaced entire per edit. Each entry carries the original
 * kind-20013 seal plus disclosed NIP-44 keys, so readers without history can
 * verify author, words, Channel and time. Compaction re-wraps it across rotations.
 */

import { getEventHash, verifyEvent } from "nostr-tools/pure";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";

import type { NostrEvent } from "nostr-tools/pure";

import {
  decodeMessageKeys,
  decryptWithDisclosedKeys,
  discloseKeysFor,
  encodeMessageKeys,
} from "@/concord/lib/nip44keys";
import { KIND_COMMENT, KIND_EDIT, KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Structural caps (CORD-04 §7) — a violating edition reads as an EMPTY list. */
export const PIN_MAX_ENTRIES = 25;
export const PIN_MAX_CONTENT_BYTES = 32_768;

export interface PinEntry {
  /** The original kind-20013 seal event: fields carried exactly, content string unaltered. */
  seal: NostrEvent;
  /** 76-byte lowercase hex: chacha_key[32] || chacha_nonce[12] || hmac_key[32]. */
  keys: string;
  /** Optional, UNVERIFIED locator hint for jump-to-context. */
  wrap?: string;
  /**
   * The newest provable Edit, for readers with no Chat plane (§7 Edits). At most
   * one: Edits target the ORIGINAL rumor, so a later Edit replaces this.
   */
  edit?: { seal: NostrEvent; keys: string };
}

/** A pin that passed the full §7 verification — safe to render. */
export interface VerifiedPin {
  /** Recomputed from the decrypted bytes; never the embedded field. */
  rumorId: string;
  /** The seal's signer == the rumor's author. */
  author: string;
  kind: number;
  content: string;
  tags: string[][];
  /** The message's own epoch tag — derives the plane address for jump-to-context. */
  epoch: string | undefined;
  /** Ordering basis: created_at*1000 + ms tag. */
  ms: number;
  createdAt: number;
  /** Untrusted locator hint, if the entry carried one. */
  wrapHint?: string;
  /** Set when a proven Edit superseded the original's words. */
  edited?: { content: string; ms: number };
  /** The wire entry, verbatim — for republishing (re-wraps, omissions). */
  entry: PinEntry;
}

const HEX64 = /^[0-9a-f]{64}$/;

function tagValue(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

function resolveMs(createdAt: number, tags: string[][]): number {
  const raw = tagValue(tags, "ms");
  const ms = raw !== undefined && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : 0;
  return createdAt * 1000 + (ms <= 999 ? ms : 0);
}

/**
 * Build a pin entry from an opened chat message, given the Channel's conversation
 * key at its epoch. Undefined if the disclosure can't be produced.
 */
export function buildPinEntry(opened: OpenedEvent, convKey: Uint8Array): PinEntry | undefined {
  return buildPinEntryOrReason(opened, convKey).entry;
}

/** Why a message could not be pinned — each cause needs a different answer. */
export type PinBuildFailure = "no-seal" | "pending" | "not-encrypted" | "bad-payload" | "unverifiable";

/**
 * A just-sent row carries a PLACEHOLDER seal (empty, unsigned) until the signer
 * answers; it would otherwise pass presence checks and fail as unreadable.
 */
export function isPlaceholderSeal(seal: NostrEvent | undefined): boolean {
  return Boolean(seal) && (!seal!.sig || !seal!.content);
}

/** {@link buildPinEntry} with the reason attached, so the UI can say which cause. */
export function buildPinEntryOrReason(
  opened: OpenedEvent,
  convKey: Uint8Array,
): { entry?: PinEntry; reason?: PinBuildFailure } {
  const seal = opened.seal;
  if (!seal) return { reason: "no-seal" };
  if (isPlaceholderSeal(seal)) return { reason: "pending" };
  if (seal.kind !== KIND_SEAL_ENCRYPTED) return { reason: "not-encrypted" };
  const keys = discloseKeysFor(seal.content, convKey);
  if (!keys) return { reason: "bad-payload" };
  // Key derivation succeeds under ANY key; a wrong epoch only fails at the MAC.
  if (decryptWithDisclosedKeys(seal.content, keys) === undefined) return { reason: "bad-payload" };
  // Refuse to build an entry that would not verify.
  const entry: PinEntry = { seal, keys: encodeMessageKeys(keys), wrap: opened.wrapId };
  return verifyPinEntry(entry, tagValue(opened.tags, "channel") ?? "") ? { entry } : { reason: "unverifiable" };
}

/**
 * The §7 verification using only the pin and the list's Channel: seal kind +
 * signature → MAC → decrypt → rumor checks (author, chat kind, channel binding)
 * → recomputed id. Undefined on ANY failure; a failed entry is dropped alone.
 */
export function verifyPinEntry(entry: PinEntry, channelIdHex: string): VerifiedPin | undefined {
  // Unvalidated wire data (`{"entries":[null]}`): throwing here would break the channel view.
  if (!entry || typeof entry !== "object") return undefined;
  // A field of the wrong type makes the whole entry invalid (CORD-04 §7, Vector serde `PinEntry`).
  if (typeof entry.keys !== "string") return undefined;
  if (entry.wrap != null && typeof entry.wrap !== "string") return undefined;
  if (entry.edit != null && (typeof entry.edit !== "object" || typeof entry.edit.seal !== "object" || entry.edit.seal === null || typeof entry.edit.keys !== "string")) {
    return undefined;
  }
  const seal = entry.seal;
  if (!seal || typeof seal !== "object") return undefined;
  if (seal.kind !== KIND_SEAL_ENCRYPTED) return undefined;
  let sigOk = false;
  try {
    sigOk = verifyEvent(seal);
  } catch {
    return undefined;
  }
  if (!sigOk) return undefined;

  const keys = decodeMessageKeys(entry.keys ?? "");
  if (!keys) return undefined;
  const plaintext = decryptWithDisclosedKeys(seal.content, keys);
  if (plaintext === undefined) return undefined;

  let rumor: NostrRumor;
  try {
    rumor = JSON.parse(plaintext) as NostrRumor;
  } catch {
    return undefined;
  }
  if (typeof rumor !== "object" || rumor === null) return undefined;
  // NIP-59 impersonation check.
  if (rumor.pubkey !== seal.pubkey) return undefined;
  if (rumor.kind !== KIND_MESSAGE && rumor.kind !== KIND_COMMENT) return undefined;
  if (!rumorShapeOk(rumor)) return undefined;
  // Strict channel binding (CORD-01), or a private Channel's keyholder could pin
  // its messages into a public list, disclosing them with proof.
  if (!HEX64.test(channelIdHex) || tagValue(rumor.tags, "channel") !== channelIdHex) return undefined;

  let rumorId: string;
  try {
    rumorId = getEventHash({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
      pubkey: rumor.pubkey,
    });
  } catch {
    return undefined;
  }

  // A bad Edit bundle drops the edit, never the pin.
  const edited = entry.edit ? verifyEditBundle(entry.edit, seal.pubkey, rumorId, channelIdHex) : undefined;

  return {
    rumorId,
    author: seal.pubkey,
    kind: rumor.kind,
    content: edited?.content ?? rumor.content,
    tags: rumor.tags,
    epoch: tagValue(rumor.tags, "epoch"),
    ms: resolveMs(rumor.created_at, rumor.tags),
    createdAt: rumor.created_at,
    wrapHint: typeof entry.wrap === "string" ? entry.wrap : undefined,
    edited,
    entry,
  };
}

/**
 * An Edit bundle proves the SAME author revised THIS message: the
 * {@link verifyPinEntry} steps plus author equality and an `e` tag naming the
 * original's recomputed rumor id.
 */
function verifyEditBundle(
  bundle: { seal: NostrEvent; keys: string },
  originalAuthor: string,
  originalRumorId: string,
  channelIdHex: string,
): { content: string; ms: number } | undefined {
  const seal = bundle?.seal;
  if (!seal || typeof seal !== "object" || seal.kind !== KIND_SEAL_ENCRYPTED) return undefined;
  if (seal.pubkey !== originalAuthor) return undefined;
  let sigOk = false;
  try {
    sigOk = verifyEvent(seal);
  } catch {
    return undefined;
  }
  if (!sigOk) return undefined;

  const keys = decodeMessageKeys(bundle.keys ?? "");
  if (!keys) return undefined;
  const plaintext = decryptWithDisclosedKeys(seal.content, keys);
  if (plaintext === undefined) return undefined;

  let rumor: NostrRumor;
  try {
    rumor = JSON.parse(plaintext) as NostrRumor;
  } catch {
    return undefined;
  }
  if (typeof rumor !== "object" || rumor === null) return undefined;
  if (rumor.pubkey !== seal.pubkey) return undefined;
  if (rumor.kind !== KIND_EDIT) return undefined;
  if (!rumorShapeOk(rumor)) return undefined;
  // Bind the Edit to this Channel too, matching withProvenEdit on the write side.
  if (tagValue(rumor.tags, "channel") !== channelIdHex) return undefined;
  if (tagValue(rumor.tags, "e") !== originalRumorId) return undefined;
  return { content: rumor.content, ms: resolveMs(rumor.created_at, rumor.tags) };
}

/** Every tag a non-empty array of strings, string content, a `created_at` in u64 (Vector's `RumorFields`). */
function rumorShapeOk(rumor: NostrRumor): boolean {
  return (
    Array.isArray(rumor.tags) &&
    rumor.tags.every((t) => Array.isArray(t) && t.length > 0 && t.every((v) => typeof v === "string")) &&
    typeof rumor.content === "string" &&
    Number.isSafeInteger(rumor.created_at) &&
    rumor.created_at >= 0
  );
}

// The list's two self-describing content forms
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const U64_MAX = 2n ** 64n - 1n;

/**
 * Serialize a PUBLIC Channel's pin list (plaintext; the plane wrap is the gate).
 * Throws on a cap violation rather than publish an edition readers read as empty.
 */
export function serializePublicPinList(entries: PinEntry[]): string {
  const content = JSON.stringify({ entries });
  assertCaps(entries.length, content);
  return content;
}

/**
 * Serialize for a PRIVATE Channel: sealed under the group conversation key at
 * `epoch`. Caps are checked on the final bytes, envelope included.
 */
export function serializeSealedPinList(entries: PinEntry[], convKey: Uint8Array, epoch: bigint): string {
  if (entries.length > PIN_MAX_ENTRIES) throw new Error(`pin list exceeds ${PIN_MAX_ENTRIES} entries`);
  const sealed = nip44Encrypt(JSON.stringify({ entries }), convKey);
  const content = JSON.stringify({ epoch: epoch.toString(), sealed });
  assertCaps(entries.length, content);
  return content;
}

function assertCaps(count: number, content: string): void {
  if (count > PIN_MAX_ENTRIES) throw new Error(`pin list exceeds ${PIN_MAX_ENTRIES} entries`);
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > PIN_MAX_CONTENT_BYTES) throw new Error(`pin list content is ${bytes} bytes (cap ${PIN_MAX_CONTENT_BYTES})`);
}

/**
 * Read a pin list's `content` (§7 Limits). A cap-violating or non-JSON edition
 * reads as EMPTY (never refused from the fold). A sealed form without the epoch
 * key returns `sealed: true` with no entries.
 */
export function readPinList(
  content: string,
  unsealKey: (epoch: bigint) => Uint8Array | undefined,
): { entries: PinEntry[]; sealed: boolean } {
  const EMPTY = { entries: [] as PinEntry[], sealed: false };
  if (typeof content !== "string") return EMPTY;
  if (new TextEncoder().encode(content).length > PIN_MAX_CONTENT_BYTES) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const obj = parsed as { entries?: unknown; epoch?: unknown; sealed?: unknown };

  // An `entries` key makes it the public form, whatever else it carries (Vector).
  if ("entries" in obj) {
    if (!Array.isArray(obj.entries) || obj.entries.length > PIN_MAX_ENTRIES) return EMPTY;
    return { entries: obj.entries as PinEntry[], sealed: false };
  }

  // An epoch past u64 names none a key exists for: empty, as Vector reads it.
  if (typeof obj.epoch === "string" && DECIMAL.test(obj.epoch) && BigInt(obj.epoch) > U64_MAX) return EMPTY;
  if (typeof obj.epoch === "string" && DECIMAL.test(obj.epoch) && typeof obj.sealed === "string") {
    const key = unsealKey(BigInt(obj.epoch));
    if (!key) return { entries: [], sealed: true };
    let inner: unknown;
    try {
      inner = JSON.parse(nip44Decrypt(obj.sealed, key));
    } catch {
      return EMPTY;
    }
    const entries = (inner as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) return EMPTY;
    if (entries.length > PIN_MAX_ENTRIES) return EMPTY;
    return { entries: entries as PinEntry[], sealed: false };
  }

  return EMPTY;
}

// Deletion (§7): self-erasure outranks curation
/**
 * Whether a kind-5 kills this pin: RECOMPUTED rumor id in its `e` tags, and only
 * when the delete's author is the pin's proven author.
 */
export function pinKilledBy(pin: VerifiedPin, deleteEvent: { author: string; tags: string[][] }): boolean {
  if (deleteEvent.author !== pin.author) return false;
  for (const t of deleteEvent.tags) if (t[0] === "e" && t[1] === pin.rumorId) return true;
  return false;
}

/** Split verified pins into the living and those an author's delete killed. */
export function partitionDeletedPins(
  pins: VerifiedPin[],
  deletes: readonly { author: string; tags: string[][] }[],
): { alive: VerifiedPin[]; killed: VerifiedPin[] } {
  const alive: VerifiedPin[] = [];
  const killed: VerifiedPin[] = [];
  for (const pin of pins) {
    (deletes.some((d) => pinKilledBy(pin, d)) ? killed : alive).push(pin);
  }
  return { alive, killed };
}

/**
 * Attach the newest provable Edit (§7 Edits), given the Edit epoch's conversation
 * key. Returns the entry unchanged if unprovable, so a refresh never downgrades it.
 */
export function withProvenEdit(entry: PinEntry, editOpened: OpenedEvent, convKey: Uint8Array): PinEntry {
  const seal = editOpened.seal;
  if (!seal || seal.kind !== KIND_SEAL_ENCRYPTED) return entry;
  const keys = discloseKeysFor(seal.content, convKey);
  if (!keys) return entry;
  const candidate: PinEntry = { ...entry, edit: { seal, keys: encodeMessageKeys(keys) } };
  // Keep it only if it verifies, as a reader would.
  return verifyPinEntry(candidate, tagValue(editOpened.tags, "channel") ?? "")?.edited ? candidate : entry;
}

/**
 * Whether this client's own write still outranks the fold, and so must be the
 * base for the next edit. The list is replace-entire and the fold lags, so a
 * published version N stays truth until a fold at ≥N is seen. Scoped by entity:
 * building on another channel's list would leak its pins and keys.
 */
export function unconfirmedWrite<T>(
  mine: { eid: string; version: bigint; held: T } | undefined,
  folded: { version: bigint } | undefined,
  /** The entity being written NOW. A record for any other one is not ours to use. */
  eid: string | undefined,
): T | undefined {
  if (!mine || !eid || mine.eid !== eid) return undefined;
  if (folded && folded.version >= mine.version) return undefined;
  return mine.held;
}
