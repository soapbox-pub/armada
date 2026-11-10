/**
 * Concord stream-key NIP-42 authentication.
 *
 * Concord planes are kind-1059 traffic authored by DERIVED stream pubkeys, and
 * relays gating 1059 behind NIP-42 (e.g. ditto-relay `AUTH_KINDS=4,1059`) require
 * every `authors` entry to be authenticated. The client holds the stream secrets,
 * so {@link NostrProvider} signs an extra kind-22242 per registered key on each
 * challenge. ditto-relay keeps a per-connection set and a socket-lifetime
 * challenge, so late keys can still AUTH; acks (`["OK", id, true]`) are tracked
 * per relay so sweeps gate deterministically (frames are processed in parallel,
 * so un-acked AUTH→REQ can race).
 *
 * Keys are scoped to their community's relays (unscoped = sign everywhere):
 * each Schnorr sign costs ~4ms and unscoped registries burned 1.5-2s per
 * challenge (see streamAuth.perf.test.ts).
 *
 * Imported only by NostrProvider and useNativeNotifications so the concord tree
 * stays independently deletable.
 */

import { finalizeEvent, getEventHash } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import type { StreamKeyView } from "@/concord/lib/derive";
import { normalizeRelayUrl } from "@/lib/platform";
import { ecSignBatch } from "@/lib/verifyPool";
import type { SignJob } from "@/lib/verifyWorkerTypes";
import { nowSecs } from "@/lib/relayClock";

interface StreamKeyEntry {
  /**
   * The stream secret — absent for an ADDRESS-ONLY registration (a split
   * `control_pk`, whose secret only staff hold, CORD-02 §2). Still registered so
   * the auth gate counts it as accounted for.
   */
  sk?: Uint8Array;
  /** Normalized relay URLs whose challenges this key signs; `undefined` = unscoped (everywhere). */
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
  // An empty/garbage relay list falls back to unscoped rather than NOWHERE.
  return out.size > 0 ? out : undefined;
}

/**
 * Register stream keys (idempotent) scoped to `relays`. Returns pubkeys newly
 * added or whose scope WIDENED, so the caller re-auths only when needed. Scopes
 * only widen (a shared key on another community's relays keeps its coverage).
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
    // A staffer adopting the control_root upgrades an address-only entry in place.
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
 * Keys a re-auth of `relayUrl` must send: scoped, holding a secret, neither acked
 * nor definitively rejected. Re-signing already-acked keys on each stale wave cost
 * hundreds of signatures; re-sending rejected ones looped every wave for the
 * socket's lifetime (a relay that can't verify AUTH answers every one `OK false`).
 */
export function unackedStreamPubkeys(relayUrl: string): string[] {
  const key = normalizeRelayUrl(relayUrl) ?? relayUrl;
  if (isRefusing(key)) return [];
  const state = relayAuth.get(key);
  return streamPubkeysForRelay(relayUrl).filter((pk) => {
    if (registry.get(pk)?.sk === undefined) return false;
    return !state?.acked.has(pk) && !state?.rejected.has(pk);
  });
}

/**
 * A self-heal wave's keys: {@link unackedStreamPubkeys} minus those already
 * being signed, marked in flight so overlapping waves don't send them twice.
 */
export function claimStaleWave(relayUrl: string): string[] {
  const state = relayAuthState(relayUrl);
  const out = unackedStreamPubkeys(relayUrl).filter((pk) => !state.inFlight.has(pk));
  for (const pk of out) state.inFlight.add(pk);
  return out;
}

/**
 * Claim the keys `relayUrl` has not been sent an AUTH for on this challenge
 * (optionally within `pubkeys`), marking them in flight so a concurrent caller
 * doesn't sign them again. NRelay1 invokes the challenge callback once per walled
 * sub, and answering each with every key re-sent the whole registry per sub.
 * A frame lost after the claim is the stale wave's job ({@link unackedStreamPubkeys}).
 */
