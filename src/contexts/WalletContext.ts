import { createContext } from "react";

import type { NWCConnection } from "@/lib/walletStorage";
import type { WebLNProvider } from "@webbtc/webln-types";

export type { NWCConnection };

export interface WalletContextType {
  /** Saved NWC connections for the CURRENT account (local-only storage). */
  connections: NWCConnection[];
  /** The connection payments go through, or null. */
  activeConnection: NWCConnection | null;
  /**
   * Validate + test a nostr+walletconnect:// URI (10s budget) and save it.
   * Throws with a user-facing message on bad scheme / unreachable wallet.
   */
  addConnection(uri: string, alias?: string): Promise<void>;
  removeConnection(connectionString: string): void;
  setActive(connectionString: string): void;
  /**
   * Pay a bolt11 invoice over the active NWC connection.
   *
   * Resolves with the preimage (the proof CORD.md zaps seal) when the wallet
   * returns it — but `preimage` is `null` when the payment settled yet the
   * proof couldn't be obtained (a lost/slow NWC ack, or a wallet without
   * `lookup_invoice`). A NIP-57 zap doesn't need it (the provider's receipt
   * confirms the zap); a private CORD.md zap treats null as fatal. Only a
   * genuine payment failure rejects.
   */
  payWithNWC(invoice: string): Promise<{ preimage: string | null }>;
  /** Browser WebLN provider, if an extension injected one (null on the APK). */
  webln: WebLNProvider | null;
}

export const WalletContext = createContext<WalletContextType | undefined>(undefined);
