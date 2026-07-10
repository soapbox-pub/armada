import { useNostr } from "@nostrify/react";
import { Capacitor } from "@capacitor/core";
import {
  NLogin,
  type NLoginType,
  type NostrConnectParams,
  type NostrConnectStatus,
  useNostrLogin,
} from "@nostrify/react/login";

import { useAppContext } from "@/hooks/useAppContext";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";
import { purgeClientStorage } from "@/lib/purgeClientStorage";
import { clearWalletStorage } from "@/lib/walletStorage";

export type { NostrConnectParams, NostrConnectStatus };
export { generateNostrConnectParams, generateNostrConnectURI } from "@nostrify/react/login";

export function useLoginActions() {
  const { nostr } = useNostr();
  const { logins, addLogin, setLogin, removeLogin } = useNostrLogin();
  const { config } = useAppContext();

  // Add a login and promote it to be the current user.
  const addAndActivate = (login: NLoginType) => {
    addLogin(login);
    setLogin(login.id);
  };

  return {
    // Login with a Nostr secret key
    nsec(nsec: string): void {
      const login = NLogin.fromNsec(nsec);
      addAndActivate(login);
    },
    // Login with a NIP-46 "bunker://" URI
    async bunker(uri: string): Promise<void> {
      const login = await NLogin.fromBunker(uri, nostr);
      addAndActivate(login);
    },
    // Login with a NIP-07 browser extension
    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addAndActivate(login);
    },
    // Login via nostrconnect:// (client-initiated NIP-46)
    async nostrconnect(
      params: NostrConnectParams,
      signal?: AbortSignal,
      onStatus?: (status: NostrConnectStatus) => void,
    ): Promise<void> {
      const login = await NLogin.fromNostrConnect(params, nostr, { signal, onStatus });
      addAndActivate(login);
    },
    // Relay URLs used for NIP-46 nostrconnect communication. App relays come
    // first (remote signers are usually reachable through public relays),
    // then the internal platform/user servers as fallback rendezvous points.
    //
    // The list is FROZEN into the signer pairing for the lifetime of the
    // session (#48), so relays the signer can never reach must not enter it:
    //   - loopback relays are only reachable from THIS machine, never from a
    //     remote signer (a stale ws://localhost:5577 pairing had Amber retry
    //     it on every sign for weeks);
    //   - on a native build (secure WebView origin) non-wss relays are also
    //     unusable on OUR side (mixed content), so they'd be rendezvous
    //     points only the signer could reach — dead weight at best.
    // Non-loopback ws:// LAN relays stay on the web build: an air-gapped LAN
    // deployment with a LAN signer is a supported setup.
    getRelayUrls(): string[] {
      const appRelays = config.appRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const added = config.addedRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const all = [...new Set([...appRelays, ...PLATFORM_RELAYS, ...added])];
      const usable = all.filter((url) => {
        try {
          const host = new URL(url).hostname;
          const loopback =
            host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
          if (loopback) return false;
        } catch {
          return false;
        }
        if (Capacitor.isNativePlatform()) return /^wss:\/\//i.test(url);
        return true;
      });
      // Never hand back an empty list: a loopback-only dev config still needs
      // SOME rendezvous attempt (and the QR shows the user what's wrong).
      return usable.length > 0 ? usable : all;
    },
    // Log out the current user
    async logout(): Promise<void> {
      const login = logins[0];
      if (login) {
        removeLogin(login.id);
        // The removed account's NWC wallet secrets must not outlive it —
        // purgeClientStorage below only runs on the FINAL logout.
        clearWalletStorage(login.pubkey);
      }
      // Drop the in-memory DM render memo so it can't be read after logout or
      // by the next account. (The persistent decrypt cache is per-pubkey and is
      // wiped by purgeClientStorage on the final logout below.)
      clearRenderedPlaintext();

      // If that was the last identity, wipe all client-side persistence (event
      // cache, drafts, read-state, relay-info, theme, added servers, decrypted
      // images…) and hard-redirect to the landing page so nothing is held onto
      // and the next session boots from clean storage. When other accounts
      // remain, leave their caches intact.
      if (logins.length <= 1) {
        await purgeClientStorage();
        window.location.assign("/welcome");
      }
    },
  };
}
