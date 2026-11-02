import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANDROID_STORES,
  DOWNLOAD_PLATFORMS,
  PACKAGE_MANAGERS,
  detectOs,
  installCommand,
  isRepublishedPackage,
} from "@/lib/downloads";
import { artifactOs } from "@/lib/releases";

/** Real user-agent strings, since the ordering bugs only show up in real ones. */
const UA = {
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("detectOs", () => {
  it("reads Android before the Linux its user-agent also claims", () => {
    expect(detectOs(UA.androidPhone)).toBe("android");
  });

  it("reads iOS before the 'like Mac OS X' its user-agent also claims", () => {
    expect(detectOs(UA.iphone)).toBe("ios");
  });

  it("tells an iPad in desktop mode from a Mac by its touchscreen", () => {
    // Since iPadOS 13 both send an identical 'Macintosh' UA.
    expect(detectOs(UA.ipadDesktopMode, 5)).toBe("ios");
    expect(detectOs(UA.mac, 0)).toBe("macos");
  });

  it("recognizes the desktop platforms", () => {
    expect(detectOs(UA.windows)).toBe("windows");
    expect(detectOs(UA.linux)).toBe("linux");
    expect(detectOs(UA.chromeos)).toBe("linux");
  });

  it("returns undefined rather than guessing at an unknown agent", () => {
    expect(detectOs("some-crawler/1.0")).toBeUndefined();
    expect(detectOs("")).toBeUndefined();
  });
});

describe("download platforms", () => {
  it("covers every detectable OS exactly once", () => {
    const seen = DOWNLOAD_PLATFORMS.map((p) => p.os);
    expect(new Set(seen).size).toBe(seen.length);
    for (const os of ["linux", "windows", "macos", "android", "ios"]) {
      expect(seen).toContain(os);
    }
  });
});

describe("installCommand", () => {
  it("writes the command against the versioned name the release actually carries", () => {
    // Filenames come off the release event now, so a command referring to some
    // fixed `Armada.AppImage` would name a file the user does not have.
    expect(installCommand("Armada-v1.2.3.AppImage")).toBe("chmod +x Armada-v1.2.3.AppImage && ./Armada-v1.2.3.AppImage");
  });

  it("says nothing for a file the page does not offer a raw command for", () => {
    // .deb and .flatpak install through pkg.soapbox.pub, not a per-file command,
    // and the page never renders them; the rest are just opened.
    expect(installCommand("Armada-v1.2.3.deb")).toBeUndefined();
    expect(installCommand("Armada-v1.2.3.flatpak")).toBeUndefined();
    expect(installCommand("Armada-v1.2.3.exe")).toBeUndefined();
    expect(installCommand("Armada-v1.2.3-mac-arm64.zip")).toBeUndefined();
    expect(installCommand("Armada-v1.2.3.apk")).toBeUndefined();
  });
});

describe("package repositories (pkg.soapbox.pub / npkg)", () => {
  it("treats the formats npkg republishes as repository-served, not sideload", () => {
    expect(isRepublishedPackage("Armada-v1.2.3.deb")).toBe(true);
    expect(isRepublishedPackage("Armada-v1.2.3.flatpak")).toBe(true);
    // The AppImage has no repository, so it stays a direct download.
    expect(isRepublishedPackage("Armada-v1.2.3.AppImage")).toBe(false);
    expect(isRepublishedPackage("Armada-v1.2.3.apk")).toBe(false);
  });

  it("offers apt and flatpak install commands that point at pkg.soapbox.pub", () => {
    const linux = PACKAGE_MANAGERS.filter((manager) => manager.os === "linux");
    expect(linux.map((manager) => manager.label)).toEqual([
      "Debian / Ubuntu (APT)",
      "Flatpak",
    ]);
    for (const manager of linux) {
      expect(manager.install).toBeTruthy();
      const lines = [...manager.setup, manager.install].join("\n");
      expect(lines).toContain("pkg.soapbox.pub");
    }
    // The flatpak path installs from npkg's per-app flatpakref, not a local bundle.
    const flatpak = linux.find((manager) => manager.label === "Flatpak");
    expect(flatpak?.install).toBe(
      "flatpak install --user https://pkg.soapbox.pub/flatpak/soapbox.pub/buzz.armada.app/buzz.armada.app.flatpakref",
    );
  });

  it("repeats the same commands and links in index.html's <noscript> fallback", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const noscript = html.slice(html.lastIndexOf("<noscript>"), html.lastIndexOf("</noscript>"));
    for (const manager of PACKAGE_MANAGERS) {
      for (const line of [...manager.setup, manager.install]) expect(noscript).toContain(line);
    }
    for (const store of ANDROID_STORES.filter((s) => s.label !== "Google Play")) {
      expect(noscript).toContain(store.url);
    }
  });

  it("lists the npkg F-Droid repository among the Android sources", () => {
    const fdroid = ANDROID_STORES.find((store) => store.label === "F-Droid");
    expect(fdroid?.url).toContain("pkg.soapbox.pub/fdroid");
    // The F-Droid client needs the pinned fingerprint in the URL.
    expect(fdroid?.url).toContain("fingerprint=");
  });
});

/**
 * The page can only render a build it can file under a platform. Reading the
 * workflow makes that a checked contract rather than a convention: staging a
 * new artifact type in CI without teaching the client about it fails the suite,
 * instead of shipping a download the page silently drops on the floor.
 */
describe("the CI workflow that publishes these files", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".ngit/act/workflows/release.yml"), "utf8");

  /** Every `Armada-...` artifact name the workflow stages for the release. */
  const staged = [...new Set(
    [...workflow.matchAll(/\bArmada-\$(?:TAG|\{TAG\}|VERSION_NAME|\{VERSION_NAME\})[\w.$-]*\.\w+/g)]
      .map((match) => match[0].replace(/\$\{?(?:TAG|VERSION_NAME)\}?/g, "v1.2.3")),
  )];

  it("stages artifacts the test can actually see", () => {
    // Guards the regex above: if the workflow stops spelling names this way,
    // every assertion below would vacuously pass.
    expect(staged.length).toBeGreaterThanOrEqual(7);
  });

  it("produces only filenames the client can file under a platform", () => {
    for (const filename of staged) {
      expect(artifactOs("", filename), `${filename} lands on no platform card`).toBeDefined();
    }
  });
});
