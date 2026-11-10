import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { getEventHash, matchFilters, type Filter, type NostrEvent } from "nostr-tools";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";

import { dismissRestore, loginAs, makePerson, profilesOf, settle, type Person } from "./screenshotWorld";

// Replication: a NIP-17 DM whose sender's clock runs behind the viewer's.
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

test("a reply from a sender whose clock is 2 minutes behind", async ({ page, context }) => {
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
  await page.waitForTimeout(3000);
  console.log("path", await page.evaluate(() => location.pathname));

  // Peer replies with a clock 30 minutes slow.
  const skewed = dmWrap(peer, me, "skewed reply", now + 20 - 120);
  relay.publish(skewed.wrap);
  await page.waitForTimeout(8000);
  const afterSkewed = {
    notified: await page.evaluate(() => (window as unknown as { __notified: string[] }).__notified.slice()),
    unreadBadges: await page.getByLabel(/unread message/).allTextContents(),
  };

  // Control: the same peer, correct clock.
  const onTime = dmWrap(peer, me, "on-time reply", Math.floor(Date.now() / 1000));
  relay.publish(onTime.wrap);
  await page.waitForTimeout(8000);
  const afterOnTime = {
    notified: await page.evaluate(() => (window as unknown as { __notified: string[] }).__notified.slice()),
    unreadBadges: await page.getByLabel(/unread message/).allTextContents(),
  };

  await page.goto(`/dm/${peer.npub}`);
  await settle(page, () => page.getByText("on-time reply").last().isVisible().catch(() => false));
  const order = await page.locator("[data-event-id]").allInnerTexts();

  console.log(JSON.stringify({ afterSkewed, afterOnTime, order: order.map((t) => t.replace(/\s+/g, " ").slice(0, 80)) }, null, 2));
});
