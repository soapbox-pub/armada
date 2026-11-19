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
