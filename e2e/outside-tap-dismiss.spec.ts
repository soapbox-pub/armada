import { devices, expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

// On a touch screen, a tap outside the profile card or a reaction's "who
// reacted" detail only dismisses it: it must not also open the link beneath.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/outside-tap-dismiss.spec.ts

const now = Math.floor(Date.now() / 1000);

async function offline(page: Page) {
  await page.context().routeWebSocket(/.*/, (ws) => {
    ws.onMessage((msg) => {
      if (typeof msg !== "string") return;
      try {
        const [verb, arg] = JSON.parse(msg) as [string, unknown];
        if (verb === "REQ") ws.send(JSON.stringify(["EOSE", arg]));
        if (verb === "EVENT") ws.send(JSON.stringify(["OK", (arg as { id: string }).id, true, ""]));
      } catch {
        // not a Nostr frame
      }
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...phone } = devices["Pixel 7"];
test.use(phone);

function touch(cdp: CDPSession, type: "touchStart" | "touchEnd", points: Array<[number, number]>) {
  return cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
}

async function bootChannel(page: Page) {
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  const ben = makePerson("ben", "", 200);
  await offline(page);
  await loginAs(page, me);

  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, ana, ben], now - 86400),
    messages: [],
  });

  const messages: ScriptedMessage[] = [
    { key: "hello", channel: 0, author: ana.pubkey, agoSec: 600, content: "hello there" },
    { channel: 0, kind: 7, author: ben.pubkey, agoSec: 550, content: "👍", target: "hello" },
    // Far enough below that neither popover covers the link.
    ...Array.from({ length: 6 }, (_, i): ScriptedMessage => ({
      channel: 0,
      author: me.pubkey,
      agoSec: 540 - i * 5,
      content: `filler ${i + 1}`,
    })),
    { channel: 0, author: ben.pubkey, agoSec: 500, content: "see https://outside.test/page" },
  ];
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "Taps", channels: [{ name: "general" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  const link = page.locator('a[href="https://outside.test/page"]').first();
  await settle(page, () => link.isVisible().catch(() => false));
  await expect(link).toBeVisible();

  const opened: string[] = [];
  page.context().on("page", (p) => opened.push(p.url()));
  await page.context().route("https://outside.test/**", (r) => {
    opened.push(r.request().url());
    return r.fulfill({ body: "" });
  });
  return { link, opened };
}

async function tapCenter(cdp: CDPSession, page: Page, target: Locator, holdMs = 0, avoid?: Locator) {
  const box = (await target.boundingBox())!;
  const point: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
  const over = avoid && (await avoid.boundingBox());
  if (over) {
    const inside = point[0] >= over.x && point[0] <= over.x + over.width && point[1] >= over.y && point[1] <= over.y + over.height;
    expect(inside, "the tap must land outside the popover").toBe(false);
  }
  await touch(cdp, "touchStart", [point]);
  if (holdMs) await page.waitForTimeout(holdMs);
  await touch(cdp, "touchEnd", []);
}

test("a tap outside the profile card only dismisses it", async ({ page }) => {
  test.setTimeout(120_000);
  const { link, opened } = await bootChannel(page);
  const cdp = await page.context().newCDPSession(page);

  await page.getByRole("button", { name: "ana" }).last().tap();
  const card = page.getByRole("dialog");
  await expect(card).toBeVisible();

  await tapCenter(cdp, page, link, 0, card);
  await expect(card).toBeHidden();
  await page.waitForTimeout(500);
  expect(opened).toEqual([]);
});

test("a tap outside a reaction's detail only dismisses it", async ({ page }) => {
  test.setTimeout(120_000);
  const { link, opened } = await bootChannel(page);
  const cdp = await page.context().newCDPSession(page);

  const pill = page.getByRole("button", { name: /👍, 1 reaction/ });
  await tapCenter(cdp, page, pill, 700);
  const detail = page.getByRole("dialog");
  await expect(detail).toBeVisible();
  await page.waitForTimeout(300);

  await tapCenter(cdp, page, link, 0, detail);
  await expect(detail).toBeHidden();
  await page.waitForTimeout(500);
  expect(opened).toEqual([]);
});
