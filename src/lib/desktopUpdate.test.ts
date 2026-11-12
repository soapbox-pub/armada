import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";

import {
  downloadUrl,
  pickDesktopArtifact,
  selectDesktopArtifact,
  selectDesktopRelease,
  parseWebSite,
  resolveWebSite,
  selectWebSite,
  toDesktopUpdate,
  trustedReleases,
} from "./desktopUpdate";
import { parseAsset, parseRelease, type ReleaseArtifact } from "./releases";

const HASH = "a".repeat(64);

/** The event shape as it comes off a relay socket. */
interface WireEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
}

function sign(secretKey: Uint8Array, template: { kind: number; created_at: number; content: string; tags: string[][] }): WireEvent {
  // Round-trip through JSON, which is what a relay socket delivers — and not
  // only for fidelity. `finalizeEvent` marks the event verified on a symbol
  // property that `verifyEvent` then trusts without re-checking, and an object
  // spread would COPY that symbol onto a tampered event. A fixture built that
  // way asserts nothing about the signature. JSON cannot carry a symbol, so
  // every check below runs the real verification.
  return JSON.parse(JSON.stringify(finalizeEvent(template, secretKey))) as WireEvent;
}

type AssetSpec = { filename: string; f: string[]; m?: string; x?: string; variant?: string };

/** The asset set CI publishes for a complete release, in release.yaml order. */
function allAssets(version: string): AssetSpec[] {
  return [
    { filename: `Armada-v${version}.apk`, f: ["android-arm64-v8a", "android-armeabi-v7a"], m: "application/vnd.android.package-archive" },
    { filename: `Armada-v${version}.AppImage`, f: ["linux-x86_64"], m: "application/vnd.appimage" },
    { filename: `Armada-v${version}.deb`, f: ["linux-x86_64"], m: "application/vnd.debian.binary-package" },
    { filename: `Armada-v${version}.flatpak`, f: ["linux-x86_64"], m: "application/vnd.flatpak" },
    { filename: `Armada-v${version}.exe`, f: ["windows-x86_64"], variant: "installer" },
    { filename: `Armada-v${version}-portable.exe`, f: ["windows-x86_64"], variant: "portable" },
    { filename: `Armada-v${version}-mac-x64.zip`, f: ["darwin-x86_64"], m: "application/zip" },
    { filename: `Armada-v${version}-mac-arm64.zip`, f: ["darwin-arm64"], m: "application/zip" },
  ];
}

function assetEvent(secretKey: Uint8Array, version: string, spec: AssetSpec, createdAt: number): WireEvent {
  const x = spec.x ?? HASH;
  return sign(secretKey, {
    kind: 3063,
    created_at: createdAt,
    content: "",
    tags: [
      ["i", "buzz.armada.app"],
      ["m", spec.m ?? "application/octet-stream"],
      ...(x ? [["x", x]] : []),
      ["version", version],
      ["url", `https://blossom.example/${x || "none"}`],
      ["filename", spec.filename],
      ["size", "1024"],
      ...spec.f.map((f) => ["f", f]),
      ...(spec.variant ? [["variant", spec.variant]] : []),
    ],
  });
}

/** A release and its assets, as `ngit release publish` emits them. */
function published(
  secretKey: Uint8Array,
  {
    version,
    channel = "main",
    appId = "buzz.armada.app",
    createdAt = 1_700_000_000,
    assets = allAssets(version),
  }: { version: string; channel?: string; appId?: string; createdAt?: number; assets?: AssetSpec[] },
): WireEvent[] {
  const assetEvents = assets.map((spec) => assetEvent(secretKey, version, spec, createdAt));
  const release = sign(secretKey, {
    kind: 30063,
    created_at: createdAt,
    content: `notes for ${version}`,
    tags: [
      ["i", appId],
      ["version", version],
      ["d", `${appId}@${version}`],
      ["c", channel],
      ...assetEvents.map((asset) => ["e", asset.id]),
    ],
  });
  return [release, ...assetEvents];
}

function artifactsOf(version: string): ReleaseArtifact[] {
  return published(generateSecretKey(), { version }).slice(1).map((event) => parseAsset(event)!);
}

