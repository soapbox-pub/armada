import { characterCardFromPngBytes, isPngBytes, stripNonCardMetadata } from "@/lib/characterCard";
import { isAnimatedImage, METADATA_SCAN_BYTES } from "@/lib/imageMetadata";
import { canvasReadbackIntact } from "@/lib/canvasProbe";
import { needsMetadataStrip, stripAnimatedMetadata, stripJpegMetadata } from "@/lib/imageMetadataStrip";

/** Maximum dimension (width or height) for resized images. */
const MAX_DIMENSION = 1920;

/** JPEG quality for resized images (0–1). */
const JPEG_QUALITY = 0.85;

interface ResizedImage {
  file: File;
  dimensions: string;
}

/**
 * Prepare an image for upload: cap the longest side at {@link MAX_DIMENSION}
 * and strip metadata (EXIF/GPS, XMP, IPTC) via canvas re-encode. Skipped for
 * in-bounds images without metadata and for animated images (canvas would flatten them).
 */
export async function resizeImage(file: File): Promise<ResizedImage> {
  // The whole file: metadata may sit anywhere before (or, in a PNG, after) the image data.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = bytes.subarray(0, METADATA_SCAN_BYTES);

  const bitmap = await decodeUpright(file);
  const { width, height } = bitmap;

  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
  const animated = isAnimatedImage(file.type, head);

  // Animated: the canvas would keep one frame, so the metadata is cut out of the
  // container instead. One that can't be walked is flattened rather than sent as is.
  if (animated) {
    const stripped = stripAnimatedMetadata(bytes);
    if (stripped) {
      bitmap.close();
      return {
        file: new File([stripped], file.name, { type: file.type, lastModified: file.lastModified }),
        dimensions: `${width}x${height}`,
      };
    }
  } else if (!needsResize && !needsMetadataStrip(bytes)) {
    bitmap.close();
    return { file, dimensions: `${width}x${height}` };
  }

  // A character-card PNG (tEXt `chara` payload, the tavern interchange format)
  // would lose its payload to the canvas round-trip below: the file IS the card,
  // so it uploads at full size with only its other metadata chunks dropped.
  // Judged by signature, since a picked file's `type` may be empty.
  if (!animated && isPngBytes(head)) {
    // The user's own file: no size cap, which exists for sender-chosen sniffs.
    const parsed = characterCardFromPngBytes(bytes, { maxChunkBytes: Infinity });
    const stripped = parsed ? stripNonCardMetadata(bytes) : null;
    if (stripped) {
      bitmap.close();
      const card = new File([stripped], replaceExtension(file.name, ".png"), {
        type: "image/png",
        lastModified: file.lastModified,
      });
      return { file: card, dimensions: `${width}x${height}` };
    }
  }

  // A fingerprint blocker would turn the re-encode into noise: send the image at
  // its own size, with the metadata cut out of the container instead.
  if (!animated && !canvasReadbackIntact()) {
    bitmap.close();
    const stripped = !needsMetadataStrip(bytes)
      ? bytes
      : stripJpegMetadata(bytes) ?? stripAnimatedMetadata(bytes);
    if (!stripped) throw new Error("This browser blocks the canvas needed to remove this image's metadata.");
    return {
      file: stripped === bytes ? file : new File([stripped], file.name, { type: file.type, lastModified: file.lastModified }),
      dimensions: `${width}x${height}`,
    };
  }

  const scale = needsResize ? MAX_DIMENSION / Math.max(width, height) : 1;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas 2D context unavailable');
  }

  ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
  bitmap.close();

  // Encode as both JPEG and PNG in parallel, then pick the smaller one.
  const [jpegBlob, pngBlob] = await Promise.all([
    canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY),
    canvasToBlob(canvas, 'image/png'),
  ]);

  const best = jpegBlob.size <= pngBlob.size
    ? { blob: jpegBlob, ext: '.jpg', mime: 'image/jpeg' as const }
    : { blob: pngBlob, ext: '.png', mime: 'image/png' as const };

  const resizedFile = new File([best.blob], replaceExtension(file.name, best.ext), {
    type: best.mime,
  });

  return {
    file: resizedFile,
    dimensions: `${newWidth}x${newHeight}`,
  };
}

