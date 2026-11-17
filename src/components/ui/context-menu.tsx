import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { Check, ChevronRight, Circle } from "lucide-react"

import {
  MenuSheet,
  MenuSheetCheckboxItem,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetSeparator,
  MenuSheetSub,
  MenuSheetSubContent,
  MenuSheetSubTrigger,
  type MenuSheetIdentity,
} from "@/components/ui/menu-sheet"
import { useIsTouch } from "@/hooks/useIsMobile"
import { ContextMenuOpenContext, useMenuSheet } from "@/hooks/useMenuSheet"
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
  /** The press landed on a menu nested inside this one, which answers it instead. */
  yielded: boolean
  cancel: (() => void) | null
}

/** Presses a trigger has taken, seen by the triggers around it as the event bubbles. */
const claimedPresses = new WeakSet<Event>()

const TouchHoldContext = React.createContext<{
  gate: TouchHoldGate
  open: () => void
} | null>(null)

/**
 * Set on touch, where the menu is a bottom sheet rather than a popup at the press point.
 * Radix then stays shut and only its trigger is used; every part below renders the sheet's
 * form of itself, so a call site is written once.
 */
const SheetContext = React.createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
} | null>(null)

const ContextMenu = ({
  onOpenChange,
  ...props
}: Omit<React.ComponentProps<typeof ContextMenuPrimitive.Root>, "open">) => {
  const asSheet = useIsTouch()
  const [open, setOpen] = React.useState(false)
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const gate = React.useRef<TouchHoldGate>({
    pending: false,
    deferred: false,
    viaContextMenu: false,
    yielded: false,
    cancel: null,
  }).current
  const change = React.useCallback((next: boolean) => {
    if (next && gate.yielded) return
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
  const sheet = React.useMemo(
    () => (asSheet ? { open, onOpenChange: change } : null),
    [asSheet, open, change],
  )
  return (
    <TouchHoldContext.Provider value={hold}>
      <ContextMenuOpenContext.Provider value={hold.open}>
        <SheetContext.Provider value={sheet}>
          <ContextMenuPrimitive.Root {...props} open={!asSheet && open} onOpenChange={change} />
        </SheetContext.Provider>
      </ContextMenuOpenContext.Provider>
    </TouchHoldContext.Provider>
  )
}

const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>(({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu, ...props }, ref) => {
  const hold = React.useContext(TouchHoldContext)
  const sheet = React.useContext(SheetContext)
  const release = () => {
    if (!hold) return
    hold.gate.cancel?.()
    hold.gate.cancel = null
    hold.gate.pending = false
    hold.gate.deferred = false
    hold.gate.yielded = false
  }
  return (
    <ContextMenuPrimitive.Trigger
      ref={ref}
      {...props}
      // Radix reports its own state, which a sheet never opens.
      {...(sheet && { "data-state": sheet.open ? "open" : "closed" })}
      onPointerDown={(e) => {
        onPointerDown?.(e)
        if (!hold || e.defaultPrevented || e.pointerType === "mouse" || props.disabled) return
        release()
        const { gate } = hold
        if (claimedPresses.has(e.nativeEvent)) {
          gate.yielded = true
          return
        }
        claimedPresses.add(e.nativeEvent)
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

const ContextMenuGroup = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Group>
>((props, ref) => {
  const sheet = useMenuSheet()
  if (sheet) return <div role="group">{props.children}</div>
  return <ContextMenuPrimitive.Group ref={ref} {...props} />
})
ContextMenuGroup.displayName = ContextMenuPrimitive.Group.displayName

const ContextMenuPortal = ContextMenuPrimitive.Portal

const ContextMenuSub = (props: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) => {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSub>{props.children}</MenuSheetSub>
  return <ContextMenuPrimitive.Sub {...props} />
}
ContextMenuSub.displayName = ContextMenuPrimitive.Sub.displayName

const ContextMenuRadioGroup = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioGroup>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioGroup>
>((props, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioGroup value={props.value} onValueChange={props.onValueChange}>
        {props.children}
      </MenuSheetRadioGroup>
    )
  }
  return <ContextMenuPrimitive.RadioGroup ref={ref} {...props} />
})
ContextMenuRadioGroup.displayName = ContextMenuPrimitive.RadioGroup.displayName

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean
    /** The submenu's current setting, shown on the touch sheet's row. */
    value?: React.ReactNode
  }
>(({ className, inset, value, children, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSubTrigger className={className} disabled={props.disabled} value={value}>
        {children}
      </MenuSheetSubTrigger>
    )
  }
  return (
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
  )
})
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => {
  const portalContainer = usePortalContainer()
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSubContent>{props.children}</MenuSheetSubContent>

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
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content> & {
    /** What the menu was opened on, heading the touch sheet. */
    sheetIdentity?: MenuSheetIdentity
  }
>(({ className, sheetIdentity, ...props }, ref) => {
  const portalContainer = usePortalContainer()
  const sheet = React.useContext(SheetContext)
  if (sheet) {
    return (
      <MenuSheet open={sheet.open} onOpenChange={sheet.onOpenChange} identity={sheetIdentity}>
        {props.children}
      </MenuSheet>
    )
  }

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
>(({ className, inset, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetItem className={className} disabled={props.disabled} onSelect={props.onSelect}>
        {props.children}
      </MenuSheetItem>
    )
  }
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  )
})
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetCheckboxItem
        className={className}
        disabled={props.disabled}
        checked={checked}
        onCheckedChange={props.onCheckedChange}
        onSelect={props.onSelect}
      >
        {children}
      </MenuSheetCheckboxItem>
    )
  }
  return (
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
  )
})
ContextMenuCheckboxItem.displayName =
  ContextMenuPrimitive.CheckboxItem.displayName

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioItem
        className={className}
        disabled={props.disabled}
        value={props.value}
        onSelect={props.onSelect}
      >
        {children}
      </MenuSheetRadioItem>
    )
  }
  return (
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
  )
})
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetLabel className={className}>{props.children}</MenuSheetLabel>
  return (
    <ContextMenuPrimitive.Label
      ref={ref}
      className={cn(
        "px-2 py-1.5 text-sm font-semibold text-foreground",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  )
})
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSeparator />
  return (
    <ContextMenuPrimitive.Separator
      ref={ref}
      className={cn("mx-2 my-1 h-px bg-foreground/10", className)}
      {...props}
    />
  )
})
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  // A touch sheet has no keyboard to hint at.
  if (useMenuSheet()) return null
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
