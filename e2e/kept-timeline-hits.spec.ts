import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

// A left channel's timeline stays mounted, hidden, in the same box as the shown one.
// Whatever their order in the DOM, presses and scrolls over the timeline must reach
// the shown channel, not a hidden one stacked over it.
//
//   ARMADA_E2E_FULL_CHROMIUM=1 npx playwright test e2e/kept-timeline-hits.spec.ts

test.use({ viewport: { width: 1200, height: 800 } });

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

/** The shown timeline's scroller: the one whose box isn't skipped. */
function shownScroller(page: Page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[class*="overflow-anchor"]')].find(
      (e) => !e.closest('[class*="content-visibility:hidden"]'),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 3, y: r.y + r.height / 2, top: el.scrollTop, height: el.scrollHeight };
  });
}

/** Wait out the opening's scroll to the newest row and its growing window. */
async function settledScroller(page: Page) {
  let last = "";
  let point = await shownScroller(page);
  await expect.poll(async () => {
    await page.waitForTimeout(300);
    point = await shownScroller(page);
    const key = JSON.stringify(point);
    const stable = point !== null && point.top > 0 && key === last;
    last = key;
    return stable;
  }, { timeout: 30_000 }).toBe(true);
  return point!;
}

/** How far the shown timeline's reader is above its bottom: older rows prepended on a scroll up move `scrollTop`, not this. */
function fromBottom(page: Page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[class*="overflow-anchor"]')].find(
      (e) => !e.closest('[class*="content-visibility:hidden"]'),
    );
    return el ? el.scrollHeight - el.clientHeight - el.scrollTop : -1;
  });
}

test("a hidden kept timeline doesn't take the shown one's scrolls and presses", async ({ page }) => {
  test.setTimeout(180_000);
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), { self: me.pubkey, profiles: profilesOf([me, ana], now - 86400 * 10), messages: [] });

  const count = 60;
  const messages: ScriptedMessage[] = [0, 1].flatMap((channel) =>
    Array.from({ length: count }, (_, i) => ({
      channel,
      author: i % 2 ? ana.pubkey : me.pubkey,
      agoSec: (count - i) * 600 + 60,
      content: `${channel ? "beta" : "alpha"} message ${i}`,
    })),
  );
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "alpha" }, { name: "beta" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  // Kept timelines are laid out in id order: leave the later id for the earlier one,
  // so the hidden timeline comes after the shown one.
  const [first, second] = channelIds[0] > channelIds[1] ? ["alpha", "beta"] : ["beta", "alpha"];

  await page.goto(`/c/${communityId}/${channelIds[first === "alpha" ? 0 : 1]}`);
  await settle(page, () => page.getByText(`${first} message ${count - 1}`, { exact: true }).isVisible().catch(() => false));
  await page.getByRole("button", { name: second, exact: true }).first().click();
  const last = page.getByText(`${second} message ${count - 1}`, { exact: true });
  await settle(page, () => last.isVisible().catch(() => false));

  // The newest row is what a press lands on, not the hidden timeline's box.
  const box = (await last.boundingBox())!;
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.textContent ?? "",
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toContain(`${second} message ${count - 1}`);

  await settledScroller(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => fromBottom(page)).toBeGreaterThan(200);
});

test("every channel of a category takes scrolls and presses while switching between them", async ({ page }) => {
  test.setTimeout(300_000);
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), { self: me.pubkey, profiles: profilesOf([me, ana], now - 86400 * 10), messages: [] });

  const names = ["general", "armada", "memes", "ditto-relay"];
  const count = 60;
  const messages: ScriptedMessage[] = names.flatMap((name, channel) =>
    Array.from({ length: count }, (_, i) => ({
      channel,
      author: i % 2 ? ana.pubkey : me.pubkey,
      agoSec: (count - i) * 600 + 60,
      content: `${name} message ${i}`,
    })),
  );
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: names.map((name) => ({ name, category: "Talk" })), messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText(`general message ${count - 1}`, { exact: true }).isVisible().catch(() => false));

  // Back and forth with the channel second in the category, then through the rest, so
  // the shown timeline has hidden ones on both sides of it in the kept order.
  for (const name of ["armada", "general", "armada", "memes", "armada", "ditto-relay", "memes", "general"]) {
    await page.getByRole("button", { name, exact: true }).first().click();
    await settle(page, () => page.getByText(`${name} message ${count - 1}`, { exact: true }).isVisible().catch(() => false));
    const at = await settledScroller(page);

    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return { hidden: Boolean(el?.closest('[class*="content-visibility:hidden"]')), text: el?.closest(".timeline-row")?.textContent ?? "" };
    }, [at.x, at.y]);
    expect(hit, name).toEqual({ hidden: false, text: expect.stringContaining(`${name} message`) });

    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(page.getByRole("menu"), name).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.mouse.move(at.x, at.y);
    const before = await fromBottom(page);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => fromBottom(page), { message: name }).toBeGreaterThan(before + 150);
  }
});
