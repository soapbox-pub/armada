/**
 * An avatar's CSS width from its classes (`size-10`, `size-[52px]`, `h-12`; the base
 * `h-10 w-10` when none), or undefined when they don't say (`size-full`) and it must
 * be measured. Responsive and state variants are ignored: it only picks a thumbnail
 * bucket, which rounds up.
 */
export function boxFromClasses(className: string | undefined): number | undefined {
  let px: number | undefined = 40
  for (const token of (className ?? "").split(/\s+/)) {
    if (token.includes(":")) continue
    const scale = /^(?:size|h)-(\d+(?:\.\d+)?)$/.exec(token)
    const exact = /^(?:size|h)-\[(\d+(?:\.\d+)?)px\]$/.exec(token)
    if (scale) px = Number(scale[1]) * 4
    else if (exact) px = Number(exact[1])
    else if (/^(?:size|h)-/.test(token)) px = undefined
  }
  return px
}

/** Box decorations (`ring-2`, `border-4`, `shadow-xl`, `bg-…`), with any variants. */
const DECOR_CLASS = /^!?-?(?:shadow|ring|border|outline|bg)(?:-|$)/;

/**
 * A framed shaped avatar's classes, split into the wrapper's layout and the masked
 * avatar's decorations: on the unmasked wrapper a ring or shadow draws a square,
 * and the frame's drop-shadow outlines it.
 */
export function splitDecor(className: string | undefined): [string, string] {
  const layout: string[] = [];
  const decor: string[] = [];
  for (const token of (className ?? "").split(/\s+/)) {
    if (!token) continue;
    (DECOR_CLASS.test(token.slice(token.lastIndexOf(":") + 1)) ? decor : layout).push(token);
  }
  return [layout.join(" "), decor.join(" ")];
}
