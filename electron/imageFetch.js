// Image bytes for the page from hosts that send no CORS headers, so it can
// draw a small copy instead of letting Chromium keep every frame at full size
// (src/lib/imageThumb.ts). An animated avatar on such a host measured ~25 MB of
// decoded frames in a busy room.
//
// The request is the one the page's <img> already makes, from this machine and
// through the session's proxy (main.js hands in Chromium's net.fetch), so
// nothing new learns the user's address. What this adds is READING the bytes
// cross-origin, so it answers only for public https hosts — every redirect hop
// checked, by name and, on a direct connection, by what the name resolves to,
// since a public name can point at the LAN — never sends cookies, caps the
// size, and returns only bytes that are an image by their own signature.

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

// Mirrors isLocalNetworkUrl (src/lib/sanitizeUrl.ts).
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"];

function isLocalHost(hostname) {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  const embedded = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (embedded) {
    const n = (parseInt(embedded[1], 16) << 16) | parseInt(embedded[2], 16);
    h = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  } else {
    const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (dotted) h = dotted[1];
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (/^f[cd][0-9a-f]*:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]*:/.test(h)) return true;
  return false;
}

function publicHttps(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !isLocalHost(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** The image type by signature, or null: GIF, PNG/APNG, JPEG, WebP, AVIF. */
function imageType(bytes) {
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 12) === "ftypavif" || ascii(4, 12) === "ftypavis") return "image/avif";
  return null;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Whether `url`'s host resolves only to public addresses. `resolveImpl`
 * returns the addresses, or null when the connection goes through a proxy,
 * which resolves the name itself (asking here would leak it to local DNS).
 */
async function resolvesPublic(url, resolveImpl) {
  if (!resolveImpl) return true;
  const addresses = await resolveImpl(url);
  if (addresses === null) return true;
  return addresses.length > 0 && !addresses.some((a) => isLocalHost(a.includes(":") ? `[${a}]` : a));
}

/** `{ type, data }` for a public https image, else null. Never throws. */
async function fetchImage(raw, { fetchImpl = globalThis.fetch, resolveImpl } = {}) {
  let url = publicHttps(raw);
  if (!url) return null;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await resolvesPublic(url, resolveImpl))) return null;
      const res = await fetchImpl(url.href, {
        credentials: "omit",
        redirect: "manual",
        signal,
        headers: { Accept: "image/*" },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        url = next ? publicHttps(new URL(next, url).href) : null;
        if (!url) return null;
        continue;
      }
      if (!res.ok) return null;
      const data = await readCapped(res);
      const type = data && imageType(data);
      return type ? { type, data } : null;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { fetchImage, imageType, isLocalHost };
