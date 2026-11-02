import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

// Jumping to a reply's old parent opens a detached run of history around it,
// which then reads forward toward the present. The target must stay on screen
// while those newer rows arrive, rather than being carried off by them.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/jump-to-message.spec.ts

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

test.use({ viewport: { width: 1200, height: 800 } });

test("a jump to an old message keeps it on screen while newer history loads", async ({ page }) => {
  test.setTimeout(180_000);
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), { self: me.pubkey, profiles: profilesOf([me, ana], now - 86400 * 3), messages: [] });

  const count = 400;
  const messages: ScriptedMessage[] = Array.from({ length: count }, (_, i) => ({
    key: `m${i}`,
    channel: 0,
    author: i % 2 ? ana.pubkey : me.pubkey,
    agoSec: (count - i) * 120 + 60,
    content: `message number ${i}`,
  }));
  messages.push({ channel: 0, author: ana.pubkey, agoSec: 30, content: "replying to an old one", quote: "m12" });
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "general" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("replying to an old one").isVisible().catch(() => false));

  const reply = page.locator("[data-event-id]").filter({ hasText: "replying to an old one" });
  await reply.getByText("message number 12").first().click();

  const target = page.locator("[data-event-id]").filter({ hasText: /^(?!.*replying).*message number 12(?!\d)/ });
  await expect(target).toBeInViewport();
  // Newer rows have read in below it by now; it must not have been scrolled away.
  await expect.poll(() => page.locator("[data-event-id]").filter({ hasText: "message number 40" }).count()).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await expect(target).toBeInViewport();
});
