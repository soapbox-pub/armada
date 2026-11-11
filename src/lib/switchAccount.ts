import { secureStorage } from "@/lib/secureStorage";
import { getActivePubkey, setActivePubkey } from "@/lib/activeAccount";
import {
  EXIT_NAV_DEADLINE_MS,
  EXIT_TEARDOWN_MS,
  runBeforeAccountExit,
} from "@/lib/beforeAccountExit";
import { beginCrossTabAccountExit } from "@/lib/crossTabAccountExit";
import { clearEsploraStorage } from "@/lib/esploraStorage";
import { clearWalletStorage } from "@/lib/walletStorage";
import { beginAccountExit, exitDone, exitStep } from "@/components/accountExitState";

import type { NLoginType } from "@nostrify/react/login";

/** `NostrLoginProvider`'s login-list key; shared because switching writes it directly. */
export const LOGIN_STORAGE_KEY = "armada:login";

/** Wrap a navigation so the deadline and the teardown can both call it, once. */
function navigateOnce(destination: string): () => void {
  let went = false;
  return () => {
    if (went) return;
    went = true;
    window.location.assign(destination);
  };
}

/** The login list with `id` moved to the front — `logins[0]` is the active one. */
export function reorderLogins(
  logins: readonly NLoginType[],
  id: string,
): NLoginType[] | null {
  const target = logins.find((login) => login.id === id);
  if (!target) return null;
  return [target, ...logins.filter((login) => login.id !== id)];
}

/**
 * Persist `logins` and hard-reload at `destination`. The reload is the only
 * complete teardown of the previous account's derived state (query cache,
 * memo maps, subscriptions) — in-place switching leaks it. The list is
 * written and awaited here because `setLogin`'s effect-based write can lose
 * the race with `location.assign`.
 */
async function persistAndReload(
  logins: readonly NLoginType[],
  destination: string,
): Promise<void> {
  const outgoingPubkey = getActivePubkey();
  // Show the exit overlay during teardown; idempotent if the caller raised it.
  beginAccountExit("switch", outgoingPubkey ?? "");
  // Absolute navigation deadline so a stalled teardown can't trap the switch.
  const go = navigateOnce(destination);
  const deadline = setTimeout(go, EXIT_NAV_DEADLINE_MS);

  // Fence other tabs first; only this tab runs destructive before-exit handlers.
  beginCrossTabAccountExit(outgoingPubkey, logins[0]?.pubkey ?? null);
  // Outgoing-account gateway/native records need cleanup while its session exists.
  exitStep("teardown", "closing secure channel");
  await runBeforeAccountExit("account-change", EXIT_TEARDOWN_MS);

  exitStep("persist", "handing over identity");
  let persisted = false;
  try {
    await secureStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(logins));
    persisted = true;
  } catch {
    // Reload anyway so the app matches what storage actually holds.
  }
  // Never point scoped config at an identity the login list didn't persist.
  setActivePubkey(persisted ? (logins[0]?.pubkey ?? null) : outgoingPubkey);

  exitDone("re-jacking in");
  clearTimeout(deadline);
  go();
}

/** Make `id` the active account and reload the app at the root. */
export async function switchAccount(
  logins: readonly NLoginType[],
  id: string,
): Promise<void> {
  const reordered = reorderLogins(logins, id);
  if (!reordered) return;
  await persistAndReload(reordered, "/");
}

/**
 * Add a new identity and make it active. Must not `addLogin`/`setLogin` in
 * place: that swaps the signer before outgoing cleanup runs.
 */
export async function addAndSwitchAccount(
  logins: readonly NLoginType[],
  login: NLoginType,
): Promise<void> {
  const next = [login, ...logins.filter((existing) => existing.id !== login.id)];
  await persistAndReload(next, "/");
}

/**
 * Sign `id` out when other accounts remain (effectively a switch). Signing out
 * the LAST account is `purgeClientStorage` + redirect, handled by the caller.
 */
export async function signOutAccount(
  logins: readonly NLoginType[],
  id: string,
): Promise<void> {
  const remaining = logins.filter((login) => login.id !== id);
  if (remaining.length === 0) return;
  // No purge runs while another account remains, so this account's secrets go here.
  const departing = logins.find((login) => login.id === id)?.pubkey;
  if (departing && !remaining.some((login) => login.pubkey === departing)) {
    clearWalletStorage(departing);
    clearEsploraStorage(departing);
  }
  await persistAndReload(remaining, "/");
}
