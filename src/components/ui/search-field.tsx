import { Loader2, Search, X } from "lucide-react";
import { forwardRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import type { InputHTMLAttributes, ReactNode } from "react";

interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className" | "placeholder"> {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  /** Shown at the right edge while the field is empty (e.g. a provider credit). */
  hint?: ReactNode;
  /** A lookup is in flight; replaces the hint. */
  busy?: boolean;
}

/** The inline search idiom: a field well around a bare input. Escape and the X both clear it. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  ({ value, onChange, placeholder, className, hint, busy, onKeyDown, ...inputProps }, ref) => {
    const intl = useIntl();
    return (
    <div
      className={cn(
        "field flex h-9 touch:h-11 min-w-0 items-center gap-1.5 px-2",
        className,
      )}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        ref={ref}
        aria-label={placeholder}
        {...inputProps}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          // Clear first; a second Escape reaches the surrounding popover or dialog.
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        variant="bare"
        className="h-full flex-1 min-w-0 px-1"
      />
      {busy ? (
        <Loader2 className="mx-1.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "searchField.clear", defaultMessage: "Clear search" })}
          className="size-7 touch:size-9 shrink-0 text-muted-foreground"
          onClick={() => onChange("")}
        >
          <X className="size-4" />
        </Button>
      ) : hint ? (
        <span className="shrink-0 pr-1 text-3xs text-muted-foreground/50 pointer-events-none select-none">
          {hint}
        </span>
      ) : null}
    </div>
    );
  },
);
SearchField.displayName = "SearchField";
