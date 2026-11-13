import { Capacitor, registerPlugin } from "@capacitor/core";

import { chatRoute, parseChatRoute } from "@/lib/routes";
import { takeSharedFiles } from "@/lib/webShareInbox";

/**
 * Android share-target bridge (ShareTargetPlugin.java) + the in-memory share
 * stash. Direct Share intents carry EXTRA_SHORTCUT_ID = the conversation's
 * in-app route (contract with publishShortcuts / pushConversationShortcut);
 * plain shares and the PWA Web Share Target go through the /share picker.
 * The payload is stashed against a route and consumed by the ChatComposer
 * there. Native shares split peekShare (instant route) from checkShare (slow
 * byte copy) so navigation never waits on a large file.
 */

interface SharedFileMeta {
  name: string;
  type: string;
  size: number;
  /** Absolute path in the app cache; fetchable via Capacitor.convertFileSrc. */
  path: string;
}

interface PeekShareResult {
  pending: boolean;
  shortcutId?: string;
}

interface CheckShareResult extends PeekShareResult {
  text?: string;
  subject?: string;
  files?: SharedFileMeta[];
}

/** One ranked Direct Share suggestion; `id` is the conversation's route. */
export interface ShareShortcutItem {
  id: string;
  label: string;
  iconUrl?: string;
}

/** One row of {@link dumpShareShortcuts}. */
export interface ShareShortcutDump {
  id: string;
  label: string;
  rank: number;
  shareTarget: boolean;
}

interface ShareTargetNativePlugin {
  peekShare(): Promise<PeekShareResult>;
  checkShare(): Promise<CheckShareResult>;
  publishShortcuts(opts: { shortcuts: ShareShortcutItem[] }): Promise<{ published: number }>;
  getMaxShortcuts(): Promise<{ max: number }>;
  dumpShortcuts(): Promise<{ shortcuts: ShareShortcutDump[]; max: number }>;
  clearShortcuts(): Promise<void>;
  addListener(
    eventName: "shareReceived",
    cb: () => void,
  ): Promise<{ remove: () => void }>;
}

export const ShareTarget = registerPlugin<ShareTargetNativePlugin>("ShareTarget");

/** True where ShareTargetPlugin.java exists (Android only, like the service). */
export function hasShareTarget(): boolean {
  return Capacitor.getPlatform() === "android";
}

/**
 * Direct Share suggestions to publish. The per-activity cap varies (often 15,
 * sometimes 5) and publishing past it silently evicts.
 */
export async function maxShareShortcuts(): Promise<number> {
  try {
    const { max } = await ShareTarget.getMaxShortcuts();
    return Number.isFinite(max) && max > 0 ? max : 8;
  } catch {
    return 8;
  }
}

/** Drop every published Direct Share suggestion (on logout; they name the old account's rooms). */
export async function clearShareShortcuts(): Promise<void> {
  if (!hasShareTarget()) return;
  try {
    await ShareTarget.clearShortcuts();
  } catch {
    // best-effort
  }
}

/** The live dynamic shortcut set (whether the sheet displays them isn't observable). */
export async function dumpShareShortcuts(): Promise<{
  shortcuts: ShareShortcutDump[];
  max: number;
}> {
  if (!hasShareTarget()) return { shortcuts: [], max: 0 };
  try {
    return await ShareTarget.dumpShortcuts();
  } catch {
    return { shortcuts: [], max: 0 };
  }
}

export interface SharePayload {
  text: string;
  files: File[];
  /**
   * NIP-92 `imeta` / NIP-30 `emoji` tags from a message forward. Never persisted:
   * an encrypted attachment's imeta holds its decryption key.
   */
  tags?: string[][];
}

/** The in-flight share; `route === null` means no destination picked yet. */
let stash: { payload: SharePayload; route: string | null } | null = null;
const stashListeners = new Set<() => void>();

function emitStashChanged(): void {
  for (const l of [...stashListeners]) l();
}

/** Subscribe to stash changes (SharePage preview, composer pickup). */
export function onShareStashChanged(cb: () => void): () => void {
  stashListeners.add(cb);
  return () => {
    stashListeners.delete(cb);
  };
}

/** Stage a payload, optionally already routed to its destination. */
export function stashShare(payload: SharePayload, route: string | null): void {
  stash = { payload, route };
  emitStashChanged();
}

/** SharePage's pick: routes the pending payload to the chosen conversation. */
export function assignShareRoute(route: string): void {
  if (!stash) return;
  stash = { ...stash, route };
  emitStashChanged();
}

/** The payload still awaiting a destination (what SharePage previews). */
export function pendingSharePreview(): SharePayload | null {
  return stash && stash.route === null ? stash.payload : null;
}

/**
 * Hand the payload to the composer serving `route` — its OWN room path, never
 * `window.location`: several composers can be mounted at once (route
 * transitions, thread panel) and the wrong one would claim the share.
 */
export function consumeShareFor(route: string | undefined): SharePayload | null {
  if (!route || !stash || stash.route === null || stash.route !== route) return null;
  const { payload } = stash;
  stash = null;
  emitStashChanged();
  return payload;
}

