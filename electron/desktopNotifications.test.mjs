import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const { createDesktopNotifications, createNotificationNavigation } = createRequire(import.meta.url)("./desktopNotifications.js");

function setup(onClick = vi.fn()) {
  const instances = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; instances.push(this); }
    show() {}
    close() { this.emit("close"); }
  }
  return { presenter: createDesktopNotifications({ Notification, onClick }), instances, onClick };
}
const input = { title: "Alice", body: "hello", tag: "dm-alice", url: "/dm/alice" };
afterEach(() => vi.useRealTimers());

describe("notification click navigation", () => {
  function setupNavigation() {
    let contents = null;
    const makeContents = () => ({ send: vi.fn(), isDestroyed: () => false });
    const showWindow = vi.fn(() => { contents ??= makeContents(); });
    const navigation = createNotificationNavigation({ showWindow, getWebContents: () => contents });
    return { navigation, showWindow, makeContents, getContents: () => contents, replace: () => { contents = makeContents(); } };
  }

  it("raises the app and delivers the exact route after its router subscribes", () => {
    const { navigation, showWindow, getContents } = setupNavigation();
    const path = "/dm/alice?from=push#message";
    expect(navigation.open(path)).toBe(true);
    expect(showWindow).toHaveBeenCalledOnce();
    expect(getContents().send).not.toHaveBeenCalled();
    navigation.setReady(getContents(), true);
    expect(getContents().send).toHaveBeenCalledExactlyOnceWith("armada:deep-link", path);
    navigation.setReady(getContents(), true);
    expect(getContents().send).toHaveBeenCalledOnce();
  });

  it("delivers warm native clicks immediately through the app route", async () => {
    const { navigation, getContents, showWindow } = setupNavigation();
    showWindow();
    navigation.setReady(getContents(), true);
    const { presenter, instances } = setup((path) => navigation.open(path));
    const shown = presenter.show({ ...input, url: "/c/community/channel/m/event" });
    instances[0].emit("show");
    await shown;
    instances[0].emit("click");
    expect(getContents().send).toHaveBeenCalledWith("armada:deep-link", "/c/community/channel/m/event");
    expect(showWindow).toHaveBeenCalledTimes(2);
  });

  it("queues the last click across a reload and ignores the old renderer", () => {
    const { navigation, getContents, showWindow, replace } = setupNavigation();
    showWindow();
    const old = getContents();
    navigation.setReady(old, true);
    navigation.reset();
    replace();
    navigation.open("/dm/alice");
    navigation.open("/dm/bob");
    navigation.setReady(old, true);
    expect(getContents().send).not.toHaveBeenCalled();
    navigation.setReady(getContents(), true);
    expect(getContents().send).toHaveBeenCalledExactlyOnceWith("armada:deep-link", "/dm/bob");
  });

  it("clears a queued plaintext route without disconnecting an already subscribed router", () => {
    const { navigation, getContents } = setupNavigation();
    navigation.open("/dm/alice");
    navigation.clearPending();
    navigation.setReady(getContents(), true);
    expect(getContents().send).not.toHaveBeenCalled();
    navigation.clearPending();
    navigation.open("/dm/bob");
    expect(getContents().send).toHaveBeenCalledExactlyOnceWith("armada:deep-link", "/dm/bob");
    navigation.reset(true);
  });

  it.each(["https://armada.buzz/dm/alice", "//evil.example", "/\\evil.example", "/dm/\n", undefined])("never hands an unsafe destination to the OS: %j", (path) => {
    const { navigation, showWindow } = setupNavigation();
    expect(navigation.open(path)).toBe(false);
    expect(showWindow).not.toHaveBeenCalled();
  });
});

describe("native desktop delivery", () => {
  it("waits for native acceptance, retains content and opens its internal route", async () => {
    const { presenter, instances, onClick } = setup();
    const shown = presenter.show(input);
    const notification = instances[0];
    expect(notification.options).toEqual({ title: "Alice", body: "hello", silent: true, groupId: "dm-alice" });
    notification.emit("show");
    await expect(shown).resolves.toBeUndefined();
    notification.emit("click");
    expect(onClick).toHaveBeenCalledWith("/dm/alice");
  });

  it("propagates a macOS authorization failure instead of claiming delivery", async () => {
    const { presenter, instances } = setup();
    const shown = presenter.show(input);
    const check = expect(shown).rejects.toThrow("UNErrorDomain error 1");
    instances[0].emit("failed", {}, "UNErrorDomain error 1");
    await check;
  });

  it("replaces a conversation's notification and clears retained notifications", async () => {
    const { presenter, instances } = setup();
    const first = presenter.show(input);
    instances[0].emit("show");
    await first;
    const closed = vi.fn();
    instances[0].on("close", closed);
    const second = presenter.show({ ...input, body: "second" });
    expect(closed).toHaveBeenCalledOnce();
    instances[1].emit("show");
    await second;
    presenter.clear();
    expect(instances[1].listenerCount("close")).toBe(0);
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example/", "/\n"])("refuses an unsafe click destination %j", async (url) => {
    const { presenter, instances } = setup();
    await expect(presenter.show({ ...input, url })).rejects.toThrow("Invalid notification");
    expect(instances).toHaveLength(0);
  });

  it("times out a delivery that never completes", async () => {
    vi.useFakeTimers();
    const { presenter } = setup();
    const check = expect(presenter.show(input)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
  });
});
