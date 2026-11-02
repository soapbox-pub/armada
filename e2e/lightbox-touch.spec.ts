import { devices, expect, test, type CDPSession, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

import { loginAs, makePerson, profilesOf, settle } from "./screenshotWorld";

// The image lightbox's own touch gestures, on a phone-sized touch screen:
// double-tap zoom, a drag that keeps the zooming finger down, pinch, and the
// gallery swipe between images.
//
//   ARMADA_E2E_SINGLE_PROCESS=1 npx playwright test e2e/lightbox-touch.spec.ts

const now = Math.floor(Date.now() / 1000);

/** An 800×600 solid PNG, built here so the spec needs no fixture file. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...phone } = devices["Pixel 7"];
test.use(phone);

function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: Array<[number, number]>) {
  return cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
}

/** The open image's zoom transform as [x, y, scale]. */
async function zoom(page: Page): Promise<[number, number, number]> {
  const transform = await page.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>(".will-change-transform")];
    const current = slots.find((s) => s.style.transform === "translateX(0%)");
    return (current?.querySelector("img")?.parentElement as HTMLElement | null)?.style.transform ?? "";
  });
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
}

test("a lightbox image zooms, pans with the held zooming finger, pinches and swipes", async ({ page }) => {
  test.setTimeout(120_000);
  const me = makePerson("viewer", "", 286);
  const image = png(800, 600);
  await offline(page);
  await page.route("https://img.test/**", (r) => r.fulfill({ contentType: "image/png", body: image }));
  await loginAs(page, me);
  await page.goto("/e2e/screenshotSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeed));
  await page.evaluate((p) => window.__armadaSeed!(p), { self: me.pubkey, profiles: profilesOf([me], now - 86400), messages: [] });
  await page.goto("/e2e/concordSeed.html");
  await page.waitForFunction(() => Boolean(window.__armadaSeedConcordScript));
  const seeded = await page.evaluate((p) => window.__armadaSeedConcordScript!(p), {
    sk: Buffer.from(me.sk).toString("hex"),
    communities: [{
      name: "M",
      channels: [{ name: "general" }],
      messages: [{ channel: 0, author: me.pubkey, agoSec: 60, content: "pics https://img.test/a.png https://img.test/b.png" }],
    }],
  });
  const { communityId, channelIds } = seeded.communities[0];
  await page.goto(`/c/${communityId}/${channelIds[0]}`);
  await settle(page, () => page.locator("[data-event-id] img").last().isVisible().catch(() => false));
  await page.locator("[data-event-id] img").first().tap();
  await expect.poll(async () => (await zoom(page))[2]).toBe(1);

  const cdp = await page.context().newCDPSession(page);
  const { width, height } = page.viewportSize()!;
  const [cx, cy] = [width / 2, height / 2];

  // Double-tap, keeping the second finger down, then drag with it.
  await touch(cdp, "touchStart", [[cx, cy]]);
  await touch(cdp, "touchEnd", []);
  await page.waitForTimeout(80);
  await touch(cdp, "touchStart", [[cx, cy]]);
  await expect.poll(async () => (await zoom(page))[2]).toBe(2.5);
  for (let i = 1; i <= 10; i++) await touch(cdp, "touchMove", [[cx + i * 8, cy]]);
  expect((await zoom(page))[0]).toBeGreaterThan(0);

  // A second finger joins: pinch out.
  await touch(cdp, "touchStart", [[cx + 80, cy], [cx + 160, cy]]);
  for (let i = 1; i <= 10; i++) await touch(cdp, "touchMove", [[cx + 80 - i * 4, cy], [cx + 160 + i * 4, cy]]);
  await touch(cdp, "touchEnd", []);
  expect((await zoom(page))[2]).toBeGreaterThan(2.5);

  // Double-tap back to fit, then swipe to the next image.
  await page.waitForTimeout(350);
  await touch(cdp, "touchStart", [[cx, cy]]);
  await touch(cdp, "touchEnd", []);
  await page.waitForTimeout(80);
  await touch(cdp, "touchStart", [[cx, cy]]);
  await touch(cdp, "touchEnd", []);
  await expect.poll(async () => (await zoom(page))[2]).toBe(1);
  await page.waitForTimeout(350);
  await touch(cdp, "touchStart", [[cx + 120, cy]]);
  for (let i = 1; i <= 12; i++) await touch(cdp, "touchMove", [[cx + 120 - i * 20, cy]]);
  await touch(cdp, "touchEnd", []);
  await expect(page.getByText("2 / 2")).toBeVisible();
});
