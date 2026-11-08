import { lazy, Suspense } from "react";

import { lazyWithReload } from "@/lib/chunkReload";

import type { WalletDialogProps } from "./WalletDialogBody";

// Loaded on first open: it brings @scure/btc-signer, which nothing else on a page needs.
const Body = lazy(lazyWithReload(() => import("./WalletDialogBody").then((m) => ({ default: m.WalletDialogBody }))));

export function WalletDialog(props: WalletDialogProps) {
  return (
    <Suspense fallback={null}>
      <Body {...props} />
    </Suspense>
  );
}
