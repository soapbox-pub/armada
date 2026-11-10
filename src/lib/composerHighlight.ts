import type { AtomSpan } from "@/lib/composerText";

/**
 * Styles the composer's text as it is typed. Every run carries the exact source
 * characters, markers included, because the runs are laid out underneath the
 * live textarea and must wrap exactly as it does; see `RichTextarea`.
 */

export const HL = {
  MARKER: 1,
  BOLD: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  STRIKE: 1 << 4,
  SPOILER: 1 << 5,
  CODE: 1 << 6,
  MENTION: 1 << 7,
  LINK: 1 << 8,
  QUOTE: 1 << 9,
  HEADING: 1 << 10,
  SUBTEXT: 1 << 11,
  CODE_BLOCK: 1 << 12,
  LIST: 1 << 13,
  EMOJI: 1 << 14,
} as const;

export interface HighlightRun {
  text: string;
  flags: number;
}

/** Stands in for an atom (code, link, mention, emoji, escaped char): neither word nor space. */
const ATOM = "\uE000";
const FENCE_LINE_RE = /^\s*(```|~~~)/;
const INLINE_CODE_RE = /(?<=(?:^|[^\\])(?:\\\\)*)`([^`\n]+)`/g;
// Stops where ChatContent's link does: at `|` and before trailing punctuation.
const URL_RE = /\b(?:https?|wss?):\/\/[^\s<>|]*[^\s<>|.,;:!?)\]*_~]/g;
const ESCAPE_RE = /\\[\\`*_~|#>\-+=.!()[\]]/g;
// A shrug is a face, not an escape and emphasis, as in markdown.ts.
const SHRUG_RE = /\u00af\\{1,2}_\(\u30c4\)_\/\u00af/g;

// Mirrors `INLINE_PATTERNS` in markdown.ts, minus the cross-atom bookkeeping.
const INLINE: ReadonlyArray<{ flag: number; size: number; re: RegExp }> = [
  { flag: HL.BOLD, size: 2, re: /\*\*([^\n]+?)\*\*(?!\*)/g },
  { flag: HL.UNDERLINE, size: 2, re: /__([^\n]+?)__(?!_)/g },
  { flag: HL.STRIKE, size: 2, re: /~~([^\n]+?)~~(?!~)/g },
  { flag: HL.SPOILER, size: 2, re: /\|\|([^\n]+?)\|\|(?!\|)/g },
  { flag: HL.ITALIC, size: 1, re: /(?<!\w)\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g },
  { flag: HL.ITALIC, size: 1, re: /(?<![\w])_([^_\n]+)_(?![\w])/g },
];

function mark(flags: number[], from: number, to: number, flag: number) {
  for (let i = from; i < to; i++) flags[i] |= flag;
}

function highlightLine(line: string, flags: number[], base: number, lineFlags: number) {
  let work = line;
  const atom = (from: number, to: number) => {
    work = work.slice(0, from) + ATOM.repeat(to - from) + work.slice(to);
  };
  for (let i = 0; i < line.length; i++) {
    if (flags[base + i] & (HL.MENTION | HL.EMOJI)) work = work.slice(0, i) + ATOM + work.slice(i + 1);
  }
  for (const m of work.matchAll(SHRUG_RE)) atom(m.index, m.index + m[0].length);
  for (const m of work.matchAll(ESCAPE_RE)) {
    mark(flags, base + m.index, base + m.index + 1, HL.MARKER);
    atom(m.index, m.index + 2);
  }
  INLINE_CODE_RE.lastIndex = 0;
  for (const m of work.matchAll(INLINE_CODE_RE)) {
    const s = base + m.index;
    const e = s + m[0].length;
    mark(flags, s, e, HL.CODE);
    mark(flags, s, s + 1, HL.MARKER);
    mark(flags, e - 1, e, HL.MARKER);
    atom(m.index, m.index + m[0].length);
  }
  for (const m of work.matchAll(URL_RE)) {
    mark(flags, base + m.index, base + m.index + m[0].length, HL.LINK);
    atom(m.index, m.index + m[0].length);
  }
  for (const { flag, size, re } of INLINE) {
    re.lastIndex = 0;
    for (const m of [...work.matchAll(re)]) {
      const s = m.index;
      const e = s + m[0].length;
      mark(flags, base + s, base + e, flag);
      mark(flags, base + s, base + s + size, HL.MARKER);
      mark(flags, base + e - size, base + e, HL.MARKER);
      // Consumed markers can't open or close a later (shorter) delimiter.
      atom(s, s + size);
      atom(e - size, e);
    }
  }
  if (lineFlags) mark(flags, base, base + line.length, lineFlags);
}

export function highlightRuns(text: string, atoms: readonly AtomSpan[] = []): HighlightRun[] {
  const flags = new Array<number>(text.length).fill(0);
  for (const a of atoms) mark(flags, a.dStart, a.dEnd, a.pubkey ? HL.MENTION : HL.EMOJI);

  let offset = 0;
  let inFence = false;
  let quoteRest = false;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    if (FENCE_LINE_RE.test(line)) {
      mark(flags, offset, end, HL.CODE_BLOCK | HL.MARKER);
      inFence = !inFence;
    } else if (inFence) {
      mark(flags, offset, end, HL.CODE_BLOCK);
    } else {
      let pos = 0;
      let lineFlags = quoteRest ? HL.QUOTE : 0;
      const quote = line.match(/^(?:>>> |(?:> )+)/);
      if (quote) {
        if (quote[0] === ">>> ") quoteRest = true;
        mark(flags, offset, offset + quote[0].length, HL.MARKER | HL.QUOTE);
        lineFlags |= HL.QUOTE;
        pos = quote[0].length;
      }
      const rest = line.slice(pos);
      const block = rest.match(/^(#{1,6}) (?=\S)/) ?? rest.match(/^-# (?=\S)/) ?? rest.match(/^\s*(?:[-*+]|\d{1,9}[.)]) (?=\S)/);
      if (block) {
        const kind = block[0].startsWith("-#") ? HL.SUBTEXT : block[0].trimStart().startsWith("#") ? HL.HEADING : HL.LIST;
        mark(flags, offset + pos, offset + pos + block[0].length, kind === HL.LIST ? HL.LIST : HL.MARKER);
        if (kind !== HL.LIST) lineFlags |= kind;
        pos += block[0].length;
      }
      highlightLine(line.slice(pos), flags, offset + pos, lineFlags);
    }
    offset = end + 1;
  }

  const runs: HighlightRun[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || flags[i] !== flags[start]) {
      if (i > start) runs.push({ text: text.slice(start, i), flags: flags[start] });
      start = i;
    }
  }
  return runs;
}
