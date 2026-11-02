/**
 * Build plugin: escape every UTF-16 code unit above U+00FF in emitted JS as
 * `\uXXXX`, as esbuild's `charset: "ascii"` does (rolldown/oxc have no such
 * option). V8 stores a script's source for the page's lifetime, and one
 * character outside Latin-1 anywhere in a chunk — an ellipsis in a message, an
 * emoji in a table — makes the whole source two bytes per character. Measured
 * on the desktop app before this: 80 of 237 chunks, the entry and vendor-nostr
 * among them (the latter for a single character).
 *
 * Runs after minification, which would otherwise print the characters back.
 * The escape is valid in strings, templates, regular expressions and comments;
 * it would change a `String.raw` template's value, so the build fails on a
 * chunk where it could. Sourcemaps (profile builds) are shifted to match.
 */
import type { Plugin } from "vite";

const WIDE = /[\u0100-\uffff]/;

function escapeUnit(unit: string): string {
  return `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** The escaped code, and per output line the columns (pre-escape) of each escaped unit. */
export function escapeWide(code: string): { code: string; escapedAt: Map<number, number[]> } {
  const escapedAt = new Map<number, number[]>();
  let line = 0;
  let lineStart = 0;
  let out = "";
  let last = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c === 10) {
      line++;
      lineStart = i + 1;
    } else if (c > 0xff) {
      // `\…` (an identity escape) must become `\u2026`, not `\\u2026`.
      let slashes = 0;
      while (code.charCodeAt(i - 1 - slashes) === 92) slashes++;
      const before = code.slice(last, i);
      out += (slashes % 2 ? before.slice(0, -1) : before) + escapeUnit(code[i]);
      last = i + 1;
      const cols = escapedAt.get(line) ?? [];
      cols.push(i - lineStart);
      escapedAt.set(line, cols);
    }
  }
  return { code: last === 0 ? code : out + code.slice(last), escapedAt };
}

/** Whether a `String.raw` template could contain a unit this would escape. */
export function rawTemplateAtRisk(code: string): boolean {
  for (const m of code.matchAll(/String\.raw\s*`/g)) {
    const end = code.indexOf("`", m.index! + m[0].length);
    if (WIDE.test(code.slice(m.index!, end < 0 ? undefined : end))) return true;
  }
  return false;
}

// ── Sourcemap VLQ: just enough to shift generated columns. ──────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

function decodeSegment(seg: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of seg) {
    const digit = B64_INDEX.get(ch)!;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

function encodeSegment(fields: number[]): string {
  let s = "";
  for (const field of fields) {
    let v = field < 0 ? (-field << 1) | 1 : field << 1;
    do {
      let digit = v & 31;
      v >>>= 5;
      if (v > 0) digit |= 32;
      s += B64[digit];
    } while (v > 0);
  }
  return s;
}

/** Move every mapping's generated column right by 5 per escaped unit before it. */
export function shiftMappings(mappings: string, escapedAt: Map<number, number[]>): string {
  return mappings
    .split(";")
    .map((lineMappings, line) => {
      const cols = escapedAt.get(line);
      if (!cols || lineMappings === "") return lineMappings;
      let prevOld = 0;
      let prevNew = 0;
      let k = 0;
      return lineMappings
        .split(",")
        .map((seg) => {
          const fields = decodeSegment(seg);
          const oldCol = prevOld + fields[0];
          while (k < cols.length && cols[k] < oldCol) k++;
          const newCol = oldCol + 5 * k;
          fields[0] = newCol - prevNew;
          prevOld = oldCol;
          prevNew = newCol;
          return encodeSegment(fields);
        })
        .join(",");
    })
    .join(";");
}

export function oneByteScripts(): Plugin {
  return {
    name: "armada:one-byte-scripts",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        if (rawTemplateAtRisk(file.code)) {
          this.error(`${file.fileName}: a String.raw template holds a character above U+00FF; escaping it would change its value`);
        }
        const { code, escapedAt } = escapeWide(file.code);
        if (escapedAt.size === 0) continue;
        file.code = code;
        if (file.map) file.map.mappings = shiftMappings(file.map.mappings, escapedAt);
      }
    },
  };
}
