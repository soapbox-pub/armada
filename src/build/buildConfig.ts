/**
 * The deployment configuration a build bakes in, read from the build's
 * environment (`.env*` files and `process.env`) by the names below.
 *
 * An explicit list rather than Vite's `VITE_` prefix: Vite refuses an empty
 * `envPrefix`, since it would put every variable of the build machine into the
 * bundle, and naming what is read is the stricter version of that guard. The
 * same names are what a host sets on `window.ENV` (`src/lib/env.ts`).
 */
import { loadEnv, type Plugin } from "vite";

export const CONFIG_NAMES = [
  "APP_NAME",
  "APP_ID",
  "PUBLIC_WEB_ORIGIN",
  // Comma-separated: the deployment's relays, every relay default at once. Unset = Armada's public relays.
  "RELAYS",
  // Comma-separated Blossom servers, the first preferred for uploads. Unset = Armada's public servers.
  "BLOSSOM_SERVERS",
  "CONCORD_AV_SERVERS",
  // Discover's curated author list: an naddr, npub/hex pubkey, or empty/"none". Unset = Armada's follow pack.
  "DISCOVER_CURATION",
  "NIP85_STATS_PUBKEY",
  "NSITE_GATEWAY",
  "DEFAULT_NOISE_SUPPRESSION",
  "DEFAULT_ECHO_CANCELLATION",
  "DEFAULT_AUTO_GAIN_CONTROL",
  "DEFAULT_RNNOISE",
  "SANDBOX_DOMAIN",
  // Generic link-preview proxy template, `{url}` = encoded target. Empty = generic previews disabled.
  "LINK_PREVIEW_ENDPOINT",
  // Discord bridge portal origin (e.g. "https://bridge.armada.buzz"). Empty/unset = Discord import UI hidden.
  "BRIDGE_PORTAL_URL",
  // KLIPY GIF API key. Unset = the keyless GIFverse backend.
  "KLIPY_API_KEY",
  "NOSTR_PUSH_PUBKEY",
  "NOSTR_PUSH_RELAYS",
  "NOSTR_PUSH2_PUBKEY",
  "NOSTR_PUSH2_RELAYS",
  // NIP-34 repo identifier whose releases `/downloads` offers (the 30617 `d`). Unset = "armada".
  "RELEASE_REPO_ID",
  // Comma-separated hex pubkeys whose kind-30622 releases are trusted. Unset = Armada's release signer.
  "RELEASE_AUTHORS",
] as const;

export type ConfigName = (typeof CONFIG_NAMES)[number];

export type BuildConfig = Partial<Record<ConfigName, string>>;

/** Prefix the names used to carry; still honoured, with a warning, when the bare name is unset. */
const LEGACY_PREFIX = "VITE_";

/**
 * Picks the listed names out of `env`. An unset name stays ABSENT rather than
 * becoming `""`: the readers fall back with `??` where an empty value means
 * "none", so the two must stay distinguishable.
 */
export function resolveBuildConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = () => {},
): BuildConfig {
  const config: BuildConfig = {};
  for (const name of CONFIG_NAMES) {
    const value = env[name];
    const legacy = env[LEGACY_PREFIX + name];
    if (value !== undefined) {
      config[name] = value;
    } else if (legacy !== undefined) {
      config[name] = legacy;
      warn(`${LEGACY_PREFIX}${name} is deprecated; set ${name} instead.`);
    }
  }
  return config;
}

/** The build's configuration for `mode`, read the way Vite reads `.env*` files. */
export function loadBuildConfig(mode: string, root: string, warn?: (message: string) => void): BuildConfig {
  return resolveBuildConfig(loadEnv(mode, root, ""), warn);
}

const warned = new Set<string>();

/** Defines `__ARMADA_BUILD_CONFIG__`, which `src/lib/env.ts` reads. */
export function buildConfigPlugin(): Plugin {
  return {
    name: "armada-build-config",
    config(config, { mode }) {
      const values = loadBuildConfig(mode, config.root ?? process.cwd(), (message) => {
        if (warned.has(message)) return;
        warned.add(message);
        console.warn(`[armada] ${message}`);
      });
      return { define: { __ARMADA_BUILD_CONFIG__: JSON.stringify(values) } };
    },
  };
}
