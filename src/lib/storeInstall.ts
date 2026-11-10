import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Whether this install came from an app store (Discover stays curated there). iOS
 * always does; on Android the installer package decides (WebReadyPlugin.java).
 */
const STORE_INSTALLERS = new Set([
  "com.android.vending",
  "com.amazon.venezia",
  "com.sec.android.app.samsungapps",
  "com.huawei.appmarket",
]);

const WebReady = registerPlugin<{ installSource(): Promise<{ installer?: string | null }> }>("WebReady");

let answer: Promise<boolean> | undefined;

export function isStoreInstall(): Promise<boolean> {
  answer ??= (async () => {
    const platform = Capacitor.getPlatform();
    if (platform === "ios") return true;
    if (platform !== "android" || !Capacitor.isPluginAvailable("WebReady")) return false;
    try {
      const { installer } = await WebReady.installSource();
      return Boolean(installer && STORE_INSTALLERS.has(installer));
    } catch {
      // A shell without the method predates store builds.
      return false;
    }
  })();
  return answer;
}

/** Tests only. */
export function _resetStoreInstallForTests(): void {
  answer = undefined;
}
