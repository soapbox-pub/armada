/**
 * Deleting this account's blobs from the Blossom servers holding them (BUD-02): one
 * `t=delete` token naming every hash, so a remote signer is asked once.
 */
import { N64 } from "@nostrify/nostrify/utils";
import type { NostrSigner } from "@nostrify/nostrify";

import { blobHashOf } from "@/lib/mediaCache";

/** Ask each blob's server to delete it; best-effort, and a refusal changes nothing here. */
export async function deleteBlobs(signer: NostrSigner, urls: readonly string[], fetcher: typeof fetch = fetch): Promise<number> {
  const blobs = new Map<string, { origin: string; hash: string }>();
  for (const url of urls) {
    const hash = blobHashOf(url);
    if (!hash) continue;
    try {
      const { origin, protocol } = new URL(url);
      if (protocol === "https:") blobs.set(`${origin}/${hash}`, { origin, hash });
    } catch {
      // not a URL
    }
  }
  if (blobs.size === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const token = await signer.signEvent({
    kind: 24242,
    content: "Delete",
    created_at: now,
    tags: [["t", "delete"], ...[...new Set([...blobs.values()].map((b) => b.hash))].map((h) => ["x", h]), ["expiration", String(now + 600)]],
  });
  const authorization = `Nostr ${N64.encodeEventUrl(token)}`;
  const results = await Promise.allSettled([...blobs.values()].map(async ({ origin, hash }) => {
    const res = await fetcher(`${origin}/${hash}`, { method: "DELETE", headers: { authorization }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(String(res.status));
  }));
  return results.filter((r) => r.status === "fulfilled").length;
}
