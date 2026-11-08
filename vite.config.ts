import { execSync } from "node:child_process";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { build, defineConfig, type InlineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";

import { buildConfigPlugin, loadBuildConfig } from "./src/build/buildConfig";
import { manualChunks } from "./src/build/manualChunks";
import { oneByteScripts } from "./src/build/oneByteScripts";

/**
 * Short commit SHA — prefer CI env var, fall back to git. Empty string if
 * unavailable (e.g. no git repo).
 */
function getCommitSha(): string {
  if (process.env.CI_COMMIT_SHORT_SHA) return process.env.CI_COMMIT_SHORT_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** Full commit SHA, or empty string without git. Recorded in `/build.json`. */
function getFullCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * The one timestamp a build may carry: `SOURCE_DATE_EPOCH` (reproducible-builds.org),
 * else the commit's own time, so two builds of one commit come out byte-identical.
 * Wall-clock time only without git.
 */
function getBuildEpoch(): number {
  const fromEnv = Number(process.env.SOURCE_DATE_EPOCH);
  if (process.env.SOURCE_DATE_EPOCH && Number.isSafeInteger(fromEnv)) return fromEnv;
  try {
    const committed = Number(execSync("git log -1 --format=%ct", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (Number.isSafeInteger(committed) && committed > 0) return committed;
  } catch {
    // fall through
  }
  return Math.floor(Date.now() / 1000);
}

const BUILD_EPOCH = getBuildEpoch();

/**
 * Git tag for the current commit — prefer CI env var, fall back to git. Empty
 * string if untagged (pre-release build). A SET but empty `CI_COMMIT_TAG` means
 * untagged, so a verifier can rebuild a branch build from a clone that has the
 * tag CI's shallow checkout never saw.
 */
function getCommitTag(): string {
  if (process.env.CI_COMMIT_TAG !== undefined) return process.env.CI_COMMIT_TAG;
  try {
    return execSync("git describe --exact-match --tags HEAD 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * The marketing version (X.Y.Z) for this build. Source of truth is the git tag
 * (per the release skill, package.json is never bumped). When on a tagged
 * commit, the tag minus its `v` prefix is used. For pre-release/dev builds, the
 * latest version from CHANGELOG.md is used so the footer matches the changelog
 * page (the caller appends a `+` suffix for untagged builds).
 */
function getVersion(): string {
  const tag = getCommitTag();
  if (tag) return tag.replace(/^v/, "");
  try {
    const changelog = fs.readFileSync(path.resolve(import.meta.dirname, "CHANGELOG.md"), "utf-8");
    const match = changelog.match(/^## \[([^\]]+)\]/m);
    if (match) return match[1];
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * Serves the repo-root CHANGELOG.md at /CHANGELOG.md in dev and copies it into
 * the build output, so the in-app changelog page and version-update toast can
 * fetch it without maintaining a duplicate copy in public/.
 */
function serveChangelog(): Plugin {
  const root = path.resolve(import.meta.dirname, "CHANGELOG.md");
  return {
    name: "armada-serve-changelog",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/CHANGELOG.md" && req.url !== "/CHANGELOG.md/") return next();
        try {
          const stat = fs.statSync(root);
          if (stat.isFile()) {
            res.setHeader("Content-Type", "text/markdown; charset=utf-8");
            res.end(fs.readFileSync(root, "utf-8"));
            return;
          }
        } catch {
          // fall through
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve("dist");
      try {
        fs.copyFileSync(root, path.join(outDir, "CHANGELOG.md"));
      } catch {
        // no changelog — skip
      }
    },
  };
}

/**
 * Writes `/desktop.json`: the desktop shell API level this bundle was built
 * against (`electron/desktopApi.json`) and the build epoch. A shell refuses a
 * site whose level is above its own, and its own shipped copy's `builtAt` is
 * the floor no site manifest may predate (`electron/webSite.js`).
 */
function desktopManifest(): Plugin {
  const source = path.resolve(import.meta.dirname, "electron/desktopApi.json");
  return {
    name: "armada-desktop-manifest",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve("dist");
      const { level } = JSON.parse(fs.readFileSync(source, "utf-8")) as { level: number };
      const manifest = { api: level, builtAt: BUILD_EPOCH };
      fs.writeFileSync(path.join(outDir, "desktop.json"), `${JSON.stringify(manifest)}\n`);
    },
  };
}

/** First line of `<command> --version`, run where `cwd` would run it (rustc honours the crate's toolchain file). */
function toolVersion(command: string, cwd = import.meta.dirname): string | null {
  try {
    return execSync(`${command} --version`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")[0].trim();
  } catch {
    return null;
  }
}

/**
 * Writes `/build.json`: everything `scripts/verify-build.mjs` needs to rebuild
 * this bundle byte-for-byte — the commit, the build epoch, the deployment
 * config (already readable in the bundle itself) and the toolchain. It sits
 * inside the signed site manifest, so the manifest commits to its source.
 */
function buildInfo(): Plugin {
  let mode = "production";
  let root = process.cwd();
  return {
    name: "armada-build-info",
    apply: "build",
    configResolved(config) {
      mode = config.mode;
      root = config.root;
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve("dist");
      const info = {
        commit: getFullCommitSha(),
        tag: getCommitTag(),
        version: getVersion(),
        sourceDateEpoch: BUILD_EPOCH,
        config: loadBuildConfig(mode, root),
        webxdcRt: fs.existsSync(path.resolve(import.meta.dirname, "src/wasm/webxdc-rt/webxdc_rt_bg.wasm")),
        toolchain: {
          node: process.version,
          rustc: toolVersion("rustc", path.resolve(import.meta.dirname, "crates/webxdc-rt")),
          wasmPack: toolVersion("wasm-pack"),
          wasmBindgen: toolVersion("wasm-bindgen"),
          // `ring`'s C is compiled into the wasm by the host clang.
          clang: toolVersion("clang"),
        },
      };
      fs.writeFileSync(path.join(outDir, "build.json"), `${JSON.stringify(info, null, 2)}\n`);
    },
  };
}

/**
 * Stamps each build with an id unique to its source commit (the build epoch):
 *  - index.html: fills the `<meta name="build">` placeholder so a device's
 *    running bundle can be identified from the DOM when debugging stale-PWA
 *    issues (installed iOS PWAs resume from memory and can serve a stale cached
 *    shell, making deploys appear to fail). `main.tsx` also puts it in the
 *    service worker's script URL, so every deploy installs a fresh worker.
 *
 * Also stamps `__PUBLIC_ORIGIN__` into index.html's Open Graph tags. Those have
 * to be absolute (crawlers don't resolve relative ones), which means a
 * hardcoded host makes every build's link preview depend on THAT host being
 * reachable rather than the one it was deployed to — and an unfetchable
 * og:image degrades to the platform's generic placeholder, which is
 * indistinguishable from having no card at all.
 */
function buildStamp(): Plugin {
  const stamp = new Date(BUILD_EPOCH * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z";
  let origin = "https://armada.buzz";
  return {
    name: "armada-build-stamp",
    configResolved(config) {
      origin = (loadBuildConfig(config.mode, config.root).PUBLIC_WEB_ORIGIN || origin).replace(/\/$/, "");
    },
    transformIndexHtml(html) {
      return html.replaceAll("__BUILD_STAMP__", stamp).replaceAll("__PUBLIC_ORIGIN__", origin);
    },
  };
}

/**
 * Builds the service worker (`src/sw/sw.ts`) to `/sw.js`: written beside the
 * app by `vite build`, and bundled on request by the dev server.
 *
 * Its own build rather than an entry of the app's, because a service worker
 * is one self-contained CLASSIC script: rollup can't emit an IIFE entry beside
 * the app's ES chunks, and a module worker (`type: "module"`) is still missing
 * from engines Armada supports. So none of the app's chunks are shared with it
 * and none of it enters the app bundle.
 */
function serviceWorker(): Plugin {
  const entry = path.resolve(import.meta.dirname, "src/sw/sw.ts");
  let outDir = path.resolve(import.meta.dirname, "dist");
  let mode = "production";
  let logLevel: InlineConfig["logLevel"];
  let isBuild = false;

  const workerConfig = (write: boolean): InlineConfig => ({
    configFile: false,
    root: import.meta.dirname,
    mode,
    logLevel,
    publicDir: false,
    plugins: [buildConfigPlugin()],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "./src") },
    },
    build: {
      // Every push-capable engine, iOS 16.4+ Safari included; es2020 covers
      // BigInt (secp256k1, and Concord's epoch arithmetic).
      target: "es2020",
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      write,
      lib: {
        entry,
        formats: ["iife"],
        name: "ArmadaServiceWorker",
        fileName: () => "sw.js",
      },
    },
  });

  return {
    name: "armada-service-worker",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      mode = config.mode;
      logLevel = config.logLevel;
      isBuild = config.command === "build";
    },
    configureServer(server) {
      // Rebuilt per request: the browser asks for /sw.js only on registration
      // and update checks, so a cache would buy little and could serve a stale
      // worker.
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/sw.js") return next();
        try {
          const result = await build(workerConfig(false));
          const outputs = Array.isArray(result) ? result : [result];
          const chunk = outputs
            .flatMap((out) => ("output" in out ? out.output : []))
            .find((file) => file.type === "chunk");
          if (!chunk || chunk.type !== "chunk") throw new Error("service worker build emitted no chunk");
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(chunk.code);
        } catch (err) {
          next(err);
        }
      });
    },
    async closeBundle() {
      if (!isBuild) return;
      await build(workerConfig(true));
    },
  };
}

/**
 * Builds `src/npanel/preview.ts` to `/.well-known/npanel/preview.js`: the
 * script an npanel gateway runs to give crawlers link previews of profiles and
 * invites. One self-contained ES module, since npanel's scripts import nothing.
 */
function npanelPreview(): Plugin {
  const entry = path.resolve(import.meta.dirname, "src/npanel/preview.ts");
  let outDir = path.resolve(import.meta.dirname, "dist");
  let mode = "production";
  let logLevel: InlineConfig["logLevel"];
  let isBuild = false;

  return {
    name: "armada-npanel-preview",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      mode = config.mode;
      logLevel = config.logLevel;
      isBuild = config.command === "build";
    },
    async closeBundle() {
      if (!isBuild) return;
      await build({
        configFile: false,
        root: import.meta.dirname,
        mode,
        logLevel,
        publicDir: false,
        plugins: [buildConfigPlugin()],
        resolve: {
          alias: { "@": path.resolve(import.meta.dirname, "./src") },
          // npanel's sandbox has no DOM, like a worker.
          conditions: ["worker", "module", "import", "default"],
        },
        build: {
          target: "es2022",
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          // Half of what QuickJS parses on every preview.
          minify: true,
          rolldownOptions: {
            // A package is only what's used of it: a barrel's other modules
            // would otherwise run on every preview.
            treeshake: { moduleSideEffects: (id: string) => !id.includes("/node_modules/") },
          },
          lib: {
            entry,
            formats: ["es"],
            fileName: () => ".well-known/npanel/preview.js",
          },
        },
      });
    },
  };
}

/**
 * Worker ceiling for the suite. Vitest defaults to one worker per core and
 * then adds its own process on top, so the whole machine stalls for the length
 * of a run. Two cores held back is enough to keep it usable.
 *
 * Don't tighten this much further without cutting the work to match. Wall time
 * here is almost exactly `worker-seconds / workers` (measured within ~17% over
 * several runs), so the ceiling is paid back directly in duration — dropping
 * to 12 of 16 cores cancelled out the whole saving from the environment split
 * below. `ARMADA_TEST_WORKERS` overrides it for a box that wants all of itself
 * (CI) or less of it.
 */
const TEST_WORKERS = Number(process.env.ARMADA_TEST_WORKERS) ||
  Math.max(1, availableParallelism() - 2);

/**
 * Test options that are the same in both projects below. Only `name`,
 * `environment` and `include` differ.
 *
 * `maxWorkers` has to live HERE, on each project, not on the root `test`
 * config: with `projects` set, the root value is silently ignored, and the
 * suite goes back to a worker per core with nothing to say it didn't take.
 * Per-project is nonetheless a global ceiling and not one pool each — the
 * projects do not run concurrently (measured: 2 workers per project across
 * both is ~200% CPU, not ~400%).
 */
const SHARED_TEST_CONFIG = {
  globals: true,
  maxWorkers: TEST_WORKERS,
  setupFiles: "./src/test/setup.ts",
  onConsoleLog(log: string) {
    return !log.includes("React Router Future Flag Warning");
  },
} as const;

/**
 * `*.perf.test.*` files are BENCHMARKS: they assert on how long something takes
 * or how many times it re-renders, not on whether it is correct. They don't
 * belong in a correctness gate — a loaded machine makes them fail while nothing
 * is wrong, and they were ~13% of the suite's test time — so `npm run test`
 * skips them and `npm run test:perf` runs them alone.
 *
 * Two modes rather than a plain exclude, so the benchmarks stay reachable by
 * the same config that hides them. They are still typechecked and linted
 * either way; only the runner ignores them.
 */
const RUN_PERF = !!process.env.ARMADA_TEST_PERF;

/**
 * `npm run build:profile`: a production build that can be profiled. Two
 * differences, each of which a profile of the normal build is missing:
 *
 *  - function and class names kept through minification, so components, and
 *    every frame of a CPU profile, read as names instead of `Xe`;
 *  - source maps, so a Performance-panel flame graph maps back to `src/`.
 *
 * Also stamps `VITE_PROFILE=1`, which switches component render attribution
 * on from boot. Never a release build — it is larger and a little slower.
 *
 * `VITE_PROFILE_REACT=1` on top swaps in react-dom's PROFILING build, so every
 * fiber carries its render time and the report gives self time per component
 * (and the DevTools Profiler tab works). Opt-in, because React 19.2's
 * profiling build also logs every component render to the Performance
 * timeline: in a render-heavy flow that logging was most of the CPU a profile
 * measured, which makes it the wrong build for asking how much CPU a flow costs.
 */
const PROFILE_BUILD = process.env.VITE_PROFILE === "1";
const PROFILE_REACT = PROFILE_BUILD && process.env.VITE_PROFILE_REACT === "1";

/**
 * Build outputs a local flatpak build drops under `electron/`, which the
 * `electron/**` test globs must never traverse. `.flatpak-builder` holds
 * host-absolute symlinks (electron-builder.yml refuses to package it for the
 * same reason) and `release/` is a multi-GB OSTree repo; letting file discovery
 * descend either one hangs the whole run at startup rather than failing. Two
 * entries cover everything `flatpak/build.sh` writes: its build and repo
 * directories are both under `release/`. Applied in BOTH modes — the perf branch
 * had no exclude at all, so a stale build tree would hang `npm run test:perf`
 * too. CI never has these (each job is a fresh checkout); this only bites a
 * machine that has run `npm run dist:flatpak`.
 */
const BUILD_ARTIFACT_EXCLUDES = [
  "**/electron/.flatpak-builder/**",
  "**/electron/release/**",
];

/** `include`/`exclude` for one project, given the extensions it owns. */
function testFilesFor(extensions: string) {
  return RUN_PERF
    ? {
        include: [`{src,electron}/**/*.perf.test.${extensions}`],
        exclude: [...configDefaults.exclude, ...BUILD_ARTIFACT_EXCLUDES],
      }
    : {
        include: [`{src,electron}/**/*.test.${extensions}`],
        exclude: [...configDefaults.exclude, "**/*.perf.test.*", ...BUILD_ARTIFACT_EXCLUDES],
      };
}

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    // The dev-server file watcher (chokidar) must never descend into a local
    // flatpak/OSTree build tree. It holds root-owned CIRCULAR symlinks (e.g.
    // `.flatpak-builder/cache/objects/**/udev/watch/*` -> `b251:0`) that crash
    // the watcher with `ELOOP` and take the whole dev server down mid-request —
    // which looks exactly like a hung dependency optimize. These are the same
    // host-absolute artifacts the vitest globs already dodge via
    // BUILD_ARTIFACT_EXCLUDES; the watcher needs its own guard because Vite
    // APPENDS `server.watch.ignored` to chokidar's defaults (`.git`,
    // `node_modules`) rather than replacing them. CI never has these (fresh
    // checkout); this only bites a machine that has run `npm run dist:flatpak`.
    // The electron:dev profile is excluded too: web-bundle updates unpack HTML
    // into it, which would full-reload the page under test.
    watch: {
      ignored: [...BUILD_ARTIFACT_EXCLUDES, "**/electron/.dev-profile/**"],
    },
  },
  plugins: [react(), buildConfigPlugin(), buildStamp(), serveChangelog(), desktopManifest(), buildInfo(), serviceWorker(), npanelPreview(), oneByteScripts()],
  optimizeDeps: {
    // Pin the dep-scanner's entry points to the real HTML entries. Left to its
    // default the scanner GLOBS `**/*.html` from the project root, and that
    // glob ignores only `outDir`/`__tests__`/`coverage` — NOT the local
    // flatpak/OSTree build tree. So on a machine that has run
    // `npm run dist:flatpak` it walks the 830 MB `.flatpak-builder` tree and
    // its root-owned circular symlinks, which reads as an optimize that never
    // finishes (distinct from the chokidar `ELOOP` crash the `server.watch`
    // guard above fixes — same tree, different traversal). Naming the entries
    // replaces the root glob with these literal paths. `e2e/harness.html` is
    // the Playwright harness (dev-server only, in no production build); listing
    // it keeps its deps pre-bundled so the e2e run doesn't pay a cold optimize.
    // `e2e/screenshotSeed.html` and `e2e/callRecording.html` are the same, for
    // the DM screenshot and call-recording harnesses.
    entries: ["index.html", "e2e/harness.html", "e2e/screenshotSeed.html", "e2e/callRecording.html"],
  },
  worker: {
    // The video worker is an ES module (`new Worker(…, { type: "module" })`).
    format: "es",
    plugins: () => [oneByteScripts()],
  },
  define: {
    "import.meta.env.VERSION": JSON.stringify(getVersion()),
    "import.meta.env.BUILD_DATE": JSON.stringify(new Date(BUILD_EPOCH * 1000).toISOString()),
    "import.meta.env.COMMIT_SHA": JSON.stringify(getCommitSha()),
    "import.meta.env.COMMIT_TAG": JSON.stringify(getCommitTag()),
  },
  test: {
    projects: [
      // Splitting by environment is the single biggest lever on suite cost. A
      // jsdom instance is built per test FILE, and at ~1.8s each that was
      // ~615s of the run's worker-time — more than actually running the tests
      // (~495s). The great majority of files never touch a DOM, so they get
      // `node` and skip that construction entirely (measured over a paired
      // run: ~615s -> ~222s of environment time, ~19% off the wall clock and
      // ~24% off the CPU consumed, using two fewer cores).
      //
      // The split is by EXTENSION rather than a list of paths, so there is no
      // roster in here to rot as files move: `.tsx` is a component/render test
      // and needs a DOM, `.ts` is assumed not to. The exceptions — a `.ts`
      // suite that drives `renderHook` or a browser shim — carry a
      // `// @vitest-environment jsdom` docblock, which overrides the project's
      // environment and travels with the file. A new one announces itself as
      // `document is not defined`, and the fix is that one line.
      {
        extends: true,
        test: {
          ...SHARED_TEST_CONFIG,
          ...testFilesFor("{js,mjs,cjs,ts,mts,cts}"),
          name: "node",
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          ...SHARED_TEST_CONFIG,
          ...testFilesFor("{jsx,tsx}"),
          name: "dom",
          environment: "jsdom",
        },
      },
    ],
  },
  build: {
    target: "esnext",
    sourcemap: PROFILE_BUILD,
    rollupOptions: {
      output: {
        manualChunks,
        ...(PROFILE_BUILD ? { keepNames: true } : {}),
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      // react-dom/profiling is react-dom/client plus fiber timings.
      ...(PROFILE_REACT ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : []),
    ],
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
});
