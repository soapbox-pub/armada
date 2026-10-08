/**
 * Build-time platform configuration.
 * - `RELAYS` — the deployment's relays, which every relay default follows.
 * - `APP_NAME` — display name of the deployment.
 * - `APP_ID` — fork identifier namespacing the app's own NIP-78 `d` tags.
 */

import { Capacitor } from "@capacitor/core";
import { nip19 } from "nostr-tools";

import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import { config } from "@/lib/env";

/**
 * True only inside the Capacitor native runtime (APK or iOS app). Kept in this
 * leaf module so `main.tsx`'s early imports don't pull the Concord stack.
 */
export function isNativeRuntime(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * True only where the Android `ArmadaNotification` service exists. iOS is
 * native too, but those calls reject with `UNIMPLEMENTED`.
 */
export function hasNativeNotificationService(): boolean {
  return Capacitor.getPlatform() === "android";
}

/** Normalize a relay URL: require ws/wss scheme, strip trailing slash. */
export function normalizeRelayUrl(url: string): string | undefined {
  let value = url.trim();
  if (!value) return undefined;
  // A non-ws URL is invalid, not a hostname (else `https://x` → `wss://https//x`).
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^wss?:\/\//i.test(value)) {
    return undefined;
  }
  if (!/^wss?:\/\//i.test(value)) {
    // Bare hostnames are allowed for convenience; assume wss except localhost/IPs.
    const secure = !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
    value = `${secure ? "wss" : "ws"}://${value}`;
  }
  try {
    const u = new URL(value);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return undefined;
    // WHATWG URL accepts e.g. `'` in a host (`host'group` would become a hostname).
    if (!/^[a-z\d._-]+$/i.test(u.hostname) && !/^\[[\da-f:.]+\]$/i.test(u.hostname)) {
      return undefined;
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Convert a relay websocket URL to its HTTP(S) origin (for NIP-29 livekit endpoints, NIP-11, etc). */
export function relayToHttpUrl(relayUrl: string): string {
  return relayUrl
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/$/, "");
}

/** Relay URL → path segment for routes (`/s/:server`). */
export function relayToRouteParam(relayUrl: string): string {
  return encodeURIComponent(relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")));
}

/** Path segment → relay URL. `relay.internal` ⇒ wss, `ws:host` ⇒ ws. */
export function routeParamToRelay(param: string): string | undefined {
  const decoded = decodeURIComponent(param);
  if (decoded.startsWith("ws:")) {
    return normalizeRelayUrl(`ws://${decoded.slice(3)}`);
  }
  return normalizeRelayUrl(decoded);
}

export const APP_NAME: string = config("APP_NAME") || "Armada";

/**
 * Fork identifier namespacing the NIP-78 settings `d` tags (see
 * `lib/settingsDocs.ts`). Unlike cosmetic {@link APP_NAME}, changing it moves
 * the documents. Must match Android's `SelfState.DEFAULT_D_TAGS`
 * (asserted by `settingsDocs.test.ts`).
 */
export const APP_ID: string = config("APP_ID") || "armada";

/**
 * iOS/iPadOS (iPadOS 13+ has a Mac UA, so Mac + touch counts). On iOS, Web Push
 * is available only to Home-Screen PWAs and every browser is WKWebView.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Whether the client is running as an installed, standalone PWA. */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode = window.matchMedia?.(
    "(display-mode: standalone), (display-mode: fullscreen)",
  ).matches;
  const iosStandalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(displayMode) || iosStandalone;
}

/** A comma-separated list of relay URLs, normalized, invalid ones dropped. */
function relayList(value: string): string[] {
  return value
    .split(",")
    .map((url: string) => normalizeRelayUrl(url))
    .filter((url: string | undefined): url is string => Boolean(url));
}

/**
 * The deployment's own relays (`RELAYS`), the one relay setting. Empty or
 * unset means Armada's public relays and the third-party helpers below.
 * Set, it is every relay default at once — account data, search, new
 * communities, desktop releases, and the {@link RESCUE_RELAYS} a user's
 * community and invite lists are backed up to — and the helpers (broadcast,
 * NIP-65 and git discovery) are off: naming your relays means only those.
 */
export const DEPLOYMENT_RELAYS: string[] = relayList(config("RELAYS") ?? "");
const OWN_RELAYS = DEPLOYMENT_RELAYS.length > 0;

/**
 * Default app relays (Ditto's concept) for non-NIP-29 traffic: profiles, 10009
 * lists, etc. Group events go directly to their host. Seeds `AppConfig.appRelays`
 * and, the same list, `AppConfig.searchRelays`.
 */
export const APP_RELAYS: string[] = OWN_RELAYS
  ? DEPLOYMENT_RELAYS
  : relayList("wss://relay.ditto.pub,wss://relay.dreamith.to");

/**
 * Write-only relays for general pool traffic: published to for reach, never
 * read. Not a marker on `appRelays`, which also serve as DM and account-data
 * relays. Folded only into `poolWriteRelays`; Concord/NIP-29 traffic never
 * goes here. Seeds `AppConfig.broadcastRelays`.
 */
export const BROADCAST_RELAYS: string[] = OWN_RELAYS ? [] : relayList("wss://relay.primal.net");

/** Public NIP-65 indexes used only for a bounded kind-10002 lookup at login. May be empty. */
export const RELAY_LIST_DISCOVERY_RELAYS: string[] = OWN_RELAYS
  ? []
  : relayList("wss://purplepag.es,wss://user.kindpag.es,wss://relay.nos.social");

/**
 * Where the CORD stock set is used as a network floor rather than as wire
 * format: the encrypted community list's and invite list's backup copies,
 * invite delivery to someone with no inbox, and bootstrap fallbacks. The
 * stock set itself stays frozen for the invite codec (`invite.ts`); only a
 * deployment's own relays replace it here.
 */
export const RESCUE_RELAYS: string[] = OWN_RELAYS ? DEPLOYMENT_RELAYS : STOCK_RELAYS;

/**
 * Default home relays for a NEW Concord community. Seeds
 * `AppConfig.communityRelays`; an emptied list falls back to
 * {@link RESCUE_RELAYS}.
 */
export const COMMUNITY_RELAYS: string[] = RESCUE_RELAYS;

/**
 * NIP-34 repository directory (kind 30617 index) for search and hintless
 * lookups only — never subscribed or persisted. Empty disables directory search.
 */
export const GIT_ANNOUNCEMENT_DISCOVERY_RELAY: string = OWN_RELAYS ? "" : "wss://index.ngit.dev";

/** Whether a relay is the discovery index, compared as normalized URLs rather than by substring. */
export function isGitAnnouncementDiscoveryRelay(url: string): boolean {
  return GIT_ANNOUNCEMENT_DISCOVERY_RELAY !== "" && normalizeRelayUrl(url) === GIT_ANNOUNCEMENT_DISCOVERY_RELAY;
}

/**
 * Default Concord AV brokers (CORD-07 §2): blind LiveKit token brokers used to
 * start a call in an empty channel. Override with `CONCORD_AV_SERVERS`
 * (https origins) or set empty to disable Concord voice.
 */
const DEFAULT_PUBLIC_AV_SERVER = "https://armada.buzz";
export const CONCORD_AV_SERVERS: string[] = (
  config("CONCORD_AV_SERVERS") ?? DEFAULT_PUBLIC_AV_SERVER
)
  .split(",")
  .map((s: string) => s.trim())
  .filter((s: string) => Boolean(s));

/** Build-time boolean: "true"/"1", "false"/"0", else `dflt`. */
function envBool(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value === "") return dflt;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return dflt;
}

/** Default mic processing toggles, seeding per-user voice preferences (`voiceDevices.ts`). */
export const DEFAULT_NOISE_SUPPRESSION: boolean = envBool(
  config("DEFAULT_NOISE_SUPPRESSION"),
  true,
);
export const DEFAULT_ECHO_CANCELLATION: boolean = envBool(
  config("DEFAULT_ECHO_CANCELLATION"),
  true,
);
export const DEFAULT_AUTO_GAIN_CONTROL: boolean = envBool(
  config("DEFAULT_AUTO_GAIN_CONTROL"),
  true,
);

/** Default for RNNoise ML noise cancellation (AudioWorklet + WASM). Users can toggle per device. */
export const DEFAULT_RNNOISE: boolean = envBool(config("DEFAULT_RNNOISE"), true);

/**
 * Cross-origin sandbox domain for in-chat apps (webxdc, YouTube). Each app runs
 * on a per-app HMAC-derived subdomain whose Service Worker proxies fetches to
 * the parent (see `SandboxFrame`). Operators may self-host.
 */
export const SANDBOX_DOMAIN: string = config("SANDBOX_DOMAIN") || "iframe.diy";

/**
 * Generic link-preview proxy for hosts without their own OEmbed; it sees every
 * previewed URL. Empty disables generic previews (provider OEmbed still works).
 * `{url}` is replaced with the encoded URL, otherwise it's appended.
 */
export const LINK_PREVIEW_ENDPOINT: string = (
  config("LINK_PREVIEW_ENDPOINT") ?? "https://ditto.pub/api/link-preview/{url}"
).trim();

/** Build the proxy request URL for a link preview, or null if no proxy is configured. */
export function linkPreviewUrl(url: string): string | null {
  if (!LINK_PREVIEW_ENDPOINT) return null;
  const encoded = encodeURIComponent(url);
  return LINK_PREVIEW_ENDPOINT.includes("{url}")
    ? LINK_PREVIEW_ENDPOINT.replaceAll("{url}", encoded)
    : `${LINK_PREVIEW_ENDPOINT}${encoded}`;
}

/** Normalize the configured portal origin, or "" for absent/unusable. */
function parseBridgePortalUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    // Must be a web origin: this ends up in an href (`javascript:` would be script injection).
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/**
 * Discord bridge portal origin. OFF by default: every Discord UI affordance is
 * gated on it. Only used as a link target; nothing is dialed or sent.
 */
export const BRIDGE_PORTAL_URL: string = parseBridgePortalUrl(
  config("BRIDGE_PORTAL_URL") ?? "",
);

/** URL into the bridge portal (`/import` wizard or `/` dashboard), or `null` without a portal. */
export function bridgePortalUrl(path: "/" | "/import" = "/"): string | null {
  if (!BRIDGE_PORTAL_URL) return null;
  return path === "/" ? BRIDGE_PORTAL_URL : `${BRIDGE_PORTAL_URL}${path}`;
}

/**
 * nostr-push gateway: `NOSTR_PUSH_PUBKEY` (npub or hex, `#p`-tagged on
 * kind-25742 RPCs) and `NOSTR_PUSH_RELAYS` (rendezvous relays). Both empty
 * ⇒ no iOS APNs push.
 */
function decodePushPubkey(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === "npub") return decoded.data;
    } catch { /* ignore */ }
  }
  return undefined;
}

