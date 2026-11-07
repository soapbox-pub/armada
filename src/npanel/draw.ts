/**
 * The images Armada's link previews draw, on an `OffscreenCanvas` — in
 * npanel's sandbox, whose text is the gateway's fonts, or in a browser alike.
 * Both are 1200×630 on Armada's own sea, with the mark from `public/logo.svg`.
 */

import logoSvg from "../../public/logo.svg?raw";

import { drawEmojiMask } from "@/lib/avatarShape";

const WIDTH = 1200;
const HEIGHT = 630;

const SEA = "#100b15";
const SAND = "#f1e7d2";
const ROSE = "#fb4d96";
const CYAN = "#19e6e6";
// The card's JetBrains Mono, else the DejaVu npanel's image installs.
const MONO = `"JetBrains Mono", "DejaVu Sans Mono", monospace`;

/** A profile: the avatar, cut to its shape, as the mark's sail over its waves. */
export async function drawProfile(picture: string | undefined, shape: string | undefined, name: string): Promise<Blob> {
  const { canvas, ctx } = sea();
  const waterline = 520;

  // The sail alone, faint and filling the height behind the avatar, its foot
  // on the waves drawn below it. Its base is at 92.7 of the logo's 128.
  const markSize = 700;
  const sail = await loadSvg(logoSvg.replace(/<g fill="#19e6e6">[\s\S]*?<\/g>/, ""), markSize);
  if (sail) {
    ctx.globalAlpha = 0.12;
    ctx.drawImage(sail, (WIDTH - markSize) / 2, waterline - 8 - (92.7 / 128) * markSize);
    ctx.globalAlpha = 1;
  }

  const size = 340;
  await drawAvatar(ctx, picture, shape, name, (WIDTH - size) / 2, 110, size);

  waves(ctx, WIDTH / 2, waterline, 1.6);
  await lockup(ctx);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

/** A person's avatar cut to its shape, or ringed in rose when round, with its top-left at (x, y). */
async function drawAvatar(
  ctx: OffscreenCanvasRenderingContext2D,
  picture: string | undefined,
  shape: string | undefined,
  name: string,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  const avatar = new OffscreenCanvas(size, size);
  const actx = avatar.getContext("2d")!;
  const bitmap = picture ? await loadImage(picture) : null;
  if (bitmap) {
    drawCover(actx, bitmap, size, size);
  } else {
    // A monogram, as the app shows someone without a picture.
    actx.fillStyle = "#2a2133";
    actx.fillRect(0, 0, size, size);
    actx.fillStyle = SAND;
    actx.font = `bold ${Math.round(size * 0.47)}px ${MONO}`;
    actx.textAlign = "center";
    actx.textBaseline = "middle";
    actx.fillText([...name.trim()][0]?.toUpperCase() ?? "?", size / 2, size / 2 + size * 0.024);
  }

  const mask = shape ? drawEmojiMask(shape, (w, h) => new OffscreenCanvas(w, h), size) : null;
  actx.globalCompositeOperation = "destination-in";
  if (mask) {
    actx.drawImage(mask, 0, 0);
  } else {
    actx.beginPath();
    actx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    actx.fill();
  }

  if (!mask) {
    // A rose ring, set off from the avatar by a band of sea.
    const ring = size * 0.04;
    ctx.fillStyle = ROSE;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2 + ring, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SEA;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2 + ring * 0.57, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.drawImage(avatar, x, y);
}

/** An invite: the mark beside an invitation, as `public/og.svg` lays out the card. */
export async function drawInvite(): Promise<Blob> {
  const { canvas, ctx } = sea();

  const mark = await loadSvg(logoSvg, 256);
  if (mark) ctx.drawImage(mark, 112, 179);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SAND;
  ctx.font = `bold 84px ${MONO}`;
  ctx.fillText("you're invited", 400, 290);

  ctx.font = `26px ${MONO}`;
  ctx.fillStyle = CYAN;
  ctx.fillText("$", 402, 352);
  ctx.fillStyle = ROSE;
  // A trailing space measures as nothing; the font is monospaced.
  ctx.fillText("join an encrypted community", 402 + ctx.measureText("$").width * 2, 352);

  ctx.globalAlpha = 0.55;
  ctx.fillStyle = SAND;
  const line = "on armada. open the link to see where.";
  ctx.fillText(line, 402, 392);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ROSE;
  ctx.fillText("_", 402 + ctx.measureText(line).width, 392);

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

const PURPLE = "#d946ef";
const GOLD = "#fcd34d";

/** Sixteen thin wedges of light around (cx, cy), as the gift page's rays. */
function rayPath(cx: number, cy: number, r: number): string {
  let d = "";
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const p = (t: number) => `${(cx + Math.cos(t) * r).toFixed(1)} ${(cy + Math.sin(t) * r).toFixed(1)}`;
    d += `M${cx} ${cy}L${p(a - 0.06)}L${p(a + 0.06)}Z`;
  }
  return d;
}

// The wrapped box the gift page opens, in logo.svg's 128 frame so loadSvg sizes it.
const GIFT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 400 400">
<defs>
<radialGradient id="glow"><stop offset="0" stop-color="${ROSE}" stop-opacity=".55"/><stop offset="1" stop-color="${ROSE}" stop-opacity="0"/></radialGradient>
<radialGradient id="ray" cx="200" cy="230" r="200" gradientUnits="userSpaceOnUse"><stop offset=".2" stop-color="${GOLD}" stop-opacity=".55"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
<linearGradient id="wrap" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ROSE}"/><stop offset=".5" stop-color="${PURPLE}"/><stop offset="1" stop-color="${CYAN}"/></linearGradient>
<linearGradient id="ribbon" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset=".5" stop-color="${GOLD}"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
</defs>
<circle cx="200" cy="230" r="200" fill="url(#glow)"/>
<path d="${rayPath(200, 230, 200)}" fill="url(#ray)"/>
<path d="M84 196H316Q320 196 320 200V350Q320 372 298 372H102Q80 372 80 350V200Q80 196 84 196Z" fill="url(#wrap)"/>
<rect x="80" y="196" width="240" height="24" fill="#000" opacity=".25"/>
<path d="M100 220H136L116 372H92Z" fill="#fff" opacity=".14"/>
<rect x="180" y="196" width="40" height="176" fill="url(#ribbon)"/>
<rect x="64" y="150" width="272" height="56" rx="12" fill="url(#wrap)"/>
<rect x="70" y="153" width="260" height="16" rx="8" fill="#fff" opacity=".22"/>
<rect x="178" y="150" width="44" height="56" fill="url(#ribbon)"/>
<ellipse cx="158" cy="120" rx="46" ry="30" transform="rotate(-25 158 120)" fill="url(#ribbon)"/>
<ellipse cx="158" cy="120" rx="19" ry="11" transform="rotate(-25 158 120)" fill="#b45309" opacity=".5"/>
<ellipse cx="242" cy="120" rx="46" ry="30" transform="rotate(25 242 120)" fill="url(#ribbon)"/>
<ellipse cx="242" cy="120" rx="19" ry="11" transform="rotate(25 242 120)" fill="#b45309" opacity=".5"/>
<rect x="182" y="112" width="36" height="42" rx="13" fill="url(#ribbon)"/>
</svg>`;

/** An Armada Ultra gift: the wrapped box beside who it is from, on an aurora sea. */
export async function drawGift(picture: string | undefined, shape: string | undefined, name: string): Promise<Blob> {
  const { canvas, ctx } = sea();

  for (const [x, y, r, color] of [[180, 60, 620, "251, 77, 150"], [1120, 640, 620, "25, 230, 230"], [330, 330, 360, "217, 70, 239"]] as const) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(${color}, 0.32)`);
    glow.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
  ctx.fillStyle = SAND;
  for (let i = 0; i < 44; i++) {
    const x = (i * 271 + 53) % WIDTH;
    const y = (i * 157 + 29) % HEIGHT;
    // None in the text, where a dot reads as punctuation.
    if (x > 580 && y > 90 && y < 530) continue;
    ctx.globalAlpha = 0.15 + ((i * 37) % 60) / 100;
    ctx.beginPath();
    ctx.arc(x, y, 1 + ((i * 13) % 3) * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const box = await loadSvg(GIFT_SVG, 420);
  if (box) ctx.drawImage(box, 110, 95);

  const left = 600;
  const right = WIDTH - 60;
  const avatar = 72;
  await drawAvatar(ctx, picture, shape, name, left + 4, 112, avatar);
  ctx.textBaseline = "middle";
  ctx.font = `30px ${MONO}`;
  const from = "from";
  const textX = left + avatar + 30;
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = SAND;
  ctx.fillText(from, textX, 148);
  ctx.globalAlpha = 1;
  ctx.font = `bold 30px ${MONO}`;
  // A trailing space measures as nothing; the font is monospaced.
  const nameX = textX + ctx.measureText("from_").width;
  ctx.fillText(fit(ctx, name, right - nameX), nameX, 148);

  // npanel draws text only in a colour, so the gradient is laid over it.
  const title = new OffscreenCanvas(WIDTH, HEIGHT);
  const tctx = title.getContext("2d")!;
  tctx.font = `bold 118px ${MONO}`;
  tctx.textBaseline = "alphabetic";
  tctx.fillStyle = SAND;
  tctx.fillText("armada", left, 318);
  tctx.fillText("ultra", left, 440);
  tctx.globalCompositeOperation = "source-in";
  const shimmer = tctx.createLinearGradient(left, 220, left + 460, 450);
  shimmer.addColorStop(0, ROSE);
  shimmer.addColorStop(0.5, PURPLE);
  shimmer.addColorStop(1, CYAN);
  tctx.fillStyle = shimmer;
  tctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.drawImage(title, 0, 0);

  ctx.textBaseline = "alphabetic";
  ctx.font = `28px ${MONO}`;
  ctx.fillStyle = CYAN;
  ctx.fillText("$", left + 4, 506);
  ctx.fillStyle = ROSE;
  const prompt = "open your gift";
  const promptX = left + 4 + ctx.measureText("$").width * 2;
  ctx.fillText(prompt, promptX, 506);
  ctx.fillText("_", promptX + ctx.measureText(prompt).width, 506);

  await lockup(ctx);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

/** Text cut with an ellipsis to fit `max` pixels in the current font. */
function fit(ctx: OffscreenCanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  const chars = [...text];
  while (chars.length > 1 && ctx.measureText(`${chars.join("")}…`).width > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/** The mark and wordmark, small, in the bottom-right corner. */
async function lockup(ctx: OffscreenCanvasRenderingContext2D): Promise<void> {
  const mark = await loadSvg(logoSvg, 44);
  ctx.font = `bold 30px ${MONO}`;
  ctx.textBaseline = "middle";
  const right = WIDTH - 40;
  const width = ctx.measureText("armada").width;
  if (mark) ctx.drawImage(mark, right - width - 52, HEIGHT - 40 - 44);
  ctx.fillStyle = SAND;
  ctx.fillText("armada", right - width, HEIGHT - 40 - 22);
}

function sea(): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = SEA;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  return { canvas, ctx };
}

/** The mark's three tapering wave lines, centred on `cx`. */
function waves(ctx: OffscreenCanvasRenderingContext2D, cx: number, top: number, scale: number): void {
  ctx.fillStyle = CYAN;
  // [width, height, top] of each line in logo.svg's units.
  for (const [w, h, y] of [[67.08, 4.28, 0], [42.83, 2.86, 12.12], [22.12, 2.14, 21.05]]) {
    ctx.beginPath();
    ctx.roundRect(cx - (w * scale) / 2, top + y * scale, w * scale, h * scale, (h * scale) / 2);
    ctx.fill();
  }
}

async function loadSvg(svg: string, size: number): Promise<ImageBitmap | null> {
  const sized = svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`);
  try {
    return await createImageBitmap(new Blob([sized], { type: "image/svg+xml" }));
  } catch {
    return null;
  }
}

async function loadImage(url: string): Promise<ImageBitmap | null> {
  if (!url.startsWith("https://")) return null;
  try {
    const response = await fetch(url);
    return response.ok ? await createImageBitmap(await response.blob()) : null;
  } catch {
    return null;
  }
}

/** Draw an image to fill a box from its origin, cropping what overflows, centred. */
function drawCover(ctx: OffscreenCanvasRenderingContext2D, image: ImageBitmap, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, 0, 0, w, h);
}
