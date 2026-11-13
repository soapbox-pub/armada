/// <reference lib="webworker" />
/**
 * Armada Service Worker
 *
 * Push-only: receive push notifications — Web Push from the nostr-push2
 * gateway, or Tenna's `window.napp.push` delivery when Armada is an nsite
 * there — and route notificationclick to the correct conversation. Beyond
 * the Web Share Target's POST (`webShareInbox.ts`) it deliberately does NOT
 * cache or intercept fetches: a cached app shell
 * references old chunk hashes and outlives the chunk-error recovery reload,
 * booting a release into the error screen. HTTP caching of the build
 * (immutable hashed /assets/*, revalidated index.html) covers fast loads.
 *
 * This module is the worker's event handling; `sw.ts` is the entry that
 * installs it with the real runtime (`pushRuntime.ts`), and the build bundles
 * the two into one classic `sw.js` (`serviceWorker()` in vite.config.ts). The
 * runtime is a parameter rather than an import so the suite can drive the
 * worker's half — whether it asks, and whether it presents the answer
 * faithfully — against a stub, while `pushRuntime.test.ts` covers the runtime
 * against the real crypto and store.
 */

import type { NostrEvent } from "@nostrify/nostrify";

import { t } from "@/i18n/intl";
import { notificationMessages } from "@/lib/notificationPreview";
import { deletePushState, readPushState, trimPushState, writePushState } from "@/lib/pushState";
import type { PushScope } from "@/lib/pushSubscriptions";
import type { SwPushConfig } from "@/lib/swPushConfig";
import { receiveSharePost, SHARE_ACTION } from "@/lib/webShareInbox";
import type { PreparedPush, PushData } from "@/sw/pushRuntime";

declare const self: ServiceWorkerGlobalScope;

