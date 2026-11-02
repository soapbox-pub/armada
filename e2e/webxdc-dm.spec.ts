import { expect, test, type Page } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { getEventHash } from "nostr-tools/pure";

import { dismissRestore, loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

// A Mini App sent from Vector in a DM: a NIP-17 kind 15 whose decryption key,
// MIME and realtime topic are top-level tags (no imeta), shaped exactly as
// Vector's `sending.rs` builds it. It has to open.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/webxdc-dm.spec.ts

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

test("a Vector-sent webxdc in a DM opens", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("[Webxdc]")) errors.push(m.text());
  });
  const me = makePerson("viewer", "", 286);
  const ana = makePerson("ana", "", 20);

  const plain = Buffer.from(zipSync({
    "index.html": strToU8("<!doctype html><title>t</title><h1 id=hello>hello from vector</h1>"),
    "manifest.toml": strToU8('name = "Hello"\n'),
  }));
  const key = randomBytes(32);
  const nonce = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const url = `https://blossom.test/${createHash("sha256").update(encrypted).digest("hex")}`;

  await offline(page);
  await page.route("https://blossom.test/**", (r) => r.fulfill({ contentType: "application/octet-stream", body: encrypted }));
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  const tags = [
    ["p", me.pubkey],
    ["file-type", "application/vnd.webxdc+zip"],
    ["size", String(encrypted.length)],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", key.toString("hex")],
    ["decryption-nonce", nonce.toString("hex")],
    ["ox", createHash("sha256").update(plain).digest("hex")],
    ["name", "hello.xdc"],
    ["webxdc-topic", "VQXKPPHDRHHYAYRCI34H3V6GEQVQONAW3JXTGKD2SI64NKIOSFFQ"],
  ];
  const rumor = { pubkey: ana.pubkey, kind: 15, created_at: now - 60, tags, content: url };
  await page.evaluate((p) => window.__armadaSeed!(p), {
    self: me.pubkey,
    profiles: profilesOf([me, ana], now - 86400),
    messages: [{ rumorId: getEventHash(rumor), author: ana.pubkey, peers: [ana.pubkey], tags, content: url, createdAt: rumor.created_at, kind: 15 }],
    // Followed, so the file isn't held as a stranger's.
    mainRumors: [{ id: "f".repeat(64), pubkey: me.pubkey, kind: 3, created_at: now - 3600, content: "", tags: [["p", ana.pubkey]] }],
  });
  await page.goto(`/dm/${ana.pubkey}`);
  await settle(page, () => page.locator("[data-event-id]").first().isVisible().catch(() => false));
  await dismissRestore(page);

  await page.locator("[data-event-id]").first().getByRole("button", { name: "Launch" }).click();
  // The app's document is a frame inside the sandbox's own frame.
  await expect.poll(async () => {
    const frame = page.frames().find((f) => f.url().endsWith("/index.html"));
    return frame ? frame.locator("#hello").textContent().catch(() => null) : null;
  }).toBe("hello from vector");
  expect(errors).toEqual([]);
});
