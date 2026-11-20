import { canvasReadbackIntact } from "@/lib/canvasProbe";
import { canFetchDesktopImages, fetchDesktopImage } from "@/lib/desktop";
import { isAnimatedImage } from "@/lib/imageMetadata";
import { canFetchNativeImages, fetchNativeImage } from "@/lib/nativeImageFetch";

/**
 * Small copies of images shown far below their natural size (avatars, emoji).
 * The browser keeps every `<img>` decoded at its FULL size whatever box it is
 * drawn in, so a 2667² avatar costs 27 MB to show at 32 px; a busy room's
 * avatars measured ~370 MB of decoded image memory in the renderer. Here each
 * one is decoded once, transiently, and re-encoded at the size it is shown.
 *
 * An animated image becomes an {@link AnimatedThumb}: every frame decoded
 * (WebCodecs' ImageDecoder) at the small size and played back on a canvas.
 * Chromium otherwise keeps the frames at full size; one 447×328 animated avatar
 * measured ~28 MB of decoded image memory in a busy room.
 *
 * `null` means "show the original": the host refused CORS (on the web; the
 * desktop shell and the Android app read it), the image is already small, or
 * the browser can't resize (or decode the animation).
 */

/** Short-edge lengths a thumbnail is made at; a box's longer side rounds up to the next one. */
const BUCKETS = [64, 128, 256, 512] as const;
/** An image within this factor of its bucket is shown as it is. */
const SMALL_ENOUGH = 1.5;
/** Full-size decodes in flight at once; each is transient but can be tens of MB. */
const CONCURRENCY = 2;
/** Unreferenced thumbnails kept for a remount before their URL is revoked. */
const KEEP_UNUSED = 400;
/** Longer animations are shown as they are rather than held frame by frame. */
const MAX_FRAMES = 400;
/** Nor is one whose frames at thumbnail size would take more than this. */
const MAX_ANIMATION_BYTES = 16 * 1024 * 1024;
/** Decoded frames of unreferenced animations kept for a remount. */
const KEEP_UNUSED_ANIMATION_BYTES = 64 * 1024 * 1024;
/** Image downloads in flight at once (the desktop shell's run in its main process). */
const FETCH_CONCURRENCY = 6;

/**
 * An animation's frames at thumbnail size, shared by every element showing it.
 * One timer per animation, running only while something is subscribed.
 */
export class AnimatedThumb {
  private frame = 0;
  private played = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(frame: ImageBitmap) => void>();

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly frames: ImageBitmap[],
    private readonly durations: number[],
    private readonly repetitions: number,
    /** The frame held after the loops (see {@link posterFrame}). */
    private readonly poster = 0,
  ) {}

  /** The decoded frames' size, for the cache's budget. */
  get bytes(): number {
    return this.width * this.height * 4 * this.frames.length;
  }

  /**
   * Draw the current frame now and every later one; after `loops` loops' worth of
   * frames, draw the poster frame and stop. Returns an unsubscribe.
   */
  subscribe(draw: (frame: ImageBitmap) => void, loops = Infinity): () => void {
    const limit = loops * this.frames.length;
    let shown = 0;
    const listener = (frame: ImageBitmap) => {
      draw(frame);
      if (++shown < limit) return;
      off();
      const held = this.frames[this.poster];
      if (frame !== held) draw(held);
    };
    const off = () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
    this.listeners.add(listener);
    listener(this.frames[this.frame]);
    if (this.listeners.size > 0 && !this.timer) this.schedule();
    return off;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      const next = (this.frame + 1) % this.frames.length;
      if (next === 0 && ++this.played > this.repetitions) {
        this.timer = undefined;
        return;
      }
      this.frame = next;
      for (const draw of this.listeners) draw(this.frames[next]);
      this.schedule();
    }, this.durations[this.frame]);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    for (const f of this.frames) f.close();
  }
}

export type Thumb = string | AnimatedThumb;

/** The format from the bytes: servers often send `application/octet-stream`. */
export function sniffImageType(head: Uint8Array, declared: string): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  return declared;
}

export function thumbBucket(cssPx: number, dpr: number): number {
  const px = Math.ceil(cssPx * Math.max(1, dpr));
  return BUCKETS.find((b) => b >= px) ?? BUCKETS[BUCKETS.length - 1];
}

interface Entry {
  promise: Promise<Thumb | null>;
  url?: Thumb | null;
  refs: number;
  /** When the download failed: a later mount tries again rather than keep the original for the session. */
  fetchFailedAt?: number;
}

