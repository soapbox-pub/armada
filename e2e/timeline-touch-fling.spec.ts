import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

// A short fling up a channel that has only just opened must move the reader a
// few messages, not days. iOS momentum keeps its own position, so a scrollTop
// write made while it runs is overridden by its next frame: rows prepended above
// the reader then throw them back by their whole height, and each landing in the
// reveal band prepends again. The fling here models that momentum. Runs in WebKit:
//
//   npx playwright test e2e/timeline-touch-fling.spec.ts
//
// FLING_MOMENTUM=honored models momentum continuing from wherever JS put it.

test.use({
  browserName: "webkit",
  launchOptions: { args: [] },
  viewport: { width: 1200, height: 800 },
  // Playwright's Linux WebKit hangs its main thread once sw.js registers.
  serviceWorkers: "block",
});

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

/** The "message number N" at the top of the timeline's viewport. */
function topMessage(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[class*="overflow-anchor"]')!;
    const box = scroller.getBoundingClientRect();
    for (let y = box.top + 4; y < box.bottom; y += 16) {
      const row = document.elementFromPoint(box.left + box.width / 2, y)?.closest("[data-scroll-anchor]");
      const match = /message number (\d+)/.exec(row?.textContent ?? "");
      if (match) return Number(match[1]);
    }
    return null;
  });
}

test("a short fling while a channel opens moves the reader messages, not days", async ({ page }) => {
  test.setTimeout(180_000);
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), { self: me.pubkey, profiles: profilesOf([me, ana], now - 86400 * 10), messages: [] });

  // ~5.5 days of history at mixed heights.
  const count = 800;
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  const messages: ScriptedMessage[] = Array.from({ length: count }, (_, i) => ({
    channel: 0,
    author: i % 3 ? ana.pubkey : me.pubkey,
    agoSec: (count - i) * 600 + 60,
    content: `message number ${i} ${filler.repeat(i % 7 === 0 ? 6 : i % 3)}`,
  }));
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "general" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);

  // Fling the moment the first rows paint, while the opening window still grows.
  await page.waitForSelector("[data-scroll-anchor]", { timeout: 60_000 });
  const before = await topMessage(page);
  expect(before).toBeGreaterThan(780);

  // Finger down and dragging for a few frames, lifted into momentum, ~800px in all.
  await page.evaluate(async (owned) => {
    const scroller = document.querySelector<HTMLElement>('[class*="overflow-anchor"]')!;
    let v = 40;
    let pos = scroller.scrollTop;
    let lifted = false;
    scroller.dispatchEvent(new Event("touchstart"));
    for (let frame = 0; v > 0.5; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (frame === 6) {
        scroller.dispatchEvent(new Event("touchend"));
        lifted = true;
      }
      if (!owned) pos = scroller.scrollTop;
      pos -= v;
      v *= 0.95;
      scroller.scrollTop = pos;
      // Reaching the edge bounces and ends the momentum.
      if (pos <= 0) break;
    }
    if (!lifted) scroller.dispatchEvent(new Event("touchend"));
  }, process.env.FLING_MOMENTUM !== "honored");

  // Hands off: what was held back lands, and nothing may move the reader further.
  await page.waitForTimeout(1500);
  const after = await topMessage(page);
  await page.waitForTimeout(2500);
  expect(await topMessage(page)).toBe(after);
  expect(before! - after!).toBeLessThan(20);
});