/** What the worker needs from `pushRuntime.ts`. */
export interface PushRuntime {
  preparePush(data: PushData, cfg: SwPushConfig | null): Promise<PreparedPush | undefined>;
  pushScope(event: NostrEvent, cfg: SwPushConfig | null): PushScope | undefined;
  /** Whether a well-formed event's id and signature hold. */
  verifyEvent(event: NostrEvent): boolean;
  openConfig(sealed: Uint8Array | undefined): Promise<SwPushConfig | null>;
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

// Every current payload is a `napp.push.payload` (src/lib/nappPush.ts):
//
//    { $type: "napp.push.payload", event_id, event?, relays }
//
// It arrives by one of two roads that this worker cannot and need not tell
// apart: Web Push from the nostr-push2 gateway in a browser, or Tenna waking
// the worker itself when Armada is an nsite there (`window.napp.push`). Either
// way it is normalized below into the `{ scope, relays, event_id, event }` the
// rest of this worker reads — the event is fetched by id when it was too big to
// carry, and its plane (`scope`) is read off the event itself.
//
// Two older shapes are still understood, for pushes already in flight to an
// endpoint made before the switch:
//
//  - The legacy relay gateway's fully-rendered payload:
//    { title, body, icon, badge, data: { url, tag } } — shown as-is.
//
//  - The retired nostr-push gateway's static wake-up plus routing hints:
//    { title, body, data: { event_id, scope, relays, event? } }.
//
// When the event is there, the runtime opens it, stores it and hands back a
// real notification: the sender's name and avatar, the room's title and
// image, the message text. The gateway's static `title`/`body` are only the
// FALLBACK, for a payload too big to carry its event (nostr-push drops it past
// ~3800 bytes) or a scope whose keys this worker doesn't hold. That path shows
// the static wake-up first to satisfy userVisibleOnly, then fetches by id and
// updates the SAME stable tag silently: plaintext and decryptable messages
// gain their preview without a second alert; a decrypted drop becomes a fixed,
// non-leaking sync entry (and is withdrawn where the runtime allows true
// silence).

/** The routing half of a push, whichever payload shape it arrived in. */
interface WorkerPushData extends PushData {
  event_id?: string;
  tag?: string;
  subscription_id?: string;
  /** The napp path already asked the relays for the event, before presenting. */
  fetched?: boolean;
  /** The napp path was handed an event that does not verify, and found no sound copy. */
  forged?: boolean;
  lines?: string[];
}

/** A push payload as `PushEvent.data.json()` returns it. */
interface PushPayload {
  $type?: string;
  title?: string;
  body?: string;
  icon?: string;
  badge?: string;
  data?: WorkerPushData;
  [key: string]: unknown;
}

/** The fields every notification of one push shares. */
interface NotificationBase {
  icon: string;
  badge: string;
  renotify: boolean;
  silent?: boolean;
}

/** What the seen ledger remembers about a handled event. */
interface SeenDetails {
  outcome: string;
  roomKey?: string;
}

/** A live page's answer about one opened event. */
interface PageOutcome {
  outcome: string;
  roomKey?: string;
}

/** `showNotification` options this worker uses beyond the DOM lib's. */
type ArmadaNotificationOptions = NotificationOptions & {
  renotify?: boolean;
  timestamp?: number;
};

const PLAINTEXT_SCOPES = new Set<string | undefined>(["group", "group-mention"]);
const BADGE_STATE_KEY = "badge";
// The page-provided push config: the DM request policy, the known-peer set, the
// viewer's pubkey, (nsec logins only) the decrypt key, and the per-channel
// Concord stream keys. Written by swPushConfig.ts; read here per push. Must
// match that module's key — `dm-config` is the ON-DISK spelling from when the
// blob only carried DM state.
const PUSH_CONFIG_KEY = "dm-config";
// The user's push kill switch, written by swPushDisabled.ts BEFORE the disable
// path's best-effort network teardown and deleted when push is re-enabled.
// While it is set this worker displays nothing and tears down its own
// subscription — the page's unsubscribe/server-delete can fail or be cut off
// mid-way, and a gateway that never saw the delete keeps pushing forever at a
// device whose user said stop.
const PUSH_DISABLED_KEY = "disabled";
// Event ids this install has already presented, so a replayed push can't
// re-alert for a message the user has seen. Bounded like the own-event set.
const SEEN_EVENT_PREFIX = "seen/";
const MAX_SEEN_EVENTS = 256;

/**
 * Persistent/in-flight identity for one push match. NIP-29 event ids are not
 * globally one conversation: the same signed event can be stored on two
 * relays, and `h` is relay-local. Per-relay gateway specs make `relays[0]` the
 * exact source; include the inline event's `h` when available. Other planes
 * keep their ordinary event-id identity.
 */
function pushEventKey(data: WorkerPushData): string {
  const eventId = typeof data?.event_id === "string" ? data.event_id : "";
  if (!eventId) return "";
  if (!PLAINTEXT_SCOPES.has(data.scope)) return eventId;
  const relays = Array.isArray(data.relays) ? data.relays : [];
  const relay = relays.length === 1 && typeof relays[0] === "string" ? relays[0] : "";
  if (!relay) return eventId;
  const h = data.event && typeof data.event === "object" ? tagValue(data.event, "h") : "";
  return `nip29|${relay}|${h || "?"}|${eventId}`;
}

// Per-room interruption ceiling, the web-push mirror of the native service's
// ALERT_BURST_MAX (NotificationRelayService.java). A public channel is writable
// by anyone holding the invite, so a flood reaches every device's push; past
// this many ALERTING notifications for one collapse `tag` inside the window,
// further ones post SILENTLY — still shown (iOS counts a silent push, and the
// tray entry and its line count still update), they just stop making noise.
// Content-blind, exactly like native: nothing is classified, a flood simply
// stops buzzing. The worker is killed between pushes, so the window's alert
// timestamps live in the push state, keyed by tag.
const ROOM_ALERT_PREFIX = "alert/";
const ROOM_ALERT_MAX = 5;
const ROOM_ALERT_WINDOW_MS = 120_000;
// Cap the timestamps one tag re-serializes while a flood is live (native's
// ALERT_BURST_MAX_TRACKED). Only the count within the window matters; the extra
// headroom keeps a sustained flood's window full so it stays quiet until it
// genuinely stops, instead of the budget refilling mid-flood.
const ROOM_ALERT_MAX_TRACKED = 64;
// Bound on alert/ entries, oldest-written dropped first like seen/. A rewrite
// makes an entry the newest, so only rooms quiet for longer than this many
// others are dropped — and a dropped room merely alerts again.
const MAX_ROOM_ALERT_ENTRIES = 128;

/** Increment the Home-Screen badge without needing a live page. */
async function incrementAppBadge(): Promise<void> {
  if (typeof self.navigator?.setAppBadge !== "function") return;
  try {
    const current = await readPushState<number>(BADGE_STATE_KEY);
    const next = Math.min((typeof current === "number" ? current : 0) + 1, 999);
    await Promise.all([
      writePushState(BADGE_STATE_KEY, next),
      self.navigator.setAppBadge(next),
    ]);
  } catch {
    // Badging is enhancement only; never risk the visible notification.
  }
}

/** Clear both the OS badge and the counter the next push increments. */
async function clearAppBadge(): Promise<void> {
  try {
    await deletePushState(BADGE_STATE_KEY);
    if (typeof self.navigator?.clearAppBadge === "function") {
      await self.navigator.clearAppBadge();
    }
  } catch {
    // Ignore unsupported/revoked badging.
  }
}

/** Whether this push references an event created by this browser install. */
async function isOwnPush(data: WorkerPushData): Promise<boolean> {
  if (!data.event_id) return false;
  try {
    return Boolean(await readPushState(`own/${encodeURIComponent(data.event_id)}`));
  } catch {
    return false;
  }
}

/** Metadata for an event successfully handled by an earlier PushEvent. */
async function seenBefore(data: WorkerPushData): Promise<SeenDetails | undefined> {
  const eventKey = pushEventKey(data);
  if (!eventKey) return undefined;
  try {
    const stored = await readPushState(`${SEEN_EVENT_PREFIX}${encodeURIComponent(eventKey)}`);
    if (stored === undefined) return undefined;
    return stored && typeof stored === "object" ? stored as SeenDetails : { outcome: "handled" };
  } catch {
    // Never trade a real notification for a bookkeeping failure.
    return undefined;
  }
}

/**
 * Commit an event only AFTER presentation or an exact page acknowledgement.
 * The ledger must describe success, not an attempt: a worker killed between a
 * pre-show write and showNotification would lose the event on replay.
 */
async function markSeen(
  data: WorkerPushData,
  details: SeenDetails = { outcome: "worker" },
): Promise<void> {
  const eventKey = pushEventKey(data);
  if (!eventKey) return;
  try {
    await writePushState(`${SEEN_EVENT_PREFIX}${encodeURIComponent(eventKey)}`, details);
    try {
      await trimPushState(SEEN_EVENT_PREFIX, MAX_SEEN_EVENTS);
    } catch {
      // No enumeration — the ledger just grows slowly.
    }
  } catch {
    // A bookkeeping failure may replay later; it must never hide this delivery.
  }
}

/**
 * A locally authored event, replay, policy drop, or exact foreground-page
 * acknowledgement updates one silent collapsed sync entry instead of going
 * dark, unless the runtime says a push may show nothing ({@link mustShowNotification}).
 */
async function quietSync(mustShow: () => Promise<boolean>, tag = "armada-quiet-sync"): Promise<void> {
  if (!(await mustShow())) return;
  await self.registration.showNotification(t(notificationMessages.appName), {
    // Deliberately fixed, not inherited from the gateway payload: suppression
    // covers own/replayed/policy-hidden events, so no sender-controlled title,
    // body, icon, route, or other message metadata may survive this fallback.
    icon: "/favicon.png",
    badge: "/badge-96.png",
    body: t(notificationMessages.messagesSynced),
    tag,
    renotify: false,
    silent: true,
    data: { url: "/" },
  } as ArmadaNotificationOptions);
}

const PAGE_PRESENTATION_OUTCOMES = new Set([
  "presenting",
  "presented",
  "suppressed",
  "unhandled",
  "worker",
]);

/** The event a page is asked about: an opened rumor, or a wrap the worker could not open. */
interface PresentationTarget {
  eventId?: string;
  /** Unset for a wrap: any room the page names is accepted. */
  roomKey?: string;
}

/** Ask or claim one exact event in a live page (room may be unresolved). */
function clientPresentationState(
  client: Client,
  prepared: PresentationTarget,
  type: string,
  timeoutMs: number,
  extra: Record<string, unknown> = {},
): Promise<PageOutcome> {
  if (typeof MessageChannel === "undefined" || typeof client.postMessage !== "function") {
    return Promise.resolve({ outcome: "unhandled", roomKey: prepared.roomKey });
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (outcome: PageOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ outcome: "unhandled", roomKey: prepared.roomKey }),
      timeoutMs,
    );
    channel.port1.onmessage = (event) => {
      const reply = event.data;
      const replyRoom = typeof reply?.roomKey === "string" ? reply.roomKey : "";
      const roomMatches = prepared.roomKey
        ? replyRoom === prepared.roomKey
        : replyRoom !== "" || reply?.outcome === "worker" || reply?.outcome === "unhandled";
      finish(
        reply?.eventId === prepared.eventId
          && roomMatches
          && PAGE_PRESENTATION_OUTCOMES.has(reply?.outcome)
          ? { outcome: reply.outcome, roomKey: replyRoom || prepared.roomKey }
          : { outcome: "unhandled", roomKey: prepared.roomKey },
      );
    };
    try {
      client.postMessage({
        ...extra,
        type,
        eventId: prepared.eventId,
        roomKey: prepared.roomKey,
      }, [channel.port2]);
    } catch {
      finish({ outcome: "unhandled", roomKey: prepared.roomKey });
    }
  });
}

