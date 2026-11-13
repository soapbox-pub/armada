import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const { createDesktopNotifications } = createRequire(import.meta.url)("./desktopNotifications.js");

function setup() {
  const instances = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; instances.push(this); }
    show() {}
    close() { this.emit("close"); }
  }
  const onClick = vi.fn();
  return { presenter: createDesktopNotifications({ Notification, onClick }), instances, onClick };
}
const input = { title: "Alice", body: "hello", tag: "dm-alice", url: "/dm/alice" };
afterEach(() => vi.useRealTimers());

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
