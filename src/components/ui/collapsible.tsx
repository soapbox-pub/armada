import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { useEffect, useState, type ReactNode } from "react"

const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger

const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

/**
 * A {@link Collapsible} mounted the first time it opens. Radix measures its content
 * in a layout effect on mount, open or not, forcing a layout of everything mounting
 * with it: a whole page, for a menu that is usually never opened. It mounts closed
 * and opens a frame later, so the first opening still animates.
 */
function LazyCollapsible({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (!open) {
      setShown(false)
      return
    }
    if (!mounted) {
      setMounted(true)
      return
    }
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [open, mounted])
  if (!mounted) return null
  return (
    <Collapsible open={shown} onOpenChange={onOpenChange}>
      {children}
    </Collapsible>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent, LazyCollapsible }
