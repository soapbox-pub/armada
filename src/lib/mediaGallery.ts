import { Capacitor, registerPlugin } from "@capacitor/core";

import { BRIDGE_CHUNK } from "@/lib/chunkedWrite";
import { bytesToBase64 } from "@/lib/fileBytes";

// The device's recent photos/videos for the attach sheet (MediaGalleryPlugin.java). Android only.

/** `limited` is Android 14+'s "Select photos": only the user's picks are listed. */
export type MediaAccess = "full" | "limited" | "denied" | "prompt";

export interface GalleryItem {
  id: number;
  uri: string;
  video: boolean;
  mime: string | null;
  name: string | null;
  size: number;
  /** Seconds since the epoch; part of the thumbnail cache key. */
  modified: number;
  width: number;
  height: number;
  /** Milliseconds, videos only. */
  duration: number;
}

interface MediaGalleryPlugin {
  checkAccess(): Promise<{ access: MediaAccess }>;
  requestAccess(): Promise<{ access: MediaAccess }>;
  openSettings(): Promise<void>;
  list(opts: { limit: number; offset: number }): Promise<{ items: GalleryItem[]; more: boolean }>;
  thumbnail(opts: { id: number; video: boolean; modified: number }): Promise<{ path: string }>;
  beginSave(opts: { filename: string; mime?: string }): Promise<{ id: string }>;
  appendSave(opts: { id: string; data: string }): Promise<void>;
  finishSave(opts: { id: string }): Promise<{ location: string }>;
  cancelSave(opts: { id: string }): Promise<void>;
}


const MediaGallery = registerPlugin<MediaGalleryPlugin>("MediaGallery");

export function hasMediaGallery(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("MediaGallery");
}

export async function checkMediaAccess(): Promise<MediaAccess> {
  return (await MediaGallery.checkAccess()).access;
}

export async function requestMediaAccess(): Promise<MediaAccess> {
  return (await MediaGallery.requestAccess()).access;
}

export function openMediaSettings(): Promise<void> {
  return MediaGallery.openSettings();
}

export function listRecentMedia(offset: number, limit = 60): Promise<{ items: GalleryItem[]; more: boolean }> {
  return MediaGallery.list({ limit, offset });
}

/**
 * Thumbnail URLs memoized per item; each miss is a bridge call plus a decode.
 * LRU-capped well above a scrolled sheet; the files themselves stay cached natively.
 */
const thumbs = new Map<string, Promise<string>>();
const THUMBS_MAX = 500;

export function galleryThumbnailSrc(item: GalleryItem): Promise<string> {
  const key = `${item.video ? "v" : "i"}${item.id}-${item.modified}`;
  const src = thumbs.get(key);
  if (src) {
    thumbs.delete(key);
    thumbs.set(key, src);
    return src;
  }
  const pending = MediaGallery.thumbnail({ id: item.id, video: item.video, modified: item.modified })
    .then(({ path }) => Capacitor.convertFileSrc(path));
  pending.catch(() => {
    if (thumbs.get(key) === pending) thumbs.delete(key);
  });
  thumbs.set(key, pending);
  if (thumbs.size > THUMBS_MAX) thumbs.delete(thumbs.keys().next().value as string);
  return pending;
}

/**
 * Save bytes into the shared collections: image/video/audio `mime` picks
 * Pictures/Movies/Music, anything else (or none) Download — each under
 * `Armada/`. Resolves the folder it landed in.
 */
export async function saveToDevice(filename: string, bytes: Uint8Array, mime?: string): Promise<string> {
  const { id } = await MediaGallery.beginSave({ filename, mime });
  try {
    for (let at = 0; at < bytes.length; at += BRIDGE_CHUNK) {
      await MediaGallery.appendSave({ id, data: bytesToBase64(bytes.subarray(at, at + BRIDGE_CHUNK)) });
    }
  } catch (error) {
    void MediaGallery.cancelSave({ id }).catch(() => {});
    throw error;
  }
  return (await MediaGallery.finishSave({ id })).location;
}

/** A loadable URL for the item itself, for the full-size preview. */
export function galleryItemSrc(item: GalleryItem): string {
  return Capacitor.convertFileSrc(item.uri);
}

/**
 * The item as a File, fetched from the content:// URI via Capacitor's local
 * server (not a plugin result, which would re-serialize every byte). Reads the
 * whole item, so callers must check `item.size` first.
 */
export async function galleryItemFile(item: GalleryItem): Promise<File> {
  const res = await fetch(Capacitor.convertFileSrc(item.uri));
  if (!res.ok) throw new Error(`Could not read ${item.name ?? "media"} (${res.status})`);
  const blob = await res.blob();
  const type = item.mime || blob.type;
  const name = item.name || `${item.video ? "video" : "image"}-${item.id}${extensionFor(type)}`;
  return new File([blob], name, { type, lastModified: item.modified * 1000 });
}

function extensionFor(mime: string): string {
  const sub = mime.split("/")[1]?.split(/[;+]/)[0];
  if (!sub) return "";
  return `.${sub === "jpeg" ? "jpg" : sub === "quicktime" ? "mov" : sub}`;
}
