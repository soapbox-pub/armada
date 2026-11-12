/**
 * Session-scoped activation behind the wire's unread-deferral rule: a
 * community whose rail dot is already lit gains nothing from background sync,
 * so it's deferred until ACTIVATED — by navigating in ({@link activateScope})
 * or its dot clearing remotely ({@link markScopeLive}). Activation is STICKY
 * for the session (else remote reads cause catch-up/defer oscillation) and
 * in-memory only.
 *
 * Scopes: `c2:<communityIdHex>` (Concord), `nip29:<relayUrl>` (a NIP-29
 * server; its channels defer and activate together).
 */
import { normalizeRelayUrl } from "@/lib/platform";

/** Scope key for a Concord community. */
export function concordScope(communityIdHex: string): string {
  return `c2:${communityIdHex}`;
}

/** Scope key for a NIP-29 server, normalized HERE so pages and the wire can't spell it two ways. */
export function nip29Scope(relayUrl: string): string {
  return `nip29:${normalizeRelayUrl(relayUrl) ?? relayUrl}`;
}

const activated = new Set<string>();
/** Most recently activated scope per kind prefix (`"c2:"`, `"nip29:"`). */
const activeByKind = new Map<string, string>();
const listeners = new Set<() => void>();

/** The `<kind>:` prefix of a scope, or the whole string if it has no colon. */
function kindOf(scope: string): string {
  const sep = scope.indexOf(":");
  return sep < 0 ? scope : scope.slice(0, sep + 1);
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // one listener must not break the others
    }
  }
}

/**
 * The user navigated in: this is the active scope of its kind, live for the session.
 * Notifies only a FIRST activation: listeners rebuild the wire's whole spec, and
 * moving between scopes already live changes nothing in it.
 */
export function activateScope(scope: string): void {
  activeByKind.set(kindOf(scope), scope);
  if (activated.has(scope)) return;
  activated.add(scope);
  notify();
}

/** Pin a scope live WITHOUT notifying (for the wire's own mid-rebuild pass). */
export function markScopeLive(scope: string): void {
  activated.add(scope);
}

/** Whether the scope has been activated (navigated to / pinned live). */
export function isScopeActivated(scope: string): boolean {
  return activated.has(scope);
}

/** Id of the most recently activated scope of a kind (e.g. `"c2:"` → current community). */
export function activeScopeId(kindPrefix: string): string | undefined {
  const scope = activeByKind.get(kindPrefix);
  return scope?.slice(kindPrefix.length);
}

/** Re-run on any activation. Returns an unsubscribe. */
export function onActivation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