/**
 * Longest side of an image's timeline preview: the inline box is at most
 * 384×320 CSS px, so this stays sharp at 2× density.
 */
export const THUMB_DIMENSION = 768;
const THUMB_QUALITY = 0.75;
/** A preview must save at least this share of the image, or it isn't worth a second blob. */
const THUMB_MIN_SAVING = 0.5;

/**
 * The timeline preview of an image about to be sent, uploaded beside it as its
 * imeta `thumb` so a chat downloads the full image only when it is opened.
 * Made here because an encrypted attachment can't be resized by any server.
 * Undefined for animated images (a still would freeze them) and where the
 * preview wouldn't be much smaller than the image itself.
 */
export async function makeImageThumb(file: File): Promise<File | undefined> {
  try {
    const head = new Uint8Array(await file.slice(0, METADATA_SCAN_BYTES).arrayBuffer());
    if (isAnimatedImage(file.type, head) || !canvasReadbackIntact()) return undefined;
    const bitmap = await decodeUpright(file);
    const scale = Math.min(1, THUMB_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return undefined;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // JPEG would paint a transparent PNG's background black: an image that may
    // carry alpha gets WebP, and no preview where the browser can't encode it.
    const opaque = file.type === 'image/jpeg';
    const type = opaque ? 'image/jpeg' : 'image/webp';
    const blob = await canvasToBlob(canvas, type, THUMB_QUALITY);
    if (blob.type !== type || blob.size > file.size * THUMB_MIN_SAVING) return undefined;
    return new File([blob], replaceExtension(file.name, opaque ? '.thumb.jpg' : '.thumb.webp'), { type });
  } catch {
    return undefined;
  }
}

/** Types every engine Armada runs on decodes; anything else is probed. */
const DECODABLE_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/svg+xml",
]);

/**
 * Whether this `image/*` file can be shown inline. An OS may type a camera RAW,
 * TIFF or HEIC as an image while the browser has no decoder for it; such a file
 * is sent as a plain attachment rather than failing the upload.
 */
export async function canDecodeImage(file: File, mime: string): Promise<boolean> {
  if (DECODABLE_IMAGE_TYPES.has(mime.toLowerCase())) return true;
  try {
    (await createImageBitmap(file)).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode with EXIF rotation baked in, so dropping the orientation tag doesn't
 * leave photos sideways. Older Chromium WebViews reject `"from-image"` with a
 * TypeError; their default already applies the rotation.
 */
async function decodeUpright(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    if (file.type === "image/svg+xml") return decodeSvg(file);
    if (!(error instanceof TypeError)) throw error;
    return createImageBitmap(file);
  }
}

/** Raster width of an SVG with no natural size (a viewBox only), along its longer side. */
const SVG_RASTER = 1024;

/** Chromium won't bitmap an SVG Blob, but rasterizes one loaded as an `<img>`. */
async function decodeSvg(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    try {
      return await createImageBitmap(img);
    } catch {
      // No natural size: only resize options can give it one.
    }
    const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/.exec(await file.text())?.[1] ?? "";
    const [, , w, h] = viewBox.trim().split(/[\s,]+/).map(Number);
    const aspect = w > 0 && h > 0 ? w / h : 1;
    return await createImageBitmap(img, aspect >= 1
      ? { resizeWidth: SVG_RASTER, resizeHeight: Math.max(1, Math.round(SVG_RASTER / aspect)) }
      : { resizeWidth: Math.max(1, Math.round(SVG_RASTER * aspect)), resizeHeight: SVG_RASTER });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`Failed to encode ${type}`))),
      type,
      quality,
    );
  });
}

function replaceExtension(filename: string, ext: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return base + ext;
}
