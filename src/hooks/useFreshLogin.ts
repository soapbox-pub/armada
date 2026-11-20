import { useNostrLogin } from "@nostrify/react/login";
import { useEffect, useRef, useState } from "react";

import { getBootPubkey } from "@/lib/activeAccount";

/**
 * A wizard signup's fresh login shouldn't raise the sync gate: a brand-new account has
 * nothing to catch up on.
 */
let suppressedFreshPubkey: string | undefined;

/** Idempotent; cleared once consumed. */
export function suppressNextSyncGate(pubkey: string): void {
  suppressedFreshPubkey = pubkey;
}

/**
 * Whether `pubkey`, active now, is a fresh login that raises the sync gate. Read
 * outside the lazy chunk too (`App.tsx`), so the app stays covered until the gate mounts.
 */
export function isFreshLogin(pubkey: string): boolean {
  return pubkey !== getBootPubkey() && suppressedFreshPubkey !== pubkey;
}

/**
 * Detects a *fresh* login (vs. a session restored on reload), which needs the blocking
 * post-login sync gate. The baseline is the pubkey active at BOOT (`activeAccount`), not the
 * mount-time login list: this hook mounts late in a lazy per-account chunk, when the fresh login
 * is already in `logins`. Account switches hard-reload, so they appear as boot accounts.
 */
export function useFreshLogin(): {
  freshPubkey: string | undefined;
  /** Call once the sync for `freshPubkey` is finished so the gate dismisses. */
  acknowledge: () => void;
} {
  const { logins } = useNostrLogin();
  const activePubkey = logins[0]?.pubkey;

  // Seeded from the BOOT marker — see the hook docstring.
  const seenRef = useRef<Set<string> | null>(null);
  if (seenRef.current === null) {
    const boot = getBootPubkey();
    seenRef.current = new Set(boot ? [boot] : []);
  }

  // Decided on the first render: the gate mounts after the route has painted the app,
  // so waiting for the effect would leave a frame of it uncovered.
  const [freshPubkey, setFreshPubkey] = useState<string | undefined>(() =>
    activePubkey && isFreshLogin(activePubkey) ? activePubkey : undefined,
  );

  useEffect(() => {
    if (!activePubkey) {
      setFreshPubkey(undefined);
      return;
    }
    const seen = seenRef.current!;
    if (!seen.has(activePubkey)) {
      seen.add(activePubkey);
      // One-shot wizard opt-out: folded into the baseline without raising the gate.
      if (suppressedFreshPubkey === activePubkey) {
        suppressedFreshPubkey = undefined;
        return;
      }
      setFreshPubkey(activePubkey);
    }
  }, [activePubkey]);

  return {
    freshPubkey,
    acknowledge: () => setFreshPubkey(undefined),
  };
}
