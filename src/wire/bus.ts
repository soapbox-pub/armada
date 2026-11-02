/**
 * The wire's change-notification bus: ingested events land in ArmadaDB first,
 * then the bus tells hooks WHICH conversation changed so they re-read the
 * store (stores are the source of truth; the bus is a doorbell). Scopes:
 *   - `nip29:<groupId>`        — a NIP-29 group timeline
 *   - `dm`                     — kind-4 or NIP-17 rumor store changed (inbox, unread dot)
 *   - `dm-thread:<peer>`       — one DM conversation
 *   - `dm:wrap`                — undecryptable live NIP-17 wrap; useDm17 force-syncs
 *   - `c2inv:wrap`             — buffered Concord direct-invite wrap (`#k`=3313); useDirectInvites drains
 *   - `c2:<channelIdHex>`      — a Concord channel's rumor store
 *   - `c2old:<channelIdHex>`   — the same, written by a background history round;
 *                                its `c2:` follows on a slower shared floor
 *   - `c2cur:<channelIdHex>`   — only the channel's sync CURSOR changed
 *   - `c2park:<streamPk>`      — a wrap PARKED for want of a key; key holders drain
 *   - `c2ctl:<communityIdHex>` — decrypted control plane changed
 *   - `git:<repository-address>` — an attached NIP-34 issue/PR root changed
 *
 * Emissions coalesce on a short window. Batches are mirrored to same-origin
 * tabs over a BroadcastChannel (received batches are never rebroadcast), except
 * in-hand-work scopes (`dm:wrap`, `c2inv:wrap`, `c2park:*`), which stay local.
 */

import { perfCount } from "@/lib/perf";

export type WireScope = string;

/** Scope naming one DM conversation without exposing it outside this process. */
export function dmThreadScope(peer: string): WireScope {
  return `dm-thread:${peer}`;
}

type WireListener = (scopes: ReadonlySet<WireScope>) => void;

/** Coalescing window for scope flushes (ms). */
const FLUSH_MS = 50;

const listeners = new Set<WireListener>();
let pending = new Set<WireScope>();
/** The subset of `pending` this context emitted itself — what gets mirrored. */
let localPending = new Set<WireScope>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Re-read doorbells held while the post-login SyncGate is up ({@link setWireGateHold}). */
let gateHold = false;
let gateHeld = new Set<WireScope>();

/** In-hand-work scopes; mirroring them would make every tab handle the same wrap. */
function isLocalOnlyScope(scope: WireScope): boolean {
  return scope === "dm:wrap" || scope === "c2inv:wrap" || scope.startsWith("c2park:");
}

/** Cross-context doorbell, created at load so idle tabs hear; absent in jsdom/old runtimes. */
const bridge: BroadcastChannel | undefined = (() => {
  if (typeof BroadcastChannel === "undefined") return undefined;
  try {
    const channel = new BroadcastChannel("armada-wire-bus");
    channel.onmessage = (event: MessageEvent) => {
      const scopes = Array.isArray(event.data)
        ? (event.data as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      if (scopes.length === 0) return;
      // `pending` only (not `localPending`): never rebroadcast, or tabs ping-pong.
      for (const s of scopes) pending.add(s);
      schedule();
    };
    // Node's BroadcastChannel holds the process open; browsers have no unref.
    (channel as { unref?: () => void }).unref?.();
    return channel;
  } catch {
    return undefined;
  }
})();

function schedule(): void {
  if (pending.size > 0 && timer === undefined) {
    timer = setTimeout(flush, FLUSH_MS);
  }
}

function deliver(scopes: ReadonlySet<WireScope>): void {
  if (scopes.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(scopes);
    } catch {
      // a listener must never break the bus
    }
  }
}

function flush(): void {
  timer = undefined;
  if (pending.size === 0) return;
  const batch = pending;
  const mirrored = [...localPending].filter((s) => !isLocalOnlyScope(s));
  pending = new Set();
  localPending = new Set();
  if (mirrored.length > 0) {
    try {
      bridge?.postMessage(mirrored);
    } catch {
      // a failed channel must never break the local doorbell
    }
  }
  // Under the SyncGate, re-read doorbells are invisible work: hold them for one
  // batch on release. In-hand-work (ingest) scopes pass through immediately.
  if (gateHold) {
    const passThrough = new Set<WireScope>();
    for (const s of batch) {
      if (isLocalOnlyScope(s)) passThrough.add(s);
      else gateHeld.add(s);
    }
    deliver(passThrough);
    return;
  }
  deliver(batch);
}

/** Announce that these conversations' stores changed. Coalesced. */
export function emitWireScopes(scopes: Iterable<WireScope>): void {
  for (const s of scopes) {
    // Per-family ring counts, profiling builds only.
    if (import.meta.env.VITE_PROFILE === "1") perfCount(`bus ${s.split(":")[0]}`, 0);
    pending.add(s);
    localPending.add(s);
  }
  schedule();
}

/** Subscribe to store-change announcements. Returns an unsubscribe. */
export function onWireScopes(listener: WireListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hold/release doorbells while the SyncGate overlay is up (`syncGateState`);
 * release delivers everything as ONE batch. Idempotent.
 */
export function setWireGateHold(active: boolean): void {
  if (gateHold === active) return;
  gateHold = active;
  if (!active && gateHeld.size > 0) {
    const held = gateHeld;
    gateHeld = new Set();
    deliver(held);
  }
}

/** Test helper: drop any pending batch, gate hold, and all listeners. */
export function resetWireBus(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  pending = new Set();
  localPending = new Set();
  gateHold = false;
  gateHeld = new Set();
  listeners.clear();
}
