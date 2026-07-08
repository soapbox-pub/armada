/**
 * Platform (build-time pinned) configuration for internal infrastructure.
 *
 * - `VITE_PLATFORM_RELAYS` — comma-separated relay websocket URLs. These are
 *   always part of the server list and cannot be removed by the user.
 * - `VITE_APP_RELAYS` — comma-separated default app relays used for
 *   non-NIP-29 traffic (profiles, lists). User-overridable in Settings.
 * - `VITE_APP_NAME` — display name of the deployment.
 */

/** Normalize a relay URL: require ws/wss scheme, strip trailing slash. */
export function normalizeRelayUrl(url: string): string | undefined {
  let value = url.trim();
  if (!value) return undefined;
  if (!/^wss?:\/\//i.test(value)) {
    // Bare hostnames are allowed for convenience; assume wss except localhost/IPs.
    const secure = !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
    value = `${secure ? "wss" : "ws"}://${value}`;
  }
  try {
    const u = new URL(value);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return undefined;
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Drop relay URLs that can never carry NIP-46 signer traffic from this origin.
 *
 * A `ws://` rendezvous relay only works when the app itself runs on an
 * insecure origin (plain-http dev): the Android APK's WebView (https scheme,
 * mixed content blocked) and any https deployment refuse `ws://` sockets
 * outright. Baking one into a signer pairing anyway doesn't just waste a
 * slot — the signer (e.g. Amber) retries the dead relay on every operation
 * for the lifetime of the connection (a pre-v0.10.0 pairing carried
 * `ws://localhost:5577` for weeks of updates). Filter them where they cannot
 * work; keep them on http origins, where local-dev signing legitimately uses
 * a localhost relay.
 */
export function usableSignerRelays(urls: string[], insecureOrigin: boolean): string[] {
  if (insecureOrigin) return urls;
  return urls.filter((url) => url.toLowerCase().startsWith("wss://"));
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

export const APP_NAME: string = import.meta.env.VITE_APP_NAME || "Armada";

/**
 * Pinned platform relays. Always present (when set); not user-removable.
 *
 * `VITE_PLATFORM_RELAYS` is set only by a *hosted* deployment (the operator
 * pins their own relay). Every other build — the Android APK, the Electron
 * desktop app, and local `npm run dev` — leaves it unset/empty and therefore
 * ships with NO pinned relays: the user starts with zero servers and adds their
 * own. This is deliberate: a baked-in `ws://localhost:5577` is meaningless (and
 * actively confusing) on a phone or a sovereign desktop client, so we never
 * default to one. For local dev against a relay, set `VITE_PLATFORM_RELAYS`
 * yourself (e.g. `VITE_PLATFORM_RELAYS=ws://localhost:5577 npm run dev`).
 *
 * Unset (`undefined`) and empty (`""`) are treated identically — both mean "no
 * pinned relays". A non-empty value is the hosted deployment's comma-separated
 * pinned relays.
 */
const RAW_PLATFORM_RELAYS: string = import.meta.env.VITE_PLATFORM_RELAYS ?? "";
export const PLATFORM_RELAYS: string[] = RAW_PLATFORM_RELAYS
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default app relays (Ditto's "app relays" concept): general-purpose relays
 * used for non-NIP-29 events — kind 0 profiles, kind 10009 group lists, and
 * any other plain Nostr traffic. Group-scoped events never go here; they are
 * published directly to their host server via `nostr.relay(url)`.
 *
 * These seed `AppConfig.appRelays`, which the user can edit in Settings.
 */
export const APP_RELAYS: string[] = (import.meta.env.VITE_APP_RELAYS || "wss://relay.ditto.pub,wss://relay.dreamith.to")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default search relays (Ditto's hardcoded `DITTO_RELAYS` concept, made
 * user-editable here). NIP-50 search queries (`search` filters) route here
 * instead of fanning out to every server. Seeds `AppConfig.searchRelays`.
 */
export const SEARCH_RELAYS: string[] = (import.meta.env.VITE_SEARCH_RELAYS || "wss://relay.ditto.pub,wss://relay.dreamith.to")
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Default Concord AV brokers (CORD-07 §2): blind LiveKit token brokers (https
 * origins) used to START a call in an empty voice channel — once anyone is in
 * a call, their presence-announced broker is the rendezvous point (§5). The
 * broker authorizes by channel-key-possession proof, not membership, so it
 * learns nothing about the community.
 *
 * Resolution order when `VITE_CONCORD_AV_SERVERS` is unset:
 *   - Hosted build (PLATFORM_RELAYS non-empty): armada's own relay hosts the
 *     broker endpoint, so the platform relays' HTTP origins are the default.
 *   - Non-hosted build (APK / Electron / dev): no platform relay hosts one, so
 *     default to the public Armada instance.
 * Operators can override with `VITE_CONCORD_AV_SERVERS` (comma-separated https
 * origins) or set it empty to disable Concord voice.
 */
const DEFAULT_PUBLIC_AV_SERVER = "https://armada.buzz";
export const CONCORD_AV_SERVERS: string[] = (
  import.meta.env.VITE_CONCORD_AV_SERVERS ??
  (PLATFORM_RELAYS.length > 0
    ? PLATFORM_RELAYS.map((url) => relayToHttpUrl(url)).join(",")
    : DEFAULT_PUBLIC_AV_SERVER)
)
  .split(",")
  .map((s: string) => s.trim())
  .filter((s: string) => Boolean(s));

/**
 * Default LiveKit-capable NIP-29 relay(s) to host **DM** voice rooms, when none
 * of the user's own DM/platform relays speak the NIP-29 LiveKit extension.
 *
 * DM voice runs over a relay's NIP-29 LiveKit
 * token endpoint. On a hosted build the platform relay already hosts it; on a
 * non-hosted build (APK / Electron / dev, `PLATFORM_RELAYS` empty) there's no
 * such relay among the default app relays, so
 * default to the public Armada instance (`wss://armada.buzz`)
 * so 1:1 calls work out of the box. Operators can override with
 * `VITE_DM_VOICE_RELAYS` (comma-separated ws/wss URLs) or set it empty to
 * disable the fallback.
 */
const DEFAULT_PUBLIC_DM_VOICE_RELAY = "wss://armada.buzz";
export const DM_VOICE_RELAYS: string[] = (
  import.meta.env.VITE_DM_VOICE_RELAYS ??
  (PLATFORM_RELAYS.length > 0 ? PLATFORM_RELAYS.join(",") : DEFAULT_PUBLIC_DM_VOICE_RELAY)
)
  .split(",")
  .map((url: string) => normalizeRelayUrl(url))
  .filter((url: string | undefined): url is string => Boolean(url));

/**
 * Parse a build-time boolean env var. Vite env vars are always strings (or
 * undefined when unset), so we treat "true"/"1" as true, "false"/"0" as false,
 * and fall back to `dflt` when unset/unrecognised.
 */
function envBool(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value === "") return dflt;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return dflt;
}

/**
 * Default mic audio-processing toggles for voice calls. These seed the
 * per-user voice preferences (`getAudioProcessing` in `voiceDevices.ts`) the
 * first time a user opens the in-call audio settings; the user can override
 * each toggle afterwards. Operators set the platform defaults at build time.
 *
 * All three default to `true`, matching LiveKit/browser defaults — good
 * general-purpose noise/echo handling. Operators targeting e.g. music or
 * push-to-talk setups may want to disable some via these env vars.
 */
export const DEFAULT_NOISE_SUPPRESSION: boolean = envBool(
  import.meta.env.VITE_DEFAULT_NOISE_SUPPRESSION,
  true,
);
export const DEFAULT_ECHO_CANCELLATION: boolean = envBool(
  import.meta.env.VITE_DEFAULT_ECHO_CANCELLATION,
  true,
);
export const DEFAULT_AUTO_GAIN_CONTROL: boolean = envBool(
  import.meta.env.VITE_DEFAULT_AUTO_GAIN_CONTROL,
  true,
);

/**
 * Default for the RNNoise ML noise-cancellation track processor (the
 * Discord-style background-noise remover, BSD-licensed, the same engine Jitsi
 * ships). Unlike the three constraints above — which are simple browser
 * MediaTrackConstraints — this runs an AudioWorklet + WASM model over the
 * captured mic and publishes the cleaned track. On by default; operators can
 * disable it at build time (e.g. for low-power clients) and users can toggle it
 * per-device in voice settings.
 */
export const DEFAULT_RNNOISE: boolean = envBool(import.meta.env.VITE_DEFAULT_RNNOISE, true);

/**
 * Cross-origin sandbox domain for in-chat apps (webxdc / YouTube watchalong).
 *
 * Untrusted app content (an arbitrary `.xdc` archive, or a third-party YouTube
 * iframe) runs inside an `<iframe>` on a *distinct* origin — a per-app
 * HMAC-derived subdomain of this domain — so it is fully origin-isolated from
 * the Armada client (no access to our localStorage/IndexedDB/cookies). The
 * subdomain hosts a tiny Service Worker (the "iframe.diy" loader) that proxies
 * every `fetch` back to the parent over `postMessage`; the parent serves the
 * app's files from memory (see `SandboxFrame`). The public `iframe.diy` service
 * provides this; operators may self-host an equivalent and override here.
 */
export const SANDBOX_DOMAIN: string = import.meta.env.VITE_SANDBOX_DOMAIN || "iframe.diy";
