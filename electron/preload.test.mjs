// @vitest-environment node

import fs from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

function loadPreload({ dbAvailable = true, platform = "linux" } = {}) {
  let api;
  const listeners = new Map();
  const windowObject = { postMessage: vi.fn() };
  const ipcRenderer = {
    invoke: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn((channel) =>
      channel === "armada:db-available" ? dbAvailable : undefined,
    ),
    on: vi.fn((channel, listener) => listeners.set(channel, listener)),
    removeListener: vi.fn((channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    }),
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((_name, value) => {
      api = value;
    }),
  };
  const source = fs.readFileSync(new URL("./preload.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    process: { platform },
    window: windowObject,
    require: (specifier) => {
      if (specifier === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`unexpected preload dependency: ${specifier}`);
    },
  });
  return { api, ipcRenderer, listeners, windowObject };
}

describe("desktop database preload bridge", () => {
  it("exposes native notification presentation only on macOS", () => {
    expect(loadPreload().api.showNotification).toBeUndefined();
    const { api, ipcRenderer } = loadPreload({ platform: "darwin" });
    const input = { title: "Alice", body: "hello", tag: "dm-a", url: "/dm/a" };
    api.showNotification(input);
    api.openNotificationSettings();
    api.clearNotifications();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:show-notification", input);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:open-notification-settings");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:clear-notifications");
  });
  it("selects the native adapter synchronously and forwards database calls", () => {
    const { api, ipcRenderer } = loadPreload({ dbAvailable: true });

    expect(api.armadaDb.available).toBe(true);
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith("armada:db-available");
    api.armadaDb.call("query", { tenant: "main", filters: [] });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:db", "query", {
      tenant: "main",
      filters: [],
    });
  });

  it("keeps the renderer on IndexedDB when the main-process store is unavailable", () => {
    const { api } = loadPreload({ dbAvailable: false });
    expect(api.armadaDb.available).toBe(false);
  });
});

describe("notification attention preload bridge", () => {
  it("forwards a taskbar-attention request to the main process", () => {
    const { api, ipcRenderer } = loadPreload();
    api.requestAttention();
    expect(ipcRenderer.send).toHaveBeenCalledWith("armada:request-attention");
  });
});

describe("screen-share preload bridge", () => {
  it("transfers the dedicated H.265 frame port into the renderer world", () => {
    const { listeners, windowObject } = loadPreload();
    const port = { close: vi.fn() };

    listeners.get("armada:hevc-screen-share-port")(
      { ports: [port] },
      { sessionId: "screen-session" },
    );

    expect(windowObject.postMessage).toHaveBeenCalledWith(
      { type: "armada:hevc-screen-share-port", sessionId: "screen-session" },
      "*",
      [port],
    );
    expect(port.close).not.toHaveBeenCalled();
  });

  it("closes a frame port whose session identity is missing", () => {
    const { listeners, windowObject } = loadPreload();
    const port = { close: vi.fn() };

    listeners.get("armada:hevc-screen-share-port")({ ports: [port] }, {});

    expect(port.close).toHaveBeenCalledOnce();
    expect(windowObject.postMessage).not.toHaveBeenCalled();
  });

  it("forwards H.265 lifecycle and macOS Screen Recording calls", () => {
    const { api, ipcRenderer } = loadPreload();
    const config = { width: 2560, height: 1440, frameRate: 60, bitrate: 25_000_000 };

    api.getHevcScreenShareCapability();
    api.getHevcScreenShareStatus();
    api.startHevcScreenShare(config);
    api.stopHevcScreenShare();
    api.getScreenCaptureAccessStatus();
    api.openScreenCapturePrivacySettings();

    expect(ipcRenderer.invoke.mock.calls).toEqual(expect.arrayContaining([
      ["armada:hevc-screen-share-capability"],
      ["armada:hevc-screen-share-status"],
      ["armada:hevc-screen-share-start", config],
      ["armada:hevc-screen-share-stop"],
      ["armada:screen-capture-access-status"],
      ["armada:open-screen-capture-settings"],
    ]));
  });

  it("subscribes and unsubscribes from H.265 publisher status", () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    const handler = vi.fn();
    const unsubscribe = api.onHevcScreenShareStatus(handler);
    const status = { state: "published", encodedBytes: 4096 };

    listeners.get("armada:hevc-screen-share-status")({}, status);
    expect(handler).toHaveBeenCalledWith(status);
    const listener = listeners.get("armada:hevc-screen-share-status");
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "armada:hevc-screen-share-status",
      listener,
    );
  });

  it("returns the React picker's source to main over IPC", async () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    api.onPickScreenSource(vi.fn(async () => "screen:portal:1"));

    await listeners.get("armada:pick-screen-source")({}, 42);

    expect(ipcRenderer.send).toHaveBeenCalledWith(
      "armada:screen-source-picked",
      42,
      "screen:portal:1",
    );
  });

  it("reports cancellation when the picker fails", async () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    api.onPickScreenSource(
      vi.fn(async () => {
        throw new Error("picker closed");
      }),
    );

    await listeners.get("armada:pick-screen-source")({}, 7);

    expect(ipcRenderer.send).toHaveBeenCalledWith("armada:screen-source-picked", 7, null);
  });
});

describe("push-to-talk preload bridge", () => {
  it("forwards configuration and press/release state without exposing IPC", async () => {
    const { api, ipcRenderer, listeners } = loadPreload();
    const binding = {
      code: "CapsLock",
      label: "Caps Lock",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    const handler = vi.fn();
    const statusHandler = vi.fn();

    api.configurePushToTalk(binding);
    api.openPushToTalkSystemSettings();
    api.setPushToTalkActive(true);
    const unsubscribe = api.onPushToTalkState(handler);
    const unsubscribeStatus = api.onPushToTalkStatus(statusHandler);
    listeners.get("armada:push-to-talk-state")({}, true);
    listeners.get("armada:push-to-talk-state")({}, false);
    const status = { supported: true, backend: "portal", bindingLabel: "Ctrl + X", reason: null };
    listeners.get("armada:push-to-talk-status")({}, status);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:push-to-talk-configure", binding);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "armada:push-to-talk-open-system-settings",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("armada:push-to-talk-active", true);
    expect(handler.mock.calls).toEqual([[true], [false]]);
    expect(statusHandler).toHaveBeenCalledWith(status);

    const listener = listeners.get("armada:push-to-talk-state");
    unsubscribe();
    const statusListener = listeners.get("armada:push-to-talk-status");
    unsubscribeStatus();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "armada:push-to-talk-state",
      listener,
    );
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "armada:push-to-talk-status",
      statusListener,
    );
  });
});
