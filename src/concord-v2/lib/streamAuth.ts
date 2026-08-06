/**
 * Concord V2 stream-key NIP-42 authentication.
 *
 * Every V2 plane is kind-1059 traffic addressed to a DERIVED per-stream pubkey
 * (control, guestbook, per-channel, dissolved, rekey) — never the user's own
 * identity. Relays that gate kind 1059 behind NIP-42 (e.g. ditto-relay's
 * default `AUTH_KINDS=4,1059`) require that EVERY `authors` entry in a
 * kind-1059 REQ be an authenticated pubkey on the connection. The user's login
 * can't satisfy that: the stream address isn't their pubkey.
 *
 * The fix: the client holds the stream SECRET keys (they live in the
 * community_root / channel keys it derives), so it can NIP-42-authenticate AS
 * each stream. This module is the registry of stream keys the client currently
 * holds; {@link NostrProvider}'s AUTH handler signs an extra kind-22242 event
 * per registered key on the same challenge, so the connection ends up
 * authenticated as the user AND every stream it will query.
 *
 * ditto-relay keeps a per-connection SET of authenticated pubkeys and its
 * challenge stays valid for the socket's whole lifetime, so a key registered
 * AFTER the challenge can still authenticate on the live socket — the client
 * just signs and sends another AUTH frame (verified empirically against the
 * real ditto-relay over a live socket). The relay acks every AUTH with
 * `["OK", id, true]`; this module also tracks those acks per relay, giving
 * sweeps a deterministic "these authors are authenticated on this socket"
 * signal instead of a timing heuristic. (The relay processes frames in
 * parallel, so an un-acked AUTH→REQ pipeline can race — hence ack-gating,
 * not send-and-hope.)
 *
 * Keys register with the RELAYS their community lives on, and a challenge
 * signs only the keys scoped to that relay (a key registered without relays is
 * unscoped and signs everywhere — the safe fallback). This matters: a Schnorr
 * signature costs ~4ms (phones 5-10x slower), a multi-community registry holds
 * hundreds of keys, and every socket (re)open earns a fresh challenge —
 * unscoped, one challenge burned 1.5-2s of main-thread signing per relay (see
 * streamAuth.perf.test.ts) for keys the relay would never see queried.
 *
 * Kept out of `concord-v1` and imported by only two shared files
 * (NostrProvider for the WebView's own sockets, useNativeNotifications for
 * the Android service's bridged AUTH challenges) so the V2 tree stays
 * independently deletable.
 */

import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import type { StreamKeyView } from "@/concord-v2/lib/derive";
import { normalizeRelayUrl } from "@/lib/platform";

interface StreamKeyEntry {
  /**
   * The stream secret key that authenticates this pubkey — absent for an
   * ADDRESS-ONLY registration: a split Control Plane's `control_pk` is held
   * by every member, but its signing secret only by staff (CORD-02 §2), so a
   * regular member can never answer a NIP-42 challenge for it. The address is
   * still registered so subscription builders and the auth gate know it is
   * accounted for rather than "not yet registered".
   */
  sk?: Uint8Array;
  /**
   * Normalized relay URLs whose challenges this key signs; `undefined` means
   * unscoped — sign on EVERY relay (pre-scoping behavior, the safe fallback
   * for callers that don't know their community's relays).
   */
  relays?: Set<string>;
}

/** pubkey (x-only hex) → its secret key + relay scope. */
const registry = new Map<string, StreamKeyEntry>();

/** Listeners notified when the registry gains keys (to re-auth open sockets). */
type Listener = (added: string[]) => void;
const listeners = new Set<Listener>();

function normalizeScope(relays?: string[]): Set<string> | undefined {
  if (!relays) return undefined;
  const out = new Set<string>();
  for (const r of relays) {
    const n = normalizeRelayUrl(r);
    if (n) out.add(n);
  }
  // An empty/garbage relay list must not silently scope a key to NOWHERE —
  // fall back to unscoped so the stream can still authenticate.
  return out.size > 0 ? out : undefined;
}

/**
 * Register a batch of stream keys (idempotent), scoped to the relays their
 * community lives on. Returns the pubkeys that were NEWLY added or whose
 * relay scope WIDENED (a new relay, or scoped → unscoped), so the caller can
 * trigger a re-auth only when a challenged socket might be missing coverage.
 *
 * Scopes only ever widen: re-registering with fewer relays never narrows an
 * existing key (a second community sharing a channel key on other relays must
 * not lose its coverage).
 */
