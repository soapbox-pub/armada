import { Capacitor } from "@capacitor/core";
import { BunkerURI, NSecSigner } from "@nostrify/nostrify";
import {
  NLogin,
  type NLoginType,
  type NostrConnectParams,
  type NostrConnectStatus,
  useNostrLogin,
} from "@nostrify/react/login";
import { generateSecretKey, nip19 } from "nostr-tools";

import { AndroidNativeSigner } from "@/lib/androidNativeSigner";
import { useAppContext } from "@/hooks/useAppContext";
import { Nip46Signer } from "@/lib/nip46Signer";
import { Nip46Transport } from "@/lib/nip46Transport";
import { normalizeRelayUrl } from "@/lib/platform";
import { addAndSwitchAccount, signOutAccount } from "@/lib/switchAccount";
import { finalLogout } from "@/lib/finalLogout";
import { logSync } from "@/lib/syncLog";
import { beginAccountExit } from "@/components/accountExitState";
import { t } from "@/i18n";

export type { NostrConnectParams, NostrConnectStatus };
export { generateNostrConnectParams, generateNostrConnectURI } from "@nostrify/react/login";

/** Cap on the frozen bunker relay set — pairing URIs plus the bunker's own. */
const MAX_BUNKER_RELAYS = 8;

/** Cap on nostrconnect:// rendezvous relays: each one grows the login QR, and one shared relay suffices. */
const MAX_RENDEZVOUS_RELAYS = 4;

/**
 * Loopback is unreachable for a remote signer, and on native builds non-wss relays are
 * mixed content on our side. LAN ws:// stays usable on web (air-gapped setups).
 */
function usableRendezvousRelay(url: string): boolean {
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
}

/**
 * Merge the bunker's own `get_relays` list (NIP-46) into the frozen pairing set: old
 * bunker:// URIs often carry stale relays. Best-effort; pairing relays stay FIRST.
 */
async function adoptBunkerRelays(signer: Nip46Signer, pairingRelays: string[]): Promise<string[]> {
  let reported: string[];
  try {
    const relays = await Promise.race([
      signer.getRelays(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("get_relays probe timed out")), 10_000),
      ),
    ]);
    reported = Object.entries(relays)
      .filter(([, perm]) => perm?.read || perm?.write)
      .map(([url]) => url);
  } catch {
    return pairingRelays;
  }
  const merged = [...pairingRelays];
  for (const url of reported) {
    const normalized = normalizeRelayUrl(url);
    if (!normalized || !usableRendezvousRelay(normalized) || merged.includes(normalized)) continue;
    merged.push(normalized);
    if (merged.length >= MAX_BUNKER_RELAYS) break;
  }
  logSync("nip46", `session relay set: ${merged.length} relay(s) (${reported.length} reported by bunker)`);
  return merged;
}

