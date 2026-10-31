/**
 * Normalized `href` if well-formed http(s), else undefined. MUST be used for
 * untrusted URLs going into `href`/`window.open()`/`openUrl()` (blocks
 * `javascript:`). Unlike Ditto, plain `http:` is allowed for private infrastructure.
 */
export function sanitizeUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.href;
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Longest magnet URI rendered as a link; tracker lists make real ones a few KB. */
const MAGNET_MAX_LENGTH = 8192;

/**
 * Whether `raw` is a BitTorrent magnet URI naming its content by hash
 * (`xt=urn:btih:` v1 or `urn:btmh:` v2), the only `magnet:` shape linked.
 */
export function isMagnetUri(raw: string): boolean {
  if (raw.length > MAGNET_MAX_LENGTH || !/^magnet:\?/i.test(raw)) return false;
  return new URLSearchParams(raw.slice(raw.indexOf("?") + 1))
    .getAll("xt")
    .some((xt) => /^urn:bt(?:ih|mh):[0-9a-z]+$/i.test(xt));
}

/**
 * Whether a URL targets a loopback/private address. Loading one from a public
 * page triggers Chrome's Local Network Access prompt for every viewer, so
 * untrusted media URLs like this MUST be refused.
 */
export function isLocalNetworkUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  let h = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  // IPv4-mapped IPv6 comes back in hex (::ffff:7f00:1) and would match no rule below.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const n = (parseInt(mapped[1], 16) << 16) | parseInt(mapped[2], 16);
    h = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  } else {
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (dotted) h = dotted[1];
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / "this host"
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
  }
  if (/^f[cd][0-9a-f]*:/.test(h)) return true; // IPv6 unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]*:/.test(h)) return true; // IPv6 link-local fe80::/10
  return false;
}

/**
 * Sanitized URL on another host, else undefined — for "open original" on
 * embeds (same-origin links navigate in-app). Without `window.location`
 * (SSR/tests), any absolute URL counts as external.
 */
export function externalUrl(raw: string | undefined | null): string | undefined {
  const safe = sanitizeUrl(raw);
  if (!safe) return undefined;
  try {
    if (typeof window !== "undefined" && new URL(safe).host === window.location.host) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return safe;
}

/** Hostname without `www.`, or the raw string if unparseable. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Validate an `<img>`/`<video>` source: {@link sanitizeUrl} plus
 * {@link isLocalNetworkUrl} (to avoid LAN prompts, not XSS). `blob:` and
 * `data:` pass through (origin-minted or self-contained).
 */
export function sanitizeImageSrc(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (/^(?:blob|data):/i.test(raw)) return raw;
  const url = sanitizeUrl(raw);
  if (!url || isLocalNetworkUrl(url)) return undefined;
  return url;
}
