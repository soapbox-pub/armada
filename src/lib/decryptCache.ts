/**
 * The signer's decrypt cache (see `AppSigner`): plaintext by a content-addressed
 * id, persisted in KV with an in-memory LRU in front. A leaf so the service
 * worker's NIP-17 opener can forget entries without bundling the signer.
 */
import { getEventHash } from "nostr-tools/pure";

import { getArmadaDB } from "@/lib/db/armadaDB";

/** KV key for a derived cache id (the KV namespace is shared, so prefixed). */
export const decryptCacheKey = (id: string): string => `decrypt:${id}`;

/** Folded into the cache id so nip44 entries are never served for nip04 calls. */
export type DecryptMethod = "nip04" | "nip44";

/**
 * Cache id: sha256(`${method}\0${pubkey}\0${counterparty}\0${ciphertext}`).
 * Namespaced per account; ciphertext is immutable so entries never go stale.
 */
export async function decryptCacheId(
  method: DecryptMethod,
  pubkey: string,
  counterparty: string,
  ciphertext: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${method}\u0000${pubkey}\u0000${counterparty}\u0000${ciphertext}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * In-memory LRU in front of the persistent cache: the same ciphertexts recur
 * constantly, and each Android persistent read is a native round trip.
 */
export const recentDecrypts = new Map<string, string>();
const MAX_RECENT_DECRYPTS = 2_048;

export function rememberDecrypt(id: string, plaintext: string): void {
  recentDecrypts.delete(id);
  recentDecrypts.set(id, plaintext);
  if (recentDecrypts.size > MAX_RECENT_DECRYPTS) {
    const oldest = recentDecrypts.keys().next().value;
    if (oldest !== undefined) recentDecrypts.delete(oldest);
  }
}

/** Forget one cached decrypt, in memory and at rest. */
export async function forgetDecrypt(
  pubkey: string,
  method: DecryptMethod,
  counterparty: string,
  ciphertext: string,
): Promise<void> {
  const id = await decryptCacheId(method, pubkey, counterparty, ciphertext);
  recentDecrypts.delete(id);
  await getArmadaDB().kv.delete(decryptCacheKey(id)).catch(() => undefined);
}

/**
 * Forget every cached decrypt of a removed NIP-17 message: the rumor's own
 * plaintext (matched by its computed id, since a rumor may omit `id`) and the
 * seal plaintext that would decrypt it again. Kind 4 has one decrypt, which the
 * caller forgets with {@link forgetDecrypt}.
 */
export async function forgetDecryptsOfRumor(pubkey: string, rumor: { id: string; pubkey: string }): Promise<void> {
  const kv = getArmadaDB().kv;
  const stored = await kv.list<unknown>({ prefix: decryptCacheKey("") }).catch(() => []);
  const entries: Array<[string, unknown]> = [
    ...recentDecrypts,
    ...stored.map(({ key, value }): [string, unknown] => [key.slice(decryptCacheKey("").length), value]),
  ];
  const parsed = (text: unknown): Record<string, unknown> | undefined => {
    if (typeof text !== "string" || !text.startsWith("{")) return undefined;
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };

  const doomed = new Set<string>();
  for (const [id, text] of entries) {
    if (typeof text !== "string" || !text.includes(rumor.pubkey)) continue;
    const r = parsed(text);
    if (!r || typeof r.kind !== "number" || typeof r.content !== "string" || !Array.isArray(r.tags)) continue;
    if (typeof r.created_at !== "number" || typeof r.pubkey !== "string") continue;
    const hash = getEventHash({ kind: r.kind, content: r.content, tags: r.tags as string[][], created_at: r.created_at, pubkey: r.pubkey });
    if (hash === rumor.id) doomed.add(id);
  }
  if (doomed.size === 0) return;
  // The seal whose decrypt is one of those: kind 13 from the rumor's author.
  for (const [id, text] of entries) {
    const seal = parsed(text);
    if (seal?.kind !== 13 || typeof seal.pubkey !== "string" || typeof seal.content !== "string") continue;
    if (doomed.has(await decryptCacheId("nip44", pubkey, seal.pubkey, seal.content))) doomed.add(id);
  }
  for (const id of doomed) recentDecrypts.delete(id);
  await Promise.all([...doomed].map((id) => kv.delete(decryptCacheKey(id)).catch(() => undefined)));
}

/** Drop every in-memory decrypt (logout: see purgeClientStorage). */
export function clearRecentDecrypts(): void {
  recentDecrypts.clear();
}
