import { describe, expect, it } from "vitest";

import {
  ASSET_KIND,
  RELEASE_KIND,
  artifactLabel,
  artifactOs,
  compareVersions,
  featuredRelease,
  foldReleases,
  isStable,
  parseAsset,
  parseRelease,
  releaseArtifacts,
  type Release,
} from "@/lib/releases";

const PUBKEY = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";
const APPIMAGE_ID = "e1f2311e674b51e410f2a182dc0b4d4498b200396f833fb6b9884cc877b1c755";
const APK_ID = "fc6236ca6a197c5463ad23295e9c797285d17baaa21f68d67382639d525ba767";

/** The tags of the real 0.64.13 release, as `ngit release publish` wrote them. */
function releaseEvent(overrides: Partial<{ kind: number; tags: string[][]; content: string }> = {}) {
  return {
    id: "a".repeat(64),
    kind: RELEASE_KIND,
    pubkey: PUBKEY,
    created_at: 1791789786,
    content: "### Fixed\n- something",
    tags: [
      ["a", `32267:${PUBKEY}:buzz.armada.app`, "wss://relay.ngit.dev"],
      ["i", "buzz.armada.app"],
      ["version", "0.64.13"],
      ["d", "buzz.armada.app@0.64.13"],
      ["c", "main"],
      ["e", APK_ID, "wss://relay.ngit.dev"],
      ["e", APPIMAGE_ID, "wss://relay.ngit.dev"],
      ["f", "android-arm64-v8a"],
      ["f", "linux-x86_64"],
      ["commit", "9a9eb7190bee3af7c406fcf9786188726cfbcf0c"],
    ],
    ...overrides,
  };
}

/** A real 0.64.13 asset. */
function assetEvent(overrides: Partial<{ id: string; pubkey: string; tags: string[][] }> = {}) {
  return {
    id: APPIMAGE_ID,
    kind: ASSET_KIND,
    pubkey: PUBKEY,
    created_at: 1791789780,
    content: "",
    tags: [
      ["a", `32267:${PUBKEY}:buzz.armada.app`, "wss://relay.ngit.dev"],
      ["i", "buzz.armada.app"],
      ["m", "application/vnd.appimage"],
      ["x", "74b21f2ef4833bf1e529d4bea1f757722d4dca0ea2e60b529baa5a5476a2663d"],
      ["version", "0.64.13"],
      ["url", "https://blossom.ditto.pub/74b21f2ef4833bf1e529d4bea1f757722d4dca0ea2e60b529baa5a5476a2663d"],
      ["filename", "Armada-v0.64.13.AppImage"],
      ["size", "147084818"],
      ["f", "linux-x86_64"],
      ["supported_nip", "01"],
    ],
    ...overrides,
  };
}

describe("parseRelease", () => {
  it("reads a release and the ids of its assets", () => {
    expect(parseRelease(releaseEvent())).toMatchObject({
      appId: "buzz.armada.app",
      version: "0.64.13",
      channel: "main",
      commit: "9a9eb7190bee3af7c406fcf9786188726cfbcf0c",
      assetIds: [APK_ID, APPIMAGE_ID],
    });
  });

  it("falls back to the d tag when i and version are absent, splitting on the last @", () => {
    const release = parseRelease(releaseEvent({ tags: [["d", "my@app@1.2.3"], ["e", APK_ID]] }));
    expect(release?.appId).toBe("my@app");
    expect(release?.version).toBe("1.2.3");
  });

  it("defaults the channel to main", () => {
    expect(parseRelease(releaseEvent({ tags: [["d", "buzz.armada.app@1.0.0"], ["e", APK_ID]] }))?.channel)
      .toBe("main");
  });

  it("refuses anything it cannot render", () => {
    expect(parseRelease(releaseEvent({ kind: 30622 }))).toBeUndefined();
    // No version: it could be neither labelled nor ordered.
    expect(parseRelease(releaseEvent({ tags: [["i", "buzz.armada.app"], ["e", APK_ID]] }))).toBeUndefined();
    // No assets: a version with no downloads is worse than no entry at all.
    expect(parseRelease(releaseEvent({ tags: [["d", "buzz.armada.app@1.0.0"], ["e", "not-an-id"]] })))
      .toBeUndefined();
  });
});

describe("parseAsset", () => {
  it("reads an asset", () => {
    expect(parseAsset(assetEvent())).toMatchObject({
      id: APPIMAGE_ID,
      hash: "74b21f2ef4833bf1e529d4bea1f757722d4dca0ea2e60b529baa5a5476a2663d",
      mime: "application/vnd.appimage",
      size: 147084818,
      platforms: ["linux-x86_64"],
      filename: "Armada-v0.64.13.AppImage",
      label: "Linux AppImage (x86_64)",
      os: "linux",
    });
  });

  it("keeps every platform an APK names", () => {
    const apk = parseAsset(assetEvent({
      tags: [
        ["url", "https://blossom.example/x"],
        ["filename", "Armada-v1.0.0.apk"],
        ["f", "android-arm64-v8a"],
        ["f", "android-armeabi-v7a"],
      ],
    }));
    expect(apk?.platforms).toEqual(["android-arm64-v8a", "android-armeabi-v7a"]);
    expect(apk?.os).toBe("android");
  });

  it("drops an asset with no url, and names one with no filename after its url", () => {
    expect(parseAsset(assetEvent({ tags: [["filename", "Armada.AppImage"]] }))).toBeUndefined();
    expect(parseAsset(assetEvent({ tags: [["url", "https://files.example/Armada.AppImage"]] }))?.filename)
      .toBe("Armada.AppImage");
  });

  it("drops an asset whose url is not https", () => {
    for (const url of ["javascript:alert(1)//Armada.apk", "http://files.example/Armada.apk", "data:text/html,x"]) {
      expect(parseAsset(assetEvent({ tags: [["url", url], ["filename", "Armada.apk"]] }))).toBeUndefined();
    }
  });
});