/** A download that failed (offline, a busy server's 429), as against an image that can't be made smaller. */
const FETCH_FAILED = Symbol("fetch failed");
/** How long a failed download is left before a mount asks again. */
const FETCH_RETRY_MS = 30_000;

const entries = new Map<string, Entry>();
/** Hosts whose images can't be read (no CORS); asked once per session. */
const unreadableHosts = new Set<string>();
function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: Array<() => void> = [];
  return async (fn) => {
    if (running >= max) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

const slot = limiter(CONCURRENCY);
const fetchSlot = limiter(FETCH_CONCURRENCY);

/** Whether this browser can make thumbnails at all; otherwise every image is shown as it is. */
export function thumbsSupported(): boolean {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
}

function hostOf(src: string): string | undefined {
  try {
    const u = new URL(src);
    return u.protocol === "blob:" || u.protocol === "data:" ? undefined : u.host;
  } catch {
    return undefined;
  }
}

/** Frames compared for a poster, spread over the animation. */
const POSTER_CANDIDATES = 32;
/** Fewer where each costs a decode of its own (media held still). */
const STILL_POSTER_CANDIDATES = 16;

/** How much a frame shows: the spread of its alpha-weighted brightness at 8×8. */
function frameContrast(frame: CanvasImageSource): number {
  const ctx = new OffscreenCanvas(8, 8).getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(frame, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = ((d[i] + d[i + 1] + d[i + 2]) / 3) * (d[i + 3] / 255);
    sum += l;
    sq += l * l;
  }
  const mean = sum / 64;
  return sq / 64 - mean * mean;
}

/** Up to `max` frame indices of `count`, evenly spread from the first. */
function spreadFrames(count: number, max: number): number[] {
  const n = Math.min(count, max);
  return Array.from({ length: n }, (_, i) => Math.floor((i * count) / n));
}

/**
 * The frame an animation is held on: of a spread of its frames, the one showing
 * the most (the earliest on a tie). Many open on a blank frame and fade in, and
 * holding the first shows an empty box.
 */
export function posterFrame<F>(frames: readonly F[], contrast: (frame: F) => number): number {
  let best = 0;
  let most = -1;
  for (const i of spreadFrames(frames.length, POSTER_CANDIDATES)) {
    const c = contrast(frames[i]);
    if (c > most) {
      most = c;
      best = i;
    }
  }
  return best;
}

/** An animation's poster frame at full size (see {@link posterFrame}), or undefined where it can't be decoded. */
async function posterStill(blob: Blob, type: string): Promise<ImageBitmap | undefined> {
  if (typeof ImageDecoder === "undefined" || !(await ImageDecoder.isTypeSupported(type).catch(() => false))) return undefined;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
  let best: ImageBitmap | undefined;
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    let most = -1;
    for (const i of spreadFrames(decoder.tracks.selectedTrack?.frameCount ?? 1, STILL_POSTER_CANDIDATES)) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        const c = frameContrast(image);
        if (c <= most) continue;
        most = c;
        best?.close();
        best = await createImageBitmap(image);
      } finally {
        image.close();
      }
    }
    const found = best;
    best = undefined;
    return found;
  } catch {
    return undefined;
  } finally {
    best?.close();
    decoder.close();
  }
}

/** Every frame of an animation at the bucket's size, or null to show the original. */
async function makeAnimated(blob: Blob, type: string, bucket: number): Promise<AnimatedThumb | null> {
  if (typeof ImageDecoder === "undefined" || !(await ImageDecoder.isTypeSupported(type).catch(() => false))) return null;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
  const frames: ImageBitmap[] = [];
  try {
    // Tracks fill in only once `ready`; the frame count is final once `completed`.
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const count = track?.frameCount ?? 0;
    if (count < 2 || count > MAX_FRAMES) return null;
    const durations: number[] = [];
    let w = 0;
    let h = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        if (i === 0) {
          // Never upscaled, but made even when already small: as frames its loops can
          // be capped, and an <img> of the original animates forever.
          const scale = Math.min(1, bucket / Math.min(image.displayWidth, image.displayHeight));
          w = Math.max(1, Math.round(image.displayWidth * scale));
          h = Math.max(1, Math.round(image.displayHeight * scale));
          if (w * h * 4 * count > MAX_ANIMATION_BYTES) return null;
        }
        frames.push(await createImageBitmap(image, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" }));
        // Microseconds; like browsers, a delay of 10ms or less plays as 100ms.
        const ms = (image.duration ?? 0) / 1000;
        durations.push(ms <= 10 ? 100 : ms);
      } finally {
        image.close();
      }
    }
    const reps = track!.repetitionCount;
    const poster = posterFrame(frames, frameContrast);
    return new AnimatedThumb(w, h, frames.splice(0), durations, Number.isFinite(reps) ? reps : Infinity, poster);
  } catch {
    return null;
  } finally {
    for (const f of frames) f.close();
    decoder.close();
  }
}

