import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { FormatToolbar } from "@/components/chat/FormatToolbar";
import type { RichText } from "@/components/chat/useRichText";
import { HL, highlightRuns, type HighlightRun } from "@/lib/composerHighlight";
import type { AtomSpan } from "@/lib/composerText";
import { useFontScale } from "@/lib/fontScale";
import { cn } from "@/lib/utils";

const LAYOUT_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant", "fontFeatureSettings",
  "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "textTransform", "textAlign", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "direction", "unicodeBidi", "wordBreak", "overflowWrap",
] as const;
const PX_PROPS = ["fontSize", "lineHeight", "letterSpacing", "wordSpacing"] as const;

/** A format's own markers stay plain: dimmed, never slanted, struck or underlined. */
const content = (flags: number, format: number) => (flags & format) !== 0 && (flags & HL.MARKER) === 0;
const slanted = (flags: number) => content(flags, HL.ITALIC);

function runClass(flags: number): string | undefined {
  if (!flags) return undefined;
  return cn(
    flags & HL.MENTION ? "rt-mention" : flags & HL.LINK && "text-primary",
    flags & HL.MARKER && (flags & HL.QUOTE ? "text-primary/70" : "text-muted-foreground/70"),
    content(flags, HL.BOLD | HL.HEADING) && "rt-bold",
    slanted(flags) && "rt-italic",
    content(flags, HL.UNDERLINE) && "rt-u",
    content(flags, HL.STRIKE) && "rt-s",
    content(flags, HL.SPOILER) && "rt-spoiler",
    content(flags, HL.CODE) && "rounded-sm bg-foreground/10",
    flags & HL.CODE_BLOCK && "bg-foreground/[0.06]",
    flags & HL.SUBTEXT && "text-muted-foreground",
    flags & HL.LIST && "text-primary/80",
  ) || undefined;
}

const RTL_CHAR = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|\ud802[\udc00-\udfff]|\ud83a[\udc00-\udfff]/;
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function graphemeStarts(text: string): number[] {
  const out: number[] = [];
  if (graphemes) for (const { index } of graphemes.segment(text)) out.push(index);
  else for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) out.push(i);
  out.push(text.length);
  return out;
}

/** One styled run's glyphs on one line, laid side by side in one direction. */
interface Paint {
  /** Display offset of its first character. */
  at: number;
  text: string;
  className?: string;
  emoji?: { shortcode: string; url: string };
  /** From the layer's left edge, or leftwards from it to the piece's right edge when `rtl`. */
  x: number;
  rtl: boolean;
  top: number;
  height: number;
}

/**
 * Where to draw each styled run over the overlay's text node, which holds the
 * textarea's text unsplit so it is laid out exactly as the textarea's is.
 */
