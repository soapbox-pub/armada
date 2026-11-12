/**
 * The desktop shell's update feed: the NIP-82 release and asset events (the
 * same ones `/downloads` reads), narrowed to the installer this machine can
 * install — content-addressed and signed by a pinned maintainer key. Also
 * resolves the web app the shell serves from Armada's signed nsite manifest
 * ({@link resolveWebSite}, {@link parseWebSite}).
 *
 * Bundled into `electron/updateFeed.cjs` (like `electronMain.ts`) so
 * `parseRelease()`/`parseAsset()` stay the single read contract. Keep it free
 * of Electron imports; the electron-updater half is `electron/nostrUpdateProvider.js`.
 */

import { verifyEvent } from "nostr-tools/pure";

import { APP_BLOSSOM_SERVERS } from "./blossom";
import {
  ASSET_KIND,
  RELEASE_APP_ID,
  RELEASE_AUTHORS,
  RELEASE_KIND,
  RELEASE_RELAYS,
  foldReleases,
  isStable,
  parseRelease,
  releaseArtifacts,
  type Release,
  type ReleaseArtifact,
} from "./releases";

// Re-exported so the bundled `electron/updateFeed.cjs` shares the version comparison.
export { compareVersions } from "./releases";

const RELAY_TIMEOUT_MS = 12_000;

/**
 * Releases asked of each relay: a relay's newest N can be a run of
 * prereleases, and a stable build must still find a stable one in it.
 */
const RELEASE_QUERY_LIMIT = 50;

/**
 * Releases whose assets are fetched before giving up: the newest can lack this
 * platform (a failed build), but a run of them means there is nothing to offer.
 */
const ASSET_LOOKUPS = 5;

/**
 * Which installer each platform self-updates from; matches
 * `supportsSelfUpdate()` in `electron/updateSupport.js`. Package-manager and
 * portable builds must never go to electron-updater; `-portable.exe` shares the
 * NSIS installer's platform id and mime, so `variant` (or the filename) is the only tell.
 *
 * `flatpak` is a SYNTHETIC target (passed when `FLATPAK_ID` is set), kept out
 * of `linux` so electron-updater never gets it: `/app` is read-only and the
 * shell updates its web app from the site instead (`electron/webSite.js`).
 */
const DESKTOP_FORMATS: Record<string, { os: string; accepts: (filename: string, variant?: string) => boolean }> = {
  linux: { os: "linux", accepts: (name) => /\.appimage$/i.test(name) },
  win32: {
    os: "windows",
    accepts: (name, variant) =>
      /\.exe$/i.test(name) && !/-portable\.exe$/i.test(name) && variant !== "portable",
  },
  darwin: { os: "macos", accepts: (name) => /\.zip$/i.test(name) },
  flatpak: { os: "linux", accepts: (name) => /\.flatpak$/i.test(name) },
};

/**
 * Architecture spellings for the same machine. The `f` ids are only used to
 * REJECT an artifact naming another arch, never to require one.
 */
const ARCH_ALIASES: Record<string, readonly string[]> = {
  x64: ["x86_64", "x64", "amd64"],
  arm64: ["aarch64", "arm64"],
  arm: ["armv7l", "armhf", "arm"],
  ia32: ["i686", "i386", "x86", "ia32"],
};

export interface DesktopTarget {
  platform: string;
  arch: string;
}

export interface DesktopUpdate {
  /** Semver with no leading `v`, which is what electron-updater compares. */
  version: string;
  tag: string;
  releaseName: string;
  releaseNotes: string;
  /** ISO 8601, from the event's `created_at`. */
  releaseDate: string;
  channel: string;
  file: {
    /** Absolute URL to fetch (see {@link downloadUrl}). */
    url: string;
    filename: string;
    /** Hex Blossom content address; the download is verified against it. */
    sha256: string;
    size: number;
  };
}

export interface ResolveDesktopUpdateOptions {
  target: DesktopTarget;
  /** Whether a release candidate is an acceptable update. */
  allowPrerelease?: boolean;
  relays?: readonly string[];
  authors?: readonly string[];
  appId?: string;
  /** Injectable for tests; defaults to the runtime's global. */
  webSocket?: typeof WebSocket;
  signal?: AbortSignal;
}

/**
 * The download URL with a Blossom URL's extension dropped (BUD-01 serves
 * `/<sha256>`). Otherwise electron-updater names the cached — and on Linux,
 * INSTALLED — AppImage after the hash. Non-Blossom URLs pass through.
 */
