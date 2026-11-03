import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { load as parseYaml } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertPackInputs } = require("./before-pack.cjs");

const SHELL_DIR = path.resolve(process.cwd(), "electron");

let temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

function appDirectory({ db = true, updateFeed = true, web = true, helper = false } = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "armada-pack-inputs-"));
  temporaryDirectories.push(temporaryDirectory);
  fs.mkdirSync(path.join(temporaryDirectory, "dist"));
  if (db) fs.writeFileSync(path.join(temporaryDirectory, "db.cjs"), "module.exports = {};");
  if (updateFeed) {
    fs.writeFileSync(path.join(temporaryDirectory, "updateFeed.cjs"), "module.exports = {};");
  }
  if (web) fs.writeFileSync(path.join(temporaryDirectory, "dist", "index.html"), "<html></html>");
  if (helper) {
    const helperPath = path.join(
      temporaryDirectory,
      "generated",
      "hevc",
      "x64",
      "armada-hevc-publisher",
    );
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, "publisher", { mode: 0o755 });
  }
  return temporaryDirectory;
}

describe("desktop package staging guard", () => {
  it("accepts the staged web client and database bridge", () => {
    expect(() => assertPackInputs(appDirectory(), { platform: "win32" })).not.toThrow();
  });

  it("names missing release inputs before packaging starts", () => {
    expect(() => assertPackInputs(appDirectory({ db: false }))).toThrow(/db\.cjs/);
    expect(() => assertPackInputs(appDirectory({ web: false }))).toThrow(/dist.index\.html/);
    // A build staged without the update feed still runs, and can never update
    // itself again — the failure this guard exists to catch before packaging.
    expect(() => assertPackInputs(appDirectory({ updateFeed: false }))).toThrow(
      /updateFeed\.cjs/,
    );
  });

  it("requires an executable publisher only for Linux packages", () => {
    expect(() =>
      assertPackInputs(appDirectory({ helper: true }), { platform: "linux", arch: "x64" }),
    ).not.toThrow();
    expect(() =>
      assertPackInputs(appDirectory(), { platform: "linux", arch: "x64" }),
    ).toThrow(/generated.hevc.x64.armada-hevc-publisher/);
    expect(() => assertPackInputs(appDirectory(), { platform: "darwin" })).not.toThrow();
  });
});

// electron-builder's `files:` is an explicit allow-list, so a shell module
// that main.js (or anything it loads) requires by relative path has to be
// named there too. An omission is invisible until a packaged build boots:
// `Error: Cannot find module './autoLaunch'` inside app.asar, with the app
// running fine from `npm start` and every unit test green. This walks the
// require graph (plus scripts forked by path) from the entry points and checks
// each edge against the list.
describe("the packaged file list", () => {
  // Self-contained vite bundles, gitignored and absent from a fresh checkout:
  // they must be packaged, but have no relative requires to walk.
  const GENERATED = new Set(["db.cjs", "updateFeed.cjs"]);

  it("names every shell module reachable from main.js and preload.js", () => {
    const config = parseYaml(fs.readFileSync(path.join(SHELL_DIR, "electron-builder.yml"), "utf8"));
    const packaged = new Set(config.files.filter((entry) => !entry.startsWith("!")));
    const seen = new Set();
    const queue = ["main.js", "preload.js"];
    const missing = [];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      if (!packaged.has(file)) missing.push(file);
      if (GENERATED.has(file) || file.endsWith(".json")) continue;
      const source = fs.readFileSync(path.join(SHELL_DIR, file), "utf8");
      for (const match of source.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) {
        const target = match[1];
        queue.push(/\.(c?js|json)$/.test(target) ? target : `${target}.js`);
      }
      // Scripts loaded by path rather than require: preload, utility processes.
      for (const match of source.matchAll(/path\.join\(__dirname,\s*["']([^"'/]+\.c?js)["']\)/g)) {
        queue.push(match[1]);
      }
    }
    expect(missing).toEqual([]);
    // Sanity check that the walk actually saw the graph.
    expect(seen.size).toBeGreaterThan(10);
  });
});
