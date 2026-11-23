import { expect, test, type Page } from "@playwright/test";
import { getEventHash } from "nostr-tools";

import { loginAs, makePerson, profilesOf, settle, type Person } from "./screenshotWorld";

// Message requests and the stranger filter, on the real routed app over a seeded
// offline store. The viewer is in no community, so every stranger is a non-member:
// one who sent a link is filtered, one who didn't is a plain request.
// `ARMADA_SHOTS=<dir>` also saves a screenshot of each state there.
//
//   ARMADA_E2E_FULL_CHROMIUM=1 npx playwright test e2e/dm-requests.spec.ts

const now = Math.floor(Date.now() / 1000);
const shots = process.env.ARMADA_SHOTS;

async function shoot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function seedRequests(page: Page) {
  const me = makePerson("pixelwitch", "", 320);
  const genuine = makePerson("lanternfish", "", 190);
  const nitro = makePerson("nitro_gift", "", 10);
  const airdrop = makePerson("Airdrop Support", "", 40);
  const say = (from: Person, ago: number, content: string) => {
    const rumor = { pubkey: from.pubkey, kind: 14, created_at: now - ago, tags: [["p", me.pubkey]], content };
    return {
      rumorId: getEventHash(rumor),
      author: from.pubkey,
      peers: [from.pubkey],
      tags: rumor.tags,
      content,
      createdAt: rumor.created_at,
      kind: 14,
    };
  };
  const messages = [
    say(genuine, 600, "hey! saw your map in the Cartographers channel, mind if I ask how you made it?"),
    say(nitro, 300, "free nitro for you 🎁 nitro-gift.example/claim"),
    // A harmless follow-up doesn't clear an earlier link.
    say(airdrop, 900, "Claim your airdrop at https://airdrop.example/now"),
    say(airdrop, 120, "Hurry, offer ends today"),
  ];
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate(
    (p) => window.__armadaSeed!(p),
    { self: me.pubkey, profiles: profilesOf([me, genuine, nitro, airdrop], now - 3600), messages },
  );
  await page.goto("/dm");
  await settle(page, async () => page.getByText("Message requests").first().isVisible().catch(() => false));
}

for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const) {
  test.describe(label, () => {
    test.use({ viewport, ...(label === "phone" ? { hasTouch: true, isMobile: true } : {}) });

    test("filtered strangers sit behind their own section", async ({ page }) => {
      await seedRequests(page);
      await shoot(page, `${label}-inbox`);
      await page.getByText("Message requests").first().click();
      await expect(page.getByText("lanternfish")).toBeVisible();
      await expect(page.getByText("nitro_gift")).toBeHidden();
      await expect(page.getByText("Airdrop Support")).toBeHidden();
      await shoot(page, `${label}-requests`);

      await page.getByRole("button", { name: /filtered/i }).first().click();
      await expect(page.getByText("nitro_gift")).toBeVisible();
      await expect(page.getByText("Airdrop Support")).toBeVisible();
      await shoot(page, `${label}-filtered`);
    });
  });
}

// Below the `sidebar` breakpoint a desktop window keeps the list at its own width,
// so at Electron's minimum (480px) the empty pane is too narrow for its prompt.
test.describe("the narrowest desktop window", () => {
  test.use({ viewport: { width: 480, height: 800 } });

  test("drops the empty pane's prompt rather than clipping it", async ({ page }) => {
    await seedRequests(page);
    await expect(page.getByText("Select a conversation")).toBeHidden();
    await shoot(page, "narrow-inbox");
  });
});
