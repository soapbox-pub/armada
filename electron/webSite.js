"use strict";

/**
 * The web app app://armada serves, loaded from Armada's own nsite (NIP-5A).
 *
 * Every web deploy signs a kind-35128 manifest naming each file by sha256. The
 * shell keeps the newest acceptable one (`current.json`, the event verbatim)
 * and the blobs it names (`blobs/<sha256>`, content addressed, so a file that
 * did not change between deploys is never downloaded twice). The asar's
 * shipped `dist` stays the floor: a fresh install serves it, and so does any
 * launch where the stored site does not check out.
 *
 * The stored copy is a file in userData, and whatever it names becomes the
 * app://armada origin with the whole preload bridge — so nothing here trusts
 * it for having been checked when it was downloaded. Each launch re-verifies
 * the event (`parse`: signature under the build-pinned key), and each file's
 * bytes are hashed against the manifest every time they are served.
 *
 * Deliberately Electron-free so it runs on the Linux CI runner.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CURRENT = "current.json";
const BLOBS = "blobs";
const SHA256 = /^[0-9a-f]{64}$/;
/** Published with the site but never served by the shell (main.js fetches dictionaries from the web). */
const SKIPPED_PREFIXES = ["/downloads/", "/dictionaries/"];
const DESKTOP_MANIFEST = "/desktop.json";
const CHANGELOG = "/CHANGELOG.md";
const INDEX = "/index.html";
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_CONCURRENCY = 6;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function blobPath(dir, hash) {
  if (!SHA256.test(hash)) throw new Error(`not a sha256: ${hash}`);
  return path.join(dir, BLOBS, hash);
}

/** The site's files the shell serves, path → sha256. */
function servedFiles(site) {
  const files = new Map();
  for (const [sitePath, hash] of site.files) {
    if (SKIPPED_PREFIXES.some((prefix) => sitePath.startsWith(prefix))) continue;
    files.set(sitePath, hash);
  }
  return files;
}

/** A stored blob's bytes if they still hash to its name, else null. */
function readBlob(dir, hash) {
  try {
    const bytes = fs.readFileSync(blobPath(dir, hash));
    return sha256(bytes) === hash ? bytes : null;
  } catch {
    return null;
  }
}

/** `{ api, builtAt }` from a `desktop.json` (see vite.config.ts), or null. */
function parseDesktopManifest(bytes) {
  if (!bytes) return null;
  try {
    const { api, builtAt } = JSON.parse(bytes.toString("utf8"));
    if (!Number.isSafeInteger(api) || api < 1) return null;
    return { api, builtAt: Number.isSafeInteger(builtAt) ? builtAt : 0 };
  } catch {
    return null;
  }
}

/** The shell's own `desktop.json`, shipped in the asar beside its bundle. */
function readShippedDesktopManifest(shippedDist) {
  try {
    return parseDesktopManifest(fs.readFileSync(path.join(shippedDist, "desktop.json")));
  } catch {
    return null;
  }
}

/** The first `## [x.y.z]` of a CHANGELOG, as the web build's getVersion() reads it. */
function changelogVersion(bytes) {
  const match = bytes ? /^## \[([^\]]+)\]/m.exec(bytes.toString("utf8")) : null;
  return match ? match[1] : null;
}

/** `major*1e6 + minor*1e3 + patch`, the scheme the mobile builds use; null when unparseable. */
function versionOrdinal(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
}

/** The stored manifest, re-verified by `parse`; null when absent or unacceptable. */
function loadCurrent(dir, parse) {
  try {
    return parse(JSON.parse(fs.readFileSync(path.join(dir, CURRENT), "utf8"))) ?? null;
  } catch {
    return null;
  }
}

/**
 * The site to serve this launch, or null for the shipped bundle.
 *
 * `floor` is the shell's own build time: a manifest no newer than the bundle
 * the shell shipped with can only be older content, so it is never served —
 * which also covers a shell that was upgraded since the site was stored.
 * `shellApi` refuses a site built for a newer shell than this one.
 */
function loadSite({ dir, parse, shellApi, floor = 0 }) {
  const site = loadCurrent(dir, parse);
  if (!site || site.createdAt <= floor) return null;
  const files = servedFiles(site);
  if (!files.has(INDEX)) return null;
  for (const hash of new Set(files.values())) {
    try {
      if (!fs.statSync(blobPath(dir, hash)).isFile()) return null;
    } catch {
      return null;
    }
  }
  const desktop = parseDesktopManifest(files.has(DESKTOP_MANIFEST) ? readBlob(dir, files.get(DESKTOP_MANIFEST)) : null);
  if (!desktop || desktop.api > shellApi) return null;
  return { ...site, files };
}

