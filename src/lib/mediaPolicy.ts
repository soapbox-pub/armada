import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

/**
 * Where remote media is loaded from. An `<img>` leaks the viewer's IP to the
 * sender's host; the only fix is a proxy URI template (`{href}`, Ditto's
 * convention). OFF by default. Loopback/private addresses are never loaded
 * (unreachable by a proxy; trips Chrome's Local Network Access prompt).
 *
 * `proxies` is an optional rotation pool used by `routeMediaCandidates`;
 * `proxy` is its first entry and what non-rotating callers use.
 *
 * Kotlin/Swift ports (`MediaPolicy.java`, `MediaPolicy.swift`) must stay in
 * step; `normalizeProxy` must stay identical across all three.
 */

/** Ditto's byte-for-byte pass-through proxy; suggested by settings, never applied without opt-in. */
export const DEFAULT_MEDIA_PROXY = "https://proxy.shakespeare.diy/?url={href}";

export interface MediaPolicy {
  /** Proxy URI template (see {@link normalizeMediaProxy}); empty = no proxy. */
  proxy: string;
  /**
   * Rotation pool for {@link routeMediaCandidates}; only set with multiple
   * proxies and never when {@link proxy} is empty. Not sent over the native bridge.
   */
  proxies?: readonly string[];
}

/** How many templates a fetched rotation list may contribute, at most. */
export const MAX_PROXY_POOL = 32;

/** The policy as sent to the service worker, Android service and iOS extension (plain JSON). */
export interface MediaPolicyConfig {
  proxy: string;
}

/**
 * Proxying OFF — the default for readers with no config (e.g. background
 * writers whose config predates this field).
 */
export function defaultMediaPolicy(): MediaPolicy {
  return { proxy: "" };
}

export function mediaPolicyFromConfig(config: Partial<MediaPolicyConfig> | undefined): MediaPolicy {
  if (!config || typeof config.proxy !== "string") return defaultMediaPolicy();
  return { proxy: normalizeMediaProxy(config.proxy) };
}

/** Minimal RFC 6570: `{var}` percent-encodes, `{+var}` keeps reserved chars, unknown vars → "". */
export function fillUriTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\+?)([A-Za-z0-9_]+)\}/g, (_m, plus: string, name: string) => {
    const value = vars[name];
    if (value === undefined) return "";
    return plus ? encodeURI(value) : encodeURIComponent(value);
  });
}

/**
 * Normalize a proxy template: trimmed, http(s) only, `""` if unusable. A bare
 * prefix ending in `=` gets `{href}` (encoded query value); other bare prefixes
 * get `{+href}` (raw, as corsfix-style proxies expect). Explicit placeholders are kept.
 */
export function normalizeMediaProxy(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  try {
    const probe = new URL(fillUriTemplate(trimmed, { href: "https://example.com/x" }));
    if (probe.protocol !== "https:" && probe.protocol !== "http:") return "";
  } catch {
    return "";
  }
  if (/\{\+?href\}/.test(trimmed)) return trimmed;
  return trimmed.endsWith("=") ? `${trimmed}{href}` : `${trimmed}{+href}`;
}

/**
 * Parse the user's proxy list: one per line (or `,`), `#` comments dropped,
 * normalized, deduped, capped at {@link MAX_PROXY_POOL}.
 */
export function parseProxyList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/[\r\n,]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = normalizeMediaProxy(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_PROXY_POOL) break;
  }
  return out;
}

/** The lowercase hostname of a URL, or undefined when it has none. */
export function mediaHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

function isInlineSource(url: string): boolean {
  return /^(?:blob|data):/i.test(url);
}

/** Resolves app-relative paths so they can be told apart from remote URLs. */
const RELATIVE_BASE = "https://relative.invalid/";

/**
 * `url` as a normalized remote http(s) URL, or undefined. The normalized form is
 * what gets loaded, so host checks see the real host. Base only catches `//host`.
 */
function remoteHref(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    try {
      parsed = new URL(url, RELATIVE_BASE);
    } catch {
      return undefined;
    }
    if (parsed.origin === new URL(RELATIVE_BASE).origin) return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  return parsed.href;
}

/**
 * `url` through `proxy`, or `url` itself for inline sources, non-http schemes,
 * an empty template, or a URL already on the proxy's origin (no double-wrapping).
 */
export function proxyMediaUrl(url: string, proxy: string): string {
  if (!proxy || isInlineSource(url)) return url;
  const href = remoteHref(url);
  if (!href) return url;
  // Template braces aren't URL chars, so read the proxy host off a filled probe.
  const proxyHost = mediaHost(fillUriTemplate(proxy, { href: "https://example.com/x" }));
  if (proxyHost && mediaHost(href) === proxyHost) return href;
  return fillUriTemplate(proxy, { href });
}

/**
 * `src` for `url` under `policy`, or undefined for loopback/private addresses.
 * For single-image sites that show nothing rather than a placeholder.
 */
export function mediaSrc(url: string | undefined, policy: MediaPolicy): string | undefined {
  if (!url) return undefined;
  if (isInlineSource(url)) return url;
  const href = remoteHref(url);
  if (!href) return url;
  if (isLocalNetworkUrl(href)) return undefined;
  return policy.proxy ? proxyMediaUrl(href, policy.proxy) : href;
}

function effectiveProxies(policy: MediaPolicy): readonly string[] {
  if (policy.proxies && policy.proxies.length > 0) return policy.proxies;
  return policy.proxy ? [policy.proxy] : [];
}

/** A stable 32-bit hash (FNV-1a), so a URL's rotation start is deterministic. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Proxied forms of `url` across `proxies`, starting at a per-URL offset to
 * spread load. A URL already on a pool host is returned once, unwrapped.
 */
function proxyRotation(url: string, proxies: readonly string[]): string[] {
  const urlHost = mediaHost(url);
  const proxyHosts = proxies.map((p) => mediaHost(fillUriTemplate(p, { href: "https://example.com/x" })));
  if (urlHost && proxyHosts.some((h) => h === urlHost)) return [url];
  const start = urlHost ? hashString(url) % proxies.length : 0;
  const out: string[] = [];
  for (let i = 0; i < proxies.length; i++) {
    out.push(fillUriTemplate(proxies[(start + i) % proxies.length], { href: url }));
  }
  return out;
}

/**
 * Route a candidate list under `policy`: proxied or direct, local-network
 * dropped, deduped. With a pool, each candidate expands through every proxy so
 * the `<img>` fallback walk tries the next one on failure.
 */
export function routeMediaCandidates(
  candidates: readonly string[],
  policy: MediaPolicy,
): { sources: string[] } {
  const proxies = effectiveProxies(policy);
  const sources: string[] = [];
  const seen = new Set<string>();
  const push = (src: string | undefined) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    sources.push(src);
  };
  for (const candidate of candidates) {
    const href = isInlineSource(candidate) ? undefined : remoteHref(candidate);
    if (!href) {
      push(candidate);
      continue;
    }
    if (isLocalNetworkUrl(href)) continue;
    if (proxies.length === 0) {
      push(href);
      continue;
    }
    for (const variant of proxyRotation(href, proxies)) push(variant);
  }
  return { sources };
}
