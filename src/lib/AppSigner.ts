import { getArmadaDB } from "@/lib/db/armadaDB";
import {
  decryptCacheId,
  decryptCacheKey,
  recentDecrypts,
  rememberDecrypt,
  type DecryptMethod,
} from "@/lib/decryptCache";
import { perfCount } from "@/lib/perf";
import { minePowFor } from "@/lib/pow";

import type { NostrSigner } from "@nostrify/nostrify";
import type { BtcSigner } from "@/lib/bitcoin-signers";

export { clearRecentDecrypts, decryptCacheKey } from "@/lib/decryptCache";

// AppSigner: wraps the user-facing signer (see `useCurrentUser`) with a
// persistent content-addressed decrypt cache, since extension/bunker decrypts
// are slow round-trips and the append-only store re-decrypts on every load.
// Only `decrypt` is memoized. Never wrap the NIP-46 transport key or AUTH signer.
// Also where the user's published events get their NIP-13 proof of work.
//
// Trust: persists DECRYPTED plaintext at rest (deliberate, like the fold
// cache); wiped on final logout by `purgeClientStorage`.

type CryptoMethods = NonNullable<NostrSigner["nip04"]>;

/**
 * Crypto bundle with an opt-out from the persistent cache: `openDmWrap` passes
 * `{ cache: false }` for NIP-40 expiring envelopes so nothing is left at rest.
 */
export interface CachingCryptoMethods extends CryptoMethods {
  decrypt(counterparty: string, ciphertext: string, opts?: { cache?: boolean }): Promise<string>;
}

export class AppSigner implements NostrSigner {
  readonly #upstream: NostrSigner;
  readonly #pubkey: string;

  /** In-flight decrypts by cache id, so concurrent callers share one resolution. */
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(upstream: NostrSigner, userPubkey: string) {
    this.#upstream = upstream;
    this.#pubkey = userPubkey;

    // Present iff upstream has them.
    if (upstream.nip04) this.nip04 = this.#wrapCrypto("nip04", upstream.nip04);
    if (upstream.nip44) this.nip44 = this.#wrapCrypto("nip44", upstream.nip44);
  }

  getPublicKey(): Promise<string> {
    return this.#upstream.getPublicKey();
  }

  /** Mined here rather than by the upstream, so a bunker or extension is asked to sign the final event. */
  async signEvent(event: Parameters<NostrSigner["signEvent"]>[0]): ReturnType<NostrSigner["signEvent"]> {
    return this.#upstream.signEvent(await minePowFor(event, this.#pubkey));
  }

  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    return this.#upstream.getRelays?.() ?? Promise.resolve({});
  }

  /** Forward PSBT signing to a BTC-enabled upstream (probed via `hasBtcSigning`). */
  signPsbt(psbtHex: string): Promise<string> {
    const upstream = this.#upstream as Partial<BtcSigner>;
    if (typeof upstream.signPsbt !== "function") {
      return Promise.reject(new Error("This signer does not support PSBT signing."));
    }
    return upstream.signPsbt(psbtHex);
  }

  nip04?: CachingCryptoMethods;
  nip44?: CachingCryptoMethods;

  /**
   * Whether resolving this ciphertext would NOT touch the upstream signer; the
   * consent gate prompts only for uncached decrypts. False on error.
   */
  async isDecryptCached(method: DecryptMethod, counterparty: string, ciphertext: string): Promise<boolean> {
    const id = await this.#deriveId(method, counterparty, ciphertext);
    if (this.#inflight.has(id)) return true;
    return (await this.#get(id)) !== undefined;
  }

  #wrapCrypto(method: DecryptMethod, crypto: CryptoMethods): CachingCryptoMethods {
    return {
      encrypt: (pubkey, plaintext) => crypto.encrypt(pubkey, plaintext),
      decrypt: (counterparty, ciphertext, opts) =>
        this.#cachedDecrypt(method, crypto, counterparty, ciphertext, opts?.cache ?? true),
    };
  }

  async #cachedDecrypt(
    method: DecryptMethod,
    crypto: CryptoMethods,
    counterparty: string,
    ciphertext: string,
    cache: boolean,
  ): Promise<string> {
    const id = await this.#deriveId(method, counterparty, ciphertext);

    // One resolution per id covering cache read + upstream decrypt. Opted-out
    // callers still join (memory-only; one plaintext per ciphertext).
    const existing = this.#inflight.get(id);
    if (existing) return existing;

    const pending = (async () => {
      // `cache: false` skips the persistent cache in both directions.
      if (!cache) {
        const start = performance.now();
        const plaintext = await crypto.decrypt(counterparty, ciphertext);
        perfCount(`signer.${method}.decrypt (uncached)`, performance.now() - start, 1, "decrypts");
        return plaintext;
      }
      const cached = await this.#get(id);
      if (cached !== undefined) {
        perfCount(`signer.${method}.decrypt (cache hit)`, 0, 1, "decrypts");
        return cached;
      }
      const start = performance.now();
      const plaintext = await crypto.decrypt(counterparty, ciphertext);
      perfCount(`signer.${method}.decrypt`, performance.now() - start, 1, "decrypts");
      void this.#put(id, plaintext);
      return plaintext;
    })().finally(() => {
      this.#inflight.delete(id);
    });

    this.#inflight.set(id, pending);
    return pending;
  }

  #deriveId(method: DecryptMethod, counterparty: string, ciphertext: string): Promise<string> {
    return decryptCacheId(method, this.#pubkey, counterparty, ciphertext);
  }

  async #get(id: string): Promise<string | undefined> {
    const remembered = recentDecrypts.get(id);
    if (remembered !== undefined) {
      recentDecrypts.delete(id);
      recentDecrypts.set(id, remembered);
      return remembered;
    }
    try {
      const stored = await getArmadaDB().kv.get<string>(decryptCacheKey(id));
      if (typeof stored === "string") rememberDecrypt(id, stored);
      return stored;
    } catch {
      return undefined;
    }
  }

  /** Persist a decrypt result, best-effort. */
  async #put(id: string, plaintext: string): Promise<void> {
    rememberDecrypt(id, plaintext);
    try {
      await getArmadaDB().kv.set(decryptCacheKey(id), plaintext);
    } catch {
      // best-effort
    }
  }
}

/**
 * Whether a signer exposes `isDecryptCached`; non-AppSigners are treated by
 * the consent gate as "would hit the signer".
 */
export function canPeekDecryptCache(
  signer: unknown,
): signer is Pick<AppSigner, "isDecryptCached"> {
  return typeof (signer as { isDecryptCached?: unknown } | null)?.isDecryptCached === "function";
}
