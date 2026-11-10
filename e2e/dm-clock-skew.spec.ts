import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { getEventHash, matchFilters, type Filter, type NostrEvent } from "nostr-tools";
import { createRumor, createSeal, createWrap, unwrapEvent } from "nostr-tools/nip59";

import { dismissRestore, loginAs, makePerson, profilesOf, settle, type Person } from "./screenshotWorld";

// A NIP-17 DM whose sender's clock runs behind the viewer's: it must still land
// after the message it answers, count as unread and notify.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/dm-clock-skew.spec.ts

const RELAY = "wss://relay.test/";
const now = Math.floor(Date.now() / 1000);

/** A one-relay fake: stores what it's given, answers REQs, pushes live to open subs. */
function fakeRelay(page: Page) {
  const events: NostrEvent[] = [];
  const subs = new Map<WebSocketRoute, Map<string, Filter[]>>();
  const reqs: Filter[][] = [];
  const route = page.context().routeWebSocket((url) => !url.hostname.includes("localhost"), (ws) => {
    subs.set(ws, new Map());
    ws.onMessage((msg) => {
      if (typeof msg !== "string") return;
      try {
        const [verb, ...args] = JSON.parse(msg) as [string, ...unknown[]];
        if (verb === "REQ") {
          const [id, ...filters] = args as [string, ...Filter[]];
          reqs.push(filters);
          subs.get(ws)!.set(id, filters);
          for (const ev of events) if (matchFilters(filters, ev)) ws.send(JSON.stringify(["EVENT", id, ev]));
          ws.send(JSON.stringify(["EOSE", id]));
        } else if (verb === "CLOSE") {
          subs.get(ws)!.delete(args[0] as string);
        } else if (verb === "EVENT") {
          const ev = args[0] as NostrEvent;
          events.push(ev);
          ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        }
      } catch {
        // not a Nostr frame
      }
    });
    ws.onClose(() => subs.delete(ws));
  });
  return {
    route,
    reqs,
    events,
    publish(ev: NostrEvent) {
      events.push(ev);
      for (const [ws, byId] of subs) {
        for (const [id, filters] of byId) {
          if (matchFilters(filters, ev)) ws.send(JSON.stringify(["EVENT", id, ev]));
        }
      }
    },
  };
}

function dmWrap(from: Person, to: Person, content: string, createdAt: number) {
  const rumor = createRumor({ kind: 14, created_at: createdAt, content, tags: [["p", to.pubkey]] }, from.sk);
  return { rumor, wrap: createWrap(createSeal(rumor, from.sk, to.pubkey), to.pubkey) };
}

test.use({ viewport: { width: 1200, height: 800 } });

