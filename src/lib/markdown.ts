/**
 * Discord-flavored markdown parsing for chat (rendering: `components/chat/Markdown.tsx`).
 * Document mode (git content) adds heading levels 4–6 and `[text](url)` links.
 * Blocks are split BEFORE the URL/nostr tokenizer so code isn't linkified.
 */

/** A top-level block of message content. */
export type MdBlock =
  | { type: "code"; lang?: string; code: string }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "heading"; level: number; text: string }
  | { type: "subtext"; text: string }
  | MdList
  | { type: "rule" }
  | { type: "text"; text: string };

/**
 * A list. `children[i]`, when present, is the list nested under `items[i]`;
 * the array is left out entirely when nothing is nested.
 */
export interface MdList {
  type: "list";
  ordered: boolean;
  start: number;
  items: string[];
  children?: (MdList | undefined)[];
}

export type InlineCodeSegment = { code: boolean; value: string };

export type InlineFormat = "strong" | "em" | "u" | "s" | "spoiler";

/** Inline AST; `A` is the opaque atom type of `parseInlineRun` (none for plain text). */
export type InlineNode<A = never> =
  | { type: "text"; value: string }
  | ([A] extends [never] ? never : { type: "atom"; atom: A })
  | { type: InlineFormat; children: InlineNode<A>[] };

/**
 * Fenced code block (closing fence required): ```lang\n … ``` anywhere, or a
 * `~~~` fence on lines of its own, so inline `~~strike~~` can't open one. A
 * language needs its newline, so ```https://…``` keeps its scheme.
 */
const FENCE_RE = /```(?:([\w+-]*)\n)?([\s\S]*?)```|(?<![^\n])~~~([\w+-]*)\n((?:[\s\S]*?\n)?)~~~(?![^\n])/g;

/**
 * A quote line: `> text` (or a bare `>`), Discord-style. The space is required
 * (after any `>>` nesting run) so emoticons like `>:D` stay literal.
 */
const QUOTE_LINE_RE = /^>(?=>*(?:[ \t]|$))/;
const QUOTE_MARKER_RE = /^>[ \t]?/;
/** Discord's `>>> `: everything from this line to the end of the message is quoted. */
const REST_QUOTE_RE = /(?<![^\n])>>>(?:[ \t]|$|(?=\n))[ \t]*/g;
/** Deeper `>` nesting stays literal, bounding the recursion. */
const MAX_QUOTE_DEPTH = 8;

/**
 * Split text into top-level blocks: fenced code, quotes (whose content is itself
 * split into blocks), headings, `-#` subtext, lists, thematic breaks, and plain text.
 * Chat headings stop at level 3; `document` allows 4–6.
 */
export function splitMarkdownBlocks(src: string, document = false): MdBlock[] {
  return splitBlocks(src, document, 0);
}

function splitBlocks(src: string, document: boolean, depth: number): MdBlock[] {
  if (depth === 0) {
    const fences = [...src.matchAll(FENCE_RE)].map((m) => [m.index, m.index + m[0].length]);
    for (const m of src.matchAll(REST_QUOTE_RE)) {
      const at = m.index;
      if (fences.some(([s, e]) => at >= s && at < e)) continue;
      const before = at > 0 ? splitFencedBlocks(src.slice(0, at), document, depth) : [];
      return [...before, { type: "quote", blocks: splitBlocks(src.slice(at + m[0].length), document, 1) }];
    }
  }
  return splitFencedBlocks(src, document, depth);
}

