/**
 * What a community channel must not load before it paints: libraries for dialogs,
 * panes and states it opens into rarely. `manualChunks` keeps @scure/btc-signer off
 * the eager vendor chunk, but a static import from the page would load it anyway.
 * Walks the static imports under src/ (type-only imports erase, `import()` splits).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm;
const TYPE_ONLY = /\{\s*(type\s+\w+\s*,?\s*)+\}\s*from/;

function resolveSpec(from: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return `npm:${spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")}`;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

/** Every module `entry` reaches by static import, each with the module that first reached it. */
function staticClosure(entry: string): Map<string, string | null> {
  const start = join(ROOT, entry);
  const seen = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.startsWith("npm:")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (TYPE_ONLY.test(m[0])) continue;
      const dep = resolveSpec(file, m[1]);
      if (dep && !seen.has(dep)) {
        seen.set(dep, file);
        queue.push(dep);
      }
    }
  }
  return seen;
}

const name = (f: string) => (f.startsWith("npm:") ? f : relative(ROOT, f));

function pathTo(closure: Map<string, string | null>, target: string): string | undefined {
  const hit = [...closure.keys()].find((f) => name(f) === target || name(f).endsWith(target));
  if (!hit) return undefined;
  const path: string[] = [];
  for (let f: string | null | undefined = hit; f; f = closure.get(f)) path.unshift(name(f));
  return path.join(" → ");
}

describe("a community channel's first paint", () => {
  const closure = staticClosure("src/concord/pages/ConcordPage.tsx");

  it.each([
    "npm:@scure/btc-signer",
    "npm:react-easy-crop",
    "npm:react-day-picker",
    "src/components/brand/GameOverScreen.tsx",
    "src/concord/components/CommunitySettingsView.tsx",
    "src/components/projects/ProjectsView.tsx",
  ])("doesn't statically import %s", (target) => {
    expect(pathTo(closure, target)).toBeUndefined();
  });
});
