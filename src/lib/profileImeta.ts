import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";

/**
 * NIP-92 `imeta` tags on a kind 0 describing its `picture` and `banner`:
 * declared `fallback` hosts, `blurhash`, `dim`, `alt`, and encryption (the
 * NIP-94 proposal in nostr-protocol/nips#2437), so the blob on the media server
 * can be ciphertext. An entry applies only when its `url` IS the field's value;
 * a stale one left from an earlier picture is ignored.
 */
export interface ProfileImeta {
  picture?: ImetaEntry;
  banner?: ImetaEntry;
}

const FIELDS = ["picture", "banner"] as const;

type ProfileImages = { picture?: unknown; banner?: unknown };

/** Match the profile's `picture` and `banner` to the imeta tags describing them. */
export function parseProfileImeta(tags: string[][], metadata: ProfileImages | undefined): ProfileImeta | undefined {
  if (!metadata || !tags.some(([name]) => name === "imeta")) return undefined;
  const entries = parseImetaMap(tags);
  const result: ProfileImeta = {};
  for (const field of FIELDS) {
    const value = metadata[field];
    const entry = typeof value === "string" && value ? entries.get(value) : undefined;
    if (entry) result[field] = entry;
  }
  return result.picture || result.banner ? result : undefined;
}

/**
 * `imeta` if it describes `src`, else undefined. Either spelling counts, since
 * callers may hand over the sanitized URL; anything else (a picture being
 * edited) gets nothing, because one file's key or fallbacks would break another.
 */
export function imetaFor(src: string | undefined, imeta: ImetaEntry | undefined): ImetaEntry | undefined {
  if (!src || !imeta) return undefined;
  return imeta.url === src || sanitizeImageSrc(imeta.url) === src ? imeta : undefined;
}

/** The NIP-94 tags an upload returned (plus any probed fields) as one `imeta` tag. */
export function imetaTagFromUpload(tags: string[][]): string[] {
  return ["imeta", ...tags.filter(([name, value]) => name && value).map(([name, value]) => `${name} ${value}`)];
}

/** The `url` an imeta tag describes, without parsing the rest of it. */
export function imetaUrl(tag: string[]): string | undefined {
  if (tag[0] !== "imeta") return undefined;
  return tag.find((part) => part.startsWith("url "))?.slice(4);
}

/**
 * The imeta tags for a new kind 0: the first of `candidates` matching the
 * `picture`, and likewise the `banner`. Pass this session's uploads before the
 * previous kind 0's tags, so a new image is described by its own upload, an
 * unchanged one keeps its tag, and tags for images no longer used are dropped.
 */
export function profileImetaTags(metadata: ProfileImages, candidates: readonly string[][]): string[][] {
  const out: string[][] = [];
  const used = new Set<string>();
  for (const field of FIELDS) {
    const value = metadata[field];
    if (typeof value !== "string" || !value || used.has(value)) continue;
    const tag = candidates.find((t) => imetaUrl(t) === value);
    if (tag) {
      out.push([...tag]);
      used.add(value);
    }
  }
  return out;
}

/**
 * The previous kind 0's tags a profile save carries forward: everything but its
 * `imeta` (recomputed by {@link profileImetaTags}) and tags mirroring a content
 * field (Amethyst writes `["name", …]` beside the JSON), which the edit makes
 * stale. NIP-30 `emoji` tags must survive, or `:shortcode:` names break.
 */
export function carriedProfileTags(prevTags: readonly string[][], fieldNames: Iterable<string>): string[][] {
  const fields = new Set(fieldNames);
  return prevTags.filter(([name]) => name !== "imeta" && !fields.has(name)).map((tag) => [...tag]);
}

/**
 * `picture` for a sink that can only take a URL (an OS notification icon, a
 * share shortcut, an exported page), or undefined when its imeta says it is
 * encrypted: the URL would only fetch ciphertext.
 */
export function plainProfilePicture(tags: string[][], metadata: ProfileImages | undefined): string | undefined {
  const picture = metadata?.picture;
  if (typeof picture !== "string" || !picture) return undefined;
  return parseProfileImeta(tags, metadata)?.picture?.encryption ? undefined : picture;
}