export function registerStreamKeys(keys: StreamKeyView[], relays?: string[]): string[] {
  const scope = normalizeScope(relays);
  const changed: string[] = [];
  for (const k of keys) {
    const existing = registry.get(k.pk);
    if (!existing) {
      registry.set(k.pk, { sk: k.sk, relays: scope ? new Set(scope) : undefined });
      changed.push(k.pk);
      continue;
    }
    // An address registered without its secret gains one the moment a holder
    // registers it (a staffer adopting the control_root upgrades in place).
    if (existing.sk === undefined && k.sk !== undefined) {
      existing.sk = k.sk;
      changed.push(k.pk);
    }
    if (!existing.relays) continue; // already unscoped — broadest possible
    if (!scope) {
      existing.relays = undefined; // widen to unscoped
      changed.push(k.pk);
      continue;
    }
    let widened = false;
    for (const r of scope) {
      if (!existing.relays.has(r)) {
        existing.relays.add(r);
        widened = true;
      }
    }
    if (widened) changed.push(k.pk);
  }
  if (changed.length > 0) for (const l of listeners) l(changed);
  return changed;
}

/** Whether a pubkey is a known stream address we can authenticate as. */
export function isStreamPubkey(pubkey: string): boolean {
  return registry.has(pubkey);
}

/** Every stream pubkey currently registered. */
export function streamPubkeys(): string[] {
  return [...registry.keys()];
}

/** The registered pubkeys whose scope covers `relayUrl` (unscoped keys always do). */
export function streamPubkeysForRelay(relayUrl: string): string[] {
  const normalized = normalizeRelayUrl(relayUrl);
  const out: string[] = [];
  for (const [pk, entry] of registry) {
    if (!entry.relays || (normalized !== undefined && entry.relays.has(normalized))) out.push(pk);
  }
  return out;
}

/**
 * Subscribe to registry growth. The listener fires with the newly-added (or
 * scope-widened) pubkeys whenever {@link registerStreamKeys} admits any.
 * Returns an unsubscribe.
 */
export function onStreamKeysAdded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sign the NIP-42 AUTH events for the registered stream keys scoped to
 * `relayUrl` (or an explicit subset) against `challenge`. Signing is local
 * (raw secret keys), so this never touches the user's signer / bunker.
 * Returns the kind-22242 events to send on the connection.
 *
 * Each signature is ~4ms of main-thread EC work — for more than a handful of
 * keys, prefer {@link signStreamAuthsChunked} so the loop yields between
 * chunks instead of blocking frames.
 */
export function signStreamAuths(
  challenge: string,
  relayUrl: string,
  pubkeys?: Iterable<string>,
): NostrEvent[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const out: NostrEvent[] = [];
  for (const pk of pubkeys ?? streamPubkeysForRelay(relayUrl)) {
    const sk = registry.get(pk)?.sk;
    if (!sk) continue;
    out.push(
      finalizeEvent(
        {
          kind: 22242,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: createdAt,
        },
        sk,
      ),
    );
  }
  return out;
}

/** Keys signed per event-loop turn by {@link signStreamAuthsChunked} (~4ms each). */
const SIGN_CHUNK = 16;

/**
 * Like {@link signStreamAuths}, but yields the events in chunks with an
 * event-loop turn between them, so signing dozens of keys doesn't block
 * rendering for hundreds of milliseconds. The caller sends each chunk as it
 * arrives (a NIP-42 AUTH is valid whenever it lands on the live challenge)
 * and can stop iterating if the challenge dies mid-flight (socket reopened).
 */
export async function* signStreamAuthsChunked(
  challenge: string,
  relayUrl: string,
  pubkeys?: Iterable<string>,
): AsyncGenerator<NostrEvent[]> {
  const pks = [...(pubkeys ?? streamPubkeysForRelay(relayUrl))];
  for (let i = 0; i < pks.length; i += SIGN_CHUNK) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    yield signStreamAuths(challenge, relayUrl, pks.slice(i, i + SIGN_CHUNK));
  }
}

/** Test seam: forget every registered stream key and all per-relay ack state. */
export function _resetStreamAuthRegistry(): void {
  registry.clear();
  relayAuth.clear();
}

// ── Per-relay AUTH ack state ─────────────────────────────────────────────────
//
// ditto-relay acks every accepted kind-22242 with `["OK", <id>, true]` and adds
// the pubkey to the connection's authenticated set. NostrProvider feeds those
// acks in here; plane sweeps gate on them (`streamAuthsSettled`) so a REQ only
// flies once the relay has CONFIRMED its authors — deterministic, no settle
// timers. State is per live socket: a reopened socket is a fresh
// unauthenticated session, so NostrProvider resets it on reconnect.

interface RelayAuthState {
  /** Whether this relay has issued a NIP-42 challenge on the live socket. */
  challenged: boolean;
  /** When the current challenge was recorded (ms) — for the stale self-heal. */
  challengedAt: number;
  /** Stream pubkeys the relay has acked (OK true) on the live socket. */
  acked: Set<string>;
  /** Sent-but-unacked AUTH event ids → the stream pubkey they authenticate. */
  pending: Map<string, string>;
}

