import { BlossomUploader } from "@nostrify/nostrify/uploaders";
import { useMutation } from "@tanstack/react-query";

import { getEffectiveBlossomServers } from "@/lib/blossom";

import { useAppContext } from "./useAppContext";
import { useCurrentUser } from "./useCurrentUser";

import type { NostrSigner } from "@nostrify/nostrify";

/**
 * Upload a file to the user's Blossom servers (BUD-02), mirroring to the
 * remaining servers in the background (BUD-04). Returns NIP-94-style tags
 * describing the uploaded blob (`[["url", ...], ["m", ...], ["x", ...], ...]`).
 */
export function useUploadFile() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: async (file: File) => {
      if (!user) {
        throw new Error("Must be logged in to upload files");
      }

      // App default servers merged with the user's kind 10063 list, which
      // NostrSync keeps cached in config.blossomServerMetadata.
      const servers = getEffectiveBlossomServers(
        config.blossomServerMetadata,
        config.useAppBlossomServers,
      );

      const uploader = new BlossomUploader({
        servers,
        signer: user.signer,
        // Custom fetch with a 30-second per-server timeout so hanging
        // servers don't block the upload promise indefinitely.
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            headers: padNostrAuthorization(init?.headers),
            signal: AbortSignal.any([
              init?.signal ?? AbortSignal.timeout(30_000),
              AbortSignal.timeout(30_000),
            ]),
          }),
      });

      const tags = await uploader.upload(file);

      // Repair a doubled scheme some Blossom servers emit in their BlobDescriptor
      // `url` (e.g. `https://https//blossom.example/<hash>` or
      // `https://https://blossom.example/<hash>`). Left as-is it renders as a
      // broken image and, once sealed into a Concord/NIP-92 message, is
      // permanently wrong. Collapse the leading duplicate scheme back to one.
      tags[0][1] = repairDoubledScheme(tags[0][1]);

      // Blossom URLs are content-addressed (`/<sha256>`) and may omit the
      // extension. Append it so media-type detection keeps working.
      const ext = getFileExtension(file.name);
      if (ext) {
        tags[0][1] = appendExtensionIfMissing(tags[0][1], ext);
      }

      const url = tags[0][1];

      // Mirror to all other servers in the background (BUD-04, best-effort).
      const uploadedServer = servers.find((s) => url.startsWith(s.replace(/\/+$/, "")));
      const mirrorServers = servers.filter((s) => s !== uploadedServer);
      if (mirrorServers.length > 0) {
        mirrorToServers(url, mirrorServers, user.signer).catch(() => {
          // Mirroring is best-effort — don't fail the upload if it fails.
        });
      }

      return tags;
    },
  });
}

/** Extract the file extension (with leading dot) from a filename, or empty string if none. */
function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return filename.slice(dotIndex).toLowerCase();
}

/**
 * Pad a Blossom `Authorization: Nostr <base64>` token to standard Base64
 * length. Some Blossom servers reject unpadded auth events even though
 * other servers accept them.
 */
export function padNostrAuthorization(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  const auth = result.get("Authorization");

  if (!auth?.startsWith("Nostr ")) return result;

  const token = auth.slice("Nostr ".length);
  const padding = (4 - (token.length % 4)) % 4;

  if (padding > 0) {
    result.set("Authorization", `Nostr ${token}${"=".repeat(padding)}`);
  }

  return result;
}

/**
 * Repair a doubled scheme some Blossom servers emit in their BlobDescriptor
 * `url`:
 *   `https://https//host/<hash>`   (second scheme missing its colon)
 *   `https://https://host/<hash>`  (second scheme intact)
 * Collapse one leading `scheme://` when it's immediately followed by another
 * `scheme` token (with or without the colon), leaving a single valid scheme.
 * Left unrepaired this renders as a broken image and, once sealed into a
 * Concord/NIP-92 message, is permanently wrong.
 */
export function repairDoubledScheme(url: string): string {
  const m = url.match(/^(https?):\/\/(https?):?\/\/(.+)$/i);
  if (m) return `${m[2].toLowerCase()}://${m[3]}`;
  return url;
}

/** Append a file extension to a URL if its path doesn't already have one. */
function appendExtensionIfMissing(urlString: string, ext: string): string {
  try {
    const url = new URL(urlString);
    const lastSegment = url.pathname.split("/").pop() ?? "";
    if (lastSegment.includes(".")) return urlString;
    url.pathname = url.pathname + ext;
    return url.toString();
  } catch {
    return urlString;
  }
}

/** Mirror a blob to additional Blossom servers (BUD-04). */
async function mirrorToServers(
  sourceUrl: string,
  servers: string[],
  signer: NostrSigner,
): Promise<void> {
  await Promise.allSettled(
    servers.map((server) => {
      // Use Nostrify's BUD-04/BUD-11 implementation so the authorization has
      // the required upload verb, blob hash, and event URL encoding. The old
      // hand-built `t=mirror` event was rejected with HTTP 403 by conforming
      // servers even though the original upload had succeeded.
      const uploader = new BlossomUploader({
        servers: [server],
        signer,
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            headers: padNostrAuthorization(init?.headers),
            signal: AbortSignal.any([
              init?.signal ?? AbortSignal.timeout(30_000),
              AbortSignal.timeout(30_000),
            ]),
          }),
      });
      return uploader.mirror(sourceUrl);
    }),
  );
}
