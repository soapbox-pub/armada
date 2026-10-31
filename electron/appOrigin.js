"use strict";

/**
 * Whether a URL belongs to the packaged renderer's app://armada origin.
 *
 * Node's URL implementation reports `.origin === "null"` for custom schemes,
 * even when Electron registered that scheme as standard and secure. Compare
 * the parsed protocol and authority instead so permission requests from the
 * packaged renderer are admitted without trusting lookalike hosts or userinfo.
 */
function isArmadaAppUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.host === "armada" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Schemes Armada will hand to the operating system's default handler.
 *
 * Deliberately a tiny allowlist rather than a denylist of known-bad schemes.
 * `setWindowOpenHandler` fires for `window.open` from ANY frame in the
 * renderer, and the app embeds untrusted third-party content — WebXDC apps run
 * in a sandbox that carries `allow-popups-to-escape-sandbox`, and link embeds
 * load foreign origins. Anything reaching shell.openExternal is therefore a
 * string a stranger may have chosen, and the OS will happily launch a handler
 * for `file:`, `smb:`, `ms-msdt:` or any installed app's private scheme.
 */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Whether a URL may be opened in the user's browser / mail client. */
function isExternallyOpenableUrl(value) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Whether a URL is the NIP-46 pairing link the login screen hands to a signer
 * app (a desktop signer like Opal registers the scheme). Not in
 * EXTERNAL_SCHEMES: it is honoured only for a navigation the app's own main
 * frame started, never for a window.open any embedded frame can reach.
 */
function isSignerHandoffUrl(value) {
  try {
    return new URL(value).protocol === "nostrconnect:";
  } catch {
    return false;
  }
}

/**
 * Whether a URL is a BitTorrent magnet link, handed to the torrent client only
 * for a click in the app's own top frame (see isSignerHandoffUrl): from any
 * frame's window.open it would let embedded content start a download.
 */
function isMagnetUrl(value) {
  try {
    return new URL(value).protocol === "magnet:";
  } catch {
    return false;
  }
}

/**
 * The in-app router path of a link to our OWN public web host, or null.
 *
 * A "Copy message link" produces `https://<host>/<chat-path>/m/<id>` — the same
 * https URL Android App Links and iOS universal links already route into the
 * app. Clicked INSIDE the desktop shell it would otherwise be treated as a
 * foreign origin and kicked out to the system browser (there is no OS-level
 * https handoff into a desktop app short of being the default browser). So the
 * navigation handlers ask this whether a link is really one of ours and, if so,
 * route it through the renderer's router instead of shell.openExternal.
 *
 * `host` is the renderer's build-time App Links host (`PUBLIC_WEB_ORIGIN`),
 * registered over IPC — it is not known to the main process otherwise. This
 * mirrors `pathFromDeepLinkUrl`'s https branch (lib/deepLinkUrl.ts) exactly:
 * https only, exact host, a real router path (a leading `//` is a
 * protocol-relative URL naming another origin, not a path), never bare `/`.
 */
function internalAppLinkPath(value, host) {
  if (!host) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname.toLowerCase() !== String(host).toLowerCase()) return null;
    const path = url.pathname + url.search + url.hash;
    if (!path.startsWith("/") || /^\/[\\/]/.test(path)) return null;
    // A bare domain open ("/") is not a deep link; leave it to the shell's
    // ordinary external handling rather than a self-navigation to the app root.
    return path === "/" ? null : path;
  } catch {
    return null;
  }
}

module.exports = {
  isArmadaAppUrl,
  isExternallyOpenableUrl,
  isSignerHandoffUrl,
  isMagnetUrl,
  internalAppLinkPath,
};