function strongestPageOutcome(outcomes: PageOutcome[]): PageOutcome | undefined {
  for (const outcome of ["presented", "presenting", "suppressed"]) {
    const match = outcomes.find((candidate) => candidate?.outcome === outcome);
    if (match) return match;
  }
  return undefined;
}

/**
 * Read a completed page outcome, then explicitly claim every unresolved page
 * before worker presentation. The claim response closes the query/claim race:
 * a page that presented in between reports that outcome; otherwise it records
 * worker ownership before acknowledging.
 */
async function pagePresentationOutcome(prepared: PreparedPush): Promise<PageOutcome | undefined> {
  if (!prepared?.eventId) return undefined;
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.length === 0) return undefined;
    const queried = await Promise.all(
      windows.map((client) => clientPresentationState(
        client,
        prepared,
        "armada-push-presentation-query",
        500,
      )),
    );
    const completed = strongestPageOutcome(queried);
    if (completed) return completed;

    const claimed = await Promise.all(
      windows.map((client) => clientPresentationState(
        client,
        prepared,
        "armada-push-worker-claim",
        650,
      )),
    );
    return strongestPageOutcome(claimed);
  } catch {
    return undefined;
  }
}

/** Total time the worker gives open pages to open a wrap it could not. */
const PAGE_OPEN_BUDGET_MS = 5_000;

/** Focused, then visible, then the rest: the first page likeliest to hold a ready signer. */
function windowPreference(client: Client): number {
  const win = client as WindowClient;
  if (win.focused) return 0;
  return win.visibilityState === "visible" ? 1 : 2;
}

/**
 * Hand an encrypted event this worker could not open to the open pages, which
 * hold the signer, one at a time. A page that opens it notifies (or not) itself
 * and says so. Otherwise every page is claimed for the worker, as in
 * {@link pagePresentationOutcome}, so none presents after the generic text.
 */
async function pageOpenOutcome(data: WorkerPushData): Promise<PageOutcome | undefined> {
  const ev = data.event;
  const eventId = pushEventKey(data);
  if (!ev || !eventId || ev.id !== eventId) return undefined;
  if (data.scope !== "dm" && data.scope !== "c2") return undefined;
  try {
    const windows = [...await self.clients.matchAll({ type: "window", includeUncontrolled: true })]
      .sort((a, b) => windowPreference(a) - windowPreference(b));
    if (windows.length === 0) return undefined;
    const target = { eventId };
    const deadline = Date.now() + PAGE_OPEN_BUDGET_MS;
    for (const client of windows) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const answer = await clientPresentationState(client, target, "armada-push-open", remaining, { event: ev });
      const decided = strongestPageOutcome([answer]);
      if (decided) return decided;
    }
    const claimed = await Promise.all(
      windows.map((client) => clientPresentationState(client, target, "armada-push-worker-claim", 650)),
    );
    return strongestPageOutcome(claimed);
  } catch {
    return undefined;
  }
}

/**
 * Re-post the notification a page already showed under `tag`, silently: the
 * one way to satisfy a runtime that demands a notification per push without a
 * second entry. Falls back to the fixed sync entry.
 */
async function reshowPageNotification(tag: string, mustShow: () => Promise<boolean>): Promise<void> {
  if (!(await mustShow())) return;
  try {
    if (typeof self.registration.getNotifications === "function") {
      const [shown] = await self.registration.getNotifications({ tag });
      if (shown) {
        await self.registration.showNotification(shown.title, {
          body: shown.body,
          icon: shown.icon,
          badge: shown.badge,
          tag,
          data: shown.data,
          silent: true,
          renotify: false,
        } as ArmadaNotificationOptions);
        return;
      }
    }
  } catch {
    // Fall through to the sync entry.
  }
  await quietSync(mustShow);
}

