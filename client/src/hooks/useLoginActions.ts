import { useNostr } from "@nostrify/react";
import {
  NLogin,
  type NLoginType,
  type NostrConnectParams,
  type NostrConnectStatus,
  useNostrLogin,
} from "@nostrify/react/login";

import { useAppContext } from "@/hooks/useAppContext";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { normalizeRelayUrl, PLATFORM_RELAYS, usableSignerRelays } from "@/lib/platform";
import { purgeClientStorage } from "@/lib/purgeClientStorage";

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
    // The set is FROZEN into the signer pairing for the connection's lifetime,
    // so relays this origin can't even open (ws:// under https / the APK's
    // WebView) are filtered out — otherwise the signer retries a dead relay on
    // every operation until the user re-pairs (see usableSignerRelays).
    getRelayUrls(): string[] {
      const appRelays = config.appRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const added = config.addedRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const urls = [...new Set([...appRelays, ...PLATFORM_RELAYS, ...added])];
      const insecureOrigin = typeof window !== "undefined" && window.location.protocol === "http:";
      return usableSignerRelays(urls, insecureOrigin);
    },
    // Log out the current user
    async logout(): Promise<void> {
      const login = logins[0];
      if (login) {
        removeLogin(login.id);
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