/** Drop the pending share (user dismissed the picker). */
export function discardShare(): void {
  if (!stash) return;
  stash = null;
  emitStashChanged();
}

/**
 * The destination a Direct Share shortcut id names, or null. Requires a ROOM
 * (other routes redirect on mount, stranding the payload) and re-emits via
 * `chatRoute`, since old shortcuts may carry hex DM peers. The result is both
 * navigation target and stash key, so they must agree.
 */
export function shortcutShareRoute(path: string): string | null {
  const route = parseChatRoute(path);
  if (!route) return null;
  const hasRoom =
    route.kind === "dm"
      ? !!route.peer
      : route.kind === "nip29"
        ? !!route.groupId
        : !!route.channelId;
  return hasRoom ? chatRoute(route) : null;
}

const webShareClaims = new Map<string, Promise<void>>();

/**
 * Stage the files a Web Share Target POST parked under `inbox` (see
 * `webShareInbox.ts`), with the share's text, awaiting a destination. Once per
 * id: a remount awaits the same claim rather than finding the inbox emptied.
 */
export function claimWebShare(inbox: string, text: string): Promise<void> {
  let claim = webShareClaims.get(inbox);
  if (!claim) {
    claim = (typeof caches === "undefined"
      ? Promise.resolve<File[]>([])
      : takeSharedFiles(inbox, caches).catch(() => [] as File[])
    ).then((files) => {
      if (files.length > 0) stashShare({ text, files }, null);
    });
    webShareClaims.set(inbox, claim);
  }
  return claim;
}

async function sharedFileToFile(meta: SharedFileMeta): Promise<File | null> {
  try {
    const res = await fetch(Capacitor.convertFileSrc(meta.path));
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], meta.name, { type: meta.type || blob.type });
  } catch {
    return null;
  }
}

/**
 * Consume the staged native share into the stash (subject merged first, like
 * the Web Share Target). Returns the route to land on, or null.
 */
export async function resolveNativeShare(): Promise<string | null> {
  const res = await ShareTarget.checkShare();
  if (!res.pending) return null;
  const files = (await Promise.all((res.files ?? []).map(sharedFileToFile))).filter(
    (f): f is File => f !== null,
  );
  const parts: string[] = [];
  if (res.subject && !(res.text ?? "").includes(res.subject)) parts.push(res.subject);
  if (res.text) parts.push(res.text);
  const route = res.shortcutId ? shortcutShareRoute(res.shortcutId) : null;
  stashShare({ text: parts.join("\n"), files }, route);
  return route ?? "/share";
}

// Cold-launch share (mirrors coldLaunchDeepLink): the destination is peeked
// once at module load and HomeRedirect waits for it; the payload resolves in
// the background via the stash.

let coldResolved = !hasShareTarget();
let coldShareRoute: string | null = null;
const coldWaiters = new Set<() => void>();
const lateColdWaiters = new Set<(route: string) => void>();

function settleColdShare(route: string | null): void {
  if (coldResolved) return;
  coldShareRoute = route;
  coldResolved = true;
  for (const w of coldWaiters) w();
  coldWaiters.clear();
}

if (hasShareTarget()) {
  // Guard against a hung bridge; longer than coldLaunchDeepLink's 1.5s since
  // the bridge is busiest on a share cold boot.
  const timeout = setTimeout(() => settleColdShare(null), 3000);
  ShareTarget.peekShare()
    .then((res) => {
      clearTimeout(timeout);
      if (!res.pending) {
        settleColdShare(null);
        return;
      }
      const route = (res.shortcutId && shortcutShareRoute(res.shortcutId)) || "/share";
      if (!coldResolved) {
        settleColdShare(route);
      } else {
        // Guard already fired: hand the route to late listeners so the payload isn't orphaned.
        for (const w of lateColdWaiters) w(route);
      }
      void resolveNativeShare().catch(() => undefined);
    })
    .catch(() => {
      clearTimeout(timeout);
      settleColdShare(null);
    });
}

/** True until the launch intent has been peeked — HomeRedirect holds. */
export function coldSharePending(): boolean {
  return !coldResolved;
}

/** The cold-launch share destination (consumed once), or null. */
export function consumeColdShareRoute(): string | null {
  const r = coldShareRoute;
  coldShareRoute = null;
  return r;
}

/** Run `cb` once the launch intent is peeked (immediately if already). */
export function onColdShareResolved(cb: () => void): () => void {
  if (coldResolved) {
    cb();
    return () => undefined;
  }
  coldWaiters.add(cb);
  return () => {
    coldWaiters.delete(cb);
  };
}

/**
 * Run `cb` if the peek resolves to a share AFTER the guard released
 * HomeRedirect (mirrors onLateColdLaunchDeepLink).
 */
export function onLateColdShareRoute(cb: (route: string) => void): () => void {
  lateColdWaiters.add(cb);
  return () => {
    lateColdWaiters.delete(cb);
  };
}