export const NOSTR_PUSH_PUBKEY: string | undefined = decodePushPubkey(
  config("NOSTR_PUSH_PUBKEY") ?? "",
);

export const NOSTR_PUSH_RELAYS: string[] = (config("NOSTR_PUSH_RELAYS") ?? "")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/** True when the nostr-push gateway is configured for this build. */
export function nostrPushConfigured(): boolean {
  return Boolean(NOSTR_PUSH_PUBKEY) && NOSTR_PUSH_RELAYS.length > 0;
}

/**
 * nostr-push2, the gateway browser Web Push goes through (`nostrPush2.ts`);
 * the legacy `NOSTR_PUSH_*` pair above serves only iOS APNs. Neither value is
 * secret, so the public service is the default and `NOSTR_PUSH2_PUBKEY` (npub
 * or hex) / `NOSTR_PUSH2_RELAYS` (relays the service itself reads) override it.
 * Empty counts as unset: CI passes an unprovisioned secret as "". Inside
 * Tenna, `window.napp.push` needs neither.
 */
const DEFAULT_NOSTR_PUSH2_PUBKEY = "4c812266b5b8039b4bd98cf2e6c77dcbcae5ea9d9f7d591933c7e4e9b6e174c7";
const DEFAULT_NOSTR_PUSH2_RELAYS = "wss://relay.ditto.pub,wss://relay.dreamith.to";

export const NOSTR_PUSH2_PUBKEY: string | undefined = decodePushPubkey(
  config("NOSTR_PUSH2_PUBKEY")?.trim() || DEFAULT_NOSTR_PUSH2_PUBKEY,
);

export const NOSTR_PUSH2_RELAYS: string[] = (
  config("NOSTR_PUSH2_RELAYS")?.trim() || DEFAULT_NOSTR_PUSH2_RELAYS
)
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

export function nostrPush2Configured(): boolean {
  return Boolean(NOSTR_PUSH2_PUBKEY) && NOSTR_PUSH2_RELAYS.length > 0;
}