/**
 * The image's bytes. A host that sends no CORS headers is read through the
 * desktop shell (electron/imageFetch.js) or the Android app (ImageFetch.java)
 * where there is one; on the web it keeps its original.
 */
async function fetchBlob(src: string): Promise<Blob | null> {
  const host = hostOf(src);
  if (!host || !unreadableHosts.has(host)) {
    try {
      const res = await fetch(src, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
      return res.ok ? await res.blob() : null;
    } catch {
      if (!host) return null;
      unreadableHosts.add(host);
    }
  }
  if (canFetchDesktopImages()) return fetchDesktopImage(src);
  return canFetchNativeImages() ? fetchNativeImage(src) : null;
}

async function make(src: string, bucket: number, still: boolean): Promise<Thumb | null | typeof FETCH_FAILED> {
  // A blocked canvas would draw noise; the original shows instead.
  if (!canvasReadbackIntact()) return null;
  const blob = await fetchSlot(() => fetchBlob(src));
  if (!blob) return FETCH_FAILED;
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const type = sniffImageType(head, blob.type);
  const animated = isAnimatedImage(type, head);
  if (!still && animated) return slot(() => makeAnimated(blob, type, bucket));
  return slot(async () => {
    let full: ImageBitmap | undefined;
    try {
      full = (animated ? await posterStill(blob, type) : undefined) ?? (await createImageBitmap(blob));
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

function disposeThumb(t: Thumb | null | undefined): void {
  if (typeof t === "string") URL.revokeObjectURL(t);
  else t?.close();
}

function trim(): void {
  let animationBytes = 0;
  for (const e of entries.values()) if (e.refs === 0 && e.url instanceof AnimatedThumb) animationBytes += e.url.bytes;
  if (entries.size <= KEEP_UNUSED && animationBytes <= KEEP_UNUSED_ANIMATION_BYTES) return;
  for (const [key, e] of entries) {
    const overCount = entries.size > KEEP_UNUSED;
    const overBytes = animationBytes > KEEP_UNUSED_ANIMATION_BYTES;
    if (!overCount && !overBytes) break;
    if (e.refs > 0 || e.url === undefined) continue;
    if (!overCount && !(e.url instanceof AnimatedThumb)) continue;
    if (e.url instanceof AnimatedThumb) animationBytes -= e.url.bytes;
    disposeThumb(e.url);
    entries.delete(key);
  }
}

/**
 * A downscaled copy of `src` for a box of `bucket` px, or `null` for the
 * original. Pair with {@link releaseThumb}. `still`: an animated image becomes
 * its first frame instead of being left alone.
 */
export function acquireThumb(src: string, bucket: number, still: boolean): { key: string; promise: Promise<Thumb | null> } {
  const key = `${still ? "s" : "a"}${bucket}|${src}`;
  let e = entries.get(key);
  if (e?.fetchFailedAt !== undefined && Date.now() - e.fetchFailedAt >= FETCH_RETRY_MS) {
    entries.delete(key);
    e = undefined;
  }
  if (!e) {
    const made = thumbsSupported() ? make(src, bucket, still) : Promise.resolve(null);
    const entry: Entry = { refs: 0, promise: made.then((url) => (url === FETCH_FAILED ? null : url)) };
    made.then(
      (url) => {
        if (url === FETCH_FAILED) {
          entry.fetchFailedAt = Date.now();
          url = null;
        }
        // Cleared (logout) or trimmed while being made: nothing will revoke it later.
        if (entries.get(key) !== entry) disposeThumb(url);
        else entry.url = url;
      },
      () => (entry.url = null),
    );
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
export function settledThumb(key: string): Thumb | null | undefined {
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
  for (const e of entries.values()) disposeThumb(e.url);
  entries.clear();
  unreadableHosts.clear();
}
