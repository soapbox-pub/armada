/**
 * The platform side of `/downloads`: install targets, OS detection, install
 * commands and store listings. Release contents (files, hashes, URLs) come
 * from the NIP-82 release events (`src/lib/releases.ts`).
 */

import { t } from "@/i18n";

export type DownloadOs = "linux" | "windows" | "macos" | "android" | "ios";

export interface DownloadPlatform {
  os: DownloadOs;
  name: string;
}

/** Every platform card, in fallback order. iOS has no build here (App Store isn't in this pipeline). */
export const DOWNLOAD_PLATFORMS: DownloadPlatform[] = [
  { os: "linux", name: "Linux" },
  { os: "windows", name: "Windows" },
  { os: "macos", name: "macOS" },
  { os: "android", name: "Android" },
  { os: "ios", name: "iPhone & iPad" },
];

/**
 * Shell command to run a downloaded file, keyed by extension (filenames carry
 * versions). Only AppImage: `.deb`/`.flatpak` go through {@link PACKAGE_MANAGERS}.
 */
export function installCommand(filename: string): string | undefined {
  if (/\.AppImage$/i.test(filename)) return `chmod +x ${filename} && ./${filename}`;
  return undefined;
}

/** Formats pkg.soapbox.pub republishes as package repos, so `/downloads` shows repo commands instead of the file. */
export function isRepublishedPackage(filename: string): boolean {
  return /\.(deb|flatpak)$/i.test(filename);
}

/**
 * The npkg (https://github.com/soapbox-pub/npkg) instance: verifies release
 * artifacts against the event's hashes and re-signs package repos with its own keys.
 */
export const NPKG_HOST = "pkg.soapbox.pub";

/** A pkg.soapbox.pub repository and its copyable setup/install commands. */
export interface PackageManager {
  os: DownloadOs;
  label: string;
  setup: string[];
  /** Installs Armada; `flatpak/apt update` upgrades it thereafter. */
  install: string;
}

export const PACKAGE_MANAGERS: PackageManager[] = [
  {
    os: "linux",
    label: "Debian / Ubuntu (APT)",
    // The .sources file carries the repo URL and its signing key inline.
    setup: [
      `sudo curl -fsSL -o /etc/apt/sources.list.d/buzz.armada.app.sources https://${NPKG_HOST}/deb/soapbox.pub/buzz.armada.app/source`,
      "sudo apt update",
    ],
    install: "sudo apt install armada-desktop",
  },
  {
    os: "linux",
    label: "Flatpak",
    setup: [],
    // The flatpakref adds the `buzz.armada.app` remote and installs from it.
    install: `flatpak install --user https://${NPKG_HOST}/flatpak/soapbox.pub/buzz.armada.app/buzz.armada.app.flatpakref`,
  },
];

export interface AppStore {
  label: string;
  /** One line describing the store. */
  hint: string;
  url: string;
  /** The store's mark as a path under `public/` (one is raster-only). */
  icon: string;
}

/** The public TestFlight invite for the iOS beta (not part of a release). */
export const IOS_TESTFLIGHT_URL = "https://testflight.apple.com/join/t61a4BFe";

/** Android store listings (not part of a release); shared by the landing page and `/downloads`. */
export const ANDROID_STORES: AppStore[] = [
  {
    label: "Google Play",
    get hint() {
      return t({ id: "downloads.hint.googlePlay", defaultMessage: "Install from the Play Store" });
    },
    url: "https://play.google.com/store/apps/details?id=buzz.armada.app&hl=en-US",
    icon: "/stores/google-play.svg",
  },
  {
    label: "F-Droid",
    get hint() {
      return t({ id: "downloads.hint.fdroid", defaultMessage: "Add the Soapbox repository" });
    },
    // The npkg F-Droid repo; the link hands repo + pinned fingerprint to the F-Droid app.
    url: `https://${NPKG_HOST}/fdroid/soapbox.pub/buzz.armada.app/repo?fingerprint=1b043939b45972c680a518799d5098dd25edcc78ddeda2c6476722ed1f571832`,
    icon: "/stores/fdroid.svg",
  },
  {
    label: "Zapstore",
    get hint() {
      return t({ id: "downloads.hint.zapstore", defaultMessage: "The Nostr-native app store" });
    },
    url: "https://zapstore.dev/apps/buzz.armada.app",
    icon: "/stores/zapstore.png",
  },
];

/**
 * Guess the visitor's OS from a user-agent. Order matters: Android UAs contain
 * "Linux" and iOS "like Mac OS X". A touch-capable "Macintosh" is iPadOS 13+.
 * Undefined when unknown (show every platform rather than feature a wrong one).
 */
export function detectOs(ua: string, touchPoints = 0): DownloadOs | undefined {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh|mac os x/i.test(ua)) return touchPoints > 1 ? "ios" : "macos";
  if (/windows|win32|win64/i.test(ua)) return "windows";
  // ChromeOS: Crostini makes the .deb the working answer.
  if (/cros|linux|x11/i.test(ua)) return "linux";
  return undefined;
}

export function detectCurrentOs(): DownloadOs | undefined {
  if (typeof navigator === "undefined") return undefined;
  return detectOs(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}
