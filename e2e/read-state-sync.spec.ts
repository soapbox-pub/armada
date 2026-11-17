import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import { finalizeEvent, getEventHash, matchFilters, nip44, type Filter, type NostrEvent } from "nostr-tools";

import { dismissRestore, loginAs, makePerson, profilesOf, settle, type Person } from "./screenshotWorld";

// Two devices on one account, sharing the relays: a conversation read on one
// must stop being unread on the other, through the NIP-78 read-state documents.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/read-state-sync.spec.ts

const GOOD = ["wss://good-one.test/", "wss://good-two.test/"];
const ONION = "ws://unreachable.onion/";
const now = Math.floor(Date.now() / 1000);

function coordinate(ev: NostrEvent): string | undefined {
  const d = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
  if (ev.kind === 0 || ev.kind === 3 || (ev.kind >= 10000 && ev.kind < 20000)) return `${ev.kind}:${ev.pubkey}`;
  if (ev.kind >= 30000 && ev.kind < 40000) return `${ev.kind}:${ev.pubkey}:${d}`;
  return undefined;
}

/** Relays shared by every context: each URL its own store, NIP-01 replaceable supersession, live pushes. */
function relayWorld() {
  const stores = new Map<string, NostrEvent[]>();
  const subs = new Map<WebSocketRoute, { url: string; byId: Map<string, Filter[]> }>();
  const reqs: { url: string; filters: Filter[] }[] = [];
  const storeOf = (url: string) => {
    let store = stores.get(url);
    if (!store) stores.set(url, (store = []));
    return store;
  };
  const accept = (url: string, ev: NostrEvent): boolean => {
    const store = storeOf(url);
    if (store.some((held) => held.id === ev.id)) return false;
    const coord = coordinate(ev);
    if (coord) {
      const i = store.findIndex((held) => coordinate(held) === coord);
      if (i >= 0) {
        const held = store[i]!;
        if (held.created_at > ev.created_at || (held.created_at === ev.created_at && held.id < ev.id)) return false;
        store.splice(i, 1);
      }
    }
    store.push(ev);
    for (const [ws, sub] of subs) {
      if (sub.url !== url) continue;
      for (const [id, filters] of sub.byId) {
        if (matchFilters(filters, ev)) ws.send(JSON.stringify(["EVENT", id, ev]));
      }
    }
    return true;
  };
  /** `blocked`: URLs this device can't reach right now (closed on connect). */
  const attach = (context: BrowserContext, blocked: ReadonlySet<string>) => context.routeWebSocket((url) => !url.hostname.includes("localhost"), (ws) => {
    const url = ws.url().endsWith("/") ? ws.url() : `${ws.url()}/`;
    if (url === ONION || blocked.has(url)) {
      ws.close();
      return;
    }
    subs.set(ws, { url, byId: new Map() });
    ws.onMessage((msg) => {
      if (typeof msg !== "string") return;
      try {
        const [verb, ...args] = JSON.parse(msg) as [string, ...unknown[]];
        if (verb === "REQ") {
          const [id, ...filters] = args as [string, ...Filter[]];
          reqs.push({ url, filters });
          subs.get(ws)!.byId.set(id, filters);
          for (const ev of storeOf(url)) if (matchFilters(filters, ev)) ws.send(JSON.stringify(["EVENT", id, ev]));
          ws.send(JSON.stringify(["EOSE", id]));
        } else if (verb === "CLOSE") {
          subs.get(ws)?.byId.delete(args[0] as string);
        } else if (verb === "EVENT") {
          const ev = args[0] as NostrEvent;
          accept(url, ev);
          ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        }
      } catch {
        // not a Nostr frame
      }
    });
    ws.onClose(() => subs.delete(ws));
  });
  return { stores, reqs, accept, attach };
}

/** The account's settings root, as an existing Armada install published it. */
function settingsRoot(me: Person): NostrEvent {
  const root = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const bare = JSON.stringify({ v: 1, root, pad: "" });
  const plaintext = JSON.stringify({ v: 1, root, pad: " ".repeat(512 - Buffer.byteLength(bare)) });
  const key = nip44.getConversationKey(me.sk, me.pubkey);
  return finalizeEvent({
    kind: 30078,
    content: nip44.encrypt(plaintext, key),
    tags: [["d", "armada"]],
    created_at: now - 86400,
  }, me.sk);
}

function relayList(me: Person): NostrEvent {
  return finalizeEvent({
    kind: 10002,
    content: "",
    tags: [...GOOD.map((url) => ["r", url]), ["r", ONION, "write"]],
    created_at: now - 86400,
  }, me.sk);
}

async function device(
  browser: Browser,
  baseURL: string | undefined,
  world: ReturnType<typeof relayWorld>,
  me: Person,
  peers: Person[],
  list: NostrEvent,
  opts: { mobile: boolean; blocked?: ReadonlySet<string> },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    ...(opts.mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1200, height: 800 } }),
  });
  await world.attach(context, opts.blocked ?? new Set());
  const page = await context.newPage();
  await context.addInitScript(([pk, relayUrl, relays, listId, listAt]) => {
    if (localStorage.getItem(`armada:app-config:${pk}`)) return;
    localStorage.setItem(`armada:app-config:${pk}`, JSON.stringify({
      dmRelays: [relayUrl],
      useAppRelays: false,
      relayMetadata: { relays, updatedAt: listAt, eventId: listId, pubkey: pk },
    }));
  }, [
    me.pubkey,
    GOOD[0]!,
    [...GOOD.map((url) => ({ url, read: true, write: true })), { url: ONION, read: false, write: true }],
    list.id,
    list.created_at,
  ] as const);
  await loginAs(page, me);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  const messages = peers.map((peer, i) => {
    const hello = { pubkey: peer.pubkey, kind: 14, created_at: now - 600 + i, tags: [["p", me.pubkey]], content: `hello from ${peer.name}` };
    return { rumorId: getEventHash(hello), author: hello.pubkey, peers: [peer.pubkey], tags: hello.tags, content: hello.content, createdAt: hello.created_at, kind: 14 };
  });
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, ...peers], now - 86400),
    messages,
    mainRumors: [{ id: "f".repeat(64), pubkey: me.pubkey, kind: 3, created_at: now - 3600, content: "", tags: peers.map((peer) => ["p", peer.pubkey]) }],
  });
  return page;
}