function splitFencedBlocks(src: string, document: boolean, depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let last = 0;
  for (const m of src.matchAll(FENCE_RE)) {
    if (m.index > last) blocks.push(...splitQuoteBlocks(src.slice(last, m.index), document, depth));
    const lang = m[1] ?? m[3];
    const code = (m[2] ?? m[4]).replace(/\n$/, "");
    if (code.trim() !== "") {
      blocks.push({ type: "code", lang: lang || undefined, code });
    } else {
      // An empty fence is almost certainly not intentional code — keep it literal.
      blocks.push({ type: "text", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) blocks.push(...splitQuoteBlocks(src.slice(last), document, depth));
  return blocks;
}

function splitQuoteBlocks(src: string, document: boolean, depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.split("\n");
  let textLines: string[] = [];
  let quoteLines: string[] | null = null;

  const flushText = () => {
    if (textLines.length > 0) {
      const text = textLines.join("\n");
      if (text !== "") blocks.push(...splitHeadingListBlocks(text, document));
      textLines = [];
    }
  };
  const flushQuote = () => {
    if (quoteLines) {
      const text = quoteLines.join("\n");
      blocks.push({
        type: "quote",
        blocks: depth < MAX_QUOTE_DEPTH ? splitBlocks(text, document, depth + 1) : [{ type: "text", text }],
      });
      quoteLines = null;
    }
  };

  for (const line of lines) {
    if (QUOTE_LINE_RE.test(line)) {
      flushText();
      (quoteLines ??= []).push(line.replace(QUOTE_MARKER_RE, ""));
    } else {
      flushQuote();
      textLines.push(line);
    }
  }
  flushText();
  flushQuote();
  return blocks;
}

/** ATX heading: `## text` (1-6 hashes, space required so `#hashtag` stays literal). */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
/** Optional closing sequence of an ATX heading: `## Title ##`. */
const HEADING_CLOSE_RE = /\s+#+\s*$/;
/** Setext underline (3+ so a stray `=`/`-` stays literal): `=` is level 1, `-` level 2. */
const SETEXT_RE = /^ {0,3}(={3,}|-{3,})[ \t]*$/;
/** Deepest heading level chat recognizes (`# `, `## `, `### `, as in Discord). */
const CHAT_HEADING_MAX_LEVEL = 3;
/** Discord's subtext line: `-# text` (space required). */
const SUBTEXT_RE = /^-#\s+(.+)$/;
/** Thematic break: 3+ of one of `-`, `*`, `_`, optionally spaced (CommonMark). */
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** Unordered list item: `- text` (space required so `*italic*` stays literal). */
const UNORDERED_ITEM_RE = /^([ \t]*)[-*+]\s+(.+)$/;
/** Ordered list item: `1. text` / `1) text`. */
const ORDERED_ITEM_RE = /^([ \t]*)(\d{1,9})[.)]\s+(.+)$/;
/** A list starts at most 3 spaces in; deeper, it is text. */
const LIST_ROOT_MAX_INDENT = 3;
/** Indented 2+ columns past its parent, an item nests under the item above it. */
const LIST_NEST_INDENT = 2;
const LIST_MAX_DEPTH = 5;

function indentWidth(lead: string): number {
  let width = 0;
  for (const c of lead) width += c === "\t" ? 4 : 1;
  return width;
}

/**
 * Split into headings, list runs and remaining text. Boundary newlines fold
 * into the extracted block's margin; chunks without blocks pass through unchanged.
 */
function splitHeadingListBlocks(src: string, document: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  const maxHeading = document ? 6 : CHAT_HEADING_MAX_LEVEL;
  let textLines: string[] = [];
  /** The open list and the lists nested in it, outermost first, with their indents. */
  let lists: { indent: number; list: MdList }[] = [];

  const flushText = () => {
    if (textLines.length > 0) {
      const text = textLines.join("\n").replace(/^\n/, "").replace(/\n$/, "");
      if (text !== "") blocks.push({ type: "text", text });
      textLines = [];
    }
  };
  const flushList = () => {
    if (lists.length > 0) {
      blocks.push(lists[0].list);
      lists = [];
    }
  };
  const newList = (ordered: boolean, start: number): MdList => ({ type: "list", ordered, start, items: [] });

  for (const line of src.split("\n")) {
    // Before the rule check: `---` under a paragraph underlines it (CommonMark).
    const setext = SETEXT_RE.exec(line);
    if (setext) {
      let start = textLines.length;
      while (start > 0 && textLines[start - 1].trim() !== "") start--;
      if (start < textLines.length) {
        const text = textLines.splice(start).map((l) => l.trim()).join("\n");
        flushText();
        blocks.push({ type: "heading", level: setext[1][0] === "=" ? 1 : 2, text });
        continue;
      }
    }
    // Before lists, so `- - -` / `* * *` are a rule rather than an item.
    if (RULE_RE.test(line)) {
      flushText();
      flushList();
      blocks.push({ type: "rule" });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading && heading[1].length <= maxHeading) {
      flushText();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].replace(HEADING_CLOSE_RE, "").trim() });
      continue;
    }
    const subtext = SUBTEXT_RE.exec(line);
    if (subtext) {
      flushText();
      flushList();
      blocks.push({ type: "subtext", text: subtext[1].trim() });
      continue;
    }
    const ordered = ORDERED_ITEM_RE.exec(line);
    const unordered = ordered ? null : UNORDERED_ITEM_RE.exec(line);
    const indent = indentWidth((ordered ?? unordered)?.[1] ?? "");
    if ((ordered || unordered) && (lists.length > 0 || indent <= LIST_ROOT_MAX_INDENT)) {
      flushText();
      const isOrdered = Boolean(ordered);
      const start = ordered ? parseInt(ordered[2], 10) : 1;
      const text = (ordered?.[3] ?? unordered![2]).trim();
      while (lists.length > 1 && indent < lists[lists.length - 1].indent) lists.pop();
      const top = lists[lists.length - 1];
      if (top && indent >= top.indent + LIST_NEST_INDENT && lists.length < LIST_MAX_DEPTH) {
        const parent = top.list.items.length - 1;
        const children = (top.list.children ??= []);
        const child = (children[parent] ??= newList(isOrdered, start));
        child.items.push(text);
        lists.push({ indent, list: child });
        continue;
      }
      if (lists.length === 1 && top.list.ordered !== isOrdered) flushList();
      if (lists.length === 0) lists = [{ indent, list: newList(isOrdered, start) }];
      lists[lists.length - 1].list.items.push(text);
      continue;
    }
    flushList();
    textLines.push(line);
  }
  flushText();
  flushList();
  if (!document && blocks.every((b) => b.type === "text")) {
    return [{ type: "text", text: src }];
  }
  return blocks;
}

