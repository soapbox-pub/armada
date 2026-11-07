import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, settle } from "./screenshotWorld";

// The vsk-13 Roster's editors in the routed app (CORD-04 §2, §8, CORD-03 §4): a
// ranked community the viewer owns, its Roles created, reordered and deleted,
// a Category made, and a Channel rule set, each read back from what the app
// stored once the relay took it.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/ranked-roles.spec.ts
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

async function boot(page: Page, ranked = true) {
  const me = makePerson("owner", "", 286);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcord));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcord!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    others: [],
    channelSizes: [1],
    lines: ["hello"],
    ranked,
  });
  return seeded;
}

test.use({ viewport: { width: 1200, height: 900 } });

test("roles are created, reordered and deleted on a ranked community", async ({ page }) => {
  test.setTimeout(180_000);
  const { communityId } = await boot(page);
  await page.goto(`/c/${communityId}/roles`);
  await settle(page, () => page.getByText("@everyone").isVisible().catch(() => false));

  for (const name of ["Mods", "Helpers"]) {
    await page.getByRole("button", { name: "Create role" }).click();
    await page.getByLabel("Role name").fill(name);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible({ timeout: 30_000 });
  }
  const order = () => page.locator("[data-role-row]").allInnerTexts();
  await expect.poll(async () => (await order()).map((t) => t.split("\n")[0].trim())).toEqual(["Mods", "Helpers"]);

  // Drag Helpers above Mods by its grip.
  const grip = page.getByRole("button", { name: "Reorder Helpers" });
  const target = page.locator("[data-role-row]").first();
  const from = (await grip.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await order()).map((t) => t.split("\n")[0].trim()), { timeout: 30_000 }).toEqual(["Helpers", "Mods"]);

  await page.getByRole("button", { name: /^Mods/ }).click();
  await page.getByRole("button", { name: "Delete role" }).click();
  await page.getByRole("button", { name: "Delete role" }).click();
  await expect.poll(async () => (await order()).map((t) => t.split("\n")[0].trim()), { timeout: 30_000 }).toEqual(["Helpers"]);

  // @everyone takes what the owner sets.
  await page.getByRole("button", { name: /^@everyone/ }).click();
  await expect(page.getByText("What every member holds, beneath every role.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("a Category is made and a Channel rule set from settings", async ({ page }) => {
  test.setTimeout(180_000);
  const { communityId, channelIds } = await boot(page);
  await page.goto(`/c/${communityId}/settings`);
  await settle(page, () => page.getByRole("button", { name: "Channels" }).isVisible().catch(() => false));
  await page.getByRole("button", { name: "Channels" }).click();

  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByLabel("Category name").fill("Text");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("No categories yet.")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Actions for Text" })).toBeVisible();

  // The general channel's menu opens its permissions.
  await page.getByRole("button", { name: "Actions for general" }).click();
  await page.getByRole("menuitem", { name: "Permissions" }).click();
  await expect(page.getByText("#general permissions")).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).nth(1).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Permissions saved").first()).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("Escape");

  // The empty Category shows in the sidebar, and a Channel files into it there.
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  const heading = page.getByRole("button", { name: "Text", exact: true });
  await settle(page, () => heading.isVisible().catch(() => false));
  await expect(heading).toBeVisible();
  const row = page.getByRole("button", { name: /general/ }).first();
  const above = async () => ((await heading.boundingBox())!.y < (await row.boundingBox())!.y);
  expect(await above()).toBe(false);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to category" }).hover();
  await page.getByRole("menuitem", { name: "Text" }).click();
  await expect.poll(above, { timeout: 30_000 }).toBe(true);

  // A drag drops a Channel into an empty Category (CORD-03 §4).
  await page.goto(`/c/${communityId}/settings`);
  await settle(page, () => page.getByRole("button", { name: "Channels" }).isVisible().catch(() => false));
  await page.getByRole("button", { name: "Channels" }).click();
  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByLabel("Category name").fill("Voice");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Actions for Voice" })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  const voice = page.getByRole("button", { name: "Voice", exact: true });
  await settle(page, () => voice.isVisible().catch(() => false));
  await expect(voice).toBeVisible();
  const general = page.getByRole("button", { name: /general/ }).first();
  const start = (await general.boundingBox())!;
  await page.mouse.move(start.x + 20, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 40, { steps: 5 });
  const slot = page.locator("[data-ch-empty]");
  await expect(slot).toHaveCount(1);
  const box = (await slot.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await voice.boundingBox())!.y < (await general.boundingBox())!.y, { timeout: 30_000 }).toBe(true);
});

test("the owner switches a legacy community to ranked roles", async ({ page }) => {
  test.setTimeout(180_000);
  const { communityId } = await boot(page, false);
  await page.goto(`/c/${communityId}/roles`);
  const offer = page.getByRole("button", { name: "Switch to ranked roles" });
  await settle(page, () => offer.isVisible().catch(() => false));
  await offer.click();
  await page.getByRole("button", { name: "Switch now" }).click();
  await expect(page.getByText("@everyone")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Create role" })).toBeEnabled();
});

test("the switch carries Armada's categories and channel order across", async ({ page }) => {
  test.setTimeout(180_000);
  const me = makePerson("owner", "", 286);
  await offline(page);
  await loginAs(page, me);
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{
      name: "Harbor",
      channels: [{ name: "general" }, { name: "lounge", category: "Voice" }, { name: "news", category: "Text" }, { name: "studio", category: "Voice" }],
      messages: [{ channel: 0, author: me.pubkey, agoSec: 60, content: "hello" }],
    }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  const sidebar = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-ch-slot], button[aria-expanded]")]
        .map((el) => (el.getAttribute("aria-expanded") !== null ? `#${el.textContent?.trim()}` : el.textContent?.trim().split("\n")[0] ?? ""))
        .filter((t) => ["general", "lounge", "news", "studio", "#Voice", "#Text"].includes(t)),
    );
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByRole("button", { name: "Voice", exact: true }).isVisible().catch(() => false));
  const before = await sidebar();
  expect(before).toEqual(["general", "#Voice", "lounge", "studio", "#Text", "news"]);

  await page.goto(`/c/${communityId}/roles`);
  const offer = page.getByRole("button", { name: "Switch to ranked roles" });
  await settle(page, () => offer.isVisible().catch(() => false));
  await offer.click();
  await page.getByRole("button", { name: "Switch now" }).click();
  await expect(page.getByText("@everyone")).toBeVisible({ timeout: 60_000 });

  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByRole("button", { name: "Voice", exact: true }).isVisible().catch(() => false));
  await expect.poll(sidebar, { timeout: 30_000 }).toEqual(before);
});
