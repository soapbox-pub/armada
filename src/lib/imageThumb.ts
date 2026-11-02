import { isAnimatedImage } from "@/lib/imageMetadata";

/**
 * Small copies of images shown far below their natural size (avatars, emoji).
 * The browser keeps every `<img>` decoded at its FULL size whatever box it is
 * drawn in, so a 2667² avatar costs 27 MB to show at 32 px; a busy room's
 * avatars measured ~370 MB of decoded image memory in the renderer. Here each
 * one is decoded once, transiently, and re-encoded at the size it is shown.
 *
 * `null` means "show the original": the host refused CORS, the image is
 * already small, it animates (and may), or the browser can't resize.
 */

/** Short-edge lengths a thumbnail is made at; a box's longer side rounds up to the next one. */
const BUCKETS = [64, 128, 256, 512] as const;
/** An image within this factor of its bucket is shown as it is. */
const SMALL_ENOUGH = 1.5;
/** Full-size decodes in flight at once; each is transient but can be tens of MB. */
const CONCURRENCY = 2;
/** Unreferenced thumbnails kept for a remount before their URL is revoked. */
const KEEP_UNUSED = 400;

export function thumbBucket(cssPx: number, dpr: number): number {
  const px = Math.ceil(cssPx * Math.max(1, dpr));
  return BUCKETS.find((b) => b >= px) ?? BUCKETS[BUCKETS.length - 1];
}

interface Entry {
  promise: Promise<string | null>;
  url?: string | null;
  refs: number;
}

const entries = new Map<string, Entry>();
/** Hosts whose images can't be read (no CORS); asked once per session. */
const unreadableHosts = new Set<string>();
let running = 0;
const queue: Array<() => void> = [];

/** Whether this browser can make thumbnails at all; otherwise every image is shown as it is. */
export function thumbsSupported(): boolean {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

function hostOf(src: string): string | undefined {
  try {
    const u = new URL(src);
    return u.protocol === "blob:" || u.protocol === "data:" ? undefined : u.host;
  } catch {
    return undefined;
  }
}

async function make(src: string, bucket: number, still: boolean): Promise<string | null> {
  const host = hostOf(src);
  if (host && unreadableHosts.has(host)) return null;
  let blob: Blob;
  try {
    const res = await fetch(src, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) return null;
    blob = await res.blob();
  } catch {
    if (host) unreadableHosts.add(host);
    return null;
  }
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  if (!still && isAnimatedImage(blob.type, head)) return null;
  return slot(async () => {
    let full: ImageBitmap | undefined;
    try {
      full = await createImageBitmap(blob);
      // The SHORT edge: these images are cropped to cover their box.
      const scale = bucket / Math.min(full.width, full.height);
      if (scale * SMALL_ENOUGH >= 1 && !still) return null;
      const w = Math.max(1, Math.round(full.width * Math.min(1, scale)));
      const h = Math.max(1, Math.round(full.height * Math.min(1, scale)));
      const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      full.close();
      full = undefined;
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")!.drawImage(small, 0, 0);
      small.close();
      return URL.createObjectURL(await canvas.convertToBlob({ type: "image/webp", quality: 0.9 }));
    } catch {
      return null;
    } finally {
      full?.close();
    }
  });
}

function trim(): void {
  if (entries.size <= KEEP_UNUSED) return;
  for (const [key, e] of entries) {
    if (entries.size <= KEEP_UNUSED) break;
    if (e.refs > 0 || e.url === undefined) continue;
    if (e.url) URL.revokeObjectURL(e.url);
    entries.delete(key);
  }
}

/**
 * A downscaled copy of `src` for a box of `bucket` px, or `null` for the
 * original. Pair with {@link releaseThumb}. `still`: an animated image becomes
 * its first frame instead of being left alone.
 */
export function acquireThumb(src: string, bucket: number, still: boolean): { key: string; promise: Promise<string | null> } {
  const key = `${still ? "s" : "a"}${bucket}|${src}`;
  let e = entries.get(key);
  if (!e) {
    const entry: Entry = { refs: 0, promise: thumbsSupported() ? make(src, bucket, still) : Promise.resolve(null) };
    entry.promise.then((url) => (entry.url = url), () => (entry.url = null));
    entries.set(key, entry);
    e = entry;
  } else {
    // Most recently used last, so trimming drops the oldest first.
    entries.delete(key);
    entries.set(key, e);
  }
  e.refs++;
  return { key, promise: e.promise };
}

/** The settled thumbnail for `key`, if it has settled: `undefined` while pending. */
export function settledThumb(key: string): string | null | undefined {
  return entries.get(key)?.url;
}

export function releaseThumb(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  trim();
}

/** Drop every thumbnail: some are of decrypted images. Logout's purge. */
export function clearThumbs(): void {
  for (const e of entries.values()) if (e.url) URL.revokeObjectURL(e.url);
  entries.clear();
  unreadableHosts.clear();
}