/**
 * The page-provided push config, or null if there is none or it won't open.
 *
 * Sealed at rest under a non-extractable AES-GCM key (swSecretVault); the
 * runtime opens it, and a config it can't decrypt safely degrades to the
 * generic wake-up.
 */
async function readConfig(runtime: PushRuntime): Promise<SwPushConfig | null> {
  let sealed: Uint8Array | undefined;
  try {
    const stored = await readPushState(PUSH_CONFIG_KEY);
    if (stored instanceof Uint8Array) sealed = stored;
  } catch {
    // Treated as no config.
  }
  return runtime.openConfig(sealed);
}

/**
 * Fail closed before the gateway's static fallback for an encrypted plane
 * whose page snapshot is explicitly incomplete. This check cannot wait for an
 * inlined/fetched event: legacy NIP-04 and oversized wraps reach the static
 * path first, where even a fixed "New message" would violate the plane gate.
 * Missing flags retain the behavior of configs written by older clients.
 */
async function pushPlaneUnready(runtime: PushRuntime, data: WorkerPushData): Promise<boolean> {
  if (data.scope !== "dm" && data.scope !== "c2") return false;
  try {
    const cfg = await readConfig(runtime);
    return data.scope === "dm"
      ? cfg?.dmReady === false
      : cfg?.concordReady === false;
  } catch {
    return false;
  }
}

/** Open/store/resolve an inlined (or just-fetched) event without presenting it. */
async function prepareNotification(
  runtime: PushRuntime,
  data: WorkerPushData,
): Promise<PreparedPush | undefined> {
  if (!data.event) return undefined;
  try {
    return await runtime.preparePush(data, await readConfig(runtime));
  } catch {
    return undefined; // never trade the notification for a runtime failure
  }
}

/** Options for {@link showPreparedNotification}. */
interface ShowOptions {
  tag?: string;
  silent?: boolean;
  reuseExisting?: boolean;
}

/** The routing data a notification carries, without the (large) inlined event. */
function routeDataOf(data: WorkerPushData): WorkerPushData {
  const routeData = { ...data };
  delete routeData.event;
  return routeData;
}

/** Present one already-resolved notification. */
async function showPreparedNotification(
  base: NotificationBase,
  data: WorkerPushData,
  prepared: PreparedPush,
  options: ShowOptions = {},
): Promise<void> {
  const displayTag = options.tag || prepared.tag;
  // A content-blind request ping must not accumulate the room's lines — the
  // whole point is that it reveals nothing the sender chose.
  const lines = prepared.accumulate
    ? options.reuseExisting
      ? (await existingRoomLines(displayTag)) ?? [prepared.line]
      : await appendRoomLine(displayTag, prepared.line)
    : [prepared.line];
  const quiet = options.silent === true || prepared.quiet === true;

  await self.registration.showNotification(prepared.title, {
    ...base,
    ...(quiet ? { silent: true, renotify: false } : {}),
    icon: prepared.icon,
    badge: prepared.badge,
    body: lines.join("\n"),
    tag: displayTag,
    ...(Number.isFinite(prepared.timestamp) && prepared.timestamp > 0
      ? { timestamp: prepared.timestamp }
      : {}),
    data: {
      ...routeDataOf(data),
      url: prepared.url,
      lines: prepared.accumulate ? lines : undefined,
      // Read by the page's `dismissReadWebNotifications`.
      roomKey: prepared.roomKey,
      newestMs: prepared.timestamp,
    },
  } as ArmadaNotificationOptions);
}

/** Close every notification currently shown under `tag`. Best-effort. */
async function withdrawNotifications(tag: string): Promise<void> {
  try {
    if (typeof self.registration.getNotifications !== "function") return;
    const shown = await self.registration.getNotifications({ tag });
    for (const n of shown) n.close();
  } catch {
    // No introspection — the notification stays until tapped.
  }
}

/**
 * The room's recent notification lines plus `line`, capped at 5 — the closest
 * Web Notifications get to the native MessagingStyle expansion. The previous
 * notification for `tag` carries its lines in `data`; replacing it with the
 * appended list keeps a busy conversation readable instead of showing only
 * the newest message. Browsers without notification introspection just get
 * the single line.
 */
async function appendRoomLine(tag: string, line: string): Promise<string[]> {
  const lines = ((await existingRoomLines(tag)) ?? []).slice(-4);
  lines.push(line);
  return lines;
}

/** Lines already carried by the notification under this exact room tag. */
async function existingRoomLines(tag: string): Promise<string[] | undefined> {
  try {
    if (typeof self.registration.getNotifications === "function") {
      const [prior] = await self.registration.getNotifications({ tag });
      return prior && prior.data && Array.isArray(prior.data.lines) ? prior.data.lines : [];
    }
  } catch {
    // No introspection — caller uses a single-line body.
  }
  return undefined;
}

/**
 * Whether this push must display something. A runtime reporting
 * `userVisibleOnly: false` (Tenna on Android, NAPP.md) allows silence. WebKit
 * revokes the subscription after a few silent pushes, with no exemption.
 * Chromium and Gecko exempt a push while a page of the origin is visible or one
 * of its notifications is still displayed (Chromium's
 * PushMessagingNotificationManager, Gecko's PushService quota); outside that,
 * Chromium posts its own generic banner and Gecko expires the subscription.
 */
async function mustShowNotification(): Promise<boolean> {
  let sub: PushSubscription | null | undefined;
  try {
    sub = await self.registration.pushManager?.getSubscription();
  } catch {
    return true;
  }
  if (sub?.options?.userVisibleOnly === false) return false;
  if (!sub || isApplePushEndpoint(sub.endpoint)) return true;
  return !(await silentPushExempt());
}

function isApplePushEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.endsWith("push.apple.com");
  } catch {
    return false;
  }
}

async function silentPushExempt(): Promise<boolean> {
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => (client as WindowClient).visibilityState === "visible")) return true;
  } catch {
    // Fall through to the displayed-notification check.
  }
  try {
    if (typeof self.registration.getNotifications !== "function") return false;
    return (await self.registration.getNotifications()).length > 0;
  } catch {
    return false;
  }
}

/**
 * {@link mustShowNotification}, asked at most once per push. Settle it before
 * the push shows anything: a notification this push itself posts (and may
 * withdraw) must not count as one already on screen.
 */
function mustShowOnce(): () => Promise<boolean> {
  let answer: Promise<boolean> | undefined;
  return () => (answer ??= mustShowNotification());
}

/**
 * Whether this room's notification must post SILENTLY — it has already ALERTED
 * {@link ROOM_ALERT_MAX} times for `tag` inside the window. Records every
 * attempt (alerting or not), like the native service, so a sustained flood
 * keeps its own window full and stays quiet until it actually stops. Call once
 * per push, before showing; a bookkeeping failure never silences a real alert.
 */
async function roomAlertSilent(tag: string | undefined): Promise<boolean> {
  if (!tag) return false;
  try {
    const key = `${ROOM_ALERT_PREFIX}${encodeURIComponent(tag)}`;
    const now = Date.now();
    const stored = await readPushState(key);
    const times: unknown[] = Array.isArray(stored) ? stored : [];
    let recent = times.filter((t): t is number => typeof t === "number" && now - t <= ROOM_ALERT_WINDOW_MS);
    const silent = recent.length >= ROOM_ALERT_MAX;
    recent.push(now);
    if (recent.length > ROOM_ALERT_MAX_TRACKED) recent = recent.slice(-ROOM_ALERT_MAX_TRACKED);
    await writePushState(key, recent);
    try {
      await trimPushState(ROOM_ALERT_PREFIX, MAX_ROOM_ALERT_ENTRIES);
    } catch {
      // No enumeration — the entries just grow slowly.
    }
    return silent;
  } catch {
    return false;
  }
}

/**
 * Whether the user has turned push off on this install. The page's disable
 * path unsubscribes and deletes the gateway registrations, but both are
 * best-effort over the network; this flag is the local truth the worker can
 * enforce without any page open.
 */
async function pushDisabled(): Promise<boolean> {
  try {
    return Boolean(await readPushState(PUSH_DISABLED_KEY));
  } catch {
    return false;
  }
}

/**
 * Tear down this install's own subscription so disabled pushes stop at the
 * source: once the endpoint is gone the push service answers 410 and the
 * gateway drops the registration — no relay cooperation needed.
 */
async function dropOwnSubscription(): Promise<void> {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    // The next stray push retries.
  }
}

