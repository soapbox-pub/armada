import type { Directory } from "@capacitor/filesystem";

import { bytesToBase64 } from "@/lib/fileBytes";

/**
 * Bytes per bridge call when handing a file to native code; a multiple of 3 so
 * each piece base64-encodes without padding. One string of a whole video
 * exhausts the Java heap on the other side.
 */
export const BRIDGE_CHUNK = 3 * 256 * 1024;

/** `Filesystem.writeFile` in {@link BRIDGE_CHUNK} pieces. Resolves the file's URI. */
export async function writeFileChunked(path: string, bytes: Uint8Array, directory: Directory): Promise<string> {
  const { Filesystem } = await import("@capacitor/filesystem");
  const { uri } = await Filesystem.writeFile({
    path,
    data: bytesToBase64(bytes.subarray(0, BRIDGE_CHUNK)),
    directory,
  });
  for (let at = BRIDGE_CHUNK; at < bytes.length; at += BRIDGE_CHUNK) {
    await Filesystem.appendFile({ path, data: bytesToBase64(bytes.subarray(at, at + BRIDGE_CHUNK)), directory });
  }
  return uri;
}
