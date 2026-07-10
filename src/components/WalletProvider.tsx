import React, { useCallback, useEffect, useMemo, useState } from "react";

import { WalletContext, type WalletContextType } from "@/contexts/WalletContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { readActive, readConnections, writeWalletStorage, type NWCConnection } from "@/lib/walletStorage";
import { bolt11Info } from "@/lib/zaps";

import type { LN } from "@getalby/sdk";
import type { WebLNProvider } from "@webbtc/webln-types";

/** Load the NWC SDK on first use — it's heavy and most sessions never pay. */
async function loadSdk(): Promise<typeof import("@getalby/sdk")> {
  return import("@getalby/sdk");
}

/**
 * Lightning wallet state for the current account.
 *
 * NWC connection URIs are wallet-spending SECRETS: they live in per-account
 * plain localStorage keys (see src/lib/walletStorage.ts — never synced, only
 * the alias + wallet-service pubkey prefix are ever rendered, purged when the
 * account is removed).
 *
 * Storage is keyed by pubkey and re-read on account switch, so wallets never
 * leak between accounts. Ported from Ditto's useNWC (validation budgets,
 * payment budget, error mapping) minus its context/SDK-instance caching —
 * a fresh `LN` per operation is simpler and each operation is seconds-long.
 */

const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Outer backstop for a payment. The SDK owns the real reply timeout (~60s per
 * request); this only guards against the SDK itself hanging, and must be
 * LONGER than the SDK's timeout so a slow-settling payment is never cut off
 * before {@link recoverPreimage} can run — cutting it short loses the preimage
 * even though the sats already moved.
 */
const PAY_TIMEOUT_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Recover a payment's preimage when `pay()` rejected without one — the
 * near-universal NWC failure where the wallet paid but its response event was
 * slow or lost (`Nip47ReplyTimeoutError`; the user's sats are gone, the ack
 * isn't). We don't classify the error: we ask the wallet whether the invoice
 * settled. A genuinely failed payment reports `failed`/never settles, so we
 * return null and the caller rethrows the original error. Polls a few times
 * because a just-timed-out payment may still be `pending`.
 *
 * This matters most for CORD.md private zaps, whose sealed announcement can't
 * be built without the preimage — a lost ack would otherwise mean paid sats
 * with no zap to show for them.
 */
async function recoverPreimage(client: LN, invoice: string): Promise<string | null> {
  // NIP-47 lets lookup_invoice match on payment_hash OR the bolt11 string, and
  // wallets vary in which they honor — try both. The hash decodes locally.
  const { paymentHash } = bolt11Info(invoice);
  const requests: Array<{ payment_hash: string } | { invoice: string }> = [];
  if (paymentHash) requests.push({ payment_hash: paymentHash });
  requests.push({ invoice });

  let unsupported = false;
  for (let attempt = 0; attempt < 5 && !unsupported; attempt++) {
    // A just-settled payment can report `pending` briefly; poll a few rounds.
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 1500));
    for (const request of requests) {
      try {
        const tx = await client.nwcClient.lookupInvoice(request);
        if (tx?.state === "settled" && tx.preimage) return tx.preimage;
        if (tx?.state === "failed") return null;
      } catch (e) {
        const message = e instanceof Error ? e.message.toLowerCase() : "";
        if (message.includes("not supported") || message.includes("unsupported") || message.includes("not_implemented")) {
          unsupported = true;
          break;
        }
        // Transient lookup error — keep polling.
      }
    }
  }
  return null;
}

