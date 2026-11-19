/** A URI with a scheme (`https://…`, `isbn:…`, `doi:…`) and no whitespace. */
const URI_RE = /^[a-z][a-z0-9+.-]*:\S+$/i;

/**
 * The non-Nostr source of a NIP-84 highlight, or `undefined` if it has none.
 *
 * The first `i` tag holding a URI wins (any URI, not only NIP-73 ids). Without
 * one it falls back to an `r` tag, by preference the one marked `source` and
 * never one marked `mention`, which can hold a URL or any other text.
 */
export function highlightExternalSource(tags: string[][]): string | undefined {
  for (const [name, value] of tags) {
    const uri = name === "i" ? value?.trim() : undefined;
    if (uri && URI_RE.test(uri)) return uri;
  }
  const refs = tags.filter(([name, value, marker]) => name === "r" && value?.trim() && marker !== "mention");
  return (refs.find(([, , marker]) => marker === "source") ?? refs[0])?.[1].trim();
}
