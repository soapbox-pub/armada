import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive a real Chromium against the dev server. They are NOT
// part of `npm run test` (tsc + eslint + vitest + build) and NOT in CI yet: a
// browser download and a live dev server don't belong in the unit gate, and CI
// runs on a maintainer-managed `act` image with a fixed time budget. Run them
// with `npm run test:e2e`.
//
// The fake-media flags are load-bearing. Without a real display to capture,
// Chromium's getDisplayMedia would block on the OS surface picker forever in
// headless CI. `--use-fake-ui-for-media-stream` auto-accepts the picker and
// `--use-fake-device-for-media-stream` supplies a synthetic surface, so a
// capture can complete with no human and no hardware. (The screen-share spec
// additionally stubs getDisplayMedia itself, but a future spec that doesn't
// still wants these.)
//
// The dev server runs on a DEDICATED port, not the app's usual 8080. Armada is
// a Ditto fork, so an Armada or Ditto `npm run dev` a developer already has
// open sits on 8080 too — and `reuseExistingServer` would then attach the whole
// suite to that unrelated app, whose SPA fallback answers every `/e2e/*`
// request with its own index.html, so the harness module never loads and every
// spec times out on `window.__screenShareHarness`. `--strictPort` makes Vite
// FAIL if the dedicated port is taken rather than silently drift to another
// (which would leave `url` pointing at nothing), so a collision is loud.
const E2E_PORT = 8181;
const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    baseURL: E2E_ORIGIN,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // The headless shell's renderer can crash booting the whole app where
        // full Chromium in new headless mode runs it; ARMADA_E2E_FULL_CHROMIUM=1
        // opts in to the latter.
        ...(process.env.ARMADA_E2E_FULL_CHROMIUM ? { channel: "chromium" } : {}),
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            // Some sandboxes (restricted user namespaces — containers, hardened
            // dev boxes) can't spawn Chromium's zygote/renderer children, and
            // the renderer dies on boot with a bare `Page crashed` and no JS
            // error. That only bites specs that boot the whole app (the
            // dm-screenshot capture); the minimal harness pages are unaffected.
            // `--single-process` collapses the process model so there is no
            // child to fail — off by default (it disables the multiprocess
            // architecture and is not what CI or a healthy machine wants) and
            // opt-in via ARMADA_E2E_SINGLE_PROCESS=1.
            ...(process.env.ARMADA_E2E_SINGLE_PROCESS ? ["--single-process"] : []),
          ],
        },
      },
    },
  ],
  // Start Vite on the dedicated port (see above). `--strictPort` makes a taken
  // port a hard failure rather than a silent drift, and `reuseExistingServer`
  // is safe here precisely because the port is ours alone — an app dev server
  // on 8080 can't be mistaken for this one. The predev wasm hook is a no-op
  // without a Rust toolchain (multiplayer off), and nothing here needs it.
  webServer: {
    command: `npm run dev -- --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