const readStamps = (page: Page, pubkey: string) => page.evaluate((pk) => {
  const raw = localStorage.getItem(`armada:read-state:${pk}`);
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
}, pubkey);

async function openDms(page: Page) {
  await page.goto("/dm");
  await settle(page, () => page.getByText(/hello from/).first().isVisible().catch(() => false));
  await dismissRestore(page);
}

async function readConversation(page: Page, peer: Person) {
  await page.goto(`/dm/${peer.npub}`);
  await settle(page, () => page.getByText(`hello from ${peer.name}`).last().isVisible().catch(() => false));
}

/** The account-signed settings document an older Armada build left behind. */
function legacyReadState(me: Person): NostrEvent {
  const key = nip44.getConversationKey(me.sk, me.pubkey);
  return finalizeEvent({
    kind: 30078,
    content: nip44.encrypt(JSON.stringify({ readState: {} }), key),
    tags: [["d", "armada/read-state-recent"], ["title", "Armada Settings"]],
    created_at: now - 7 * 86400,
  }, me.sk);
}

test("a read whose write mints the settings root still reaches the other device", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  const ben = makePerson("ben", "", 120);
  const world = relayWorld();
  const list = relayList(me);
  const root = settingsRoot(me);
  const legacy = legacyReadState(me);
  // Both relays hold the account's list and an older build's settings; only the second holds the root.
  for (const url of GOOD) {
    world.accept(url, list);
    world.accept(url, legacy);
  }
  world.accept(GOOD[1]!, root);
  const roots = () => [...world.stores.values()].flat()
    .filter((ev) => ev.kind === 30078 && ev.pubkey === me.pubkey && ev.tags.some(([n, v]) => n === "d" && v === "armada"));

  const desktop = await device(browser, baseURL, world, me, [ana, ben], list, { mobile: false });
  await openDms(desktop);

  // The phone can reach only the first relay when it comes up.
  const mobileBlocked = new Set([GOOD[1]!]);
  const mobile = await device(browser, baseURL, world, me, [ana, ben], list, { mobile: true, blocked: mobileBlocked });
  await openDms(mobile);

  // The phone mints a root of its own while writing this read.
  await readConversation(mobile, ana);
  await expect.poll(async () => (await readStamps(mobile, me.pubkey))[`dm:${ana.pubkey}`]).toBe(now - 600);
  await expect.poll(() => new Set(roots().map((ev) => ev.id)).size, { timeout: 30_000 }).toBe(2);

  // The phone's network recovers.
  mobileBlocked.clear();
  await mobile.waitForTimeout(15_000);

  await readConversation(desktop, ben);
  await expect.poll(async () => (await readStamps(desktop, me.pubkey))[`dm:${ben.pubkey}`]).toBe(now - 599);

  const results = async () => ({
    desktopSeesAna: (await readStamps(desktop, me.pubkey))[`dm:${ana.pubkey}`] ?? 0,
    mobileSeesBen: (await readStamps(mobile, me.pubkey))[`dm:${ben.pubkey}`] ?? 0,
  });
  await expect.poll(results, { timeout: 60_000 }).toEqual({ desktopSeesAna: now - 600, mobileSeesBen: now - 599 });
});

test("a conversation read on one device is read on the other", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const me = makePerson("viewer", "", 286);
  const peer = makePerson("peer", "", 20);
  const world = relayWorld();
  const list = relayList(me);
  const root = settingsRoot(me);
  for (const url of GOOD) {
    world.accept(url, root);
    world.accept(url, list);
  }

  const desktop = await device(browser, baseURL, world, me, [peer], list, { mobile: false });
  const mobile = await device(browser, baseURL, world, me, [peer], list, { mobile: true });

  // Both devices idle on the DM list with the conversation unread.
  for (const page of [desktop, mobile]) await openDms(page);
  const key = `dm:${peer.pubkey}`;
  expect((await readStamps(mobile, me.pubkey))[key]).toBeUndefined();

  // The mobile device's standing self-state REQ is open before the desktop reads.
  await expect.poll(() => world.reqs.filter((r) => r.filters.some((f) => f.kinds?.includes(30078) && !f.authors?.includes(me.pubkey))).length)
    .toBeGreaterThanOrEqual(2);

  await readConversation(desktop, peer);
  await expect.poll(async () => (await readStamps(desktop, me.pubkey))[key]).toBe(now - 600);

  // Published under a derived key (4 s debounce).
  const derivedDocs = () => world.stores.get(GOOD[0]!)!.filter((ev) => ev.kind === 30078 && ev.pubkey !== me.pubkey);
  await expect.poll(() => derivedDocs().length, { timeout: 30_000 }).toBeGreaterThan(0);

  await expect.poll(async () => (await readStamps(mobile, me.pubkey))[key], { timeout: 30_000 }).toBe(now - 600);
});
