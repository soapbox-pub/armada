import { Capacitor } from "@capacitor/core";

import { t } from "@/i18n";
import { bytesToBase64, filenameFromUrl, safeFilename, sniffImageMime } from "@/lib/fileBytes";
import { hasMediaGallery, saveToDevice } from "@/lib/mediaGallery";
import { openUrl } from "@/lib/share";

/**
 * Save raw bytes to the device: `<a download>` on web; on Android through
 * MediaStore, where `mime` files media into Pictures/Movies/Music and anything
 * else into Download; on iOS a base64 write to Documents (the Armada folder in
 * Files). Resolves where it went on native, `undefined` on web.
 *
 * Omit `mime` to force a plain download. `filename` is sanitized here because
 * neither native path contains paths (`..` resolves). Sanitized, not rejected:
 * {@link downloadUrl} answers a throw by opening the URL.
 */
export async function downloadBinaryFile(
  filename: string,
  bytes: Uint8Array,
  mime?: string,
): Promise<string | undefined> {
  if (hasMediaGallery()) {
    return saveToDevice(safeFilename(filename), bytesToBase64(bytes), mime);
  }
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    // No `encoding` → Capacitor treats `data` as base64.
    await Filesystem.writeFile({
      path: safeFilename(filename),
      data: bytesToBase64(bytes),
      directory: Directory.Documents,
    });
    return t({ id: "downloadFile.iosLocation", defaultMessage: "the Armada folder in Files" });
  }
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return undefined;
}

/** The "Saved" toast's description for a {@link downloadBinaryFile} result. */
export function savedDescription(location: string | undefined): string {
  return location
    ? t({ id: "downloadFile.savedIn", defaultMessage: "You'll find it in {location}." }, { location })
    : t({ id: "downloadFile.checkDownloads", defaultMessage: "Check your downloads folder." });
}

export type DownloadResult = { status: "downloaded"; location?: string } | { status: "opened" };

/**
 * Save a media `src` (resolved: a decrypted `blob:` URL or plain `https:`) by
 * fetching its bytes; `nameHint` only derives the filename. Resolves
 * `opened` when it had to fall back to opening (e.g. CORS-less host).
 */
export async function downloadUrl(
  src: string,
  opts: { nameHint?: string; mime?: string } = {},
): Promise<DownloadResult> {
  const filename = filenameFromUrl(opts.nameHint ?? src, opts.mime);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The bytes outrank the sender's claim for what goes into the gallery.
    const mime = sniffImageMime(bytes) ?? opts.mime ?? (res.headers.get("content-type") || undefined);
    const location = await downloadBinaryFile(filename, bytes, mime);
    return { status: "downloaded", location };
  } catch (error) {
    // A blob: URL is this origin: opening one typed as a document by its sender
    // would run the sender's markup as the app.
    if (/^blob:/i.test(src)) throw error;
    await openUrl(src);
    return { status: "opened" };
  }
}
