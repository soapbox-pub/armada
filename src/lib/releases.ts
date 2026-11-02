/**
 * Reads NIP-82 software releases (kind 30063) and their assets (kind 3063) for
 * `/downloads` and the desktop updater. See `docs/releases.md`.
 */

import type { DownloadOs } from "./downloads";
import { config } from "./env";
import { DEPLOYMENT_RELAYS, normalizeRelayUrl } from "./platform";
import { sanitizeUrl } from "./sanitizeUrl";

export const RELEASE_KIND = 30063;
export const ASSET_KIND = 3063;

/**
 * Relays releases are read from — explicit because `/downloads` works signed
 * out. Discovery only (never pooled or subscribed). A deployment's `RELAYS`
 * replace these; otherwise they must match `publication.relays` in
 * `.ngit/release.yaml`.
 */
export const RELEASE_RELAYS: string[] = DEPLOYMENT_RELAYS.length > 0
  ? DEPLOYMENT_RELAYS
  : ["wss://relay.ditto.pub", "wss://relay.dreamith.to", "wss://relay.primal.net"]
    .map((url: string) => normalizeRelayUrl(url))
    .filter((url: string | undefined): url is string => Boolean(url));

/** The NIP-82 application id (`d` of the 32267, `i` of each release). Overridable for forks. */
export const RELEASE_APP_ID: string = config("RELEASE_APP_ID") || "buzz.armada.app";

/**
 * Trusted release signers (hex). Build-time, so adding a signer goes through
 * code review: these events hand out executables.
 */
export const RELEASE_AUTHORS: string[] = (
  config("RELEASE_AUTHORS") ||
  "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5"
)
  .split(",")
  .map((pubkey: string) => pubkey.trim().toLowerCase())
  .filter((pubkey: string) => /^[0-9a-f]{64}$/.test(pubkey));

/** One build output of a release (a kind-3063 asset). */
export interface ReleaseArtifact {
  id: string;
  /** Blossom URL (the path carries the hash). */
  url: string;
  hash: string;
  mime: string;
  size: number;
  /** NIP-82 platform ids (`f`); an APK names one per ABI. */
  platforms: string[];
  /** `installer` / `portable` for sibling builds of one platform. */
  variant: string | undefined;
  filename: string;
  label: string;
  os: DownloadOs | undefined;
}

/** A kind-30063 release. Its artifacts are separate events, named by {@link assetIds}. */
export interface Release {
  id: string;
  pubkey: string;
  createdAt: number;
  appId: string;
  /** As published: NIP-82 spells it without the tag's `v`. */
  version: string;
  channel: string;
  commit: string | undefined;
  notes: string;
  assetIds: string[];
}

/** A minimal event shape, so this module doesn't depend on a relay library. */
export interface ReleaseEventLike {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

function firstTag(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name && typeof tag[1] === "string")?.[1];
}

/**
 * Which OS card an artifact belongs on. `f` is advisory: unknown ids fall
 * through to the filename; unplaceable artifacts are still listed.
 */
export function artifactOs(platform: string, filename: string): DownloadOs | undefined {
  const f = platform.toLowerCase();
  if (f.startsWith("linux")) return "linux";
  if (f.startsWith("windows") || f.startsWith("win")) return "windows";
  if (f.startsWith("darwin") || f.startsWith("macos") || f.startsWith("mac")) return "macos";
  if (f.startsWith("android")) return "android";
  if (f.startsWith("ios")) return "ios";

  const name = filename.toLowerCase();
  if (/\.(appimage|deb|flatpak|rpm|tar\.gz)$/.test(name)) return "linux";
  if (/\.(exe|msi)$/.test(name)) return "windows";
  if (/\.(dmg|pkg)$/.test(name) || /mac|darwin|osx/.test(name)) return "macos";
  if (/\.(apk|aab)$/.test(name)) return "android";
  if (/\.ipa$/.test(name)) return "ios";
  return undefined;
}

/** A human label; NIP-82 assets carry none, so it is derived from what they do carry. */
export function artifactLabel(filename: string, platforms: readonly string[], variant?: string): string {
  const name = filename.toLowerCase();
  const arch = platforms[0]?.slice(platforms[0].indexOf("-") + 1) ?? "";
  if (name.endsWith(".appimage")) return `Linux AppImage (${arch || "x86_64"})`;
  if (name.endsWith(".deb")) return `Debian / Ubuntu package (${arch || "x86_64"})`;
  if (name.endsWith(".flatpak")) return `Flatpak bundle (${arch || "x86_64"})`;
  if (name.endsWith(".exe")) {
    const portable = variant === "portable" || name.endsWith("-portable.exe");
    return `Windows ${portable ? "portable" : "installer"} (${arch === "x86_64" || !arch ? "x64" : arch})`;
  }
  if (name.endsWith(".apk")) return "Android APK";
  if (platforms.some((f) => f.startsWith("darwin"))) {
    return `macOS (${arch === "x86_64" ? "Intel" : arch === "arm64" || arch === "aarch64" ? "Apple silicon" : arch})`;
  }
  return filename;
}

