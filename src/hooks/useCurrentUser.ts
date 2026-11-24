import { NSecSigner } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { type NLoginType, NUser, useNostrLogin } from "@nostrify/react/login";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo } from "react";

import { AndroidNativeSigner } from "@/lib/androidNativeSigner";
import { AppSigner } from "@/lib/AppSigner";
import {
  NSecSignerBtc,
  NBrowserSignerBtc,
} from "@/lib/bitcoin-signers";
import { NIP46_SIGN_TIMEOUT_MS, Nip46Signer } from "@/lib/nip46Signer";
import { getNip46Transport } from "@/lib/nip46Transport";
import { signerWithNudge } from "@/lib/signerWithNudge";
import { logSync } from "@/lib/syncLog";

import { useAuthor } from "./useAuthor.ts";

/**
 * ONE NUser (and signer) per (nostr instance, login id), app-wide. Per-call-site
 * construction would give NIP-46 logins N signers with duplicate bunker subscriptions
 * and caches. Weakly keyed by the nostr instance so a provider remount invalidates it.
 */
const userCache = new WeakMap<object, Map<string, NUser>>();

export function useCurrentUser() {
  const { nostr } = useNostr();
  const { logins } = useNostrLogin();

  // AppSigner serves `decrypt` from the persistent cache; signerWithNudge toasts
  // on slow remote signs. Only this signer — not the NIP-46 transport key or AUTH signer.
  const cached = useCallback(
    (user: NUser, isBunkerConnected?: () => boolean, bunkerRelays?: string[]): NUser =>
      new NUser(
        user.method,
        user.pubkey,
        signerWithNudge(
          new AppSigner(user.signer, user.pubkey),
          isBunkerConnected,
          // A NIP-46 or NIP-55 signature may wait on the user approving it in the signer app.
          user.method === "bunker"
            ? { remote: true, signerRelays: bunkerRelays, hardTimeoutMs: NIP46_SIGN_TIMEOUT_MS + 10_000 }
            : user.method === "x-android-signer"
              ? { hardTimeoutMs: NIP46_SIGN_TIMEOUT_MS + 10_000 }
              : undefined,
        ),
      ),
    [],
  );

  const loginToUser = useCallback((login: NLoginType): NUser => {
    let byLogin = userCache.get(nostr as object);
    if (!byLogin) {
      byLogin = new Map();
      userCache.set(nostr as object, byLogin);
    }
    const existing = byLogin.get(login.id);
    if (existing) return existing;

    const user = (() => {
      switch (login.type) {
        case "nsec": {
          const sk = nip19.decode(login.data.nsec) as { type: "nsec"; data: Uint8Array };
          return cached(new NUser(login.type, login.pubkey, new NSecSignerBtc(sk.data)));
        }
        case "bunker": {
          const clientSk = nip19.decode(login.data.clientNsec) as { type: "nsec"; data: Uint8Array };
          const clientSigner = new NSecSigner(clientSk.data);
          const bunkerRelays = login.data.relays;

          // NIP-46 uses a DEDICATED plain-WebSocket transport (the pool wedges on
          // Android; see nip46Transport.ts) and one persistent response subscription
          // (nip46Signer.ts).
          const transport = getNip46Transport(login.data.bunkerPubkey, bunkerRelays);
          logSync("nip46", `building the app-wide bunker signer (login ${login.id.slice(0, 8)})`);

          return cached(
            new NUser(
              login.type,
              login.pubkey,
              new Nip46Signer({
                transport,
                bunkerPubkey: login.data.bunkerPubkey,
                clientSigner,
              }),
            ),
            // Lets the nudge say "signer relay unreachable" when all bunker sockets are down.
            () => transport.isConnected(),
            bunkerRelays,
          );
        }
        case "extension":
          return cached(
            new NUser(login.type, login.pubkey, new NBrowserSignerBtc({ pubkey: login.pubkey })),
          );
        case "x-android-signer": {
          // NIP-55 Android signer (Amber…): seed the pubkey to avoid boot prompts;
          // AppSigner caches decrypts to avoid an intent per ciphertext.
          const { packageName } = login.data as { packageName: string };
          return cached(
            new NUser(login.type, login.pubkey, new AndroidNativeSigner(packageName, login.pubkey)),
          );
        }
        default:
          throw new Error(`Unsupported login type: ${login.type}`);
      }
    })();
    byLogin.set(login.id, user);
    return user;
  }, [nostr, cached]);

  const users = useMemo(() => {
    const users: NUser[] = [];
    for (const login of logins) {
      try {
        users.push(loginToUser(login));
      } catch (error) {
        console.warn("Skipped invalid login", login.id, error);
      }
    }
    return users;
  }, [logins, loginToUser]);

  const user = users[0] as NUser | undefined;

  // No profile read here: this is called per message row. See useCurrentUserProfile.
  return { user, users };
}

/** The current user plus their kind-0 profile. One query observer per call. */
export function useCurrentUserProfile() {
  const { user, users } = useCurrentUser();
  const author = useAuthor(user?.pubkey);
  return {
    user,
    users,
    ...author.data,
    isLoading: author.isLoading,
  };
}
