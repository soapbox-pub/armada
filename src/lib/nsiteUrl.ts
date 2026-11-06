import { nip19 } from "nostr-tools";

/**
 * Whether `raw` is an `nsite://` URL naming a site, in the grammar Tenna and
 * Din share (Ditto Browser's, NIP-5A labels):
 *
 *     nsite://<npub1…>/path              root site (kind 15128)
 *     nsite://<pubkeyB36><dTag>/path     named site (kind 35128)
 *     nsite://v<snapshotIdB36>/path      snapshot (kind 5128, Tenna only)
 *     nsite://naddr1…/path               alias carrying relay hints
 *
 * Only a URL that names a key is linked: anything else spelled `nsite:` would
 * be handed to the OS's handler for a site that cannot exist.
 */
export function isNsiteUrl(raw: string): boolean {
  if (raw.length > NSITE_URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "nsite:" || url.username || url.password || url.port) return false;
  // `nsite:` is a non-special scheme, so `URL` leaves the host's case and any
  // percent escapes alone; an escape fails the label check rather than decoding.
  const host = url.hostname.toLowerCase();
  if (!LABEL.test(host)) return false;

  if (host.startsWith("npub1") || host.startsWith("naddr1")) {
    try {
      const decoded = nip19.decode(host);
      if (decoded.type === "npub") return true;
      if (decoded.type !== "naddr") return false;
      const { kind, identifier } = decoded.data;
      return kind === NSITE_ROOT_KIND || (kind === NSITE_NAMED_KIND && Boolean(identifier));
    } catch {
      return false;
    }
  }

  if (/^v[0-9a-z]{50}$/.test(host)) return isBase36Key(host.slice(1));

  const dTag = host.slice(BASE36_LENGTH);
  return dTag.length >= 1 && dTag.length <= 63 && isBase36Key(host.slice(0, BASE36_LENGTH));
}

const NSITE_ROOT_KIND = 15128;
const NSITE_NAMED_KIND = 35128;
const BASE36_LENGTH = 50;
const NSITE_URL_MAX_LENGTH = 8192;

/** A label's characters and ends, uncapped: an nsite host is never a DNS name. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Fifty base36 characters can hold far more than 32 bytes; the range check is
 * also what refuses an `nsec1…` or `note1…` host, both of which overflow it.
 */
function isBase36Key(b36: string): boolean {
  if (b36.length !== BASE36_LENGTH) return false;
  let n = 0n;
  for (const ch of b36) n = n * 36n + BigInt(parseInt(ch, 36));
  return n < 1n << 256n;
}
