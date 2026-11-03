// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A web bundle from the site runs on whatever shell is installed, which can be
 * any release since `desktop.json` gained its level. The shell's side of that
 * contract is the preload bridge and the ArmadaDB engine it hosts (db.cjs and
 * everything it bundles), so this fingerprints both and fails on any change
 * the recorded `surface` does not account for — forcing the question below to
 * be answered rather than discovered by users of older shells.
 */
const root = path.resolve(import.meta.dirname, "..");
const SURFACE_ROOTS = ["electron/preload.js", "src/lib/db/electronMain.ts"];

function resolveImport(from, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

/** Every local file reachable from the roots, with its content hash. */
function surfaceFiles() {
  const seen = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    const source = fs.readFileSync(file, "utf8");
    seen.set(file, crypto.createHash("sha256").update(source).digest("hex"));
    if (!/\.tsx?$/.test(file)) return;
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const resolved = resolveImport(file, specifier);
      if (resolved) walk(resolved);
    }
  };
  for (const file of SURFACE_ROOTS) walk(path.join(root, file));
  return [...seen].map(([file, hash]) => [path.relative(root, file).split(path.sep).join("/"), hash]).sort();
}

describe("desktop shell API level", () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "desktopApi.json"), "utf8"));

  it("is a positive integer", () => {
    expect(Number.isSafeInteger(recorded.level) && recorded.level > 0).toBe(true);
  });

  it("records the current shell surface", () => {
    const files = surfaceFiles();
    const surface = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
    if (surface !== recorded.surface) {
      throw new Error(
        [
          "The shell surface web bundles depend on changed (electron/desktopApi.json):",
          ...files.map(([file]) => `  ${file}`),
          "If a web bundle built from this change cannot run on the previous shell (it calls a",
          "bridge method or channel, an ArmadaDB op, a query feature or a term the old one lacks),",
          "bump `level`: older shells then keep their current web app until they are updated.",
          `Either way, set "surface" to "${surface}".`,
        ].join("\n"),
      );
    }
  });
});
