import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Slot } from "@radix-ui/react-slot"
import { Check, ChevronRight, Circle } from "lucide-react"

import {
  MenuSheet,
  MenuSheetCheckboxItem,
  MenuSheetItem,
  MenuSheetSwitchItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetSeparator,
  MenuSheetSub,
  MenuSheetSubContent,
  MenuSheetSubTrigger,
  type MenuSheetIdentity,
} from "@/components/ui/menu-sheet"
import { Switch } from "@/components/ui/switch"
import { useBackDismiss } from "@/hooks/useAndroidBack"
import { useIsTouch } from "@/hooks/useIsMobile"
import { MenuSheetContext, useMenuSheet } from "@/hooks/useMenuSheet"
import { usePortalContainer } from "@/hooks/usePortalContainer"
import { cn } from "@/lib/utils"

type RootProps = React.ComponentProps<typeof DropdownMenuPrimitive.Root>

/**
 * Set by a `touchSheet` menu on touch, where it is a bottom sheet rather than a popup
 * at its trigger. Radix is not mounted; every part below renders the sheet's form of
 * itself, so a call site is written once.
 */
const SheetContext = React.createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
} | null>(null)

const PopupRoot = (props: RootProps) => (
  // A popup built inside a sheet's tree is still a popup.
  <MenuSheetContext.Provider value={null}>
    <DropdownMenuPrimitive.Root {...props} {...useBackDismiss(props)} />
  </MenuSheetContext.Provider>
)

function SheetRoot({ open: controlled, defaultOpen, onOpenChange, children }: RootProps) {
  const [own, setOwn] = React.useState(defaultOpen ?? false)
  const open = controlled ?? own
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const change = React.useCallback((next: boolean) => {
    setOwn(next)
    onOpenChangeRef.current?.(next)
  }, [])
  const sheet = React.useMemo(() => ({ open, onOpenChange: change }), [open, change])
  return <SheetContext.Provider value={sheet}>{children}</SheetContext.Provider>
}

const DropdownMenu = ({
  touchSheet,
  ...props
}: RootProps & {
  /** An action menu: on touch it opens as a bottom sheet, with submenus as its pages. */
  touchSheet?: boolean
}) => {
  const asSheet = useIsTouch() && touchSheet === true
  return asSheet ? <SheetRoot {...props} /> : <PopupRoot {...props} />
}
DropdownMenu.displayName = "DropdownMenu"

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ asChild, onClick, ...props }, ref) => {
  const sheet = React.useContext(SheetContext)
  if (!sheet) return <DropdownMenuPrimitive.Trigger ref={ref} asChild={asChild} onClick={onClick} {...props} />
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      {...(!asChild && { type: "button" as const })}
      aria-haspopup="menu"
      aria-expanded={sheet.open}
      data-state={sheet.open ? "open" : "closed"}
      {...props}
      // On the tap, not Radix's pointerdown: the press would land on the sheet rising under it.
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e)
        if (!e.defaultPrevented) sheet.onOpenChange(true)
      }}
    />
  )
})
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName

const DropdownMenuGroup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group>
>((props, ref) => {
  const sheet = useMenuSheet()
  if (sheet) return <div role="group">{props.children}</div>
  return <DropdownMenuPrimitive.Group ref={ref} {...props} />
})
DropdownMenuGroup.displayName = DropdownMenuPrimitive.Group.displayName

const DropdownMenuPortal = (props: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) => {
  const sheet = useMenuSheet()
  if (sheet) return <>{props.children}</>
  return <DropdownMenuPrimitive.Portal {...props} />
}
DropdownMenuPortal.displayName = DropdownMenuPrimitive.Portal.displayName

const DropdownMenuSub = (props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) => {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSub>{props.children}</MenuSheetSub>
  return <DropdownMenuPrimitive.Sub {...props} />
}
DropdownMenuSub.displayName = DropdownMenuPrimitive.Sub.displayName