export function downloadUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const match = /^\/([0-9a-f]{64})\.[A-Za-z0-9]+$/.exec(parsed.pathname);
    if (!match) return url;
    parsed.pathname = `/${match[1]}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Whether an artifact's `f` ids rule it out for this architecture: only if every one names another. */
function archMatches(platforms: readonly string[], arch: string): boolean {
  const accepted = ARCH_ALIASES[arch];
  // Unknown arch isn't evidence either way; the format check still applies.
  if (accepted == null || platforms.length === 0) return true;
  return platforms.some((platform) => {
    const dash = platform.indexOf("-");
    const named = dash < 0 ? "" : platform.slice(dash + 1).toLowerCase();
    return !named || accepted.includes(named);
  });
}

/**
 * The artifact this machine self-updates from, if any (undefined is normal).
 * Artifacts without a hash are skipped: here it's the ONLY verification, so an
 * unverifiable installer is never offered.
 */
export function pickDesktopArtifact(
  artifacts: readonly ReleaseArtifact[],
  target: DesktopTarget,
): ReleaseArtifact | undefined {
  const format = DESKTOP_FORMATS[target.platform];
  if (!format) return undefined;
  return artifacts.find(
    (artifact) =>
      artifact.os === format.os &&
      format.accepts(artifact.filename, artifact.variant) &&
      archMatches(artifact.platforms, target.arch) &&
      /^[0-9a-f]{64}$/.test(artifact.hash),
  );
}

function semver(version: string): string {
  return version.replace(/^v/i, "");
}

export function toDesktopUpdate(
  release: Release,
  artifact: ReleaseArtifact,
): DesktopUpdate {
  const version = semver(release.version);
  return {
    version,
    tag: `v${version}`,
    releaseName: `v${version}`,
    releaseNotes: release.notes,
    releaseDate: new Date(release.createdAt * 1000).toISOString(),
    channel: release.channel,
    file: {
      url: downloadUrl(artifact.url),
      filename: artifact.filename,
      sha256: artifact.hash,
      size: artifact.size,
    },
  };
}

/**
 * The trusted releases among untrusted relay responses, newest first. Each
 * check blocks a malicious relay: the signature must verify, the author must be
 * a BUILD-PINNED release key, and `i` must be this application (not another one
 * by the same maintainer).
 */
export function trustedReleases(
  events: readonly unknown[],
  {
    allowPrerelease = false,
    authors = RELEASE_AUTHORS,
    appId = RELEASE_APP_ID,
  }: { allowPrerelease?: boolean; authors?: readonly string[]; appId?: string } = {},
): Release[] {
  const trusted = new Set(authors.map((author) => author.toLowerCase()));
  const releases: Release[] = [];
  for (const event of events) {
    if (!isSignedEvent(event) || event.kind !== RELEASE_KIND) continue;
    if (!trusted.has(event.pubkey.toLowerCase())) continue;
    if (!verifyEvent(event)) continue;
    const release = parseRelease(event);
    if (!release || release.appId !== appId) continue;
    releases.push(release);
  }
  const folded = foldReleases(releases);
  // Stable builds take the newest stable release (as `/downloads` does).
  return allowPrerelease ? folded : folded.filter(isStable);
}

/**
 * The update a trusted release offers this machine, from untrusted asset
 * events. An asset counts only if its signature verifies and the release names
 * its id: the id is what binds the asset's bytes to the signed release.
 */
export function selectDesktopArtifact(
  release: Release,
  events: readonly unknown[],
  target: DesktopTarget,
): DesktopUpdate | undefined {
  const assets = events.filter(
    (event): event is SignedEvent =>
      isSignedEvent(event) &&
      event.kind === ASSET_KIND &&
      release.assetIds.includes(event.id) &&
      verifyEvent(event),
  );
  const artifact = pickDesktopArtifact(releaseArtifacts(release, assets), target);
  return artifact ? toDesktopUpdate(release, artifact) : undefined;
}

/** {@link trustedReleases} then {@link selectDesktopArtifact}, over one pile of events. */
export function selectDesktopRelease(
  events: readonly unknown[],
  options: {
    target: DesktopTarget;
    allowPrerelease?: boolean;
    authors?: readonly string[];
    appId?: string;
  },
): DesktopUpdate | undefined {
  for (const release of trustedReleases(events, options)) {
    // Skip releases lacking this platform (e.g. a failed Windows build).
    const update = selectDesktopArtifact(release, events, options.target);
    if (update) return update;
  }
  return undefined;
}

interface SignedEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
}

function isSignedEvent(value: unknown): value is SignedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.kind === "number" &&
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.content === "string" &&
    typeof event.created_at === "number" &&
    Array.isArray(event.tags)
  );
}

/**
 * Read one relay's release history. Never rejects: a bad relay contributes
 * nothing so the others can still answer.
 */
function queryRelay(
  url: string,
  filters: readonly unknown[],
  WebSocketImpl: typeof WebSocket,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(url);
    } catch {
      resolve([]);
      return;
    }

    const subscriptionId = `armada-update-${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      try {
        socket.close();
      } catch { /* ignore */ }
      resolve(events);
    };

    const timer = setTimeout(finish, RELAY_TIMEOUT_MS);
    // Never keep the app from quitting.
    (timer as unknown as { unref?: () => void }).unref?.();
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish);

    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify(["REQ", subscriptionId, ...filters]));
      } catch {
        finish();
      }
    });
    socket.addEventListener("message", (message: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof message.data === "string" ? message.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[1] !== subscriptionId) return;
      if (parsed[0] === "EVENT") events.push(parsed[2]);
      // CLOSED too: a refusing relay (AUTH, rate limit) never sends EOSE.
      else if (parsed[0] === "EOSE" || parsed[0] === "CLOSED") finish();
    });
    socket.addEventListener("error", finish);
    socket.addEventListener("close", finish);
  });
}