function measurePaint(base: Text, layer: HTMLElement, inner: HTMLElement, runs: HighlightRun[], atoms: readonly AtomSpan[]): Paint[] {
  const text = base.data.slice(0, -1);
  const innerStyle = getComputedStyle(inner);
  const box = layer.getBoundingClientRect();
  const lineHeight = parseFloat(innerStyle.lineHeight);
  const fixedLines = lineHeight > 0;
  const padTop = parseFloat(innerStyle.paddingTop) || 0;
  // Without a strong RTL character every paragraph is LTR, and a line's run is one piece.
  const bidi = RTL_CHAR.test(text) || innerStyle.direction === "rtl";
  const starts = graphemeStarts(text);
  const range = document.createRange();

  const rectOf = (from: number, to: number): DOMRect | null => {
    range.setStart(base, from);
    range.setEnd(base, to);
    let best: DOMRect | null = null;
    for (const r of range.getClientRects()) if (r.height > 0 && (!best || r.width > best.width)) best = r;
    return best;
  };
  const lineOf = (r: DOMRect) =>
    fixedLines ? Math.floor((r.top + r.height / 2 - box.top - padTop) / lineHeight) : Math.round(r.top - box.top);
  // A line box is in the first font; a glyph's box may be in a fallback with another ascent.
  const lineBox = (r: DOMRect) =>
    fixedLines ? { top: padTop + lineOf(r) * lineHeight, height: lineHeight } : { top: r.top - box.top, height: r.height };
  /** The grapheme holding `offset`. */
  const graphemeAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const out: Paint[] = [];
  const push = (from: number, to: number, className: string | undefined, r: DOMRect, rtl: boolean) => {
    let part = text.slice(from, to);
    if (!className && !part.trim()) return;
    // A line broken at a soft hyphen shows a hyphen there.
    if (part.endsWith("\u00ad")) {
      const next = to < text.length ? rectOf(to, to + 1) : null;
      if (next && lineOf(next) !== lineOf(r)) part = `${part.slice(0, -1)}-`;
    }
    const { top, height } = lineBox(r);
    out.push({ at: from, text: part, className, x: rtl ? box.left - r.right : r.left - box.left, rtl, top, height });
  };

  /** Bisects `[from, to)` into its lines: a line holds a contiguous run of graphemes. */
  const byLine = (from: number, to: number, className: string | undefined) => {
    const k0 = graphemeAt(from);
    const k1 = graphemeAt(to - 1) + 1;
    const lo = (k: number) => Math.max(from, starts[k]);
    const hi = (k: number) => Math.min(to, starts[k + 1]);
    const rects = new Map<number, DOMRect | null>();
    const rect = (k: number) => {
      if (!rects.has(k)) rects.set(k, rectOf(lo(k), hi(k)));
      return rects.get(k)!;
    };
    const line = (k: number) => {
      const r = rect(k);
      return r ? lineOf(r) : null;
    };
    const cuts = [k0];
    const split = (a: number, b: number, la: number, lb: number) => {
      if (la === lb) return;
      if (b - a === 1) {
        cuts.push(b);
        return;
      }
      const m = (a + b) >> 1;
      const lm = line(m);
      if (lm === null) {
        // A glyph without a box (a lone joiner): find its line by walking.
        for (let k = a + 1; k <= b; k++) if (line(k) !== null && line(k) !== la) return split(k - 1, k, la, line(k)!);
        return;
      }
      split(a, m, la, lm);
      split(m, b, lm, lb);
    };
    let first = k0;
    while (first < k1 && line(first) === null) first++;
    let last = k1 - 1;
    while (last > first && line(last) === null) last--;
    if (first >= k1) return;
    split(first, last, line(first)!, line(last)!);
    cuts.push(k1);
    for (let i = 0; i + 1 < cuts.length; i++) {
      let k = cuts[i];
      while (k < cuts[i + 1] && !rect(k)) k++;
      if (k < cuts[i + 1]) push(lo(cuts[i]), hi(cuts[i + 1] - 1), className, rect(k)!, false);
    }
  };

  /**
   * Groups `[from, to)` by visual adjacency, so a piece drawn in its own order
   * (bidi-override) lands glyph for glyph where the line put it, whatever the
   * paragraph's direction made of its neutrals.
   */
  const byGlyph = (from: number, to: number, className: string | undefined) => {
    let cur: { from: number; to: number; rect: DOMRect; first: DOMRect; rtl: boolean; glyphs: number } | null = null;
    const flush = () => {
      if (cur) push(cur.from, cur.to, className, cur.rtl ? new DOMRect(cur.rect.left, cur.first.top, cur.rect.width, cur.first.height) : cur.first, cur.rtl);
    };
    for (let k = graphemeAt(from); k + 1 < starts.length && starts[k] < to; k++) {
      const a = Math.max(from, starts[k]);
      const b = Math.min(to, starts[k + 1]);
      const r = rectOf(a, b);
      if (!r) continue;
      const sameLine = cur && lineOf(r) === lineOf(cur.first);
      const ltrNext = !!sameLine && Math.abs(r.left - cur!.rect.right) < 0.5;
      const rtlNext = !!sameLine && Math.abs(r.right - cur!.rect.left) < 0.5;
      // A lone glyph has no direction yet; its neighbour gives it one.
      if (cur && cur.to === a && (cur.glyphs === 1 ? ltrNext || rtlNext : cur.rtl ? rtlNext : ltrNext)) {
        if (cur.glyphs === 1) cur.rtl = rtlNext && !ltrNext;
        const left = Math.min(cur.rect.left, r.left);
        cur.rect = new DOMRect(left, cur.rect.top, Math.max(cur.rect.right, r.right) - left, cur.rect.height);
        cur.to = b;
        cur.glyphs++;
      } else {
        flush();
        cur = { from: a, to: b, rect: r, first: r, rtl: false, glyphs: 1 };
      }
    }
    flush();
  };

  const emojiAt = new Map(atoms.filter((a) => a.emoji).map((a) => [a.dStart, a.emoji!]));
  let pos = 0;
  for (const run of runs) {
    const from = pos;
    pos += run.text.length;
    if (run.flags & HL.EMOJI) {
      // One placeholder per emoji, holding its width; the image is drawn over it.
      for (let i = from; i < pos; i++) {
        const emoji = emojiAt.get(i);
        const r = emoji && rectOf(i, i + 1);
        if (!r) continue;
        const { top, height } = lineBox(r);
        out.push({ at: i, text: text[i], emoji, x: r.left - box.left, rtl: false, top, height });
      }
      continue;
    }
    const className = runClass(run.flags);
    // A tab's width depends on where its line starts, so tabs and newlines aren't drawn.
    for (const m of run.text.matchAll(/[^\t\n]+/g)) {
      const a = from + m.index;
      (bidi ? byGlyph : byLine)(a, a + m[0].length, className);
    }
  }
  return out;
}

