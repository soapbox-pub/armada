import { type Page } from "@playwright/test";
import { generateSecretKey, getEventHash, getPublicKey, nip19 } from "nostr-tools";

// Shared by the screenshot specs (`store-screenshots.spec.ts`,
// `landing-screenshots.spec.ts`): the seeded cast, and booting the real app
// logged in as one of them with no relay in the way.

export interface Person {
  sk: Uint8Array;
  pubkey: string;
  npub: string;
  /** The display handle, in the community register the app is actually used in. */
  name: string;
  about: string;
  hue: number;
}

/**
 * A self-contained SVG avatar (no network). Deliberately NOT initials-on-a-disc:
 * at 32px in the conversation list that reads as a placeholder, and every row
 * looking like a placeholder is what makes a seeded capture look seeded. This is
 * a deterministic two-tone glyph mark on a gradient, so the rows look like
 * pictures people actually chose.
 */
export function avatarDataUri(seed: string, hue: number): string {
  // Deterministic per handle, so re-running produces identical bytes.
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = `hsl(${hue} 62% 52%)`;
  const b = `hsl(${(hue + 38) % 360} 66% 34%)`;
  const shapes = [
    // A blocky arrow/chevron mark.
    `<path d="M34 78 L60 34 L86 78 L70 78 L60 60 L50 78 Z" fill="#fff" fill-opacity=".92"/>`,
    // Concentric rings.
    `<circle cx="60" cy="60" r="26" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="9"/>` +
      `<circle cx="60" cy="60" r="8" fill="#fff" fill-opacity=".9"/>`,
    // A pixel/dice cluster.
    `<g fill="#fff" fill-opacity=".9"><rect x="34" y="34" width="20" height="20" rx="4"/>` +
      `<rect x="66" y="34" width="20" height="20" rx="4"/>` +
      `<rect x="34" y="66" width="20" height="20" rx="4"/>` +
      `<rect x="66" y="66" width="20" height="20" rx="4" fill-opacity=".55"/></g>`,
    // A crescent/moon.
    `<path d="M74 30 a34 34 0 1 0 0 60 a27 27 0 1 1 0-60 Z" fill="#fff" fill-opacity=".92"/>`,
    // A stylised bolt.
    `<path d="M66 26 L38 66 L56 66 L50 94 L82 52 L62 52 Z" fill="#fff" fill-opacity=".92"/>`,
    // Stacked bars.
    `<g fill="#fff" fill-opacity=".9"><rect x="32" y="60" width="14" height="28" rx="4"/>` +
      `<rect x="53" y="44" width="14" height="44" rx="4"/>` +
      `<rect x="74" y="30" width="14" height="58" rx="4"/></g>`,
  ];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>` +
    `</linearGradient></defs>` +
    `<rect width="120" height="120" rx="60" fill="url(#g)"/>` +
    shapes[h % shapes.length] +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function makePerson(name: string, about: string, hue: number): Person {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey), name, about, hue };
}

/** Kind-0 rows for `__armadaSeed`, each with its generated avatar. */
export function profilesOf(people: Person[], createdAt: number) {
  return people.map((p) => {
    const content = JSON.stringify({ name: p.name, about: p.about, picture: avatarDataUri(p.name, p.hue) });
    const base = { pubkey: p.pubkey, kind: 0, created_at: createdAt, tags: [] as string[][], content };
    return { rumorId: getEventHash(base), pubkey: p.pubkey, createdAt: base.created_at, content };
  });
}

/** Set `armada:login` before any app code runs, so the app boots logged in. */
export async function loginAs(page: Page, me: Person) {
  const login = [
    {
      id: `nsec:${me.pubkey}`,
      type: "nsec",
      pubkey: me.pubkey,
      createdAt: new Date().toISOString(),
      data: { nsec: nip19.nsecEncode(me.sk) },
    },
  ];
  await page.context().addInitScript(
    ([loginJson, pubkey]) => {
      localStorage.setItem("armada:login", loginJson);
      localStorage.setItem("armada:active-pubkey", pubkey);
      // The one-time push opt-in covers the app and takes every click.
      localStorage.setItem("armada:webpush-prompt-shown", "1");
    },
    [JSON.stringify(login), me.pubkey] as const,
  );
}

/**
 * An account whose relay list can't be found offline gets a one-time "restore
 * your setup" interstitial, which can cover the app either before or after the
 * view paints. Dismiss it whenever it shows.
 */
export async function dismissRestore(page: Page): Promise<boolean> {
  const skip = page.getByText("Skip for now");
  if (await skip.isVisible().catch(() => false)) {
    await skip.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

/** Poll until `ready` paints, dismissing the interstitial as it appears. */
export async function settle(page: Page, ready: () => Promise<boolean>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await dismissRestore(page)) continue;
    if (await ready()) break;
    await page.waitForTimeout(500);
  }
}
