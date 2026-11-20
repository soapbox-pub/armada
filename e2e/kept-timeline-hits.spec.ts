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
function scrollTop(page: Page) {
  return page.evaluate(() => {
    const shown = [...document.querySelectorAll<HTMLElement>('[class*="overflow-anchor"]')].find(
      (el) => !el.closest('[class*="content-visibility:hidden"]'),
    );
    return shown?.scrollTop ?? -1;
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

  // Let the opening scroll to the newest row land first.
  let before = -1;
  await expect.poll(async () => {
    const prev = before;
    await page.waitForTimeout(300);
    before = await scrollTop(page);
    return before > 0 && before === prev;
  }).toBe(true);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => scrollTop(page)).toBeLessThan(before - 200);
});
