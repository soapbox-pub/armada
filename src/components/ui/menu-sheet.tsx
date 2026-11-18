import * as React from "react"
import { createPortal } from "react-dom"
import { Check, ChevronLeft, ChevronRight } from "lucide-react"

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Switch } from "@/components/ui/switch"
import { useOverlayBack } from "@/hooks/useAndroidBack"
import { MenuSheetContext, trackOpenMenuSheet, useMenuSheet, type MenuSheetApi } from "@/hooks/useMenuSheet"
import { common, FormattedMessage, useIntl } from "@/i18n"
import { cn } from "@/lib/utils"

/**
 * Window after opening in which an outside-dismiss is refused: the opening
 * press leaves a trailing event read as an outside tap.
 */
const OPEN_GUARD_MS = 400

// The message action sheet's rows (MessageActionSheet), so every touch menu reads as one.
const ROW =
  "flex min-h-11 w-full items-center gap-3 clip-corner px-3 py-2.5 text-left text-chat font-medium active:bg-secondary disabled:opacity-50"
const TILE = "flex size-10 shrink-0 items-center justify-center clip-corner-lg bg-secondary"
const LIST = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[var(--safe-area-pad-bottom,0.75rem)]"
const TITLE = "truncate text-base font-semibold leading-tight tracking-normal"

/** What the sheet was opened on, shown above its rows. */
export interface MenuSheetIdentity {
  /** A `size-10` avatar or {@link MenuSheetTile}. */
  lead?: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
}

interface MenuSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  identity?: MenuSheetIdentity
  onCloseAutoFocus?: (event: Event) => void
  children?: React.ReactNode
}

/**
 * A menu as a bottom sheet: the touch form of a context menu, whose submenus
 * become pages of the same sheet. Mounted on first open, since a closed sheet
 * per list row would be a vaul root per row.
 */
function MenuSheet({ open, ...props }: MenuSheetProps) {
  const [mounted, setMounted] = React.useState(open)
  if (open && !mounted) setMounted(true)
  return mounted ? <MenuSheetDrawer open={open} {...props} /> : null
}

function MenuSheetDrawer({ open, onOpenChange, identity, onCloseAutoFocus, children }: MenuSheetProps) {
  const [pages, setPages] = React.useState<readonly string[]>([])
  const [outlet, setOutlet] = React.useState<HTMLElement | null>(null)

  // Stamped during the opening render, NOT in an effect: an effect runs after
  // the layer is listening and would compare against the previous open's stale time.
  const openedAt = React.useRef(0)
  const [wasOpen, setWasOpen] = React.useState(false)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      openedAt.current = Date.now()
      // Reset on opening rather than closing, so the sheet slides away as it stood.
      setPages([])
    }
  }

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  const openPage = React.useCallback((id: string) => setPages((p) => [...p, id]), [])
  const back = React.useCallback(() => setPages((p) => p.slice(0, -1)), [])
  const api = React.useMemo<MenuSheetApi>(
    () => ({ close, pages, openPage, back, outlet }),
    [close, pages, openPage, back, outlet],
  )

  const nested = pages.length > 0
  useOverlayBack(() => {
    if (nested) back()
    else close()
    return true
  }, open)

  React.useEffect(() => (open ? trackOpenMenuSheet(close) : undefined), [open, close])

  const guard = (e: { preventDefault: () => void }) => {
    if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault()
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        // The popup's layer, so a menu opened over a dialog or the lightbox isn't under it.
        className="z-[260] max-h-[85dvh]"
        overlayClassName="z-[260]"
        aria-describedby={undefined}
        onPointerDownOutside={guard}
        onInteractOutside={guard}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e)
          // Focus an item moved (a search field, a dialog) stays where it was put.
          const active = document.activeElement
          if (active && active !== document.body) e.preventDefault()
        }}
      >
        <MenuSheetContext.Provider value={api}>
          {identity ? (
            <div className={cn("flex shrink-0 items-center gap-3 px-5 pb-2 pt-1", nested && "hidden")}>
              {identity.lead}
              <div className="min-w-0 flex-1">
                <DrawerTitle className={TITLE}>{identity.title}</DrawerTitle>
                {identity.sub && <p className="truncate text-xs text-muted-foreground">{identity.sub}</p>}
              </div>
            </div>
          ) : (
            <DrawerTitle className="sr-only">
              <FormattedMessage id="menuSheet.title" defaultMessage="Actions" />
            </DrawerTitle>
          )}
          {/* Hidden, not unmounted: a page is rendered by the row that opened it. */}
          <div className={cn(LIST, !identity && "pt-2", nested && "hidden")}>{children}</div>
          <div ref={setOutlet} className="contents" />
        </MenuSheetContext.Provider>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * An icon for a {@link MenuSheetIdentity} lead. Bare, since a filled tile reads as one
 * of the rows; it keeps the tile's width, so the title lines up with their labels.
 */