/** A prerelease by channel or by version: the version guards a release published under the wrong channel. */
export function isStable(release: Pick<Release, "channel" | "version">): boolean {
  return release.channel === "main" && !release.version.includes("-");
}

/** Parse a release, or undefined. Refuses events with no version or no assets. */
export function parseRelease(event: ReleaseEventLike): Release | undefined {
  if (event.kind !== RELEASE_KIND) return undefined;

  // `d` is `<app-id>@<version>`; `i` and `version` win when present.
  const d = firstTag(event.tags, "d") ?? "";
  const at = d.lastIndexOf("@");
  const appId = firstTag(event.tags, "i") ?? (at > 0 ? d.slice(0, at) : "");
  const version = firstTag(event.tags, "version") ?? (at > 0 ? d.slice(at + 1) : "");
  if (!appId || !version) return undefined;

  const assetIds = [...new Set(
    event.tags
      .filter((tag) => tag[0] === "e" && typeof tag[1] === "string" && /^[0-9a-f]{64}$/.test(tag[1]))
      .map((tag) => tag[1]),
  )];
  if (assetIds.length === 0) return undefined;

  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    appId,
    version,
    channel: firstTag(event.tags, "c") || "main",
    commit: firstTag(event.tags, "commit"),
    notes: event.content,
    assetIds,
  };
}

/** Parse an asset, or undefined if it lacks what a download button needs. */
export function parseAsset(event: ReleaseEventLike): ReleaseArtifact | undefined {
  if (event.kind !== ASSET_KIND) return undefined;
  const url = firstTag(event.tags, "url");
  // Rendered as a link and navigated to, so never a `javascript:` or other scheme.
  if (!url || !/^https:\/\//i.test(url) || !sanitizeUrl(url)) return undefined;
  let filename = firstTag(event.tags, "filename");
  if (!filename) {
    try {
      filename = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    } catch { /* ignore */ }
  }
  if (!filename) return undefined;

  const platforms = event.tags.filter((tag) => tag[0] === "f" && typeof tag[1] === "string").map((tag) => tag[1]);
  const variant = firstTag(event.tags, "variant");
  const size = Number(firstTag(event.tags, "size"));
  return {
    id: event.id,
    url,
    hash: (firstTag(event.tags, "x") ?? "").toLowerCase(),
    mime: firstTag(event.tags, "m") ?? "application/octet-stream",
    size: Number.isFinite(size) && size > 0 ? size : 0,
    platforms,
    variant,
    filename,
    label: artifactLabel(filename, platforms, variant),
    os: artifactOs(platforms[0] ?? "", filename),
  };
}

/**
 * The release's artifacts, in its `e` order. Only assets the release names, by
 * the release's own author, count: the `e` tags are what make an asset part of
 * this release, and a relay can serve anything.
 */
export function releaseArtifacts(release: Release, events: readonly ReleaseEventLike[]): ReleaseArtifact[] {
  const byId = new Map<string, ReleaseArtifact>();
  for (const event of events) {
    if (event.pubkey !== release.pubkey || !release.assetIds.includes(event.id)) continue;
    const artifact = parseAsset(event);
    if (artifact) byId.set(event.id, artifact);
  }
  return release.assetIds.flatMap((id) => byId.get(id) ?? []);
}

/** Newest-first numeric comparison (v0.9.0 < v0.55.3); a prerelease loses to the same numbers without one. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, ...rest] = v.replace(/^v/, "").split("-");
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join("-"),
    };
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < len; i++) {
    const diff = (right.parts[i] ?? 0) - (left.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return -1;
  if (!right.pre) return 1;
  return left.pre < right.pre ? 1 : -1;
}

/**
 * The default release: newest STABLE (a prerelease sorts above the previous
 * stable), else newest of any channel.
 */
export function featuredRelease(releases: readonly Release[]): Release | undefined {
  return releases.find(isStable) ?? releases[0];
}

/** Newest first, one per version (newest `created_at` wins, as for any addressable event). */
export function foldReleases(releases: Release[]): Release[] {
  const byVersion = new Map<string, Release>();
  for (const release of releases) {
    const existing = byVersion.get(release.version);
    if (!existing || release.createdAt > existing.createdAt) byVersion.set(release.version, release);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
}
