/**
 * Cross-platform share + clipboard. Native uses Capacitor plugins because the
 * Android System WebView often lacks `navigator.share`.
 */

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";

import { writeFileChunked } from "@/lib/chunkedWrite";
import { filenameFromUrl, safeFilename, sniffImageMime } from "@/lib/fileBytes";

const native = Capacitor.isNativePlatform();

/** True when the native share sheet / Web Share API can be used. */
export function canShare(): boolean {
  if (native) return true;
  return typeof navigator !== "undefined" && "share" in navigator;
}

/** True when the sheet can carry a FILE (Web Share Level 2 is missing on desktop Firefox / older Safari). */
export function canShareFiles(): boolean {
  if (native) return true;
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([], "probe.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

/**
 * Open the share sheet. Resolves false if it couldn't be presented (so callers
 * can fall back to copy); a user cancel counts as presented.
 */
export async function share(opts: {
  title?: string;
  text?: string;
  url?: string;
  dialogTitle?: string;
}): Promise<boolean> {
  if (native) {
    try {
      await Share.share({
        title: opts.title,
        text: opts.text,
        url: opts.url,
        dialogTitle: opts.dialogTitle ?? opts.title,
      });
    } catch {
      // Cancel and post-open failure are indistinguishable; don't fall back on a cancel.
    }
    return true;
  }
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await navigator.share({ title: opts.title, text: opts.text, url: opts.url });
      return true;
    } catch (e) {
      // AbortError = user closed an opened sheet. Others (e.g. NotAllowedError
      // after lost transient activation) mean no sheet was shown.
      return (e as Error | null)?.name === "AbortError";
    }
  }
  return false;
}

/**
 * Share the CONTENTS of a media `src`, not a link (encrypted URLs point at
 * ciphertext; `blob:` URLs mean nothing elsewhere). Native writes a cache copy
 * since Capacitor Share takes paths. Resolves false when unavailable or
 * unreadable; a cancel counts as presented.
 */
export async function shareFile(
  src: string,
  opts: { nameHint?: string; mime?: string; title?: string; text?: string; dialogTitle?: string } = {},
): Promise<boolean> {
  let bytes: Uint8Array;
  let mime = opts.mime;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    // Type/extension drive the sheet's thumbnail: fall back to header, then sniffing.
    const declared = res.headers.get("content-type")?.split(";")[0].trim();
    mime = mime || (declared && declared !== "application/octet-stream" ? declared : undefined) ||
      sniffImageMime(bytes);
  } catch {
    return false;
  }
  const filename = filenameFromUrl(opts.nameHint ?? src, mime);

  if (native) {
    let uri: string;
    try {
      const { Directory } = await import("@capacitor/filesystem");
      // Cache dir: transient copy. safeFilename again at the write because the
      // plugin doesn't contain paths, and the cache's siblings are the databases.
      uri = await writeFileChunked(safeFilename(filename), bytes, Directory.Cache);
    } catch {
      return false;
    }
    try {
      await Share.share({
        title: opts.title,
        text: opts.text,
        files: [uri],
        dialogTitle: opts.dialogTitle ?? opts.title,
      });
    } catch {
      // Cancel is indistinguishable from failure; don't fall back on a cancel.
    }
    return true;
  }

  const file = new File([bytes as BlobPart], filename, { type: mime || "application/octet-stream" });
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: opts.title, text: opts.text });
    return true;
  } catch (e) {
    // AbortError = cancelled an opened sheet; anything else = no sheet.
    return (e as Error | null)?.name === "AbortError";
  }
}

/** Open an external URL; native uses the share sheet since WebView `window.open` may not hand off. */
export async function openUrl(url: string): Promise<void> {
  if (native) {
    await Share.share({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