/** NIP-5A named site manifest. */
const NSITE_KIND = 35128;

/** BUD-03 user server list. */
const BLOSSOM_SERVER_LIST_KIND = 10063;

/** The named site `.nsite/config.json` publishes: every push to main. */
export const WEB_SITE_ID = "armada";
/** The named site deploy-nsite.yml also publishes on a stable release commit only. */
export const WEB_RELEASE_SITE_ID = "armada-stable";
/** Every site id a stored manifest may carry; each is signed by the same pinned authors. */
export const WEB_SITE_IDS: readonly string[] = [WEB_SITE_ID, WEB_RELEASE_SITE_ID];

/**
 * Which deploys the shell follows (electron/webUpdateChannel.js): every push to
 * main, stable releases only, or none — keeping the web app it has.
 */
export type WebUpdateChannel = "latest" | "release" | "off";

/** The site a channel follows (the shell never asks for "off"). */
export function webSiteIdFor(channel: WebUpdateChannel): string {
  return channel === "release" ? WEB_RELEASE_SITE_ID : WEB_SITE_ID;
}

/** A signed site manifest the desktop shell can serve app://armada from. */
export interface WebSite {
  /** The manifest event itself, stored as-is and re-verified at every launch. */
  event: SignedEvent;
  id: string;
  /** Its `d` tag: which track it was published to ({@link WEB_SITE_IDS}). */
  siteId: string;
  createdAt: number;
  /** Absolute site path → sha256, from the `path` tags. */
  files: Map<string, string>;
  /** https Blossom origins to fetch blobs from, in order. */
  servers: string[];
}

function httpsOrigins(urls: readonly unknown[]): string[] {
  const origins: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch { /* ignore */ }
  }
  return origins;
}

function httpsServers(tags: readonly string[][]): string[] {
  return httpsOrigins(tags.filter((tag) => tag[0] === "server").map((tag) => tag[1]));
}

/**
 * One site manifest, if it is acceptable: a verified kind 35128 for `siteId`
 * from a BUILD-PINNED author. Everything the shell serves is read from this
 * event, so it is the whole trust decision — the shell runs it again on the
 * stored copy at every launch, not only when it was downloaded.
 */
export function parseWebSite(
  value: unknown,
  {
    authors = RELEASE_AUTHORS,
    siteId,
  }: { authors?: readonly string[]; siteId?: string } = {},
): WebSite | undefined {
  if (!isSignedEvent(value) || value.kind !== NSITE_KIND) return undefined;
  if (!value.tags.every((tag) => Array.isArray(tag))) return undefined;
  if (!authors.some((author) => author.toLowerCase() === value.pubkey.toLowerCase())) return undefined;
  // Without a `siteId`, any of the shell's tracks (a stored site re-verified at launch).
  const d = value.tags.find((tag) => tag[0] === "d")?.[1];
  if (typeof d !== "string" || (siteId !== undefined ? d !== siteId : !WEB_SITE_IDS.includes(d))) return undefined;
  if (!verifyEvent(value)) return undefined;

  const files = new Map<string, string>();
  for (const [name, sitePath, hash] of value.tags) {
    if (name !== "path" || typeof sitePath !== "string" || !sitePath.startsWith("/")) continue;
    const sha256 = typeof hash === "string" ? hash.toLowerCase() : "";
    if (/^[0-9a-f]{64}$/.test(sha256) && !files.has(sitePath)) files.set(sitePath, sha256);
  }
  return {
    event: value,
    id: value.id,
    siteId: d,
    createdAt: value.created_at,
    files,
    servers: httpsServers(value.tags),
  };
}

