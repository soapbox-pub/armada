/**
 * Publish budgets by signer locality.
 *
 * The timeout wraps only the relay round-trip (signing completes before it
 * starts), but on an auth-gating relay that round-trip can EMBED a remote
 * sign: EVENT → OK:auth-required → kind-22242 through the bunker (a full
 * NIP-46 relay round-trip) → EVENT again. 8s routinely loses that race on
 * lossy networks — sends fail in bulk and land in the outbox even though
 * every step eventually succeeds — so bunker logins get a wider window.
 */
export const PUBLISH_TIMEOUT_MS = 8_000;
export const REMOTE_SIGNER_PUBLISH_TIMEOUT_MS = 30_000;

/** The publish timeout for the given login method (`NUser.method`). */
export function publishTimeoutMs(loginMethod: string | undefined): number {
  return loginMethod === "bunker" ? REMOTE_SIGNER_PUBLISH_TIMEOUT_MS : PUBLISH_TIMEOUT_MS;
}
