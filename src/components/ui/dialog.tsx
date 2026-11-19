import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { useBackDismiss } from "@/hooks/useAndroidBack"
import { usePortalContainer } from "@/hooks/usePortalContainer"
import { common, FormattedMessage } from "@/i18n"
import { cn } from "@/lib/utils"

const Dialog = (props: React.ComponentProps<typeof DialogPrimitive.Root>) => (
  <DialogPrimitive.Root {...props} {...useBackDismiss(props)} />
)
Dialog.displayName = "Dialog"

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-radix-dialog-overlay=""
    className={cn(
      "fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm cursor-pointer data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideClose?: boolean
    portalContainer?: HTMLElement
    /** Raise the backdrop with `className`'s z-index, e.g. above the post-login wizard (`z-[260]`). */
    overlayClassName?: string
  }
>(({ className, children, hideClose, portalContainer, overlayClassName, ...props }, ref) => {
  const inheritedPortalContainer = usePortalContainer()

  return (
    <DialogPortal container={portalContainer ?? inheritedPortalContainer}>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // Centered within the SAFE area, or tall dialogs put the close button under the Android status bar.
          "fixed left-[50%] top-[calc(50%+(var(--safe-area-inset-top,env(safe-area-inset-top,0px))-var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))/2)] z-[250] grid w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem-var(--safe-area-inset-top,env(safe-area-inset-top,0px))-var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto overscroll-contain border bg-background p-6 shadow-lg rounded-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm p-2 -m-2 touch:p-3 touch:-m-3 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="size-5" />
            <span className="sr-only"><FormattedMessage {...common.close} /></span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

/**
 * Armada's single dialog idiom: a cut-corner chrome vessel. The inner card is
 * an inline-size container (children can use `cqw`). `title` is visually hidden
 * unless you render your own heading.
 */
const ChromeDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    title: string
    contentClassName?: string
    hideClose?: boolean
    portalContainer?: HTMLElement
    overlayClassName?: string
  }
>(({ className, contentClassName, title, children, hideClose, portalContainer, overlayClassName, ...props }, ref) => (
  <DialogContent
    ref={ref}
    hideClose={hideClose}
    portalContainer={portalContainer}
    overlayClassName={overlayClassName}
    className={cn(
      "sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none",
      className
    )}
    {...props}
  >
    <DialogTitle className="sr-only">{title}</DialogTitle>
    <div className={cn("chrome-dialog clip-corner-lg bg-chrome p-5 sm:p-7 relative", contentClassName)}>
      {children}
    </div>
  </DialogContent>
))
ChromeDialogContent.displayName = "ChromeDialogContent"

const CHROME_TONES = {
  primary: "bg-primary/15 text-primary",
  destructive: "bg-destructive/15 text-destructive",
  warning: "bg-warning/15 text-warning",
} as const

/** The chrome dialog heading: icon tile, mono lowercase title, optional description. */
const ChromeDialogHeader = ({
  icon: Icon,
  title,
  description,
  tone = "primary",
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  tone?: keyof typeof CHROME_TONES
  className?: string
}) => (
  <div className={cn("flex flex-col items-center gap-2 text-center", className)}>
    <div className={cn("flex size-12 items-center justify-center clip-corner-lg", CHROME_TONES[tone])}>
      <Icon className="size-6" />
    </div>
    <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
      {title}
    </h2>
    {description && <div className="text-sm text-muted-foreground">{description}</div>}
  </div>
)
ChromeDialogHeader.displayName = "ChromeDialogHeader"

/** Equal-width cut-corner actions under a chrome dialog body. */
const ChromeDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mt-6 flex items-center gap-2 [&>*]:flex-1 [&>*]:clip-corner-lg", className)} {...props} />
)
ChromeDialogFooter.displayName = "ChromeDialogFooter"

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  ChromeDialogContent,
  ChromeDialogHeader,
  ChromeDialogFooter,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
