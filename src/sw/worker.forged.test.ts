import { IDBFactory } from "fake-indexeddb";
import type { NostrEvent } from "@nostrify/nostrify";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreparedPush } from "@/sw/pushRuntime";
import { installServiceWorker, type PushRuntime } from "@/sw/worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

const RELAY = "wss://relay.example";

function groupMessage(content: string): NostrEvent {
  return finalizeEvent({ kind: 9, content, tags: [["h", "room"]], created_at: 1_700_000_000 }, generateSecretKey());
}

/** `event` with content its id and signature do not cover. */
function forgedCopy(event: NostrEvent): NostrEvent {
  return { ...event, content: "not what was signed" };
}

/** A relay socket answering every REQ with `answer`, or with nothing. */
function fakeRelays(answers: Record<string, NostrEvent | undefined>) {
  return class {
    onopen?: () => void;
    onmessage?: (msg: { data: string }) => void;
    onerror?: () => void;
    constructor(private url: string) {
      queueMicrotask(() => this.onopen?.());
    }
    send(frame: string) {
      const [, subId] = JSON.parse(frame) as [string, string];
      const answer = answers[this.url];
      queueMicrotask(() => {
        if (answer) this.onmessage?.({ data: JSON.stringify(["EVENT", subId, answer]) });
        this.onmessage?.({ data: JSON.stringify(["EOSE", subId]) });
      });
    }
    close() {}
  };
}

function loadWorker(scope: "group" | undefined = "group") {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const self = {
    location: { origin: "https://armada.buzz" },
    registration: {
      showNotification: vi.fn(async (_title: string, _options?: unknown) => undefined),
      pushManager: { getSubscription: async () => null, subscribe: vi.fn() },
    },
    clients: { matchAll: vi.fn(async () => []), claim: vi.fn(), openWindow: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener(name: string, handler: (event: unknown) => unknown) {
      handlers.set(name, handler);
    },
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("caches", { has: vi.fn(async () => false), keys: vi.fn(async () => []) });
  // The real runtime's contract: a forged event is dropped, a sound one is presented.
  const runtime: PushRuntime = {
    preparePush: async (data) => {
      const event = data.event as NostrEvent;
      const shown: PreparedPush = {
        tag: "room",
        url: "/",
        title: "Ana",
        line: event.content,
        icon: "/favicon.png",
        badge: "/badge-96.png",
        timestamp: 0,
        accumulate: false,
      };
      return verifyEvent(event) ? shown : { ...shown, drop: true };
    },
    pushScope: () => scope,
    openConfig: async () => null,
    verifyEvent,
  };
  installServiceWorker(runtime);

  async function push(payload: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> | undefined;
    (handlers.get("push") as (e: unknown) => void)({
      // As off the wire: no in-memory verification mark survives.
      data: { json: () => JSON.parse(JSON.stringify(payload)), text: () => "" },
      waitUntil: (p: Promise<unknown>) => { pending = p; },
    });
    await pending;
  }
  const napp = (fields: Record<string, unknown>) => push({ $type: "napp.push.payload", ...fields });
  const titles = () => self.registration.showNotification.mock.calls.map((call) => call[0]);
  const bodies = () =>
    self.registration.showNotification.mock.calls.map((call) => (call[1] as { body?: string } | undefined)?.body);
  return { push, napp, titles, bodies };
}

describe("a forged event in a push", () => {
  it("does not spend the id of the event it copies", async () => {
    const real = groupMessage("hello");
    const w = loadWorker();
    await w.napp({ event_id: real.id, event: forgedCopy(real), relays: [RELAY] });
    expect(w.titles()).not.toContain("Ana");

    await w.napp({ event_id: real.id, event: real, relays: [RELAY] });
    expect(w.titles()).toContain("Ana");
    expect(w.bodies()).toContain("hello");
  });

  it("is passed over when a relay answers a fetch with it", async () => {
    const real = groupMessage("hello");
    vi.stubGlobal("WebSocket", fakeRelays({ "wss://forger.example": forgedCopy(real), "wss://honest.example": real }));
    const w = loadWorker();
    await w.napp({ event_id: real.id, relays: ["wss://forger.example", "wss://honest.example"] });
    expect(w.titles()).toContain("Ana");
    expect(w.bodies()).not.toContain("not what was signed");
  });

  it("is never shown as the text of a legacy wake-up", async () => {
    const real = groupMessage("hello");
    vi.stubGlobal("WebSocket", fakeRelays({ [RELAY]: forgedCopy(real) }));
    const w = loadWorker();
    await w.push({ title: "New message", body: "x", data: { scope: "group", event_id: real.id, relays: [RELAY] } });
    expect(w.bodies()).not.toContain("not what was signed");
  });
});

describe("a malformed event in a push", () => {
  it.each([
    ["tags that are not a list", 5],
    ["a tag that is not a list", [null]],
  ])("still shows a notification for %s", async (_name, tags) => {
    const id = "a".repeat(64);
    const w = loadWorker(undefined);
    await w.napp({ event_id: id, event: { id, kind: 9, content: "", tags }, relays: [RELAY] });
    expect(w.titles()).toHaveLength(1);

    await w.push({ title: "New message", body: "x", data: { scope: "group", event_id: "b".repeat(64), relays: [RELAY], event: { id, tags } } });
    expect(w.titles()).toHaveLength(2);
  });
});