const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  const [connections, setConnections] = useState<NWCConnection[]>(() => readConnections(pubkey));
  const [active, setActiveString] = useState<string | null>(() => readActive(pubkey));

  // Account switch: swap to the new account's wallet set, never mixing.
  useEffect(() => {
    setConnections(readConnections(pubkey));
    setActiveString(readActive(pubkey));
  }, [pubkey]);

  const persist = useCallback(
    (next: NWCConnection[], nextActive: string | null) => {
      setConnections(next);
      setActiveString(nextActive);
      if (pubkey) writeWalletStorage(pubkey, next, nextActive);
    },
    [pubkey],
  );

  const addConnection = useCallback(
    async (uri: string, alias?: string) => {
      const trimmed = uri.trim();
      if (!/^nostr\+?walletconnect:\/\//i.test(trimmed)) {
        throw new Error("Not a wallet connection string (expected nostr+walletconnect://…).");
      }
      if (connections.some((c) => c.connectionString === trimmed)) {
        throw new Error("That wallet is already connected.");
      }
      // Prove the wallet is reachable before saving: a NIP-47 get_info
      // round-trip against the wallet service's relay.
      let client: LN | undefined;
      try {
        await withTimeout(
          (async () => {
            const { LN: LNClass } = await loadSdk();
            client = new LNClass(trimmed);
            await client.nwcClient.getInfo();
          })(),
          CONNECT_TIMEOUT_MS,
          "Wallet didn't respond — check the connection string and try again.",
        );
      } catch (e) {
        throw e instanceof Error ? e : new Error("Couldn't reach that wallet.");
      } finally {
        try {
          client?.close();
        } catch {
          // best-effort socket cleanup
        }
      }
      const connection: NWCConnection = {
        connectionString: trimmed,
        alias: alias?.trim() || "Lightning wallet",
        addedAt: Date.now(),
      };
      // First wallet becomes active automatically.
      persist([...connections, connection], active ?? trimmed);
    },
    [connections, active, persist],
  );

  const removeConnection = useCallback(
    (connectionString: string) => {
      const next = connections.filter((c) => c.connectionString !== connectionString);
      const nextActive =
        active === connectionString ? (next[0]?.connectionString ?? null) : active;
      persist(next, nextActive);
    },
    [connections, active, persist],
  );

  const setActive = useCallback(
    (connectionString: string) => {
      if (connections.some((c) => c.connectionString === connectionString)) {
        persist(connections, connectionString);
      }
    },
    [connections, persist],
  );

  const payWithNWC = useCallback(
    async (invoice: string): Promise<{ preimage: string | null }> => {
      const connection = connections.find((c) => c.connectionString === active);
      if (!connection) throw new Error("No wallet connected.");
      let client: LN | undefined;
      try {
        return await withTimeout(
          (async () => {
            const sdk = await loadSdk();
            client = new sdk.LN(connection.connectionString);
            try {
              const result = await client.pay(invoice);
              if (result?.preimage) return { preimage: result.preimage };
              // Paid, but the reply carried no preimage — recover it by lookup.
              return { preimage: await recoverPreimage(client, invoice) };
            } catch (payErr) {
              // A NIP-47 timeout means the wallet's response (and the preimage
              // with it) was lost, but the payment very likely settled — like
              // Ditto, we DON'T fail the zap over a lost ack. Try to recover
              // the preimage (CORD.md needs it), but return null rather than
              // throw when we can't: the NIP-29 caller doesn't need it (the
              // provider's public receipt confirms the zap), and the private
              // caller decides for itself whether a null proof is fatal.
              // Any other error is a genuine payment failure — surface it.
              if (!(payErr instanceof sdk.Nip47TimeoutError)) {
                throw payErr instanceof Error ? payErr : new Error("Payment failed.");
              }
              return { preimage: await recoverPreimage(client, invoice) };
            }
          })(),
          PAY_TIMEOUT_MS,
          "Payment timed out — check your wallet before retrying.",
        );
      } finally {
        try {
          client?.close();
        } catch {
          // best-effort socket cleanup
        }
      }
    },
    [connections, active],
  );

  const value = useMemo<WalletContextType>(() => {
    const activeConnection = connections.find((c) => c.connectionString === active) ?? null;
    const webln = (globalThis as { webln?: WebLNProvider }).webln ?? null;
    return { connections, activeConnection, addConnection, removeConnection, setActive, payWithNWC, webln };
  }, [connections, active, addConnection, removeConnection, setActive, payWithNWC]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

export default WalletProvider;