describe("downloadUrl", () => {
  it("drops the extension from a Blossom URL so the installer keeps its name", () => {
    expect(downloadUrl(`https://blossom.example/${HASH}.AppImage`)).toBe(
      `https://blossom.example/${HASH}`,
    );
    expect(downloadUrl(`https://blossom.example/${HASH}.exe`)).toBe(
      `https://blossom.example/${HASH}`,
    );
  });

  it("leaves anything that is not a bare content address alone", () => {
    // A release published somewhere other than Blossom still has to resolve.
    expect(downloadUrl("https://files.example/downloads/Armada.AppImage")).toBe(
      "https://files.example/downloads/Armada.AppImage",
    );
    expect(downloadUrl(`https://blossom.example/${HASH}`)).toBe(
      `https://blossom.example/${HASH}`,
    );
    expect(downloadUrl("not a url")).toBe("not a url");
  });
});

describe("pickDesktopArtifact", () => {
  const artifacts = artifactsOf("1.2.3");

  it("takes the AppImage on Linux, never the deb or Flatpak", () => {
    // Those two belong to apt and to the Flatpak remote; electron-updater must
    // not replace files behind a package manager.
    expect(pickDesktopArtifact(artifacts, { platform: "linux", arch: "x64" })?.filename)
      .toBe("Armada-v1.2.3.AppImage");
  });

  it("takes the .flatpak bundle for a Flatpak install, never the AppImage", () => {
    // The synthetic `flatpak` platform resolves the .flatpak the `linux` row
    // deliberately refuses. Same release, different artifact.
    expect(pickDesktopArtifact(artifacts, { platform: "flatpak", arch: "x64" })?.filename)
      .toBe("Armada-v1.2.3.flatpak");
  });

  it("refuses a .flatpak that names a different architecture", () => {
    // The bundle is per-arch, so an x86_64 bundle must not be offered to an
    // arm64 machine even though the extension matches.
    expect(pickDesktopArtifact(artifacts, { platform: "flatpak", arch: "arm64" })).toBeUndefined();
  });

  it("takes the NSIS installer on Windows, never the portable build", () => {
    expect(pickDesktopArtifact(artifacts, { platform: "win32", arch: "x64" })?.filename)
      .toBe("Armada-v1.2.3.exe");
  });

  it("refuses an exe whose variant says portable, whatever it is called", () => {
    const [portable] = artifactsOf("1.2.3").filter((a) => a.variant === "portable");
    const renamed = { ...portable, filename: "Armada-v1.2.3.exe" };
    expect(pickDesktopArtifact([renamed], { platform: "win32", arch: "x64" })).toBeUndefined();
  });

  it("takes the zip matching the mac architecture", () => {
    expect(pickDesktopArtifact(artifacts, { platform: "darwin", arch: "arm64" })?.filename)
      .toBe("Armada-v1.2.3-mac-arm64.zip");
    expect(pickDesktopArtifact(artifacts, { platform: "darwin", arch: "x64" })?.filename)
      .toBe("Armada-v1.2.3-mac-x64.zip");
  });

  it("refuses an artifact that names a different architecture", () => {
    // No arm64 AppImage is built. Matching on the extension alone would hand
    // an x86_64 binary to an arm64 machine.
    expect(pickDesktopArtifact(artifacts, { platform: "linux", arch: "arm64" })).toBeUndefined();
  });

  it("has nothing to offer a platform that does not self-update", () => {
    expect(pickDesktopArtifact(artifacts, { platform: "android", arch: "arm64" })).toBeUndefined();
  });

  it("refuses an artifact with no checksum", () => {
    // `x` is the only thing the downloaded bytes get checked against, so an
    // artifact without one is not installable however well it matches.
    const unverifiable = { ...artifacts.find((a) => a.filename.endsWith(".AppImage"))!, hash: "" };
    expect(pickDesktopArtifact([unverifiable], { platform: "linux", arch: "x64" })).toBeUndefined();
  });

  it("accepts an artifact that names no architecture", () => {
    const vague = { ...artifacts.find((a) => a.filename.endsWith(".AppImage"))!, platforms: ["linux"] };
    expect(pickDesktopArtifact([vague], { platform: "linux", arch: "x64" })?.filename)
      .toBe("Armada-v1.2.3.AppImage");
  });
});