test("a reply from a sender whose clock runs slow is placed, counted and notified on arrival", async ({ page, context }) => {
  test.setTimeout(240_000);
  const me = makePerson("viewer", "", 286);
  const peer = makePerson("peer", "", 20);
  const relay = fakeRelay(page);
  await relay.route;

  await context.grantPermissions(["notifications"]);
  await context.addInitScript(() => {
    const w = window as unknown as { __notified: string[] };
    w.__notified = [];
    const Real = window.Notification;
    const Fake = function (this: unknown, title: string, opts?: NotificationOptions) {
      w.__notified.push(`${title}: ${opts?.body ?? ""}`);
      return new Real(title, opts);
    } as unknown as typeof Notification;
    Object.defineProperty(Fake, "permission", { get: () => Real.permission });
    Fake.requestPermission = Real.requestPermission.bind(Real);
    window.Notification = Fake;
    // The notifier's sound plays at ingest, before any OS-permission or focus gate.
    HTMLMediaElement.prototype.play = function () {
      w.__notified.push(`sound: ${this.src.split("/").pop()}`);
      return Promise.resolve();
    };
    const show = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) {
      w.__notified.push(`${title}: ${opts?.body ?? ""}`);
      return show.call(this, title, opts);
    };
  });
  await context.addInitScript(([pk, relayUrl]) => {
    localStorage.setItem(`armada:app-config:${pk}`, JSON.stringify({ dmRelays: [relayUrl], useAppRelays: false, automaticSettingsSync: false }));
    localStorage.setItem("armada:notification-sound", JSON.stringify({ enabled: true }));
  }, [me.pubkey, RELAY] as const);
  await loginAs(page, me);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  const seeded = [
    { pubkey: peer.pubkey, kind: 14, created_at: now - 600, tags: [["p", me.pubkey]], content: "hello from peer" },
    { pubkey: me.pubkey, kind: 14, created_at: now - 5, tags: [["p", peer.pubkey]], content: "my latest message" },
  ];
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, peer], now - 86400),
    messages: seeded.map((e) => ({
      rumorId: getEventHash(e), author: e.pubkey, peers: [peer.pubkey], tags: e.tags,
      content: e.content, createdAt: e.created_at, kind: 14,
    })),
    mainRumors: [{ id: "f".repeat(64), pubkey: me.pubkey, kind: 3, created_at: now - 3600, content: "", tags: [["p", peer.pubkey]] }],
  });

  // Read the conversation: the read stamp becomes the newest message's created_at.
  await page.goto(`/dm/${peer.npub}`);
  await settle(page, () => page.getByText("my latest message").last().isVisible().catch(() => false));
  await dismissRestore(page);
  await expect(page.getByText("my latest message").last()).toBeVisible();
  const readStamp = () => page.evaluate((pk) => {
    const raw = localStorage.getItem(`armada:read-state:${pk}`);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  }, me.pubkey);
  await expect.poll(async () => (await readStamp())[`dm:${peer.pubkey}`]).toBe(now - 5);
  await expect.poll(() => relay.reqs.some((fs) => fs.some((f) => f.kinds?.includes(1059)))).toBe(true);

  // Leave the room so it isn't the active one.
  // Client-side, so the session (and its notifier) survives.
  await page.evaluate(() => {
    history.pushState({}, "", "/settings");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/settings");
  await page.waitForTimeout(2000);

  // The peer's clock runs two minutes slow: their reply is dated before the viewer's message.
  relay.publish(dmWrap(peer, me, "skewed reply", Math.floor(Date.now() / 1000) - 120).wrap);
  const notified = () => page.evaluate(() => (window as unknown as { __notified: string[] }).__notified.slice());
  await expect.poll(notified, { timeout: 20_000 }).toContain("peer: skewed reply");
  await expect(page.getByLabel(/1 unread message/)).toBeVisible();

  // Read where it arrived, after the message it answers.
  await page.goto(`/dm/${peer.npub}`);
  await settle(page, () => page.getByText("skewed reply").last().isVisible().catch(() => false));
  const order = (await page.locator("[data-event-id]").allInnerTexts()).map((t) =>
    t.includes("skewed reply") ? "skewed" : t.includes("my latest message") ? "mine" : t.includes("hello from peer") ? "hello" : "?");
  expect(order).toEqual(["hello", "mine", "skewed"]);
});

test("a browser whose clock runs slow dates what it sends by the corrected clock", async ({ page, context }) => {
  test.setTimeout(240_000);
  const me = makePerson("viewer", "", 286);
  const peer = makePerson("peer", "", 20);
  const relay = fakeRelay(page);
  await relay.route;

  // The page's clock runs 30 minutes slow; the dev server's `Date` is the truth.
  await context.addInitScript(() => {
    const RealDate = Date;
    const skew = -30 * 60_000;
    class SlowDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) super(RealDate.now() + skew);
        else super(...args);
      }
      static now() {
        return RealDate.now() + skew;
      }
    }
    (window as unknown as { Date: DateConstructor }).Date = SlowDate as DateConstructor;
  });
  await context.addInitScript(([pk, relayUrl]) => {
    localStorage.setItem(`armada:app-config:${pk}`, JSON.stringify({ dmRelays: [relayUrl], useAppRelays: false, automaticSettingsSync: false }));
  }, [me.pubkey, RELAY] as const);
  await loginAs(page, me);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  const hello = { pubkey: peer.pubkey, kind: 14, created_at: now - 600, tags: [["p", me.pubkey]], content: "hello from peer" };
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, peer], now - 86400),
    messages: [{ rumorId: getEventHash(hello), author: hello.pubkey, peers: [peer.pubkey], tags: hello.tags, content: hello.content, createdAt: hello.created_at, kind: 14 }],
    mainRumors: [{ id: "f".repeat(64), pubkey: me.pubkey, kind: 3, created_at: now - 3600, content: "", tags: [["p", peer.pubkey]] }],
  });
  await page.goto(`/dm/${peer.npub}`);
  await settle(page, () => page.getByText("hello from peer").last().isVisible().catch(() => false));
  await dismissRestore(page);
  // The clock is first sampled 5 s after the wire mounts.
  await page.waitForTimeout(8_000);

  const field = page.getByRole("textbox").last();
  await field.click();
  await field.fill("sent from a slow clock");
  await field.press("Enter");

  const sentAt = () => {
    for (const ev of relay.events) {
      if (ev.kind !== 1059 || !ev.tags.some(([n, v]) => n === "p" && v === peer.pubkey)) continue;
      try {
        const rumor = unwrapEvent(ev, peer.sk);
        if (rumor.content === "sent from a slow clock") return rumor.created_at;
      } catch {
        // not for the peer
      }
    }
    return undefined;
  };
  await expect.poll(sentAt, { timeout: 30_000 }).not.toBeUndefined();
  expect(Math.abs(sentAt()! - Math.floor(Date.now() / 1000))).toBeLessThan(15);
});
