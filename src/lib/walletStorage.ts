/**
 * NWC wallet connection storage — SPENDING SECRETS, deliberately per-account,
 * plain-local, and never synced (a NIP-78 event on relays is the wrong place
 * for a spending key). Shared between WalletProvider (read/write) and the
 * logout paths (purge): when an account is removed its wallet secrets must
 * not outlive it in localStorage, even when other accounts remain logged in.
 * Follow-up: move the backing store to the platform keystore on Capacitor.
 */

/** One saved Nostr Wallet Connect (NIP-47) connection. */
export interface NWCConnection {
  /** The full nostr+walletconnect:// URI. SECRET — never synced, never rendered whole. */
  connectionString: string;
  /** User-facing label ("Alby Hub", "Coinos", …). */
  alias: string;
  /** ms timestamp, for stable ordering. */
  addedAt: number;
}

const connectionsKey = (pubkey: string) => `armada:nwc-connections:${pubkey}`;
const activeKey = (pubkey: string) => `armada:nwc-active:${pubkey}`;

export function readConnections(pubkey: string | undefined): NWCConnection[] {
  if (!pubkey) return [];
  try {
    const raw = localStorage.getItem(connectionsKey(pubkey));
    const parsed = raw ? (JSON.parse(raw) as NWCConnection[]) : [];
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c?.connectionString === "string") : [];
  } catch {
    return [];
  }
}

export function readActive(pubkey: string | undefined): string | null {
  if (!pubkey) return null;
  try {
    return localStorage.getItem(activeKey(pubkey));
  } catch {
    return null;
  }
}

export function writeWalletStorage(
  pubkey: string,
  connections: NWCConnection[],
  active: string | null,
): void {
  try {
    localStorage.setItem(connectionsKey(pubkey), JSON.stringify(connections));
    if (active) localStorage.setItem(activeKey(pubkey), active);
    else localStorage.removeItem(activeKey(pubkey));
  } catch {
    // Storage unavailable — connections survive for the session only.
  }
}

/** Remove an account's wallet secrets (call whenever the account is removed). */
export function clearWalletStorage(pubkey: string): void {
  try {
    localStorage.removeItem(connectionsKey(pubkey));
    localStorage.removeItem(activeKey(pubkey));
  } catch {
    // best-effort
  }
}

/** The wallet-service pubkey a NWC URI points at (its "host" part), or "". */
export function nwcWalletPubkey(uri: string): string {
  const match = uri.match(/^nostr\+?walletconnect:\/\/([0-9a-f]{64})/i);
  return match ? match[1].toLowerCase() : "";
}
