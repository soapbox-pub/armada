import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, settle } from "./screenshotWorld";

// A member the owner has timed out (CORD-04 §8) is told so where the composer
// would be, rather than handed one whose posts every reader collapses.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/member-timeout.spec.ts
//
// Offline: every relay is answered here, taking every EVENT and serving nothing.

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

test.use({ viewport: { width: 1200, height: 900 } });

test("a timed-out member gets no composer in a channel", async ({ page }) => {
  test.setTimeout(180_000);
  const me = makePerson("member", "", 120);
  const owner = makePerson("owner", "", 286);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcord));
  const { communityId, channelIds } = await page.evaluate((p) => window.__armadaSeedConcord!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    ownerSk: Buffer.from(owner.sk).toString("hex"),
    timeoutViewerSecs: 3600,
    others: [],
    channelSizes: [1],
    lines: ["hello"],
    ranked: true,
  });
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("hello (#0)").isVisible().catch(() => false));
  await expect(page.getByText("hello (#0)")).toBeVisible();

  await expect(page.getByText(/You're timed out until/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "Message #general" })).toHaveCount(0);
});
