import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

export interface PillTab<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Shared tab strip of cut-corner pills. Below `sm` only the active pill shows
 * its label, animated via a 0fr→1fr grid column (no measuring). Overflow scrolls.
 */
export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  iconClassName,
  labels = "responsive",
  fill = false,
}: {
  tabs: readonly PillTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  iconClassName?: string;
  /** "always": every pill keeps its label, for short strips with room to spare. */
  labels?: "responsive" | "always";
  /** Every pill takes an equal share of a full-width strip, label always shown. */
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-1 p-1 clip-corner-lg bg-chrome",
        !fill && "overflow-x-auto sm:w-auto sm:shrink-0",
        className,
      )}
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = value === t.id;
        const fixed = fill || labels === "always";
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            aria-pressed={isActive}
            aria-label={t.label}
            className={cn(
              "flex items-center justify-center overflow-hidden py-1.5 text-sm clip-corner-lg touch:py-2.5",
              fill ? "min-w-0 flex-1 px-3" : "px-2 sm:flex-none sm:px-3",
              // Fixed labels: nothing resizes, so only the colors change.
              fixed ? "transition-colors" : "transition-all duration-200 ease-out motion-reduce:transition-none",
              !fill && fixed && "flex-none px-3",
              isActive
                ? cn("bg-primary font-medium text-primary-foreground", !fixed && "flex-1 sm:flex-none")
                : cn("text-muted-foreground hover:bg-foreground/5 hover:text-foreground", !fill && "flex-none"),
            )}
          >
            <Icon className={cn("size-4 shrink-0", iconClassName)} />
            {fixed ? (
              <span className={cn("whitespace-nowrap pl-1.5", fill && "truncate")}>{t.label}</span>
            ) : (
              <span
                className={cn(
                  "grid transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
                  isActive ? "grid-cols-[1fr]" : "grid-cols-[0fr] sm:grid-cols-[1fr]",
                )}
              >
                <span className="overflow-hidden whitespace-nowrap pl-1.5">{t.label}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
