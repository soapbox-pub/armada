/**
 * A NIP-07 provider pinned to one account. Din's `window.nostr` (and its
 * service workers' `self.nostr`) adds `getSigner(pubkey)`, a signer that keeps
 * acting as that account whatever account Din switches to; elsewhere the
 * provider IS the account, and is used only while it still answers as it.
 *
 * Worker-safe: no DOM, no React.
 */

export interface Nip07Crypto {
  encrypt(pubkey: string, plaintext: string): Promise<string>;
  decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: unknown): Promise<unknown>;
  getRelays?(): Promise<unknown>;
  nip04?: Nip07Crypto;
  nip44?: Nip07Crypto;
  signPsbt?(psbtHex: string): Promise<string>;
  /** Din: a signer that always acts as `pubkey`; rejects `NotFoundError` if the site doesn't hold it. */
  getSigner?(pubkey: string): Promise<Nip07Provider>;
}

/** The global provider, if one has been injected. */
export function globalNip07(): Nip07Provider | undefined {
  const nostr = (globalThis as { nostr?: unknown }).nostr;
  return nostr && typeof nostr === "object" ? nostr as Nip07Provider : undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NotFoundError";
}

/**
 * Resolve `nostr` to a provider acting as `pubkey`. `getSigner` is preferred;
 * where the site doesn't hold the account (or there is no `getSigner`), the
 * provider itself is used only if its own account is `pubkey`, never as
 * another account. Rejects otherwise.
 */
export async function pinNip07(nostr: Nip07Provider, pubkey: string): Promise<Nip07Provider> {
  if (typeof nostr.getSigner === "function") {
    try {
      const pinned = await nostr.getSigner(pubkey);
      if (pinned && typeof pinned === "object") return pinned;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const current = await nostr.getPublicKey();
  if (current !== pubkey) {
    throw new DOMException("The signer is signed in to a different account", "NotFoundError");
  }
  return nostr;
}

/** Whether `nostr` has Din's pinned signers, so a pin survives an account switch. */
export function canPinNip07(nostr: Nip07Provider | undefined): boolean {
  return typeof nostr?.getSigner === "function";
}
