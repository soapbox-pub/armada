/**
 * Keys and addresses of the documents under the settings root (`settingsRoot.ts`).
 * Each document gets its own secp256k1 key and an opaque `d`, both a pure
 * function of the root, so every device holding the root re-derives the same
 * set and nothing on the wire links a document to the account. Wire format:
 * changing a label or the salt re-addresses every document.
 *
 *   sk(label) = HKDF-SHA256(ikm=root, salt="armada-nip78/v1", info=label [|| 0x00 || ctr])
 *   d(label)  = hex(HMAC-SHA256(root, "d:" || label))
 *
 * Content is NIP-44 to the document's own pubkey.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getConversationKey } from "nostr-tools/nip44";

import { DM_CONVERSATION_INDEX_BUCKETS } from "@/lib/dmConversationIndex";
import { PowNSecSigner } from "@/lib/pow";
import { SETTINGS_DOC_NAMES, type SettingsDocName } from "@/lib/settingsDocNames";

const SALT = new TextEncoder().encode("armada-nip78/v1");
const ENCODER = new TextEncoder();

export type DerivedDocRef =
  | { family: "settings"; name: SettingsDocName }
  | { family: "gif-favorites" }
  | { family: "dm-conversations"; bucket: number };

export interface DerivedDoc {
  ref: DerivedDocRef;
  label: string;
  secretKey: Uint8Array;
  pubkey: string;
  d: string;
  signer: PowNSecSigner;
}

export interface SettingsKeyring {
  /** A non-secret fingerprint of the root, for cache keys. */
  id: string;
  settings: Record<SettingsDocName, DerivedDoc>;
  gifFavorites: DerivedDoc;
  dmConversations: DerivedDoc[];
  /** Every derived author, for the standing REQ. */
  authors: string[];
  byPubkey: ReadonlyMap<string, DerivedDoc>;
}

export function derivedLabel(ref: DerivedDocRef): string {
  switch (ref.family) {
    case "settings": return `settings/${ref.name}`;
    case "gif-favorites": return "gif-favorites";
    case "dm-conversations": return `dm-conversations/${ref.bucket}`;
  }
}

/** HKDF to a valid secret key, appending a retry counter in the ~2^-128 case it is not one. */
export function deriveSecretKey(root: Uint8Array, label: string): Uint8Array {
  const base = ENCODER.encode(label);
  let info = base;
  for (let ctr = 0; ctr < 256; ctr++) {
    const sk = hkdf(sha256, root, SALT, info, 32);
    if (secp256k1.utils.isValidSecretKey(sk)) return sk;
    info = new Uint8Array(base.length + 2);
    info.set(base);
    info[base.length] = 0;
    info[base.length + 1] = ctr;
  }
  throw new Error("Could not derive a settings key");
}

export function deriveDTag(root: Uint8Array, label: string): string {
  return bytesToHex(hmac(sha256, root, ENCODER.encode(`d:${label}`)));
}

function deriveDoc(root: Uint8Array, ref: DerivedDocRef): DerivedDoc {
  const label = derivedLabel(ref);
  const secretKey = deriveSecretKey(root, label);
  return {
    ref,
    label,
    secretKey,
    pubkey: bytesToHex(schnorr.getPublicKey(secretKey)),
    d: deriveDTag(root, label),
    signer: new PowNSecSigner(secretKey),
  };
}

const keyringMemo = new Map<string, SettingsKeyring>();

/** Every derived document under `rootHex`. Memoized: the derivation is pure. */
export function settingsKeyring(rootHex: string): SettingsKeyring {
  const held = keyringMemo.get(rootHex);
  if (held) return held;
  const root = hexToBytes(rootHex);
  const settings = Object.fromEntries(
    SETTINGS_DOC_NAMES.map((name) => [name, deriveDoc(root, { family: "settings", name })]),
  ) as Record<SettingsDocName, DerivedDoc>;
  const gifFavorites = deriveDoc(root, { family: "gif-favorites" });
  const dmConversations = Array.from(
    { length: DM_CONVERSATION_INDEX_BUCKETS },
    (_, bucket) => deriveDoc(root, { family: "dm-conversations", bucket }),
  );
  const all = [...Object.values(settings), gifFavorites, ...dmConversations];
  const keyring: SettingsKeyring = {
    id: bytesToHex(sha256(ENCODER.encode(`armada-nip78/id:${rootHex}`))).slice(0, 16),
    settings,
    gifFavorites,
    dmConversations,
    authors: all.map((doc) => doc.pubkey),
    byPubkey: new Map(all.map((doc) => [doc.pubkey, doc])),
  };
  keyringMemo.set(rootHex, keyring);
  return keyring;
}

/** Drop the memoized secrets (logout). */
export function clearSettingsKeyringMemo(): void {
  keyringMemo.clear();
}

/** The derived document `event` belongs to: right author AND right `d`. */
export function derivedDocOf(
  keyring: SettingsKeyring | null | undefined,
  event: { pubkey: string; tags: string[][] },
): DerivedDoc | undefined {
  const doc = keyring?.byPubkey.get(event.pubkey);
  if (!doc) return undefined;
  return event.tags.some(([name, value]) => name === "d" && value === doc.d) ? doc : undefined;
}

/** One derived document, as the Android service is told about it. */
export interface NativeSelfDoc {
  pubkey: string;
  d: string;
  /**
   * Only for read-state: the document's NIP-44 conversation key, so the service
   * can dismiss notifications read elsewhere. It can open that document, not sign one.
   */
  readStateKey?: string;
}

/** Per keyring: the read-state documents' keys are an ECDH each, and every native config build asked. */
const selfDocsByKeyring = new WeakMap<SettingsKeyring, NativeSelfDoc[]>();

export function nativeSelfDocs(keyring: SettingsKeyring | null | undefined): NativeSelfDoc[] {
  if (!keyring) return [];
  let docs = selfDocsByKeyring.get(keyring);
  if (!docs) selfDocsByKeyring.set(keyring, (docs = buildSelfDocs(keyring)));
  return docs;
}

function buildSelfDocs(keyring: SettingsKeyring): NativeSelfDoc[] {
  return [...keyring.byPubkey.values()].map((doc) => {
    const readState = doc.ref.family === "settings"
      && (doc.ref.name === "read-state" || doc.ref.name === "read-state-recent");
    return {
      pubkey: doc.pubkey,
      d: doc.d,
      ...(readState ? { readStateKey: bytesToHex(getConversationKey(doc.secretKey, doc.pubkey)) } : {}),
    };
  });
}

/** A fresh 32-byte root secret. */
export function generateSettingsRoot(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
