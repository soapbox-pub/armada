import { expect, test, type Page } from "@playwright/test";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

import type { ScriptedMessage } from "./concordSeed";

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

async function bootChannel(page: Page) {
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);
  await offline(page);
  await page.route("https://emoji.test/**", (r) => r.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="orange"/></svg>',
  }));
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, ana], now - 86400),
    messages: [],
    // A custom emoji palette (kind 10030) for the viewer.
    mainRumors: [{
      id: "e".repeat(64), pubkey: me.pubkey, kind: 10030, created_at: now - 3600, content: "",
      tags: [["emoji", "blob", "https://emoji.test/blob.png"]],
    }],
  });
  const messages: ScriptedMessage[] = [{ channel: 0, author: ana.pubkey, agoSec: 60, content: "hello" }];
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{ name: "M", channels: [{ name: "general" }], messages }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.getByText("hello").isVisible().catch(() => false));

}

test.use({ viewport: { width: 1200, height: 800 } });

// The composer shows mentions as `@Name` and custom emoji as their image, and
// sends both in their canonical spelling (`nostr:npub1…`, `:shortcode:`).
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/composer-mentions.spec.ts

test("typing after a picked mention keeps it", async ({ page }) => {
  test.setTimeout(120_000);
  await bootChannel(page);
  const field = page.getByRole("textbox").last();
  await field.click();
  await page.keyboard.type("hi @an");
  await expect(page.locator("[data-mention-item]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("hi @ana ");

  // The name may resolve while the keystrokes land; the mention must survive both.
  await page.keyboard.type("xyz more");
  await expect(field).toHaveValue("hi @ana xyz more");

  await page.keyboard.press("Enter");
  const sent = page.locator("[data-event-id]").filter({ hasText: "xyz more" });
  await expect(sent.getByRole("button", { name: "@ana" })).toBeVisible();
});

test("a custom emoji shows as its image and is sent as its shortcode", async ({ page }) => {
  test.setTimeout(120_000);
  await bootChannel(page);

  const field = page.getByRole("textbox").last();
  await field.click();
  await page.keyboard.type("hi :blob: there");
  await expect(field).toHaveValue("hi \u2B1C there");
  await expect(page.locator(".rt-overlay img[alt=':blob:']")).toBeVisible();

  // One backspace takes the whole emoji.
  await page.keyboard.press("End");
  for (let i = 0; i < " there".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect(field).toHaveValue("hi  there");
  await page.keyboard.type(":blob:");

  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const sent = page.locator("[data-event-id]").filter({ hasText: "there" });
  await expect(sent.locator("img[alt=':blob:']")).toBeVisible();
});

// Reduce motion is on whenever the OS asks for it. Its stylesheet once gave
// every element a 0.01ms transition, so the overlay read back its pre-write
// font size, divided it out as a text zoom, and drew the text smaller than the
// textarea under it: the caret drifted further from the glyphs with every word.
test("the overlay keeps the textarea's font under Reduce motion", async ({ page }) => {
  test.setTimeout(120_000);
  await page.context().addInitScript(() => localStorage.setItem("armada:reduce-effects", "1"));
  await bootChannel(page);
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "");

  const field = page.getByRole("textbox").last();
  await field.click();
  await page.keyboard.type("adwjdi wdwdwdw wdwd   wdwdwd wdwd");

  const fonts = await page.evaluate(() => {
    const textarea = [...document.querySelectorAll<HTMLTextAreaElement>("textarea.rt-input")].pop()!;
    const inner = textarea.parentElement!.querySelector<HTMLElement>(".rt-inner")!;
    const piece = inner.querySelector<HTMLElement>(".rt-piece")!;
    return [getComputedStyle(textarea).font, getComputedStyle(inner).font, getComputedStyle(piece).fontSize];
  });
  expect(fonts[1]).toBe(fonts[0]);
  expect(fonts[0]).toContain(fonts[2]);
});

// A theme font that needs no download changes the textarea's font without a
// resize or a `loadingdone`; the overlay must follow it all the same.
test("the overlay follows a theme font that needs no loading", async ({ page }) => {
  test.setTimeout(120_000);
  await bootChannel(page);
  const field = page.getByRole("textbox").last();
  await field.click();
  await page.keyboard.type("adwjdi wdwdwdw wdwd");
  await page.evaluate(() => document.documentElement.style.setProperty("--theme-font", "monospace"));

  const fonts = () => page.evaluate(() => {
    const textarea = [...document.querySelectorAll<HTMLTextAreaElement>("textarea.rt-input")].pop()!;
    const inner = textarea.parentElement!.querySelector<HTMLElement>(".rt-inner")!;
    return [getComputedStyle(textarea).fontFamily, getComputedStyle(inner).fontFamily];
  });
  await expect.poll(async () => (await fonts())[0]).toContain("monospace");
  const [textareaFont, overlayFont] = await fonts();
  expect(overlayFont).toBe(textareaFont);
});