export function useLoginActions() {
  const { logins, addLogin, setLogin } = useNostrLogin();
  const { config } = useAppContext();

  const addAndActivate = async (login: NLoginType): Promise<void> => {
    // Adding an account while one is active is a switch: cleanup and hard reload happen before
    // the new signer is exposed.
    if (logins.length === 0) {
      addLogin(login);
      setLogin(login.id);
      return;
    }
    await addAndSwitchAccount(logins, login);
  };

  return {
    async nsec(nsec: string): Promise<void> {
      const login = NLogin.fromNsec(nsec);
      await addAndActivate(login);
    },
    // Pairing uses a throwaway Nip46Transport, never the relay pool (which wedges NIP-46 on
    // Android; see nip46Transport.ts). The bunker's relays are then adopted (adoptBunkerRelays).
    async bunker(uri: string): Promise<void> {
      const { pubkey: bunkerPubkey, secret, relays } = new BunkerURI(uri);
      if (!relays.length) {
        throw new Error(t({ id: "useLoginActions.noRelay", defaultMessage: "No relay provided" }));
      }
      const clientSk = generateSecretKey();
      const transport = new Nip46Transport(relays);
      try {
        const signer = new Nip46Signer({
          transport,
          bunkerPubkey,
          clientSigner: new NSecSigner(clientSk),
        });
        await signer.connect(secret);
        const pubkey = await signer.getPublicKey();
        const sessionRelays = await adoptBunkerRelays(signer, relays);
        await addAndActivate(
          new NLogin("bunker", pubkey, {
            bunkerPubkey,
            clientNsec: nip19.nsecEncode(clientSk),
            relays: sessionRelays,
          }),
        );
      } finally {
        transport.close();
      }
    },
    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      await addAndActivate(login);
    },
    // NIP-55 Android signer (Amber, etc.); the pubkey is persisted so later sessions don't re-prompt.
    async androidSigner(packageName: string): Promise<void> {
      const signer = new AndroidNativeSigner(packageName);
      const pubkey = await signer.getPublicKey();
      const login = new NLogin("x-android-signer", pubkey, { packageName });
      await addAndActivate(login);
    },
    // Client-initiated NIP-46. Same dedicated-transport rule as bunker(): the bunker pubkey is
    // unknown until the ack, so it can't share the session transport. Closed in `finally`.
    async nostrconnect(
      params: NostrConnectParams,
      signal?: AbortSignal,
      onStatus?: (status: NostrConnectStatus) => void,
    ): Promise<void> {
      const clientSigner = new NSecSigner(params.clientSecretKey);
      const transport = new Nip46Transport(params.relays);
      const effectiveSignal = signal ?? AbortSignal.timeout(120_000);
      try {
        onStatus?.("awaiting-connect");
        const sub = transport.req([{ kinds: [24133], "#p": [params.clientPubkey] }], {
          signal: effectiveSignal,
        });
        for await (const msg of sub) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2];
          let response: { result?: unknown };
          try {
            response = JSON.parse(await clientSigner.nip44.decrypt(event.pubkey, event.content));
          } catch {
            continue; // Not addressed to us / undecryptable noise.
          }
          // ONLY the generated secret is accepted: the REQ reveals the client pubkey to every relay,
          // so any of them could win with a bare "ack". (`bunker://` pins the counterparty, so "ack" is fine there.)
          if (response?.result !== params.secret) continue;

          onStatus?.("getting-public-key");
          logSync("nip46", `nostrconnect ack from signer ${event.pubkey.slice(0, 8)} — fetching user pubkey`);
          const signer = new Nip46Signer({
            transport,
            bunkerPubkey: event.pubkey,
            clientSigner,
          });
          const userPubkey = await signer.getPublicKey();
          const sessionRelays = await adoptBunkerRelays(signer, params.relays);
          await addAndActivate(
            new NLogin("bunker", userPubkey, {
              bunkerPubkey: event.pubkey,
              clientNsec: nip19.nsecEncode(params.clientSecretKey),
              relays: sessionRelays,
            }),
          );
          return;
        }
        // Ended without a response: aborted or timed out.
        if (effectiveSignal.aborted) {
          const err = new Error("The nostrconnect handshake was aborted");
          err.name = "AbortError";
          throw err;
        }
        throw new Error(t({ id: "useLoginActions.signerTimeout", defaultMessage: "Timeout waiting for remote signer" }));
      } finally {
        transport.close();
      }
    },
    // NIP-46 rendezvous relays: the app relays (the user's NIP-29 servers need a login to read).
    // Frozen into the pairing, so unreachable relays are filtered (see usableRendezvousRelay).
    getRelayUrls(): string[] {
      const appRelays = config.appRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const all = [...new Set(appRelays)];
      const usable = all.filter(usableRendezvousRelay);
      // Never empty: a loopback-only dev config still needs SOME rendezvous attempt.
      return (usable.length > 0 ? usable : all).slice(0, MAX_RENDEZVOUS_RELAYS);
    },
    async logout(): Promise<void> {
      const login = logins[0];
      // Last identity: wipe persistence and land on login (see finalLogout).
      if (logins.length <= 1) {
        await finalLogout(login?.pubkey ?? null);
        return;
      }
      // Otherwise this is an account SWITCH and takes the switch path, reload included, so no
      // caches leak to the next account.
      beginAccountExit("switch", login?.pubkey ?? "");
      if (login) await signOutAccount(logins, login.id);
    },
  };
}