/** normalized relay url → live-socket auth state. */
const relayAuth = new Map<string, RelayAuthState>();

/**
 * How long a challenged-but-not-fully-acked relay stays "unsettled" before the
 * self-heal kicks in. Longer than plane sweeps' auth-wait cap (8s) so a merely
 * slow ack still wins the race; past it we assume an AUTH frame or its OK was
 * lost (dropped send, half-open socket, ack that raced the listener attach) and
 * stop blocking sweeps forever — instead firing a re-auth so the relay can
 * recover WITHOUT an app restart (the old failure mode: only a socket reopen
 * cleared the stuck state, and a half-open socket never reopens).
 */
const AUTH_STALE_MS = 12_000;

/** Listeners asked to re-send AUTH frames for a relay whose auth went stale. */
type ReauthListener = (url: string) => void;
const reauthListeners = new Set<ReauthListener>();

/**
 * Subscribe to auth-stale events: fired for a relay that has been challenged
 * but hasn't fully acked its stream AUTHs within {@link AUTH_STALE_MS}. The
 * listener (NostrProvider) re-signs and re-sends the stream AUTH frames on the
 * live socket. Returns an unsubscribe.
 */
export function onStreamAuthStale(listener: ReauthListener): () => void {
  reauthListeners.add(listener);
  return () => reauthListeners.delete(listener);
}

function relayAuthState(url: string): RelayAuthState {
  const key = normalizeRelayUrl(url) ?? url;
  let state = relayAuth.get(key);
  if (!state) {
    state = { challenged: false, challengedAt: 0, acked: new Set(), pending: new Map() };
    relayAuth.set(key, state);
  }
  return state;
}

/** Record that `url` issued a NIP-42 challenge on its live socket. */
export function noteRelayChallenged(url: string): void {
  const state = relayAuthState(url);
  state.challenged = true;
  state.challengedAt = Date.now();
}

/** Reset a relay's auth state (socket reopened — the old session's acks are dead). */
export function resetRelayAuth(url: string): void {
  relayAuth.delete(normalizeRelayUrl(url) ?? url);
}

/** Record a stream AUTH frame sent to `url`, so its OK ack can be matched. */
export function noteStreamAuthSent(url: string, eventId: string, pubkey: string): void {
  relayAuthState(url).pending.set(eventId, pubkey);
}

/** Feed an `["OK", id, ok]` from `url`; ignores ids that aren't pending stream AUTHs. */
export function noteAuthResult(url: string, eventId: string, ok: boolean): void {
  const state = relayAuth.get(normalizeRelayUrl(url) ?? url);
  const pk = state?.pending.get(eventId);
  if (!state || pk === undefined) return;
  state.pending.delete(eventId);
  if (ok) state.acked.add(pk);
}

/**
 * Whether a REQ authored by `pubkeys` would pass `url`'s NIP-42 gate right
 * now: either the relay never challenged this socket (not auth-gating, or the
 * lazy challenge hasn't fired — the REQ itself will trigger it and NRelay1's
 * auth-retry covers that round), or every pubkey's AUTH has been acked.
 *
 * SELF-HEAL: if the relay was challenged but some pubkey is still unacked past
 * {@link AUTH_STALE_MS}, an AUTH frame or its OK was almost certainly lost. We
 * stop reporting unsettled (so sweeps/backfills stop burning the auth-wait cap
 * on every call — the old wedge that made sync "die" until an app restart) and
 * fire a re-auth so the relay can actually recover on the LIVE socket. The
 * challenge window is re-armed so a single stale detection triggers one re-auth
 * wave, not a storm.
 */
export function streamAuthsSettled(url: string, pubkeys: Iterable<string>): boolean {
  const state = relayAuth.get(normalizeRelayUrl(url) ?? url);
  if (!state?.challenged) return true;
  let allAcked = true;
  for (const pk of pubkeys) {
    // An address-only registration (a split control_pk without its staff
    // secret) can never be authenticated by this client — there is no AUTH to
    // wait for, so it must not hold every sweep at the stale-timer forever.
    const entry = registry.get(pk);
    if (entry !== undefined && entry.sk === undefined) continue;
    if (!state.acked.has(pk)) {
      allAcked = false;
      break;
    }
  }
  if (allAcked) return true;
  // Not fully acked. If we're still inside the fresh-challenge window, keep
  // waiting (a slow-but-live ack should win). Past the window, self-heal.
  if (Date.now() - state.challengedAt < AUTH_STALE_MS) return false;
  // Re-arm the window so the re-auth we trigger gets its own fresh grace period
  // (and a subsequent settled check waits for the new AUTHs rather than firing
  // another re-auth immediately).
  state.challengedAt = Date.now();
  const key = normalizeRelayUrl(url) ?? url;
  for (const l of reauthListeners) l(key);
  return true;
}
