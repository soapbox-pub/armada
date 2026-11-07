#!/usr/bin/env node
// Lists Vector's decision points: every refusal a client makes (an `Err("…")`, an
// `ok_or("…")`, a fold's `refuse(…)`, a vend verdict, a permission gate) and every
// branch on ranked vs legacy roles. Each is keyed by file, enclosing fn and text, so
// line drift between Vector releases doesn't change it.
//
//   node scripts/vector-parity/extract.mjs <vector>/crates/vector-core/src > scripts/vector-parity/points.json
//
// `src/test/vectorParity.test.ts` fails when a point here has no entry in ledger.json,
// so re-running this against a new Vector release surfaces what it added.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: extract.mjs <vector-core/src>");
  process.exit(1);
}
const SCOPE = ["community", "calls", "lib.rs"];

const PATTERNS = [
  ["refuse", /refuse\(&mut why, \w+, "([^"]+)"\)/g],
  ["vend", /VendVerdict::(?:Refuse|Park)\("([^"]+)"\)/g],
  ["gate", /ensure_folded_permission\([^;]*?"([^"]+)"\)/g],
  ["err", /Err\((?:format!\()?"([^"]+)"/g],
  ["ok_or", /ok_or(?:_else\(\|\| )?\("([^"]+)"/g],
  ["branch", /(everyone\.is_some\(\)|everyone\.is_none\(\)|roles_v2_held\()/g],
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".rs") ? [p] : [];
  });
}

/** The source with test-only code blanked out, line count kept. */
function withoutTests(src) {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "#[cfg(test)]") continue;
    // Blank the attributed item: up to its matching closing brace, or its `;`.
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") (depth++, (opened = true));
        else if (ch === "}") depth--;
      }
      const done = (opened && depth === 0) || (!opened && j > i && lines[j].trimEnd().endsWith(";"));
      lines[j] = "";
      if (done) {
        i = j;
        break;
      }
    }
  }
  return lines;
}

const points = [];
const targets = SCOPE.flatMap((s) => {
  const p = join(root, s);
  return statSync(p).isDirectory() ? files(p) : [p];
}).sort();
for (const file of targets) {
  const lines = withoutTests(readFileSync(file, "utf8"));
  const rel = relative(root, file);
  let fn = "";
  const seen = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:pub(?:\([^)]*\))? )?(?:async )?fn ([a-z_0-9]+)/);
    if (m) fn = m[1];
    if (/^\s*\/\//.test(line)) return;
    for (const [kind, re] of PATTERNS) {
      for (const hit of line.matchAll(re)) {
        if (kind === "err" && /refuse\(|VendVerdict/.test(line)) continue;
        const text = hit[1];
        const base = `${rel}::${fn}::${kind}::${text}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        points.push({ id: n > 1 ? `${base}#${n}` : base, file: rel, fn, line: i + 1, kind, text });
      }
    }
  });
}
process.stdout.write(JSON.stringify(points, null, 1) + "\n");
