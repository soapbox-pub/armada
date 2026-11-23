/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in a `npm run build:profile` build: names kept, source maps, render attribution on. */
  readonly VITE_PROFILE?: string;
  /** Semver version from package.json (e.g., "0.25.4"). */
  readonly VERSION: string;
  /** ISO 8601 timestamp of when the app was built. */
  readonly BUILD_DATE: string;
  /** Short git commit SHA. Empty string if unavailable. */
  readonly COMMIT_SHA: string;
  /** Full git commit SHA. Empty string if unavailable. */
  readonly COMMIT_SHA_FULL: string;
  /** Git tag for the current commit (e.g., "v0.25.4"). Empty string if untagged (pre-release build). */
  readonly COMMIT_TAG: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Deployment settings baked in at build time; read through `config()` in `src/lib/env.ts`. */
declare const __ARMADA_BUILD_CONFIG__: import("./build/buildConfig").BuildConfig;
