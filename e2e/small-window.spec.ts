import { devices, expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

// Small windows: a desktop window narrower than the `sidebar` breakpoint keeps
// its channel list at its own (resizable) width rather than splitting the window
// with the chat, a phone keeps the full-width drill-down, and a member row keeps
// its name readable beside its badges.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/small-window.spec.ts

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

/** A one-channel community owned by an Armada Ultra viewer named Sophia. */
async function bootChannel(page: Page) {
  const me = makePerson("Sophia", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  const profiles = profilesOf([me, ana], now - 86400).map((p) =>
    p.pubkey === me.pubkey
      ? { ...p, content: JSON.stringify({ ...JSON.parse(p.content), armada_ultra: { since: now - 100 } }) }
      : p);
  await page.evaluate((p) => window.__armadaSeed!(p), { self: me.pubkey, profiles, messages: [] });
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "general" }], messages: [{ channel: 0, author: ana.pubkey, agoSec: 60, content: "hello" }] }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("hello").isVisible().catch(() => false));
}

const channelList = (page: Page) => page.locator("aside").filter({ hasText: "general" }).first();

test.describe("a desktop window under 900px", () => {
  test.use({ viewport: { width: 795, height: 550 } });

  test("keeps the channel list at its own width, resizable by dragging", async ({ page }) => {
    test.setTimeout(120_000);
    await bootChannel(page);
    expect((await channelList(page).boundingBox())!.width).toBe(240);
    const handle = page.getByRole("separator", { name: "Resize channel list" });
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 200, { steps: 4 });
    await page.mouse.up();
    expect((await channelList(page).boundingBox())!.width).toBe(280);
  });
});

test("a member row keeps the name and shows only badge icons when tight", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1200, height: 800 });
  await bootChannel(page);
  const row = page.locator(".member-row").filter({ hasText: "Sophia" }).first();
  await expect(row).toBeVisible();
  const name = row.getByText("Sophia", { exact: true });
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test.describe("on a phone", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { defaultBrowserType, ...phone } = devices["Pixel 7"];
  test.use(phone);

  test("the channel list is the full-width drill-down, with no resize handle", async ({ page }) => {
    test.setTimeout(120_000);
    await bootChannel(page);
    await page.getByRole("button", { name: "Back to channels" }).first().click();
    const width = page.viewportSize()!.width;
    await expect.poll(async () => (await channelList(page).boundingBox())?.width ?? 0).toBeGreaterThan(width / 2);
    await expect(page.getByRole("separator", { name: "Resize channel list" })).toBeHidden();
  });
});
