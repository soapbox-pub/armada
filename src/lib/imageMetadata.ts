// Animation detection for uploads; metadata itself is walked in imageMetadataStrip.ts.

/** How much of the file the animation sniff reads. */
export const METADATA_SCAN_BYTES = 64 * 1024;

/** Animated images must not be canvas round-tripped (flattens to one frame). */
export function isAnimatedImage(mime: string, bytes: Uint8Array): boolean {
  // Treat all GIFs as animated: never flattened, and their comment and XMP
  // blocks are cut out in place (stripAnimatedMetadata).
  if (mime === "image/gif") return true;

  if (mime === "image/webp") {
    // RIFF....WEBPVP8X with the animation flag, signalled by an ANIM chunk.
    for (let i = 12; i + 4 <= Math.min(bytes.length, 1024); i++) {
      if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x49 && bytes[i + 3] === 0x4d) {
        return true;
      }
    }
    return false;
  }

  if (mime === "image/png" || mime === "image/apng") {
    // APNG is a PNG with an `acTL` chunk before the first `IDAT`.
    for (let i = 8; i + 4 <= Math.min(bytes.length, 4096); i++) {
      if (bytes[i] === 0x61 && bytes[i + 1] === 0x63 && bytes[i + 2] === 0x54 && bytes[i + 3] === 0x4c) {
        return true;
      }
      if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && bytes[i + 2] === 0x41 && bytes[i + 3] === 0x54) {
        return false;
      }
    }
    return false;
  }

  return false;
}