describe("releaseArtifacts", () => {
  const release = parseRelease(releaseEvent())!;

  it("takes only assets the release names, by its own author, in its order", () => {
    const apk = assetEvent({ id: APK_ID, tags: [["url", "https://b.example/apk"], ["filename", "Armada.apk"]] });
    const unnamed = assetEvent({ id: "b".repeat(64) });
    const impostor = assetEvent({ pubkey: "c".repeat(64) });
    const artifacts = releaseArtifacts(release, [assetEvent(), unnamed, impostor, apk]);
    expect(artifacts.map((a) => a.id)).toEqual([APK_ID, APPIMAGE_ID]);
  });
});

describe("artifactLabel", () => {
  it("labels each build CI publishes", () => {
    expect(artifactLabel("Armada-v1.deb", ["linux-x86_64"])).toBe("Debian / Ubuntu package (x86_64)");
    expect(artifactLabel("Armada-v1.flatpak", ["linux-x86_64"])).toBe("Flatpak bundle (x86_64)");
    expect(artifactLabel("Armada-v1.exe", ["windows-x86_64"], "installer")).toBe("Windows installer (x64)");
    expect(artifactLabel("Armada-v1-portable.exe", ["windows-x86_64"], "portable")).toBe("Windows portable (x64)");
    expect(artifactLabel("Armada-v1-mac-arm64.zip", ["darwin-arm64"])).toBe("macOS (Apple silicon)");
    expect(artifactLabel("Armada-v1-mac-x64.zip", ["darwin-x86_64"])).toBe("macOS (Intel)");
    expect(artifactLabel("Armada-v1.apk", ["android-arm64-v8a", "android-armeabi-v7a"])).toBe("Android APK");
  });

  it("falls back to the filename", () => {
    expect(artifactLabel("SHA256SUMS", [])).toBe("SHA256SUMS");
  });
});

describe("artifactOs", () => {
  it("files each NIP-82 platform id", () => {
    expect(artifactOs("linux-x86_64", "x.AppImage")).toBe("linux");
    expect(artifactOs("windows-x86_64", "x.exe")).toBe("windows");
    expect(artifactOs("darwin-arm64", "x.zip")).toBe("macos");
    expect(artifactOs("darwin-x86_64", "x.zip")).toBe("macos");
    expect(artifactOs("android-arm64-v8a", "x.apk")).toBe("android");
  });

  it("falls back to the filename for an id this build doesn't know", () => {
    // An unrecognized platform id must cost a grouping hint, never a download button.
    expect(artifactOs("linux-riscv64", "Armada.AppImage")).toBe("linux");
    expect(artifactOs("", "Armada-Setup.exe")).toBe("windows");
    expect(artifactOs("", "Armada.deb")).toBe("linux");
    expect(artifactOs("", "Armada-mac-arm64.zip")).toBe("macos");
    expect(artifactOs("", "Armada.apk")).toBe("android");
  });

  it("returns undefined rather than guessing at something unplaceable", () => {
    expect(artifactOs("", "SHA256SUMS")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    // The whole reason this exists: "0.9.0" > "0.55.3" as strings.
    expect(compareVersions("0.55.3", "0.9.0")).toBeLessThan(0);
    expect([...["v0.9.0", "v0.55.3", "v0.10.1"]].sort(compareVersions))
      .toEqual(["v0.55.3", "v0.10.1", "v0.9.0"]);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBeLessThan(0);
    expect(compareVersions("1.2.3-rc.2", "1.2.3-rc.1")).toBeLessThan(0);
  });
});

const rel = (version: string, channel = "main", createdAt = 1, id = version): Release => ({
  id,
  pubkey: "p",
  createdAt,
  appId: "buzz.armada.app",
  version,
  channel,
  commit: undefined,
  notes: "",
  assetIds: [],
});

describe("isStable", () => {
  it("requires the main channel and a version with no prerelease suffix", () => {
    expect(isStable(rel("1.2.0"))).toBe(true);
    expect(isStable(rel("1.3.0-rc.1", "beta"))).toBe(false);
    // ngit defaults the channel to main, so a prerelease tag published without
    // `--channel` must still not reach stable installs.
    expect(isStable(rel("1.3.0-rc.1", "main"))).toBe(false);
  });
});

describe("featuredRelease", () => {
  it("skips a prerelease that sorts above the newest stable", () => {
    // 1.3.0-rc.1 is genuinely newer than 1.2.0, so the head of the list is a
    // release candidate. Featuring it would hand every visitor an rc build.
    expect(featuredRelease([rel("1.3.0-rc.1", "beta"), rel("1.2.0")])?.version).toBe("1.2.0");
  });

  it("takes the newest stable when the list leads with one", () => {
    expect(featuredRelease([rel("1.2.0"), rel("1.1.0")])?.version).toBe("1.2.0");
  });

  it("falls back to a prerelease when nothing stable was ever tagged", () => {
    expect(featuredRelease([rel("0.1.0-rc.2", "beta"), rel("0.1.0-rc.1", "beta")])?.version).toBe("0.1.0-rc.2");
  });

  it("has nothing to offer for an empty list", () => {
    expect(featuredRelease([])).toBeUndefined();
  });
});

describe("foldReleases", () => {
  it("keeps the newest event per version and sorts newest version first", () => {
    const folded = foldReleases([
      rel("1.0.0", "main", 100, "old"),
      rel("1.0.0", "main", 200, "republished"),
      rel("1.1.0", "main", 150, "next"),
    ]);
    expect(folded.map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(folded.find((r) => r.version === "1.0.0")?.id).toBe("republished");
  });
});