/**
 * The newest acceptable site manifest. Only a candidate newer than the best so
 * far is verified, and a forgery is skipped rather than ending the search, so
 * a newer forged manifest cannot hide a valid one.
 */
export function selectWebSite(
  events: readonly unknown[],
  options: { authors?: readonly string[]; siteId?: string } = {},
): WebSite | undefined {
  let newest: WebSite | undefined;
  for (const event of events) {
    if (!isSignedEvent(event) || event.kind !== NSITE_KIND) continue;
    if (newest && event.created_at <= newest.createdAt) continue;
    newest = parseWebSite(event, options) ?? newest;
  }
  return newest;
}

/** The `server` tags of the newest verified kind 10063 by `pubkey`. */
function serverListOf(events: readonly unknown[], pubkey: string): string[] {
  let newest: SignedEvent | undefined;
  for (const event of events) {
    if (!isSignedEvent(event) || event.kind !== BLOSSOM_SERVER_LIST_KIND) continue;
    if (event.pubkey.toLowerCase() !== pubkey.toLowerCase()) continue;
    if (!event.tags.every((tag) => Array.isArray(tag))) continue;
    if (newest && event.created_at <= newest.created_at) continue;
    if (verifyEvent(event)) newest = event;
  }
  return newest ? httpsServers(newest.tags) : [];
}

/**
 * The deployed site from the release relays, undefined if none is acceptable.
 * Its servers are the manifest's, then its author's kind 10063, then the app's
 * own Blossom servers: every blob is hash-checked, so a server is only ever a
 * source, never a trust decision.
 */
export async function resolveWebSite({
  relays = RELEASE_RELAYS,
  authors = RELEASE_AUTHORS,
  siteId = WEB_SITE_ID,
  fallbackServers = APP_BLOSSOM_SERVERS,
  webSocket,
  signal,
}: {
  relays?: readonly string[];
  authors?: readonly string[];
  siteId?: string;
  fallbackServers?: readonly string[];
  webSocket?: typeof WebSocket;
  signal?: AbortSignal;
} = {}): Promise<WebSite | undefined> {
  const WebSocketImpl =
    webSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketImpl) {
    throw new Error("no WebSocket implementation available for the site check");
  }
  if (relays.length === 0) throw new Error("no site relays configured");
  if (authors.length === 0) throw new Error("no release authors configured");

  const filters = [
    { kinds: [NSITE_KIND], authors: [...authors], "#d": [siteId] },
    { kinds: [BLOSSOM_SERVER_LIST_KIND], authors: [...authors] },
  ];
  const responses = await Promise.all(
    relays.map((relay) => queryRelay(relay, filters, WebSocketImpl, signal)),
  );
  const events = responses.flat();
  const site = selectWebSite(events, { authors, siteId });
  if (!site) return undefined;
  const servers = httpsOrigins([
    ...site.servers,
    ...serverListOf(events, site.event.pubkey),
    ...fallbackServers,
  ]);
  return { ...site, servers };
}

/**
 * The newest installable release for this machine, or undefined if none has an
 * artifact for it. Whether it is newer than the running build is
 * electron-updater's call. Called only from `electron/nostrUpdateProvider.js`.
 */
export async function resolveDesktopUpdate({
  target,
  allowPrerelease = false,
  relays = RELEASE_RELAYS,
  authors = RELEASE_AUTHORS,
  appId = RELEASE_APP_ID,
  webSocket,
  signal,
}: ResolveDesktopUpdateOptions): Promise<DesktopUpdate | undefined> {
  const WebSocketImpl =
    webSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketImpl) {
    throw new Error("no WebSocket implementation available for the update check");
  }
  if (relays.length === 0) throw new Error("no release relays configured");
  if (authors.length === 0) throw new Error("no release authors configured");

  const query = async (filter: unknown) =>
    (await Promise.all(relays.map((relay) => queryRelay(relay, [filter], WebSocketImpl, signal)))).flat();

  const releases = trustedReleases(
    await query({
      kinds: [RELEASE_KIND],
      authors: [...authors],
      "#i": [appId],
      limit: RELEASE_QUERY_LIMIT,
    }),
    { allowPrerelease, authors, appId },
  );
  for (const release of releases.slice(0, ASSET_LOOKUPS)) {
    if (signal?.aborted) break;
    const assets = await query({ kinds: [ASSET_KIND], authors: [release.pubkey], ids: release.assetIds });
    const update = selectDesktopArtifact(release, assets, target);
    if (update) return update;
  }
  return undefined;
}
