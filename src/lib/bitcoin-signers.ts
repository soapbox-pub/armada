import type { NostrEvent, NostrSigner } from '@nostrify/types';
import { NSecSigner, NBrowserSigner } from '@nostrify/nostrify';
import { nip44 } from 'nostr-tools';

import { canPinNip07, globalNip07, pinNip07, type Nip07Crypto, type Nip07Provider } from '@/lib/nip07Pin';

/** Conversation keys kept per nsec signer, and first sightings remembered. */
const CONVERSATION_KEYS_MAX = 512;
const SEEN_ONCE_MAX = 2_048;

/**
 * A Nostr signer with PSBT signing: signs Taproot inputs matching its key and
 * returns the signed (not finalized) hex PSBT. The heavy implementation is
 * lazily imported so this module stays out of the ~150 kB crypto stack.
 */
export interface BtcSigner extends NostrSigner {
  signPsbt(psbtHex: string): Promise<string>;
}

export function hasBtcSigning(signer: NostrSigner): signer is BtcSigner {
  return typeof (signer as BtcSigner).signPsbt === 'function';
}

/**
 * `NSecSigner` with local Taproot PSBT signing. `NSecSigner` keeps its key in
 * a `#private` field, so this keeps its own runtime-private copy.
 */
export class NSecSignerBtc extends NSecSigner implements BtcSigner {
  readonly #secretKeyBytes: Uint8Array;

  constructor(secretKey: Uint8Array) {
    super(secretKey);
    this.#secretKeyBytes = new Uint8Array(secretKey);
  }

  /**
   * NIP-44 with cached conversation keys (each is a ~4ms+ ECDH). Admission
   * needs a second sighting so one-shot gift-wrap authors don't displace the
   * recurring seal senders.
   */
  override nip44 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> =>
      nip44.v2.encrypt(plaintext, this.#conversationKey(pubkey)),
    decrypt: async (pubkey: string, ciphertext: string): Promise<string> =>
      nip44.v2.decrypt(ciphertext, this.#conversationKey(pubkey)),
  };

  readonly #conversationKeys = new Map<string, Uint8Array>();
  readonly #seenOnce = new Set<string>();

  #conversationKey(pubkey: string): Uint8Array {
    const hit = this.#conversationKeys.get(pubkey);
    if (hit) {
      this.#conversationKeys.delete(pubkey);
      this.#conversationKeys.set(pubkey, hit);
      return hit;
    }
    const key = nip44.v2.utils.getConversationKey(this.#secretKeyBytes, pubkey);
    if (this.#seenOnce.delete(pubkey)) {
      this.#conversationKeys.set(pubkey, key);
      if (this.#conversationKeys.size > CONVERSATION_KEYS_MAX) {
        const oldest = this.#conversationKeys.keys().next();
        if (!oldest.done) this.#conversationKeys.delete(oldest.value);
      }
    } else {
      this.#seenOnce.add(pubkey);
      if (this.#seenOnce.size > SEEN_ONCE_MAX) {
        const oldest = this.#seenOnce.values().next();
        if (!oldest.done) this.#seenOnce.delete(oldest.value);
      }
    }
    return key;
  }

  async signPsbt(psbtHex: string): Promise<string> {
    const { signNsecPsbt } = await import('@/lib/bitcoin-signers-impl');
    return signNsecPsbt(psbtHex, this.#secretKeyBytes);
  }
}

/**
 * `NBrowserSigner` with NIP-07 `window.nostr.signPsbt()` support. Given the
 * login's `pubkey`, a provider with Din's `getSigner` is pinned to it, so
 * switching the account in Din doesn't switch Armada's; any other provider is
 * used as `NBrowserSigner` uses it.
 */
export class NBrowserSignerBtc extends NBrowserSigner implements BtcSigner {
  readonly #pubkey?: string;
  #pinned?: Promise<Nip07Provider>;

  constructor(opts?: { timeout?: number; pubkey?: string }) {
    super(opts);
    this.#pubkey = opts?.pubkey;
  }

  /** The pinned provider, or undefined to behave as `NBrowserSigner`. */
  #pin(): Promise<Nip07Provider> | undefined {
    const nostr = globalNip07();
    if (!this.#pubkey || !nostr || !canPinNip07(nostr)) return undefined;
    if (!this.#pinned) {
      const pinned = pinNip07(nostr, this.#pubkey);
      this.#pinned = pinned;
      // A refusal isn't kept: the user may connect the account again.
      pinned.catch(() => {
        if (this.#pinned === pinned) this.#pinned = undefined;
      });
    }
    return this.#pinned;
  }

  override async getPublicKey(): Promise<string> {
    if (this.#pin() && this.#pubkey) return this.#pubkey;
    return super.getPublicKey();
  }

  override async signEvent(event: Parameters<NBrowserSigner['signEvent']>[0]): Promise<NostrEvent> {
    const pinned = this.#pin();
    if (!pinned) return super.signEvent(event);
    const signed = await (await pinned).signEvent(event) as NostrEvent;
    if (typeof signed !== 'object' || !signed?.id || !signed.pubkey || !signed.sig) {
      throw new Error('Nostr event signing failed: the signer returned no signed event');
    }
    return signed;
  }

  override async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    const pinned = this.#pin();
    if (!pinned) return super.getRelays();
    const target = await pinned;
    const relays = typeof target.getRelays === 'function' ? await target.getRelays() : {};
    return relays && typeof relays === 'object' ? relays as Record<string, { read: boolean; write: boolean }> : {};
  }

  override get nip04(): NostrSigner['nip04'] {
    return this.#pinnedCrypto('nip04') ?? super.nip04;
  }

  override get nip44(): NostrSigner['nip44'] {
    return this.#pinnedCrypto('nip44') ?? super.nip44;
  }

  #pinnedCrypto(method: 'nip04' | 'nip44'): Nip07Crypto | undefined {
    if (!this.#pin() || !globalNip07()?.[method]) return undefined;
    const call = async (op: 'encrypt' | 'decrypt', pubkey: string, text: string) => {
      const crypto = (await this.#pin())?.[method];
      if (!crypto) throw new Error(`${method.toUpperCase()} is not supported by the signer`);
      const result = await crypto[op](pubkey, text);
      if (typeof result !== 'string') throw new Error(`${method.toUpperCase()} ${op} failed: expected a string`);
      return result;
    };
    return {
      encrypt: (pubkey, plaintext) => call('encrypt', pubkey, plaintext),
      decrypt: (pubkey, ciphertext) => call('decrypt', pubkey, ciphertext),
    };
  }

  async signPsbt(psbtHex: string): Promise<string> {
    const pinned = this.#pin();
    // `awaitNostr` is TypeScript-private but JavaScript-public at runtime.
    const nostr = (pinned ? await pinned : await (this as unknown as { awaitNostr(): Promise<Nip07Provider> }).awaitNostr()) as unknown as Record<string, unknown>;

    if (typeof nostr.signPsbt !== 'function') {
      throw new Error(
        "Your browser extension doesn't support sending Bitcoin. Try a different extension, or log in with your secret key.",
      );
    }

    const signPsbt = nostr.signPsbt as (hex: string) => Promise<string>;
    return signPsbt.call(nostr, psbtHex);
  }
}

// The NIP-46 bunker signer is `Nip46Signer` in `@/lib/nip46Signer.ts`.