/**
 * The site path a request is answered with: the file itself, else index.html
 * for the SPA router (a client route, or a route whose last segment merely
 * looks like a file because a relay URL in it has a dot).
 */
function resolveSitePath(site, pathname) {
  if (pathname === "/" || pathname === "") return INDEX;
  return site.files.has(pathname) ? pathname : INDEX;
}

async function fetchBlob(servers, hash, fetchImpl) {
  let lastError = new Error("no Blossom server for the site");
  for (const server of servers) {
    try {
      const url = new URL(`/${hash}`, server);
      if (url.protocol !== "https:") throw new Error(`refusing non-https server ${server}`);
      const response = await fetchImpl(url.href, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.href}`);
      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) throw new Error(`blob too large at ${url.href}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BLOB_BYTES) throw new Error(`blob too large at ${url.href}`);
      if (sha256(bytes) !== hash) throw new Error(`hash mismatch from ${url.href}`);
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** A blob's bytes, from disk when already stored intact, else downloaded and stored. */
async function ensureBlob(dir, servers, hash, fetchImpl) {
  const stored = readBlob(dir, hash);
  if (stored) return stored;
  const bytes = await fetchBlob(servers, hash, fetchImpl);
  const target = blobPath(dir, hash);
  const temp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, target);
  return bytes;
}

async function eachLimited(items, limit, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) await task(queue.shift());
  });
  await Promise.all(workers);
}

/** Remove every blob (and leftover temp file) no site in `keep` names. */
function pruneBlobs(dir, keep) {
  const wanted = new Set();
  for (const site of keep) {
    if (site) for (const hash of servedFiles(site).values()) wanted.add(hash);
  }
  let names;
  try {
    names = fs.readdirSync(path.join(dir, BLOBS));
  } catch {
    return;
  }
  for (const name of names) {
    if (!wanted.has(name)) fs.rmSync(path.join(dir, BLOBS, name), { force: true });
  }
}

/**
 * Download everything `site` names and make it the stored site. Resolves
 * `{ result }`:
 *
 * - `"installed"`: the next launch serves `site` (`id` names it).
 * - `"unchanged"`: nothing newer that this shell should serve.
 * - `"incompatible"`: the site needs a newer shell (its `desktop.json` level
 *   is above `shellApi`); nothing else was downloaded.
 *
 * `site` must come from `resolveWebSite` (verified under the pinned key). A
 * manifest older than the stored one is refused, so a relay serving a stale
 * copy of the replaceable event cannot roll the app back, and so is one whose
 * CHANGELOG version is older than the shell's. The manifest is written only
 * after every blob is in place, so an interrupted update leaves the previous
 * site intact. `active` is the site this run is serving; its blobs survive
 * the prune until the restart.
 */
async function stageSite({ dir, site, active, parse, shellApi, shellVersion, floor = 0, fetchImpl = fetch }) {
  const current = loadCurrent(dir, parse);
  if (current && site.createdAt < current.createdAt) return { result: "unchanged" };
  if (site.createdAt <= floor) return { result: "unchanged" };
  const files = servedFiles(site);
  if (!files.has(INDEX) || !files.has(DESKTOP_MANIFEST)) return { result: "unchanged" };

  fs.mkdirSync(path.join(dir, BLOBS), { recursive: true });
  const servers = site.servers;
  const desktop = parseDesktopManifest(await ensureBlob(dir, servers, files.get(DESKTOP_MANIFEST), fetchImpl));
  if (!desktop) return { result: "unchanged" };
  if (desktop.api > shellApi) return { result: "incompatible", id: site.id };

  if (files.has(CHANGELOG)) {
    const siteVersion = versionOrdinal(changelogVersion(await ensureBlob(dir, servers, files.get(CHANGELOG), fetchImpl)));
    const shell = versionOrdinal(shellVersion);
    if (siteVersion !== null && shell !== null && siteVersion < shell) return { result: "unchanged" };
  }

  await eachLimited(new Set(files.values()), FETCH_CONCURRENCY, (hash) => ensureBlob(dir, servers, hash, fetchImpl));

  if (current?.id !== site.id) {
    const target = path.join(dir, CURRENT);
    const temp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(site.event));
    fs.renameSync(temp, target);
  }
  pruneBlobs(dir, [site, active]);
  return site.id === active?.id ? { result: "unchanged" } : { result: "installed", id: site.id };
}

module.exports = {
  DESKTOP_MANIFEST,
  loadCurrent,
  loadSite,
  parseDesktopManifest,
  pruneBlobs,
  readBlob,
  readShippedDesktopManifest,
  resolveSitePath,
  servedFiles,
  stageSite,
};
