import { ChevronLeft, MoreVertical, Search, Users, type LucideIcon } from "lucide-react";
import { forwardRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** The chat pane's top bar, shared by Concord and NIP-29 so both read the same. */
export const ChatHeader = forwardRef<HTMLElement, { className?: string; children: ReactNode }>(
  function ChatHeader({ className, children }, ref) {
    return (
      <header
        ref={ref}
        className={cn(
          "relative h-12 touch:h-[3.25rem] max-sidebar:h-auto max-sidebar:py-1 mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome",
          className,
        )}
      >
        {children}
      </header>
    );
  },
);

export function ChatHeaderBack({ onClick }: { onClick: () => void }) {
  const intl = useIntl();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={intl.formatMessage({ id: "chatHeader.back", defaultMessage: "Back to channels" })}
      className="size-9 touch:size-11 shrink-0 sidebar:hidden"
      onClick={onClick}
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}

/** The mobile title's community/server mark: its image, or the name's initial. */
export function ChatHeaderAvatar({ src, name }: { src: string | null | undefined; name: string | undefined }) {
  if (src) return <img src={src} alt="" className="size-8 rounded object-cover shrink-0" />;
  return (
    <div className="size-8 rounded shrink-0 bg-muted text-muted-foreground flex items-center justify-center text-sm font-semibold uppercase">
      {name?.trim()?.[0] ?? "#"}
    </div>
  );
}

/**
 * Desktop shows the channel alone; mobile, where the channel list is hidden,
 * leads with the community it belongs to and names the channel beneath.
 */
export function ChatHeaderTitle({
  glyph,
  title,
  topic,
  avatar,
  context,
  onContextClick,
  contextLabel,
  indicator,
  className,
}: {
  /** Rendered at both sizes, so it takes the size class. */
  glyph: (className: string) => ReactNode;
  title: ReactNode;
  /** The channel's description, beneath the title on desktop and after it on mobile. */
  topic?: string;
  avatar: ReactNode;
  context: ReactNode;
  onContextClick?: () => void;
  contextLabel?: string;
  /** A badge pinned to the glyph/avatar corner, positioned by the class given. */
  indicator?: (className: string) => ReactNode;
  className?: string;
}) {
  const mobile = (
    <>
      {avatar}
      <div className="min-w-0 flex flex-col">
        <span className="font-semibold text-base leading-tight truncate">{context}</span>
        <span className="text-xs text-muted-foreground leading-tight flex items-center gap-0.5 min-w-0">
          {glyph("size-3 shrink-0")}
          <span className="truncate">
            {title}
            {topic && <> · {topic}</>}
          </span>
        </span>
      </div>
    </>
  );
  return (
    <>
      <div className={cn("relative hidden sidebar:flex items-center gap-1.5 min-w-0", className)}>
        {indicator?.("absolute -bottom-0.5 left-2 z-10")}
        {glyph("size-5 text-muted-foreground shrink-0")}
        <div className="min-w-0">
          <h1 className="font-semibold truncate leading-tight">{title}</h1>
          {topic && <p className="text-xs text-muted-foreground truncate">{topic}</p>}
        </div>
      </div>
      <div className={cn("relative flex sidebar:hidden items-center min-w-0", className)}>
        {/* Beside the button, not in it: the indicator may be interactive. */}
        {indicator?.("absolute bottom-0 left-5 z-10")}
        {onContextClick ? (
          <button
            type="button"
            className="flex items-center gap-2.5 min-w-0 text-left"
            onClick={onContextClick}
            aria-label={contextLabel}
          >
            {mobile}
          </button>
        ) : (
          <div className="flex items-center gap-2.5 min-w-0">{mobile}</div>
        )}
      </div>
    </>
  );
}

/** The right-aligned action group. */
export function ChatHeaderActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex items-center gap-0.5">{children}</div>;
}

/** An icon action with a tooltip; `pressed` makes it a toggle. */
export function ChatHeaderAction({
  icon: Icon,
  label,
  tooltip = label,
  pressed,
  disabled,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  tooltip?: string;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          className={cn(
            "size-8 touch:size-11",
            pressed !== undefined && "text-muted-foreground",
            pressed && "text-foreground",
            className,
          )}
          onClick={onClick}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The ⋮ menu's `onCloseAutoFocus`: leave focus where an item moved it (the
 * search input) instead of returning it to the trigger, which hands typing to
 * the composer. Radix restores focus a tick after the item's own focus lands.
 */
export function keepItemFocus(event: Event) {
  const active = document.activeElement;
  if (active && active !== document.body) event.preventDefault();
}

/** The ⋮ trigger; render inside a `DropdownMenu`. */
export function ChatHeaderMenuTrigger() {
  const intl = useIntl();
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage({ id: "chatHeader.moreOptions", defaultMessage: "More options" })}
        className="size-8 touch:size-11 shrink-0 text-muted-foreground"
      >
        <MoreVertical className="size-4" />
      </Button>
    </DropdownMenuTrigger>
  );
}

/**
 * The menu's first items: search and the member list move here on mobile,
 * where the header has no room for them; desktop keeps search in the bar.
 */
export function ChatHeaderViewItems({
  onSearch,
  onMembers,
  membersVisible,
  onToggleMembers,
}: {
  onSearch?: () => void;
  onMembers: () => void;
  membersVisible: boolean;
  onToggleMembers: () => void;
}) {
  return (
    <>
      {onSearch && (
        <DropdownMenuItem className="sidebar:hidden" onClick={onSearch}>
          <Search className="size-4" />
          <FormattedMessage id="chatHeader.searchMessages" defaultMessage="Search messages" />
        </DropdownMenuItem>
      )}
      <DropdownMenuItem className="sidebar:hidden" onClick={onMembers}>
        <Users className="size-4" />
        <FormattedMessage id="chatHeader.members" defaultMessage="Members" />
      </DropdownMenuItem>
      <DropdownMenuItem className="hidden sidebar:flex" onClick={onToggleMembers}>
        <Users className="size-4" />
        {membersVisible ? (
          <FormattedMessage id="chatHeader.hideMembers" defaultMessage="Hide members" />
        ) : (
          <FormattedMessage id="chatHeader.showMembers" defaultMessage="Show members" />
        )}
      </DropdownMenuItem>
    </>
  );
}