describe("toDesktopUpdate", () => {
  it("reports a semver version and the content address as the digest", () => {
    const [releaseEvent, ...assets] = published(generateSecretKey(), { version: "1.2.3" });
    const release = parseRelease(releaseEvent)!;
    const artifact = pickDesktopArtifact(assets.map((a) => parseAsset(a)!), { platform: "linux", arch: "x64" })!;
    const update = toDesktopUpdate(release, artifact);

    expect(update.version).toBe("1.2.3");
    expect(update.tag).toBe("v1.2.3");
    expect(update.file.filename).toBe("Armada-v1.2.3.AppImage");
    expect(update.file.url).toBe(`https://blossom.example/${HASH}`);
    // The `x` sha256 is both the content address and the digest the download
    // is verified against. There is no second hash to keep in step with it.
    expect(update.file.sha256).toBe(HASH);
    expect(update.releaseDate).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it("strips a leading v, which electron-updater's semver refuses", () => {
    const [releaseEvent, ...assets] = published(generateSecretKey(), { version: "v1.2.3" });
    const update = toDesktopUpdate(parseRelease(releaseEvent)!, parseAsset(assets[1])!);
    expect(update.version).toBe("1.2.3");
  });
});

describe("selectDesktopRelease", () => {
  const secretKey = generateSecretKey();
  const author = getPublicKey(secretKey);
  const target = { platform: "linux", arch: "x64" };
  const select = (events: unknown[], overrides = {}) =>
    selectDesktopRelease(events, { target, authors: [author], ...overrides });

  it("offers the newest stable release", () => {
    const events = [
      ...published(secretKey, { version: "1.2.3", createdAt: 1000 }),
      ...published(secretKey, { version: "1.3.0", createdAt: 2000 }),
      ...published(secretKey, { version: "1.1.0", createdAt: 500 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("passes over a prerelease unless the running build is one", () => {
    const events = [
      ...published(secretKey, { version: "1.3.0", createdAt: 2000 }),
      ...published(secretKey, { version: "1.4.0-rc.1", channel: "beta", createdAt: 3000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
    expect(select(events, { allowPrerelease: true })?.version).toBe("1.4.0-rc.1");
  });

  it("treats a prerelease version on the main channel as a prerelease", () => {
    const events = [
      ...published(secretKey, { version: "1.3.0", createdAt: 2000 }),
      ...published(secretKey, { version: "1.4.0-rc.1", channel: "main", createdAt: 3000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("falls back to an older release when the newest has no artifact for us", () => {
    // A tag whose Windows job failed still publishes a release. Offering
    // nothing would strand Windows until the next one.
    const events = [
      ...published(secretKey, { version: "1.3.0", createdAt: 2000 }),
      ...published(secretKey, {
        version: "1.4.0",
        createdAt: 3000,
        assets: [{ filename: "Armada-v1.4.0.AppImage", f: ["linux-x86_64"] }],
      }),
    ];
    expect(select(events, { target: { platform: "win32", arch: "x64" } })?.version).toBe("1.3.0");
    expect(select(events)?.version).toBe("1.4.0");
  });

  it("rejects a release whose signature does not verify", () => {
    // The relay is untrusted transport, and the payload is a binary this
    // process is about to download and execute.
    const [forged, ...forgedAssets] = published(secretKey, { version: "9.9.9" });
    const events = [{ ...forged, sig: "0".repeat(128) }, ...forgedAssets, ...published(secretKey, { version: "1.3.0" })];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("rejects a validly signed release from an unpinned author", () => {
    const events = [
      ...published(generateSecretKey(), { version: "9.9.9", createdAt: 9000 }),
      ...published(secretKey, { version: "1.3.0", createdAt: 2000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("rejects a release of a different application by the same author", () => {
    const events = [
      ...published(secretKey, { version: "9.9.9", appId: "something.else", createdAt: 9000 }),
      ...published(secretKey, { version: "1.3.0", createdAt: 2000 }),
    ];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("ignores events of another kind and malformed payloads", () => {
    const notARelease = finalizeEvent({ kind: 1, created_at: 9000, content: "hello", tags: [] }, secretKey);
    const events = [notARelease, null, "nonsense", { kind: 30063 }, ...published(secretKey, { version: "1.3.0" })];
    expect(select(events)?.version).toBe("1.3.0");
  });

  it("keeps the newest event when a version is republished", () => {
    const first = published(secretKey, { version: "1.3.0", createdAt: 1000 });
    const corrected = published(secretKey, {
      version: "1.3.0",
      createdAt: 5000,
      assets: [{ filename: "Armada-v1.3.0.AppImage", f: ["linux-x86_64"], x: "b".repeat(64) }],
    });
    expect(select([...first, ...corrected])?.file.sha256).toBe("b".repeat(64));
  });

  it("returns undefined when nothing matches", () => {
    expect(select([])).toBeUndefined();
  });

  it("matches authors case-insensitively", () => {
    expect(select(published(secretKey, { version: "1.3.0" }), { authors: [author.toUpperCase()] })?.version)
      .toBe("1.3.0");
  });

  it("uses the pubkey the secret key actually derives", () => {
    // Guards the fixture itself: every author check above is meaningless if
    // the events are signed by a key unrelated to `author`.
    expect(bytesToHex(secretKey)).toHaveLength(64);
    expect(published(secretKey, { version: "1.0.0" })[0].pubkey).toBe(author);
  });
});

describe("selectDesktopArtifact", () => {
  const secretKey = generateSecretKey();
  const target = { platform: "linux", arch: "x64" };
  const [releaseEvent, ...assets] = published(secretKey, { version: "1.3.0" });
  const [release] = trustedReleases([releaseEvent], { authors: [getPublicKey(secretKey)] });
  const appImage = assets.find((a) => a.tags.some((t) => t[1] === "Armada-v1.3.0.AppImage"))!;

  it("takes an asset the release names", () => {
    expect(selectDesktopArtifact(release, assets, target)?.file.filename).toBe("Armada-v1.3.0.AppImage");
  });

  it("refuses a tampered asset served under a named id", () => {
    // The release's `e` tag commits to the id, and the id to the content; an
    // asset whose content no longer hashes to its id is a relay's forgery.
    // Cloned through JSON: a spread would copy the verified mark an earlier test left on `appImage`.
    const swapped = JSON.parse(JSON.stringify(appImage)) as WireEvent;
    swapped.tags = swapped.tags.map((t) => (t[0] === "x" ? ["x", "f".repeat(64)] : t));
    expect(selectDesktopArtifact(release, [swapped], target)).toBeUndefined();
  });

  it("refuses a validly signed asset the release does not name", () => {
    const extra = assetEvent(secretKey, "1.3.0", { filename: "Armada-v1.3.0.AppImage", f: ["linux-x86_64"], x: "d".repeat(64) }, 1);
    expect(selectDesktopArtifact(release, [extra], target)).toBeUndefined();
  });
});

describe("web site manifests", () => {
  const INDEX = "c".repeat(64);

  function manifest(
    secretKey: Uint8Array,
    {
      createdAt = 1_800_000_000,
      site = "armada",
      paths = [["/index.html", INDEX], ["/assets/app.js", "d".repeat(64)]] as string[][],
      servers = ["https://blossom.one", "https://blossom.two/"],
    } = {},
  ): WireEvent {
    return sign(secretKey, {
      kind: 35128,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", site],
        ...paths.map(([sitePath, hash]) => ["path", sitePath, hash]),
        ...servers.map((server) => ["server", server]),
      ],
    });
  }

  it("reads every path's hash and the https servers from a pinned manifest", () => {
    const key = generateSecretKey();
    const event = manifest(key, { servers: ["https://blossom.one", "http://plain.example", "not a url", "https://blossom.two/x"] });
    const site = parseWebSite(event, { authors: [getPublicKey(key)] });
    expect(site?.id).toBe(event.id);
    expect(site?.createdAt).toBe(1_800_000_000);
    expect([...site!.files]).toEqual([["/index.html", INDEX], ["/assets/app.js", "d".repeat(64)]]);
    expect(site?.servers).toEqual(["https://blossom.one", "https://blossom.two"]);
  });

  it("drops path tags that are not absolute or carry no sha256", () => {
    const key = generateSecretKey();
    const event = manifest(key, { paths: [["/index.html", INDEX.toUpperCase()], ["relative.js", INDEX], ["/x.js", "nope"]] });
    expect([...parseWebSite(event, { authors: [getPublicKey(key)] })!.files]).toEqual([["/index.html", INDEX]]);
  });

  it("accepts only the pinned key, a valid signature and its own site", () => {
    const key = generateSecretKey();
    const authors = [getPublicKey(key)];
    expect(parseWebSite(manifest(generateSecretKey()), { authors })).toBeUndefined();
    expect(parseWebSite(manifest(key, { site: "other" }), { authors })).toBeUndefined();
    const tampered = manifest(key);
    tampered.tags = tampered.tags.map((tag) => (tag[1] === "/index.html" ? [tag[0], tag[1], "e".repeat(64)] : tag));
    expect(parseWebSite(tampered, { authors })).toBeUndefined();
    expect(parseWebSite({ ...manifest(key), kind: 15128 }, { authors })).toBeUndefined();
    expect(parseWebSite("not an event", { authors })).toBeUndefined();
  });

  it("knows which track a site is on, and holds a track request to it", () => {
    const key = generateSecretKey();
    const authors = [getPublicKey(key)];
    expect(parseWebSite(manifest(key), { authors })?.siteId).toBe("armada");
    const release = manifest(key, { site: "armada-stable" });
    // A stored manifest is re-verified without a track: either is the shell's own.
    expect(parseWebSite(release, { authors })?.siteId).toBe("armada-stable");
    expect(parseWebSite(release, { authors, siteId: "armada" })).toBeUndefined();
    expect(parseWebSite(manifest(key), { authors, siteId: "armada-stable" })).toBeUndefined();
  });

  it("selects the newest acceptable manifest, past a newer forgery", () => {
    const key = generateSecretKey();
    const authors = [getPublicKey(key)];
    const older = manifest(key, { createdAt: 1_700_000_000 });
    const valid = manifest(key);
    const forged = { ...manifest(key, { createdAt: 1_900_000_000 }), sig: "0".repeat(128) };
    expect(selectWebSite([older, forged, valid], { authors })?.id).toBe(valid.id);
    expect(selectWebSite([manifest(generateSecretKey())], { authors })).toBeUndefined();
  });

  it("resolves the site with its servers, the author's 10063 and the fallbacks, in that order", async () => {
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    const site = manifest(key, { servers: ["https://blossom.one"] });
    const serverList = sign(key, {
      kind: 10063,
      created_at: 1_800_000_000,
      content: "",
      tags: [["server", "https://list.example/"], ["server", "https://blossom.one"]],
    });
    const strangerList = sign(generateSecretKey(), {
      kind: 10063,
      created_at: 1_800_000_000,
      content: "",
      tags: [["server", "https://stranger.example"]],
    });
    const requests: unknown[] = [];

    class FakeSocket extends EventTarget {
      constructor(_url: string) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(data: string) {
        const [, id, ...filters] = JSON.parse(data) as [string, string, ...unknown[]];
        requests.push(...filters);
        for (const event of [site, serverList, strangerList]) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", id, event]) }));
        }
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EOSE", id]) }));
      }
      close() {}
    }

    const resolved = await resolveWebSite({
      relays: ["wss://relay.example"],
      authors: [pubkey],
      fallbackServers: ["https://fallback.example/", "http://insecure.example"],
      webSocket: FakeSocket as unknown as typeof WebSocket,
    });
    expect(resolved?.id).toBe(site.id);
    expect(resolved?.servers).toEqual(["https://blossom.one", "https://list.example", "https://fallback.example"]);
    expect(requests).toEqual([
      { kinds: [35128], authors: [pubkey], "#d": ["armada"] },
      { kinds: [10063], authors: [pubkey] },
    ]);
  });
});