export type MdLinkSegment =
  | { type: "text"; value: string }
  | { type: "link"; text: string; url: string };

/** `[text](url)` / `![alt](url)`, http(s) only so pseudo-scheme URLs stay literal. */
const MD_LINK_RE = /(!?)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Split on markdown links. `![alt](url)` yields the bare URL so it embeds like a pasted image. */
export function splitMarkdownLinks(src: string): MdLinkSegment[] {
  const out: MdLinkSegment[] = [];
  let last = 0;
  MD_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ type: "text", value: src.slice(last, m.index) });
    if (m[1]) out.push({ type: "text", value: m[3] });
    else out.push({ type: "link", text: m[2], url: m[3] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", value: src.slice(last) });
  return out;
}

/** Inline code; an opening backtick after an odd run of backslashes is escaped. */
const INLINE_CODE_RE = /(?<=(?:^|[^\\])(?:\\\\)*)`([^`\n]+)`/g;

/** Split out `` `inline code` `` so the URL/nostr tokenizer can skip it. */
export function splitInlineCode(src: string): InlineCodeSegment[] {
  const out: InlineCodeSegment[] = [];
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ code: false, value: src.slice(last, m.index) });
    out.push({ code: true, value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ code: false, value: src.slice(last) });
  return out;
}

const blankOut = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * `src` with what renders as code (fences, inline code) blanked to spaces,
 * offsets kept — for scans deriving tags or embeds, which must not see a URL
 * or reference the reader is shown as literal code.
 */
export function withoutCode(src: string): string {
  const outside = (s: string) => s.replace(INLINE_CODE_RE, blankOut);
  let out = "";
  let last = 0;
  for (const m of src.matchAll(FENCE_RE)) {
    // An empty fence renders as text (see `splitFencedBlocks`).
    if ((m[2] ?? m[4]).trim() === "") continue;
    out += outside(src.slice(last, m.index)) + blankOut(m[0]);
    last = m.index + m[0].length;
  }
  return out + outside(src.slice(last));
}

/** Inline patterns in tie-break priority order (longer delimiters first). */
const INLINE_PATTERNS: ReadonlyArray<{
  type: InlineFormat;
  re: RegExp;
}> = [
  // Negative lookahead so `**bold *and italic***` closes at the LAST `**`.
  { type: "strong", re: /\*\*([\s\S]+?)\*\*(?!\*)/ },
  { type: "u", re: /__([\s\S]+?)__(?!_)/ },
  { type: "s", re: /~~([\s\S]+?)~~(?!~)/ },
  { type: "spoiler", re: /\|\|([\s\S]+?)\|\|(?!\|)/ },
  // Single `*`/`_` only at word boundaries, so `2*3*4` and snake_case stay literal.
  { type: "em", re: /(?<!\w)\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/ },
  { type: "em", re: /(?<![\w])_([^_\n]+)_(?![\w])/ },
];

/**
 * Stands in for one atom (an opaque token, or an escaped character) while
 * delimiters are matched: neither a word character nor whitespace.
 */
const ATOM = "\uE000";
/** `\*` etc.: the markdown punctuation a backslash makes literal. */
const ESCAPE_RE = /\\([\\`*_~|#>\-+=.!()[\]])|\uE000/g;