/**
 * Moves each drawn piece onto the laid-out glyphs' baseline. A line's baseline
 * can sit a pixel off the line-height arithmetic when it holds a fallback font
 * (Firefox), which a piece without that font doesn't reproduce.
 */
function alignPieces(base: Text, layer: HTMLElement) {
  const range = document.createRange();
  const rectOf = (node: Node, from: number, to: number) => {
    range.setStart(node, from);
    range.setEnd(node, to);
    return [...range.getClientRects()].find((r) => r.height > 0);
  };
  for (const piece of layer.querySelectorAll<HTMLElement>(".rt-piece")) {
    const text = piece.classList.contains("rt-emoji") ? piece.firstElementChild?.firstChild : piece.firstChild;
    if (!(text instanceof Text) || !text.data) continue;
    const at = Number(piece.dataset.at);
    const width = text.data.codePointAt(0)! > 0xffff ? 2 : 1;
    const drawn = rectOf(text, 0, width);
    const laid = rectOf(base, at, at + width);
    if (!drawn || !laid) continue;
    const dy = laid.top + laid.height / 2 - (drawn.top + drawn.height / 2);
    if (Math.abs(dy) > 0.01) piece.style.top = `${parseFloat(piece.style.top) + dy}px`;
  }
}

const PaintLayer = memo(function PaintLayer({ paint }: { paint: Paint[] }) {
  // An emoji is keyed by which occurrence of its shortcode it is, not its offset:
  // typing before it would otherwise remount (and reload) its image every keystroke.
  const seen = new Map<string, number>();
  return paint.map((p) => {
    const style = { [p.rtl ? "right" : "left"]: `${p.x}px`, top: `${p.top}px`, lineHeight: `${p.height}px` };
    if (p.emoji) {
      const n = seen.get(p.emoji.shortcode) ?? 0;
      seen.set(p.emoji.shortcode, n + 1);
      return (
        <span key={`e:${p.emoji.shortcode}:${n}`} data-at={p.at} className="rt-piece rt-emoji" style={style}>
          <span className="opacity-0">{p.text}</span>
          <CustomEmojiImg name={p.emoji.shortcode} url={p.emoji.url} className="rt-emoji-img" />
        </span>
      );
    }
    return (
      <span key={p.at} data-at={p.at} dir={p.rtl ? "rtl" : "ltr"} className={cn("rt-piece", p.className)} style={style}>
        {p.text}
      </span>
    );
  });
});

interface RichTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "maxLength" | "defaultValue"> {
  rich: RichText;
  ref?: Ref<HTMLTextAreaElement>;
  /** The floating Bold/Italic/… bar over a selection. */
  formatToolbar?: boolean;
}

/**
 * The live textarea with its text drawn by an overlay laid out identically
 * underneath it: mentions as pills, custom emoji as images, markdown styled
 * in place. The overlay lays out the text unsplit and unpainted, as the
 * textarea does (every element boundary would round to 1/64px, which adds up
 * along a line), and draws each line's styled runs over it.
 * Its parent must be the positioned box the overlay is placed in.
 */
