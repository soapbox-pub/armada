import { Search, X } from "lucide-react";
import { useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaneCoveredContext } from "@/contexts/PaneCoveredContext";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { cn } from "@/lib/utils";
import { useIntl } from "@/i18n";

/**
 * Inline message-search bar sliding over the chat header. Focuses with
 * `preventScroll` (the input starts off-screen). The caller owns the state.
 */
export function ChatSearchBar({
  open,
  value,
  onChange,
  onClose,
  placeholder,
  label,
  filters,
  suggestions,
}: {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  placeholder: string;
  label?: string;
  /** Rendered between the input and the close button (Concord's filters popover). */
  filters?: ReactNode;
  /** A caret-driven dropdown bound to the input (Concord's typed filter tokens). */
  suggestions?: (input: RefObject<HTMLInputElement | null>) => ReactNode;
}) {
  const intl = useIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Not while the pane is swiped aside: back then belongs to the list on screen.
  const covered = useContext(PaneCoveredContext);
  useAndroidBack(() => {
    onClose();
    return true;
  }, open && !covered, "overlay");

  return (
    <div
      className={cn(
        "absolute inset-y-0 right-0 left-10 sidebar:left-0 z-10 flex items-center gap-1.5 px-2 sidebar:px-3",
        "bg-chrome clip-corner-lg overflow-hidden",
        "transition-transform duration-300 ease-in-out",
        open ? "transform-none pointer-events-auto" : "translate-x-full pointer-events-none",
      )}
    >
      <Search className="size-4 text-muted-foreground shrink-0" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Prevented so an enclosing Escape handler (the settings overlay) leaves itself open.
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={placeholder}
        aria-label={label ?? intl.formatMessage({ id: "chatSearchBar.label", defaultMessage: "Search messages" })}
        variant="bare"
        className="h-8 touch:h-11 flex-1 px-1"
      />
      {open && suggestions?.(inputRef)}
      {filters}
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage({ id: "chatSearchBar.close", defaultMessage: "Close search" })}
        className="size-8 touch:size-10 shrink-0 text-muted-foreground"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
