import { useContext } from "react";

import { WalletContext, type WalletContextType } from "@/contexts/WalletContext";

/** Lightning wallet state + payment methods for the current account. */
export function useWallet(): WalletContextType {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used within WalletProvider");
  }
  return context;
}
