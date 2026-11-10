import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ platform: "web", installer: undefined as string | null | undefined, available: true }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => h.platform, isPluginAvailable: () => h.available },
  registerPlugin: () => ({ installSource: async () => ({ installer: h.installer }) }),
}));

const { isStoreInstall, _resetStoreInstallForTests } = await import("./storeInstall");

afterEach(() => _resetStoreInstallForTests());

describe("isStoreInstall", () => {
  it("is never a store install on the web or desktop", async () => {
    h.platform = "web";
    expect(await isStoreInstall()).toBe(false);
  });

  it("always is on iOS", async () => {
    h.platform = "ios";
    expect(await isStoreInstall()).toBe(true);
  });

  it("goes by the installer on Android: Play is, a sideload or Zapstore isn't", async () => {
    h.platform = "android";
    h.installer = "com.android.vending";
    expect(await isStoreInstall()).toBe(true);
    for (const installer of [null, "com.google.android.packageinstaller", "dev.zapstore.app"]) {
      _resetStoreInstallForTests();
      h.installer = installer;
      expect(await isStoreInstall(), String(installer)).toBe(false);
    }
  });
});