/** Handle one unique PushEvent. The caller serializes equal event ids. */
async function handlePush(
  runtime: PushRuntime,
  payload: PushPayload,
  data: WorkerPushData,
  base: NotificationBase,
): Promise<void> {
  const mustShow = mustShowOnce();

  // The user turned push off. Showing nothing is intentional here: dropping
  // the endpoint is the requested outcome, even if WebKit also revokes it.
  if (await pushDisabled()) {
    await dropOwnSubscription();
    return;
  }
  await mustShow();

  // A forged event is not a message. It is not recorded as seen either: the id
  // it claims belongs to an event that may still arrive.
  if (data.forged || (data.event !== undefined && !isSound(runtime, data.event))) {
    await quietSync(mustShow);
    return;
  }

  if (await pushPlaneUnready(runtime, data)) {
    await quietSync(mustShow);
    await markSeen(data, { outcome: "suppressed" });
    return;
  }

  if (await isOwnPush(data)) {
    await quietSync(mustShow);
    await markSeen(data, { outcome: "suppressed" });
    return;
  }
  const seen = await seenBefore(data);
  if (seen) {
    if (
      seen.outcome === "page-presented"
      && typeof seen.roomKey === "string"
      && await mustShow()
    ) {
      const replay = await prepareNotification(runtime, data);
      if (replay && !replay.drop && replay.roomKey === seen.roomKey) {
        await showPreparedNotification(base, data, replay, {
          tag: seen.roomKey,
          silent: true,
          reuseExisting: true,
        });
        return;
      }
    }
    await quietSync(mustShow);
    return;
  }

  // Open/store first. Only a resolved event has an exact room/event identity a
  // page may acknowledge; generic capability or stale WindowClient URLs never
  // suppress a push again.
  const prepared = await prepareNotification(runtime, data);
  if (prepared) {
    if (prepared.drop) {
      await quietSync(mustShow);
      await markSeen(data, { outcome: "suppressed" });
      return;
    }

    const pageOutcome = await pagePresentationOutcome(prepared);
    if (pageOutcome?.outcome === "presented" || pageOutcome?.outcome === "presenting") {
      const pageRoomKey = pageOutcome.roomKey || prepared.roomKey || prepared.tag;
      // A visible page already used this exact room tag. A runtime that still
      // requires a showNotification call for this PushEvent gets a silent
      // update of that same real entry (never a generic banner or re-alert). A
      // still-pending page call gets the same update everywhere as a fallback.
      if (pageOutcome.outcome === "presenting" || await mustShow()) {
        await showPreparedNotification(base, data, prepared, {
          tag: pageRoomKey,
          silent: true,
          reuseExisting: true,
        });
      }
      await markSeen(data, {
        outcome: "page-presented",
        roomKey: pageRoomKey,
      });
      return;
    }
    if (pageOutcome?.outcome === "suppressed") {
      // Active-room/read/policy suppression uses only the fixed non-leaking
      // sync entry, or nothing where the runtime allows it.
      await quietSync(mustShow);
      await markSeen(data, { outcome: "suppressed" });
      return;
    }

    const silent = await roomAlertSilent(prepared.roomKey || prepared.tag);
    await showPreparedNotification(base, data, prepared, {
      tag: prepared.roomKey || prepared.tag,
      silent,
    });
    await Promise.all([incrementAppBadge(), markSeen(data)]);
    return;
  }

  // An open page holds the signer this worker lacks: let it open the event.
  const handed = await pageOpenOutcome(data);
  if (handed?.outcome === "presented" || handed?.outcome === "presenting") {
    const roomKey = handed.roomKey || "";
    if (roomKey) await reshowPageNotification(roomKey, mustShow);
    else await quietSync(mustShow);
    await markSeen(data, { outcome: "page-presented", roomKey });
    return;
  }
  if (handed?.outcome === "suppressed") {
    await quietSync(mustShow);
    await markSeen(data, { outcome: "suppressed" });
    return;
  }

  // No key/event: show the gateway wake-up exactly once. Prefer an
  // event-stable tag so later enrichment can update this same entry without a
  // second alert; fall back to the subscription tag only when no event exists.
  const tag = pushEventKey(data) || data.tag || data.subscription_id || "armada-notification";
  const rateKey = data.tag || data.subscription_id || tag;
  const silent = await roomAlertSilent(rateKey);
  const alertBase = silent ? { ...base, silent: true, renotify: false } : base;
  const routeData = routeDataOf(data);
  await self.registration.showNotification(payload.title ?? t(notificationMessages.appName), {
    ...alertBase,
    body: payload.body ?? "",
    data: routeData,
    tag,
  } as ArmadaNotificationOptions);
  await Promise.all([incrementAppBadge(), markSeen(data)]);

  // Best-effort enrichment is an UPDATE, never a second alert: keep the exact
  // static tag and force silent/non-renotify, or an oversized encrypted wrap
  // shows two banners.
  if (!data.event_id) return;
  const relays = Array.isArray(data.relays)
    ? data.relays.filter((relay): relay is string => typeof relay === "string")
    : [];
  const encrypted = data.scope === "dm" || data.scope === "c2";
  if (!PLAINTEXT_SCOPES.has(data.scope) && !encrypted) return;

  // A plaintext event in hand needs no second fetch; an encrypted one the
  // runtime already failed to open would fail again.
  let ev = data.event;
  if (ev && encrypted) return;
  if (!ev) {
    // `fetched`: the napp path already asked the relays, before presenting.
    if (data.fetched || relays.length === 0) return;
    try {
      ev = await fetchEventFromRelays(runtime, relays, data.event_id, 4000);
    } catch {
      return; // leave the static notification in place
    }
  }
  if (!ev) return;

  if (encrypted) {
    const enriched = await prepareNotification(runtime, { ...data, event: ev });
    if (!enriched) return;
    if (enriched.drop) {
      if (await mustShow()) {
        await quietSync(mustShow, tag);
      } else {
        await withdrawNotifications(tag);
      }
      return;
    }
    await showPreparedNotification(base, data, enriched, { tag, silent: true });
    return;
  }

  const h = tagValue(ev, "h");
  await self.registration.showNotification(payload.title ?? t(notificationMessages.appName), {
    ...base,
    body: truncate(ev.content, 140) || payload.body || "",
    tag,
    silent: true,
    renotify: false,
    data: {
      ...routeData,
      url: h && relays[0] ? groupUrl(relays[0], h, ev.id) : data.url,
    },
  } as ArmadaNotificationOptions);
}

/** Serializes duplicate gateway matches without pre-committing the seen key. */
function pushRunner(runtime: PushRuntime) {
  // One worker global handles concurrent PushEvents. Claim an event id before
  // the first await so overlapping gateway filters cannot both race through the
  // persistent Cache check and alert for the same event.
  const inFlight = new Map<string, Promise<void>>();

  return (payload: PushPayload, data: WorkerPushData, base: NotificationBase): Promise<void> => {
    const eventKey = pushEventKey(data);
    if (!eventKey) return handlePush(runtime, payload, data, base);

    const existing = inFlight.get(eventKey);
    if (existing) {
      return (async () => {
        try {
          await existing;
        } catch {
          // The first show failed and therefore did not commit `seen`; this
          // push is the retry, not a duplicate to suppress.
        }
        // Re-enter through the committed seen metadata. In particular, an
        // event first presented by the page must silently update that
        // same room entry, not create a second generic sync notification.
        return handlePush(runtime, payload, data, base);
      })();
    }

    const tracked: Promise<void> = handlePush(runtime, payload, data, base).finally(() => {
      if (inFlight.get(eventKey) === tracked) inFlight.delete(eventKey);
    });
    inFlight.set(eventKey, tracked);
    return tracked;
  };
}

const NAPP_PUSH_PAYLOAD_TYPE = "napp.push.payload";

/** What the worker shows when it can't open the event, per plane. */
const FALLBACK_TEXT = {
  dm: notificationMessages.newDirectMessage,
  c2: notificationMessages.newCommunityMessage,
  group: notificationMessages.newChannelMessage,
  "group-mention": notificationMessages.someoneMentionedYou,
} satisfies Record<PushScope, unknown>;

/** The plane an event belongs to, or undefined for anything unplaceable. */
async function scopeOfEvent(
  runtime: PushRuntime,
  ev: NostrEvent | undefined,
): Promise<PushScope | undefined> {
  if (!ev || typeof ev !== "object") return undefined;
  try {
    return runtime.pushScope(ev, await readConfig(runtime));
  } catch {
    return undefined;
  }
}