export function RichTextarea({ rich, ref, className, onKeyDown, onCopy, onCut, formatToolbar = true, ...props }: RichTextareaProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [paint, setPaint] = useState<Paint[]>([]);
  const fontScale = useFontScale();
  const { textareaRef } = rich;
  const runs = useMemo(() => highlightRuns(rich.display, rich.model.atoms), [rich.display, rich.model.atoms]);
  const paintInput = useRef({ runs, atoms: rich.model.atoms });
  paintInput.current = { runs, atoms: rich.model.atoms };

  const setRefs = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  }, [textareaRef, ref]);

  const syncScroll = useCallback(() => {
    const el = textareaRef.current;
    const inner = innerRef.current;
    if (el && inner) inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  }, [textareaRef]);

  /**
   * Runs after every change to the text or its layout. From a browser event
   * (`now`) the pieces are committed at once: a resize animates the textarea's
   * width frame by frame, and a state update would land a frame late, drawing
   * every piece at the previous frame's wrap.
   */
  const syncText = useCallback((now = false) => {
    const el = textareaRef.current;
    const inner = innerRef.current;
    const layer = paintRef.current;
    if (!el || !inner || !layer) return;
    // The text wraps inside the textarea's scrollbar. A gutter of the same kind
    // (hidden in CSS) takes exactly its width, which no offset/client size gives.
    const overflow = getComputedStyle(el).overflowY;
    const scrollbar = overflow === "scroll" || (overflow === "auto" && el.scrollHeight > el.clientHeight);
    inner.style.overflowY = scrollbar ? "scroll" : "";
    syncScroll();
    const base = inner.firstChild;
    if (!(base instanceof Text)) return;
    const next = measurePaint(base, layer, inner, paintInput.current.runs, paintInput.current.atoms);
    if (now) flushSync(() => setPaint(next));
    else setPaint(next);
  }, [textareaRef, syncScroll]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    const overlay = overlayRef.current;
    const inner = innerRef.current;
    if (!el || !overlay || !inner) return;
    let box = "";
    let font = "";
    const sync = (now = true) => {
      const style = getComputedStyle(el);
      box = `${style.width}|${style.height}`;
      font = style.font;
      overlay.style.top = `${el.offsetTop}px`;
      overlay.style.left = `${el.offsetLeft}px`;
      // Computed sizes, not offset/client ones: those are whole pixels, and at a
      // fractional width the overlay then wraps a word the textarea doesn't.
      overlay.style.width = style.width;
      overlay.style.height = style.height;
      for (const prop of LAYOUT_PROPS) inner.style[prop] = style[prop];
      inner.style.width = style.width;
      // Android WebView scales text by the system font size, and a computed size
      // already carries it, so a copied size would be scaled twice. Divide it back out.
      const copied = getComputedStyle(inner);
      for (const prop of PX_PROPS) {
        const want = parseFloat(style[prop]);
        const got = parseFloat(copied[prop]);
        if (want > 0 && got > 0 && Math.abs(got - want) > 0.001) inner.style[prop] = `${(want * want) / got}px`;
      }
      syncText(now);
    };
    const onEvent = () => sync();
    sync(false);
    setReady(true);
    el.addEventListener("scroll", syncScroll);
    window.addEventListener("resize", onEvent);
    document.fonts?.addEventListener("loadingdone", onEvent);
    // The observer reports once on observe() with the box sync(false) just
    // measured; its flushSync would render every pending update (a whole
    // channel's timeline on a switch) synchronously for nothing.
    const onResize = () => {
      const style = getComputedStyle(el);
      if (`${style.width}|${style.height}` !== box) sync();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(el);
    // A theme font is a custom property on <html>; one that needs no loading
    // changes the textarea's font with no resize and no `loadingdone`.
    const onRootChange = () => {
      if (getComputedStyle(el).font !== font) sync();
    };
    const rootObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(onRootChange);
    rootObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      el.removeEventListener("scroll", syncScroll);
      window.removeEventListener("resize", onEvent);
      document.fonts?.removeEventListener("loadingdone", onEvent);
      observer?.disconnect();
      rootObserver?.disconnect();
    };
    // The text size changes the textarea's font without necessarily resizing it.
  }, [textareaRef, syncScroll, syncText, fontScale]);

  useLayoutEffect(() => {
    const base = innerRef.current?.firstChild;
    if (base instanceof Text && paintRef.current) alignPieces(base, paintRef.current);
  }, [paint]);

  // A new value can scroll the field, or bring in a scrollbar, without an event reaching us first.
  useLayoutEffect(() => syncText(), [rich.display, rich.model.atoms, syncText]);

  return (
    <>
      <div
        ref={overlayRef}
        aria-hidden
        className="rt-overlay pointer-events-none absolute overflow-hidden"
        style={{ visibility: ready ? undefined : "hidden" }}
      >
        <div
          ref={innerRef}
          dir={props.dir}
          className="rt-inner relative box-border whitespace-pre-wrap break-words border-solid border-transparent"
        >
          {/* A trailing newline only takes up a line when something follows it. */}
          {`${rich.display}\u200b`}
          <div ref={paintRef} className="absolute left-0 top-0">
            <PaintLayer paint={paint} />
          </div>
        </div>
      </div>
      <textarea
        {...props}
        ref={setRefs}
        value={rich.display}
        onChange={rich.onChange}
        onKeyDown={(e) => {
          if (rich.handleKeyDown(e)) return;
          onKeyDown?.(e);
        }}
        onCopy={(e) => {
          if (rich.handle.copySelection(e.clipboardData)) e.preventDefault();
          onCopy?.(e);
        }}
        onCut={(e) => {
          if (rich.handle.copySelection(e.clipboardData)) {
            e.preventDefault();
            rich.handle.insertAtSelection("");
          }
          onCut?.(e);
        }}
        className={cn(className, ready && "rt-input")}
      />
      {formatToolbar && <FormatToolbar rich={rich} />}
    </>
  );
}