const DropdownMenuRadioGroup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioGroup>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioGroup>
>((props, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioGroup value={props.value} onValueChange={props.onValueChange}>
        {props.children}
      </MenuSheetRadioGroup>
    )
  }
  return <DropdownMenuPrimitive.RadioGroup ref={ref} {...props} />
})
DropdownMenuRadioGroup.displayName = DropdownMenuPrimitive.RadioGroup.displayName

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
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
    <DropdownMenuPrimitive.SubTrigger
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
    </DropdownMenuPrimitive.SubTrigger>
  )
})
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => {
  const portalContainer = usePortalContainer()
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSubContent>{props.children}</MenuSheetSubContent>

  return (
    <DropdownMenuPrimitive.Portal container={portalContainer}>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        collisionPadding={collisionPadding}
        className={cn(
          "z-[260] max-w-[var(--radix-dropdown-menu-content-available-width)] min-w-[8rem] overflow-hidden vessel p-1 text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
    portalContainer?: HTMLElement
    /** What the menu is about, heading the touch sheet. */
    sheetIdentity?: MenuSheetIdentity
  }
>(({ className, sideOffset = 4, collisionPadding = 8, portalContainer, sheetIdentity, ...props }, ref) => {
  const inheritedPortalContainer = usePortalContainer()
  const sheet = React.useContext(SheetContext)
  if (sheet) {
    return (
      <MenuSheet
        open={sheet.open}
        onOpenChange={sheet.onOpenChange}
        identity={sheetIdentity}
        onCloseAutoFocus={props.onCloseAutoFocus}
      >
        {props.children}
      </MenuSheet>
    )
  }

  return (
    <DropdownMenuPrimitive.Portal container={portalContainer ?? inheritedPortalContainer}>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-[260] max-w-[calc(100vw-1rem)] min-w-[8rem] overflow-hidden vessel p-1 text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    const child = props.asChild && React.isValidElement<React.HTMLAttributes<HTMLElement>>(props.children)
      ? props.children
      : undefined
    return (
      <MenuSheetItem
        as={child}
        className={className}
        disabled={props.disabled}
        onSelect={props.onSelect}
        onClick={props.onClick}
      >
        {child ? child.props.children : props.children}
      </MenuSheetItem>
    )
  }
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none transition-colors focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  )
})
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
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
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none transition-colors focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="order-last ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center empty:hidden">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
})
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName

/** A setting toggled in place. Not a Radix item, which would close the menu on the toggle. */
const DropdownMenuSwitchItem = ({
  className,
  disabled,
  checked,
  onCheckedChange,
  children,
}: {
  className?: string
  disabled?: boolean
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  children?: React.ReactNode
}) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetSwitchItem className={className} disabled={disabled} checked={checked} onCheckedChange={onCheckedChange}>
        {children}
      </MenuSheetSwitchItem>
    )
  }
  return (
    <label
      className={cn("flex items-center justify-between gap-3 px-2 py-1.5 touch:py-3 text-sm cursor-pointer", className)}
      onPointerDown={(e) => e.preventDefault()}
    >
      <span className="flex items-center gap-2">{children}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  )
}
DropdownMenuSwitchItem.displayName = "DropdownMenuSwitchItem"

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) {
    return (
      <MenuSheetRadioItem className={className} disabled={props.disabled} value={props.value} onSelect={props.onSelect}>
        {children}
      </MenuSheetRadioItem>
    )
  }
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 menu-row clip-corner px-2 py-1.5 touch:py-3 text-sm outline-none transition-colors focus:bg-foreground/[0.08] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <span className="order-last ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center empty:hidden">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="h-2 w-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
})
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean
  }
>(({ className, inset, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetLabel className={className}>{props.children}</MenuSheetLabel>
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn(
        "px-2 py-1.5 text-sm font-semibold",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  )
})
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => {
  const sheet = useMenuSheet()
  if (sheet) return <MenuSheetSeparator />
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn("mx-2 my-1 h-px bg-foreground/10", className)}
      {...props}
    />
  )
})
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName

const DropdownMenuShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  // A touch sheet has no keyboard to hint at.
  if (useMenuSheet()) return null
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
      {...props}
    />
  )
}
DropdownMenuShortcut.displayName = "DropdownMenuShortcut"

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSwitchItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
}