/**
 * Normalize a `napp.push.payload` into the `{ title, body }` fallback and the
 * `data` the rest of the worker reads. The event is fetched here when it did
 * not fit the transport, BEFORE anything is shown: its plane, and so whether
 * and how to show it, is only knowable from the event.
 */
async function nappPush(
  runtime: PushRuntime,
  raw: PushPayload,
): Promise<{ payload: PushPayload; data: WorkerPushData }> {
  const eventId = typeof raw.event_id === "string" ? raw.event_id : "";
  const relays = Array.isArray(raw.relays)
    ? raw.relays.filter((relay): relay is string => typeof relay === "string")
    : [];
  const inlined = raw.event as NostrEvent | undefined;
  const claimed = Boolean(inlined) && typeof inlined === "object" && inlined?.id === eventId;
  // Tenna delivers what its relays sent unchecked: only a sound event is read below.
  let ev = claimed && isSound(runtime, inlined) ? inlined : undefined;
  if (!ev && eventId && relays.length > 0) {
    try {
      ev = await fetchEventFromRelays(runtime, relays, eventId, 4000);
    } catch {
      ev = undefined;
    }
  }

  const scope = await scopeOfEvent(runtime, ev);
  const data: WorkerPushData = { event_id: eventId, relays, fetched: true };
  if (scope) data.scope = scope;
  if (ev) data.event = ev;
  else if (claimed) data.forged = true;
  if (scope === "dm") data.url = "/dm";
  const h = ev ? tagValue(ev, "h") : undefined;
  if (PLAINTEXT_SCOPES.has(scope) && h && relays.length === 1) {
    data.url = groupUrl(relays[0], h, eventId);
  }
  return {
    payload: scope
      ? { title: t(notificationMessages.newMessage), body: t(FALLBACK_TEXT[scope]) }
      : { title: t(notificationMessages.appName), body: t(notificationMessages.newMessage) },
    data,
  };
}

/** Whether `ev` is a well-formed event whose id and signature hold. */
function isSound(runtime: PushRuntime, ev: unknown): ev is NostrEvent {
  try {
    return typeof ev === "object" && ev !== null && runtime.verifyEvent(ev as NostrEvent);
  } catch {
    return false;
  }
}

/** First value of the first `name` tag on an event, or undefined. Total: it is asked before the event is checked. */
function tagValue(event: { tags?: unknown }, name: string): string | undefined {
  if (!Array.isArray(event.tags)) return undefined;
  const t: unknown = event.tags.find((x) => Array.isArray(x) && x[0] === name);
  return Array.isArray(t) && typeof t[1] === "string" ? t[1] : undefined;
}

function truncate(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Deep link to a message in a NIP-29 group, matching the SPA's chat routes
 * (`src/lib/routes.ts`) — including the relay route param. The shapes it has
 * to agree with are `/s/:server/:groupId` and its `/m/:messageId` suffix.
 */
function groupUrl(relayUrl: string, groupId: string, eventId?: string): string {
  const param = encodeURIComponent(
    relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")),
  );
  const room = `/s/${param}/${encodeURIComponent(groupId)}`;
  return eventId ? `${room}/m/${encodeURIComponent(eventId)}` : room;
}

/**
 * Fetch one event by id, racing the given relays, resolving with the first hit
 * — or undefined once every relay has said it has none, or after `timeoutMs`.
 * Each socket is torn down on resolve.
 */
function fetchEventFromRelays(
  runtime: PushRuntime,
  relays: string[],
  id: string,
  timeoutMs: number,
): Promise<NostrEvent | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const sockets: WebSocket[] = [];
    let unanswered = 0;
    const answered = () => {
      unanswered -= 1;
      if (unanswered <= 0) done(undefined);
    };
    const done = (ev: NostrEvent | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      resolve(ev);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);

    for (const url of relays) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        continue;
      }
      sockets.push(ws);
      unanswered += 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        answered();
      };
      const subId = `sw-${Math.random().toString(36).slice(2, 10)}`;
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(["REQ", subId, { ids: [id] }]));
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (msg) => {
        let frame;
        try {
          frame = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (!Array.isArray(frame)) return;
        if (frame[0] === "EVENT" && frame[1] === subId) {
          // First SOUND answer wins: a forged one must not settle the race against an honest relay.
          if (isSound(runtime, frame[2]) && frame[2].id === id) done(frame[2]);
        } else if ((frame[0] === "EOSE" || frame[0] === "CLOSED") && frame[1] === subId) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          finish();
        }
      };
      ws.onerror = () => {
        // Other relays may still answer.
        finish();
      };
    }

    if (unanswered === 0) done(undefined);
  });
}

