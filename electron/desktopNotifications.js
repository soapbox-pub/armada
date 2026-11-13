"use strict";

/** Keep native notifications alive until macOS dismisses or replaces them. */
function createDesktopNotifications({ Notification, onClick, timeoutMs = 10_000 }) {
  const active = new Map();

  function show(input) {
    if (!Notification.isSupported()) return Promise.reject(new Error("Notifications unavailable"));
    if (!input || typeof input.title !== "string" || typeof input.body !== "string" ||
        typeof input.tag !== "string" || !input.tag || input.tag.length > 128 ||
        typeof input.url !== "string" || !input.url.startsWith("/") ||
        input.url.startsWith("//") || /[\\\x00-\x1f]/.test(input.url)) {
      return Promise.reject(new Error("Invalid notification"));
    }
    return new Promise((resolve, reject) => {
      const previous = active.get(input.tag);
      previous?.close();
      if (active.size >= 128) active.values().next().value.close();
      // Avatar attachments can fail independently of text delivery. macOS uses
      // the signed bundle's icon; no sender-controlled file is opened here.
      const notification = new Notification({
        title: input.title.slice(0, 256),
        body: input.body.slice(0, 4096),
        silent: true,
        groupId: input.tag,
      });
      active.set(input.tag, notification);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const forget = () => {
        if (active.get(input.tag) === notification) active.delete(input.tag);
      };
      const timer = setTimeout(() => {
        finish(new Error("Notification delivery timed out"));
        forget();
        notification.close();
      }, timeoutMs);
      notification.once("show", () => finish());
      notification.once("failed", (_event, error) => {
        finish(new Error(error || "Notification delivery failed"));
        forget();
      });
      notification.once("close", () => {
        finish(new Error("Notification closed before delivery"));
        forget();
      });
      notification.once("click", () => {
        onClick(input.url);
        notification.close();
        forget();
      });
      try {
        notification.show();
      } catch (error) {
        finish(error);
        forget();
      }
    });
  }

  function clear() {
    for (const notification of active.values()) notification.close();
    active.clear();
  }

  return { show, clear };
}

module.exports = { createDesktopNotifications };