function MenuSheetTile({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("flex size-10 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-5", className)}
      {...props}
    />
  )
}

/** Call sites mark a destructive item with a text colour; the row tints its tile from it. */
const isDestructive = (className?: string) => /\btext-destructive\b/.test(className ?? "")

function flatten(children: React.ReactNode, out: React.ReactNode[] = []): React.ReactNode[] {
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment) {
      flatten(child.props.children, out)
    } else if (child != null && typeof child !== "boolean") {
      out.push(child)
    }
  })
  return out
}

const isBlank = (node: React.ReactNode) => typeof node === "string" && node.trim() === ""

type IconElement = React.ReactElement<{ className?: string; children?: React.ReactNode }>

/**
 * A menu item is written `<Icon className="…" /> label`. The icon is the leading
 * element that has a class and no children; a label is text or an element around it.
 */
function splitLead(children: React.ReactNode): { lead?: IconElement; rest: React.ReactNode[] } {
  const nodes = flatten(children)
  while (nodes.length > 0 && isBlank(nodes[0])) nodes.shift()
  const first = nodes[0]
  if (
    !React.isValidElement<{ className?: string; children?: React.ReactNode }>(first) ||
    typeof first.props.className !== "string" ||
    first.props.children != null
  ) {
    return { rest: nodes }
  }
  const rest = nodes.slice(1)
  while (rest.length > 0 && isBlank(rest[0])) rest.shift()
  return { lead: first, rest }
}

const keyed = (nodes: React.ReactNode[]) =>
  nodes.map((node, i) => <React.Fragment key={i}>{node}</React.Fragment>)

interface RowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> {
  /** The current choice of a set: a tinted tile. */
  chosen?: boolean
  trailing?: React.ReactNode
  /** The element to be the row in a button's place: an item written `asChild` around a link. */
  as?: React.ReactElement<React.HTMLAttributes<HTMLElement>>
}

/** A call site shows or hides an item by breakpoint; the row keeps that and nothing else of its styling. */
const visibility = (className?: string) =>
  (className ?? "").split(/\s+/).filter((c) => /(^|:)hidden$/.test(c) || /:flex$/.test(c))

function Row({ className, chosen, trailing, as, children, ...props }: RowProps) {
  const destructive = isDestructive(className)
  const { lead, rest } = splitLead(children)
  const rowClass = cn(ROW, destructive ? "text-destructive" : "text-foreground", visibility(className))
  const inner = (
    <>
      {lead && (
        <span className={cn(TILE, chosen && "bg-primary/20")}>
          {typeof lead.type === "string"
            ? lead
            : React.cloneElement(lead, {
                className: cn("size-5", chosen ? "text-primary" : !destructive && "text-muted-foreground"),
              })}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">{keyed(rest)}</span>
      {trailing}
    </>
  )
  if (as) return React.cloneElement(as, { className: rowClass, onClick: props.onClick }, inner)
  return (
    <button type="button" className={rowClass} {...props}>
      {inner}
    </button>
  )
}

type SelectHandler = ((event: Event) => void) | undefined

/** Runs an item's `onSelect` as Radix would; true when it asked for the menu to stay open. */
function keptOpen(onSelect: SelectHandler): boolean {
  const event = new Event("menu.itemSelect", { cancelable: true })
  onSelect?.(event)
  return event.defaultPrevented
}

interface ItemProps {
  className?: string
  disabled?: boolean
  onSelect?: SelectHandler
  children?: React.ReactNode
}

function MenuSheetItem({
  className,
  disabled,
  onSelect,
  onClick,
  as,
  children,
}: ItemProps & { onClick?: React.MouseEventHandler<HTMLElement> } & Pick<RowProps, "as">) {
  const sheet = useMenuSheet()
  return (
    <Row
      as={as}
      className={className}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e)
        if (!keptOpen(onSelect)) sheet?.close()
      }}
    >
      {children}
    </Row>
  )
}

function MenuSheetCheckboxItem({
  className,
  disabled,
  checked,
  onCheckedChange,
  onSelect,
  children,
}: ItemProps & { checked?: boolean | "indeterminate"; onCheckedChange?: (checked: boolean) => void }) {
  const sheet = useMenuSheet()
  const on = checked === true
  return (
    <Row
      role="checkbox"
      aria-checked={on}
      className={className}
      disabled={disabled}
      trailing={
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-xs border border-primary",
            on && "bg-primary text-primary-foreground",
          )}
        >
          {on && <Check className="size-4" />}
        </span>
      }
      onClick={() => {
        onCheckedChange?.(!on)
        if (!keptOpen(onSelect)) sheet?.close()
      }}
    >
      {children}
    </Row>
  )
}

