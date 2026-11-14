import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { Check, ChevronRight, Circle } from "lucide-react"

import { usePortalContainer } from "@/hooks/usePortalContainer"
import { holdTimeout } from "@/lib/holdTimeout"
import { cn } from "@/lib/utils"

/** Radix's touch hold. */
const TOUCH_HOLD_MS = 700

/**
 * Radix opens a touch hold on a bare setTimeout, which a tap released during a main-thread stall
 * outlasts. The Root defers that open until the press's own {@link holdTimeout} confirms it. A
 * `contextmenu` event is a hold the platform measured (or a right-click) and passes.
 */
interface TouchHoldGate {
  /** A touch press is down and its hold not yet confirmed. */
  pending: boolean
  /** Radix asked to open while `pending`. */
  deferred: boolean
  viaContextMenu: boolean
  cancel: (() => void) | null
}

const TouchHoldContext = React.createContext<{
  gate: TouchHoldGate
  open: () => void
} | null>(null)

const ContextMenu = ({
  onOpenChange,
  ...props
}: Omit<React.ComponentProps<typeof ContextMenuPrimitive.Root>, "open">) => {
  const [open, setOpen] = React.useState(false)
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const gate = React.useRef<TouchHoldGate>({
    pending: false,
    deferred: false,
    viaContextMenu: false,
    cancel: null,
  }).current
  const change = React.useCallback((next: boolean) => {
    if (next && gate.pending && !gate.viaContextMenu) {
      gate.deferred = true
      return
    }
    gate.viaContextMenu = false
    setOpen(next)
    onOpenChangeRef.current?.(next)
  }, [gate])
  React.useEffect(() => () => gate.cancel?.(), [gate])
  const hold = React.useMemo(() => ({ gate, open: () => change(true) }), [gate, change])
  return (
    <TouchHoldContext.Provider value={hold}>
      <ContextMenuPrimitive.Root {...props} open={open} onOpenChange={change} />
    </TouchHoldContext.Provider>
  )
}

const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>(({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu, ...props }, ref) => {
  const hold = React.useContext(TouchHoldContext)
  const release = () => {
    if (!hold) return
    hold.gate.cancel?.()
    hold.gate.cancel = null
    hold.gate.pending = false
    hold.gate.deferred = false
  }
  return (
    <ContextMenuPrimitive.Trigger
      ref={ref}
      {...props}
      onPointerDown={(e) => {
        onPointerDown?.(e)
        if (!hold || e.defaultPrevented || e.pointerType === "mouse" || props.disabled) return
        release()
        const { gate } = hold
        gate.viaContextMenu = false
        gate.pending = true
        gate.cancel = holdTimeout(() => {
          gate.cancel = null
          gate.pending = false
          if (!gate.deferred) return
          gate.deferred = false
          hold.open()
        }, TOUCH_HOLD_MS)
      }}
      // Radix drops its hold on any move, so the deferred open goes with it.
      onPointerMove={(e) => {
        onPointerMove?.(e)
        if (e.pointerType !== "mouse") release()
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e)
        if (e.pointerType !== "mouse") release()
      }}
      onPointerCancel={(e) => {
        onPointerCancel?.(e)
        if (e.pointerType !== "mouse") release()
      }}
      onContextMenu={(e) => {
        if (hold) {
          hold.gate.viaContextMenu = true
          // Radix opens within this dispatch; a handler that prevented it leaves no pass behind.
          queueMicrotask(() => {
            hold.gate.viaContextMenu = false
          })
        }
        onContextMenu?.(e)
      }}
    />
  )
})
ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName

const ContextMenuGroup = ContextMenuPrimitive.Group

const ContextMenuPortal = ContextMenuPrimitive.Portal

const ContextMenuSub = ContextMenuPrimitive.Sub

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean
  }
>(({ className, inset, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none focus:bg-foreground/[0.08] data-[state=open]:bg-foreground/[0.08]",
      inset && "pl-8",
      className
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </ContextMenuPrimitive.SubTrigger>
))
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => {
  const portalContainer = usePortalContainer()

  // Portaled: nested inside the parent, its vessel clip-path would crop it.
  return (
    <ContextMenuPrimitive.Portal container={portalContainer}>
      <ContextMenuPrimitive.SubContent
        ref={ref}
        collisionPadding={collisionPadding}
        className={cn(
          "z-[260] max-w-[var(--radix-context-menu-content-available-width)] min-w-[8rem] overflow-hidden vessel p-1 text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
})
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => {
  const portalContainer = usePortalContainer()

  return (
    <ContextMenuPrimitive.Portal container={portalContainer}>
      <ContextMenuPrimitive.Content
        ref={ref}
        className={cn(
          "z-[260] min-w-[8rem] overflow-hidden vessel p-1 text-popover-foreground animate-in fade-in-80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
})
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    checked={checked}
    {...props}
  >
    <span className="order-last ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center empty:hidden">
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.CheckboxItem>
))
ContextMenuCheckboxItem.displayName =
  ContextMenuPrimitive.CheckboxItem.displayName

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    <span className="order-last ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center empty:hidden">
      <ContextMenuPrimitive.ItemIndicator>
        <Circle className="h-2 w-2 fill-current" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </ContextMenuPrimitive.RadioItem>
))
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-sm font-semibold text-foreground",
      inset && "pl-8",
      className
    )}
    {...props}
  />
))
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("mx-2 my-1 h-px bg-foreground/10", className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}
ContextMenuShortcut.displayName = "ContextMenuShortcut"

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
