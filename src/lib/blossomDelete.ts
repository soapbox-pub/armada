/**
 * Deleting this account's blobs from the Blossom servers holding them (BUD-02): one
 * `t=delete` token per server, scoped to it and to the hashes it holds (BUD-11), so a
 * server can't replay what it was handed against another.
 */
import { N64 } from "@nostrify/nostrify/utils";
import type { NostrSigner } from "@nostrify/nostrify";

import { blobHashOf } from "@/lib/mediaCache";

/** Ask each blob's server to delete it; best-effort, and a refusal changes nothing here. */
export async function deleteBlobs(signer: NostrSigner, urls: readonly string[], fetcher: typeof fetch = fetch): Promise<number> {
  const byOrigin = new Map<string, { host: string; hashes: Set<string> }>();
  for (const url of urls) {
    const hash = blobHashOf(url);
    if (!hash) continue;
    try {
      const { origin, protocol, hostname } = new URL(url);
      if (protocol !== "https:") continue;
      const entry = byOrigin.get(origin) ?? { host: hostname.toLowerCase(), hashes: new Set<string>() };
      entry.hashes.add(hash);
      byOrigin.set(origin, entry);
    } catch {
      // not a URL
    }
  }
  if (byOrigin.size === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.allSettled([...byOrigin].map(async ([origin, { host, hashes }]) => {
    const token = await signer.signEvent({
      kind: 24242,
      content: "Delete",
      created_at: now,
      tags: [["t", "delete"], ["server", host], ...[...hashes].map((h) => ["x", h]), ["expiration", String(now + 600)]],
    });
    const authorization = `Nostr ${N64.encodeEventUrl(token)}`;
    const done = await Promise.allSettled([...hashes].map(async (hash) => {
      const res = await fetcher(`${origin}/${hash}`, { method: "DELETE", headers: { authorization }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(String(res.status));
    }));
    return done.filter((r) => r.status === "fulfilled").length;
  }));
  return results.reduce((n, r) => n + (r.status === "fulfilled" ? r.value : 0), 0);
}