/** A setting toggled in place, which leaves the sheet open. */
function MenuSheetSwitchItem({
  className,
  disabled,
  checked,
  onCheckedChange,
  children,
}: Omit<ItemProps, "onSelect"> & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) {
  return (
    <Row
      as={<label />}
      className={className}
      trailing={<Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />}
    >
      {children}
    </Row>
  )
}

const RadioContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({})

function MenuSheetRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value?: string
  onValueChange?: (value: string) => void
  children?: React.ReactNode
}) {
  const group = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange])
  return (
    <RadioContext.Provider value={group}>
      <div role="radiogroup">{children}</div>
    </RadioContext.Provider>
  )
}

/** Inside a nested page, where settling a choice goes back rather than closing. */
const PageContext = React.createContext(false)

function MenuSheetRadioItem({ className, disabled, value, onSelect, children }: ItemProps & { value: string }) {
  const sheet = useMenuSheet()
  const group = React.useContext(RadioContext)
  const inPage = React.useContext(PageContext)
  const chosen = group.value === value
  return (
    <Row
      role="radio"
      aria-checked={chosen}
      className={className}
      disabled={disabled}
      chosen={chosen}
      trailing={chosen && <Check className="size-5 shrink-0 text-primary" />}
      onClick={() => {
        group.onValueChange?.(value)
        if (keptOpen(onSelect)) return
        // Back to the row that shows the choice.
        if (inPage) sheet?.back()
        else sheet?.close()
      }}
    >
      {children}
    </Row>
  )
}

const SubContext = React.createContext<{
  id: string
  titleSlot: HTMLElement | null
  setTitleSlot: (el: HTMLElement | null) => void
} | null>(null)

/** A submenu: a row that opens a page of the same sheet. */
function MenuSheetSub({ children }: { children?: React.ReactNode }) {
  const id = React.useId()
  const [titleSlot, setTitleSlot] = React.useState<HTMLElement | null>(null)
  const sub = React.useMemo(() => ({ id, titleSlot, setTitleSlot }), [id, titleSlot])
  return <SubContext.Provider value={sub}>{children}</SubContext.Provider>
}

function MenuSheetSubTrigger({
  className,
  disabled,
  value,
  children,
}: {
  className?: string
  disabled?: boolean
  /** The current setting, shown beside the chevron. */
  value?: React.ReactNode
  children?: React.ReactNode
}) {
  const sheet = useMenuSheet()
  const sub = React.useContext(SubContext)
  return (
    <>
      <Row
        className={className}
        disabled={disabled}
        trailing={
          <>
            {value != null && (
              <span className="max-w-[45%] shrink-0 truncate text-sm font-normal text-muted-foreground">{value}</span>
            )}
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
          </>
        }
        onClick={() => {
          if (sub) sheet?.openPage(sub.id)
        }}
      >
        {children}
      </Row>
      {/* The page is titled by the row that opened it. */}
      {sub?.titleSlot && createPortal(keyed(splitLead(children).rest), sub.titleSlot)}
    </>
  )
}

function MenuSheetSubContent({ children }: { children?: React.ReactNode }) {
  const intl = useIntl()
  const sheet = useMenuSheet()
  const sub = React.useContext(SubContext)
  if (!sheet?.outlet || !sub || !sheet.pages.includes(sub.id)) return null
  const showing = sheet.pages[sheet.pages.length - 1] === sub.id
  return createPortal(
    <PageContext.Provider value>
      <div className={cn("flex min-h-0 flex-1 flex-col", !showing && "hidden")}>
        {/* The back button sits on the rows' tile column, so the title starts where their labels do. */}
        <div className="flex shrink-0 items-center gap-3 px-5 pb-1">
          <button
            type="button"
            aria-label={intl.formatMessage(common.back)}
            className="-m-0.5 flex size-11 shrink-0 items-center justify-center clip-corner-lg text-muted-foreground active:bg-secondary"
            onClick={sheet.back}
          >
            <ChevronLeft className="size-5" />
          </button>
          <h2 ref={sub.setTitleSlot} className={cn("min-w-0", TITLE)} />
        </div>
        <div className={LIST}>{children}</div>
      </div>
    </PageContext.Provider>,
    sheet.outlet,
  )
}

function MenuSheetSeparator() {
  return <div role="separator" className="mx-3 my-1.5 h-px bg-foreground/10" />
}

function MenuSheetLabel({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={cn("px-3 py-1.5 text-sm font-semibold text-foreground", className)}>{children}</div>
}

export {
  MenuSheet,
  MenuSheetTile,
  MenuSheetItem,
  MenuSheetCheckboxItem,
  MenuSheetSwitchItem,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetSub,
  MenuSheetSubTrigger,
  MenuSheetSubContent,
  MenuSheetSeparator,
  MenuSheetLabel,
}