export function claimStreamAuths(relayUrl: string, pubkeys?: Iterable<string>): string[] {
  const state = relayAuthState(relayUrl);
  const sending = new Set(state.pending.values());
  const scoped = new Set(streamPubkeysForRelay(relayUrl));
  // A refusing relay gets one probe per challenge, not the whole key set.
  const limit = isRefusing(normalizeRelayUrl(relayUrl) ?? relayUrl)
    ? (state.pending.size + state.inFlight.size + state.rejected.size > 0 ? 0 : 1)
    : Infinity;
  const out: string[] = [];
  for (const pk of pubkeys ?? scoped) {
    if (out.length >= limit) break;
    if (!scoped.has(pk) || registry.get(pk)?.sk === undefined) continue;
    if (state.acked.has(pk) || state.rejected.has(pk) || state.inFlight.has(pk) || sending.has(pk)) continue;
    state.inFlight.add(pk);
    out.push(pk);
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
 * Sign NIP-42 AUTH events for the stream keys scoped to `relayUrl` (or a subset)
 * locally — never touches the user's signer. ~4ms per signature on the main
 * thread; for more than one key use {@link signStreamAuthsChunked}.
 */
export function signStreamAuths(
  challenge: string,
  relayUrl: string,
  pubkeys?: Iterable<string>,
): NostrEvent[] {
  const createdAt = nowSecs();
  const out: NostrEvent[] = [];
  for (const pk of pubkeys ?? streamPubkeysForRelay(relayUrl)) {
    const sk = registry.get(pk)?.sk;
    if (!sk) continue;
    out.push(finalizeEvent(unsignedAuth(challenge, relayUrl, createdAt), sk));
  }
  return out;
}

function unsignedAuth(challenge: string, relayUrl: string, createdAt: number) {
  return {
    kind: 22242,
    content: "",
    tags: [
      ["relay", relayUrl],
      ["challenge", challenge],
    ],
    created_at: createdAt,
  };
}

/** Keys per pool round in {@link signStreamAuthsChunked}; each round is yielded as it returns. */
const SIGN_BATCH = 64;

/**
 * Like {@link signStreamAuths}, but Schnorr-signs in the EC worker pool
 * (`verifyPool.ts`, `ecSignBatch`), yielding batches for the caller to send as
 * they arrive (stop iterating if the challenge dies). The pubkey comes from the
 * registry rather than re-derived; a mismatch could only produce a rejected sig.
 */
export async function* signStreamAuthsChunked(
  challenge: string,
  relayUrl: string,
  pubkeys?: Iterable<string>,
): AsyncGenerator<NostrEvent[]> {
  const createdAt = nowSecs();
  const pks = [...(pubkeys ?? streamPubkeysForRelay(relayUrl))];
  for (let i = 0; i < pks.length; i += SIGN_BATCH) {
    const unsigned: Omit<NostrEvent, "sig">[] = [];
    const jobs: SignJob[] = [];
    for (const pk of pks.slice(i, i + SIGN_BATCH)) {
      const sk = registry.get(pk)?.sk;
      if (!sk) continue;
      const event = { ...unsignedAuth(challenge, relayUrl, createdAt), pubkey: pk };
      const id = getEventHash(event);
      unsigned.push({ ...event, id });
      jobs.push({ hash: id, sk });
    }
    if (jobs.length === 0) continue;
    const sigs = await ecSignBatch(jobs);
    const signed: NostrEvent[] = [];
    for (let j = 0; j < unsigned.length; j++) {
      const sig = sigs[j];
      if (sig) signed.push({ ...unsigned[j], sig });
    }
    if (signed.length > 0) yield signed;
  }
}

/** Forget every registered stream key (secrets) and all per-relay ack state. Logout. */
export function clearStreamAuthRegistry(): void {
  registry.clear();
  relayAuth.clear();
  refusingRelays.clear();
}

/** Test seam. */
export const _resetStreamAuthRegistry = clearStreamAuthRegistry;

// Per-relay AUTH ack state: NostrProvider feeds ditto-relay's `["OK", id, true]`
// acks in here and sweeps gate on them (`streamAuthsSettled`). Per live socket;
// reset on reconnect.

interface RelayAuthState {
  /** Whether this relay has issued a NIP-42 challenge on the live socket. */
  challenged: boolean;
  /** When the current challenge was recorded (ms) — for the stale self-heal. */
  challengedAt: number;
  /** When the relay last answered one of our stream AUTHs (ms): progress, not loss. */
  answeredAt: number;
  /** Self-heal waves fired since the relay last answered; each doubles the next window. */
  waves: number;
  /** The challenge the claims, pending AUTHs and rejections below answered. */
  challenge?: string;
  /** Stream pubkeys the relay has acked (OK true) on the live socket. */
  acked: Set<string>;
  /** Sent-but-unacked AUTH event ids → the stream pubkey they authenticate. */
  pending: Map<string, string>;
  /** Claimed by {@link claimStreamAuths}, not yet sent (signing in the pool). */
  inFlight: Set<string>;
  /** Refused with a non-transient `OK false` on this challenge; not re-sent. */
  rejected: Set<string>;
}

/** normalized relay url → live-socket auth state. */
const relayAuth = new Map<string, RelayAuthState>();

/**
 * Relays that refused every stream AUTH they answered on a socket (e.g. one that
 * can't verify AUTH at all), until when (ms). Outlives the socket and the
 * challenge a reconnect renews, so the whole key set isn't re-signed and
 * re-sent per reconnect. While set, a challenge gets one probe key; an ack
 * clears it.
 */
const refusingRelays = new Map<string, number>();
const REFUSING_MS = 60 * 60_000;
/** Refusals, with nothing acked on the socket, that mark a relay as refusing. */
const REFUSING_MIN_REJECTS = 3;

function isRefusing(key: string): boolean {
  const until = refusingRelays.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  refusingRelays.delete(key);
  return false;
}

/**
 * How long a challenged-but-not-fully-acked relay stays "unsettled" before
 * self-heal. Longer than the sweep auth-wait cap (8s) so slow acks win; past it
 * we assume a lost AUTH/OK and re-auth on the live socket (half-open sockets
 * never reopen on their own).
 */
const AUTH_STALE_MS = 12_000;
/** Ceiling for the doubling stale window. */
const AUTH_STALE_MAX_MS = 5 * 60_000;

/** Listeners asked to re-send AUTH frames for a relay whose auth went stale. */
type ReauthListener = (url: string) => void;
const reauthListeners = new Set<ReauthListener>();

/**
 * Subscribe to auth-stale events (relay challenged, AUTHs not fully acked within
 * {@link AUTH_STALE_MS}); NostrProvider re-sends. Returns an unsubscribe.
 */
export function onStreamAuthStale(listener: ReauthListener): () => void {
  reauthListeners.add(listener);
  return () => reauthListeners.delete(listener);
}

function relayAuthState(url: string): RelayAuthState {
  const key = normalizeRelayUrl(url) ?? url;
  let state = relayAuth.get(key);
  if (!state) {
    state = {
      challenged: false,
      challengedAt: 0,
      answeredAt: 0,
      waves: 0,
      acked: new Set(),
      pending: new Map(),
      inFlight: new Set(),
      rejected: new Set(),
    };
    relayAuth.set(key, state);
  }
  return state;
}

/**
 * Record that `url` issued a NIP-42 challenge on its live socket. A NEW nonce
 * voids what answered the old one (its AUTHs and refusals) but not the acks:
 * NIP-42 authentication holds for the connection.
 */
export function noteRelayChallenged(url: string, challenge?: string): void {
  const state = relayAuthState(url);
  if (challenge !== undefined && challenge !== state.challenge) {
    if (state.challenge !== undefined) {
      state.pending.clear();
      state.inFlight.clear();
      state.rejected.clear();
    }
    state.challenge = challenge;
    state.waves = 0;
  }
  state.challenged = true;
  state.challengedAt = Date.now();
}

/** Reset a relay's auth state (socket reopened — the old session's acks are dead). */
export function resetRelayAuth(url: string): void {
  relayAuth.delete(normalizeRelayUrl(url) ?? url);
}

/** Record a stream AUTH frame sent to `url`, so its OK ack can be matched. */
export function noteStreamAuthSent(url: string, eventId: string, pubkey: string): void {
  const state = relayAuthState(url);
  state.inFlight.delete(pubkey);
  state.pending.set(eventId, pubkey);
}

/**
 * Feed an `["OK", id, ok, message]` from `url`; ignores ids that aren't pending
 * stream AUTHs. Only a NIP-01 `rate-limited:` refusal is worth re-sending on the
 * same challenge; any other is the relay's answer for this socket.
 */
export function noteAuthResult(url: string, eventId: string, ok: boolean, message?: string): void {
  const key = normalizeRelayUrl(url) ?? url;
  const state = relayAuth.get(key);
  const pk = state?.pending.get(eventId);
  if (!state || pk === undefined) return;
  state.pending.delete(eventId);
  state.answeredAt = Date.now();
  state.waves = 0;
  if (ok) {
    state.acked.add(pk);
    refusingRelays.delete(key);
  } else if (!message?.startsWith("rate-limited:")) {
    state.rejected.add(pk);
    // A refused probe, or enough refusals with nothing acked, is the relay's answer.
    if (state.acked.size === 0 && (isRefusing(key) || state.rejected.size >= REFUSING_MIN_REJECTS)) {
      refusingRelays.set(key, Date.now() + REFUSING_MS);
    }
  }
}

/**
 * Whether a REQ by `pubkeys` would pass `url`'s NIP-42 gate now: the socket was
 * never challenged (NRelay1's auth-retry covers a lazy challenge), or every AUTH
 * is acked.
 *
 * SELF-HEAL: past {@link AUTH_STALE_MS} with keys unacked, report settled (so
 * sync doesn't wedge) and fire one re-auth wave, re-arming the window. Waves
 * recur while unacked, hence re-signing only {@link unackedStreamPubkeys}.
 */
export function streamAuthsSettled(url: string, pubkeys: Iterable<string>): boolean {
  const key = normalizeRelayUrl(url) ?? url;
  const state = relayAuth.get(key);
  if (!state?.challenged) return true;
  // Nothing will be acked; waiting would only stall the sweep and fire waves.
  if (isRefusing(key)) return true;
  let allAcked = true;
  for (const pk of pubkeys) {
    // Address-only keys can never be authenticated here, so don't wait on them.
    const entry = registry.get(pk);
    if (entry !== undefined && entry.sk === undefined) continue;
    if (!state.acked.has(pk)) {
      allAcked = false;
      break;
    }
  }
  if (allAcked) return true;
  // Inside the window since the challenge — or since the relay last answered one
  // of our AUTHs — keep waiting: a relay working through a large batch is slow,
  // not lossy, and a wave would re-send keys whose answers are on the way.
  const window = Math.min(AUTH_STALE_MAX_MS, AUTH_STALE_MS * 2 ** state.waves);
  if (Date.now() - Math.max(state.challengedAt, state.answeredAt) < window) return false;
  state.waves += 1;
  // Re-arm so the triggered re-auth gets its own grace period.
  state.challengedAt = Date.now();
  for (const l of reauthListeners) l(key);
  return true;
}