/** Keep notification routes inside this installed app's origin. */
function notificationTarget(raw: unknown): string {
  try {
    const url = new URL(typeof raw === "string" ? raw : "/", self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/** How long a live page has to confirm it routed a tap itself before the worker reloads it. */
const SOFT_ROUTE_WAIT_MS = 1000;

/**
 * Ask a running page to route the tap through its own router. `client.navigate()` loads a new
 * document, which cold-boots the whole app (splash included) even onto the screen already open.
 */
function softRoute(client: WindowClient, target: string): Promise<boolean> {
  if (typeof MessageChannel === "undefined" || typeof client.postMessage !== "function") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (routed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(routed);
    };
    // A frozen or discarded page never answers.
    const timer = setTimeout(() => finish(false), SOFT_ROUTE_WAIT_MS);
    channel.port1.onmessage = (event) => finish(event.data?.routed === target);
    try {
      client.postMessage({ type: "armada-open-route", path: target }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

/** Route in the live page, else navigate before focusing; if both fail, open the route explicitly. */
async function openNotificationTarget(target: string): Promise<WindowClient | null | undefined> {
  let fallbackClient: WindowClient | undefined;
  try {
    const clientList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    fallbackClient = clientList.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (fallbackClient) {
      if (await softRoute(fallbackClient, target)) {
        try {
          return await fallbackClient.focus();
        } catch {
          // Routed already; the explicit paths below would reload it.
          return fallbackClient;
        }
      }
      try {
        // `navigate()` is asynchronous. Focusing the old document before it
        // settles races the SPA's startup redirect and sometimes loses the
        // message route on iOS; await the returned WindowClient instead.
        const navigated = await fallbackClient.navigate(target);
        if (navigated && typeof navigated.focus === "function") {
          return await navigated.focus();
        }
      } catch {
        // A frozen/discarded client can reject navigation. Opening a new app
        // window is the reliable route-preserving fallback.
      }
    }
  } catch {
    // Client enumeration is best-effort; openWindow remains available.
  }

  try {
    const opened = await self.clients.openWindow(target);
    if (opened) return opened;
  } catch {
    // Last resort below: bring the existing client forward even if routing
    // could not be changed, rather than making the tap appear to do nothing.
  }
  if (fallbackClient && typeof fallbackClient.focus === "function") {
    return fallbackClient.focus();
  }
}

/** Register every event handler on the worker global. */
export function installServiceWorker(runtime: PushRuntime): void {
  const runPush = pushRunner(runtime);

  self.addEventListener("install", (event) => {
    // Take over immediately: this worker holds no per-build state, so there
    // is no old-build/new-build consistency to preserve across a swap.
    void self.skipWaiting();
    // Static routing: GETs go straight to the network without starting this
    // worker, so the share target's fetch handler costs page loads nothing.
    const routed = event as ExtendableEvent & {
      addRoutes?: (rules: unknown) => Promise<void>;
    };
    if (typeof routed.addRoutes === "function") {
      try {
        event.waitUntil(
          routed.addRoutes({ condition: { requestMethod: "GET" }, source: "network" }).catch(() => undefined),
        );
      } catch { /* unsupported condition: the handler below passes GETs through */ }
    }
  });

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "POST") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname !== SHARE_ACTION) return;
    event.respondWith(receiveSharePost(request, caches, self.location.origin));
  });

  self.addEventListener("activate", (event) => {
    // Purge every shell cache left behind by the old caching worker and claim
    // open clients, so installs that are stuck booting a stale cached shell
    // heal themselves as soon as this worker replaces the old one.
    event.waitUntil(
      Promise.all([
        caches
          .keys()
          .then((keys) =>
            Promise.all(keys.filter((k) => k.startsWith("armada-shell-")).map((k) => caches.delete(k))),
          ),
        self.clients.claim(),
      ]),
    );
  });

  self.addEventListener("push", (event) => {
    // Read synchronously: the payload is the event's, not the promise's.
    let parsed: PushPayload | null = null;
    let isJson = false;
    let text: string | undefined;
    if (event.data) {
      try {
        parsed = event.data.json();
        isJson = true;
      } catch {
        text = event.data.text();
      }
    }

    event.waitUntil((async () => {
      // Opening the config installs its language, for every string shown below.
      await readConfig(runtime);
      const payload = isJson
        ? parsed
        : { title: t(notificationMessages.appName), body: text ?? t(notificationMessages.messagesSynced), data: {} };

      const base: NotificationBase = {
        icon: payload?.icon || "/favicon.png",
        // Single-colour on transparency: the platform keeps only this image's
        // alpha channel, so a full-colour icon renders as a solid blob.
        badge: payload?.badge || "/badge-96.png",
        renotify: true,
      };

      if (payload?.$type === NAPP_PUSH_PAYLOAD_TYPE) {
        // The kill switch before the fetch: a disabled install asks no relay
        // anything on a push's behalf.
        if (await pushDisabled()) {
          await dropOwnSubscription();
          return;
        }
        const normalized = await nappPush(runtime, payload);
        await runPush(normalized.payload, normalized.data, base);
        return;
      }

      await runPush(payload ?? {}, payload?.data ?? {}, base);
    })());
  });

  self.addEventListener("pushsubscriptionchange", (event: Event) => {
    // The browser invalidated or rotated the push subscription (endpoint
    // expiry, push-service key rotation). Until a new subscription is
    // registered with the relay, every push goes to a dead endpoint. Resubscribe
    // with the same server key so a live subscription exists again, then tell
    // open pages to re-register it — the gateway client key that must sign the
    // `create` lives in page storage, out of this worker's reach. With no page
    // open, the page-load sync in useNostrPush re-registers on the next visit.
    const change = event as ExtendableEvent & {
      oldSubscription?: PushSubscription | null;
      newSubscription?: PushSubscription | null;
    };
    const key = change.oldSubscription?.options?.applicationServerKey;
    change.waitUntil(
      (async () => {
        // While the user's kill switch is set, a rotation must not resurrect
        // push: drop whatever the browser minted instead of re-subscribing.
        if (await pushDisabled()) {
          try {
            if (change.newSubscription) await change.newSubscription.unsubscribe();
          } catch {
            // Already dead, or the push service is unreachable — either way no
            // page will re-register it while the flag stands.
          }
          return;
        }
        if (!change.newSubscription && key) {
          try {
            await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            });
          } catch {
            // Permission revoked or push service unreachable — nothing to do.
          }
        }
        const clientList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clientList) {
          client.postMessage({ type: "armada-push-changed" });
        }
      })(),
    );
  });

  self.addEventListener("message", (event) => {
    if (event.data?.type === "armada-clear-badge") {
      event.waitUntil(clearAppBadge());
    }
  });

  self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    const target = notificationTarget(event.notification.data?.url);

    event.waitUntil(Promise.all([
      clearAppBadge(),
      openNotificationTarget(target),
    ]));
  });
}