export type InlineAtom<A> = { atom: A };

/**
 * Parse inline formatting across a run of text and opaque atoms (links,
 * mentions), so `**see https://…**` spans the link. Backslash escapes are
 * resolved into literal text.
 */
export function parseInlineRun<A>(parts: ReadonlyArray<string | InlineAtom<A>>): InlineNode<A>[] {
  // Slots are consumed in document order; a literal ATOM in the input is itself a slot.
  const slots: Array<{ text: string } | InlineAtom<A>> = [];
  let src = "";
  for (const part of parts) {
    if (typeof part !== "string") {
      slots.push(part);
      src += ATOM;
      continue;
    }
    src += part.replace(ESCAPE_RE, (m: string, ch: string | undefined) => {
      slots.push({ text: ch ?? m });
      return ATOM;
    });
  }
  if (slots.length === 0) return parseEncoded(src) as InlineNode<A>[];
  return resolveAtoms(parseEncoded(src), slots, { next: 0 });
}

/** Parse inline formatting into an AST; degenerate delimiters stay literal. */
export function parseInline(text: string): InlineNode[] {
  return parseInlineRun<never>([text]);
}

function resolveAtoms<A>(
  nodes: InlineNode[],
  slots: ReadonlyArray<{ text: string } | InlineAtom<A>>,
  cursor: { next: number },
): InlineNode<A>[] {
  const out: InlineNode<A>[] = [];
  const pushText = (value: string) => {
    if (value === "") return;
    const prev = out[out.length - 1];
    if (prev?.type === "text") prev.value += value;
    else out.push({ type: "text", value });
  };
  for (const node of nodes) {
    if (node.type !== "text") {
      out.push({ type: node.type, children: resolveAtoms(node.children, slots, cursor) });
      continue;
    }
    const pieces = node.value.split(ATOM);
    pieces.forEach((piece, i) => {
      if (i > 0) {
        const slot = slots[cursor.next++];
        if ("text" in slot) pushText(slot.text);
        else out.push({ type: "atom", atom: slot.atom } as InlineNode<A>);
      }
      pushText(piece);
    });
  }
  return out;
}

function parseEncoded(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let rest = text;

  while (rest.length > 0) {
    let best: { index: number; length: number; content: string; type: InlineFormat } | null = null;
    for (const { type, re } of INLINE_PATTERNS) {
      const m = re.exec(rest);
      if (!m) continue;
      if (m[1].trim() === "") continue; // "** **" etc. stays literal
      if (!best || m.index < best.index) {
        best = { index: m.index, length: m[0].length, content: m[1], type };
      }
    }
    if (!best) {
      out.push({ type: "text", value: rest });
      break;
    }
    if (best.index > 0) out.push({ type: "text", value: rest.slice(0, best.index) });
    out.push({ type: best.type, children: parseEncoded(best.content) });
    rest = rest.slice(best.index + best.length);
  }

  return out;
}
