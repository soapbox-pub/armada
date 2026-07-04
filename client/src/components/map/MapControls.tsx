import type { LucideIcon } from "lucide-react";

import type { UseMapTheme } from "@/hooks/useMapTheme";
import { cn } from "@/lib/utils";

/**
 * Visual variant for a floating map control:
 *  - "overlay" — white-on-black glass, for the viewer's photographic map;
 *  - "panel"   — themed secondary chrome, for the downloader's app-surface UI.
 */
export type MapControlVariant = "overlay" | "panel";

const VARIANT_CLASSES: Record<MapControlVariant, string> = {
  overlay:
    "bg-black/60 text-white/80 hover:text-white hover:bg-white/10",
  panel:
    "bg-secondary/70 text-muted-foreground hover:text-foreground disabled:opacity-40",
};

interface MapControlButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: MapControlVariant;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/**
 * A floating, circular icon button used by the fullscreen map surfaces (close,
 * look toggle, locate). Shared so the three near-identical button trios in the
 * viewer and downloader don't drift.
 */
export function MapControlButton({
  icon: Icon,
  label,
  onClick,
  variant = "overlay",
  disabled,
  title,
  className,
}: MapControlButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pointer-events-auto rounded-full p-2 backdrop-blur transition-colors",
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      <Icon className="size-6" />
    </button>
  );
}

interface MapThemeToggleProps {
  /** The map-look state from {@link useMapTheme}. */
  mapTheme: UseMapTheme;
  variant?: MapControlVariant;
  disabled?: boolean;
  className?: string;
}

/**
 * The look toggle (sparkle → sun → moon) that both map surfaces render under
 * their close button. Wraps {@link MapControlButton} with the current look's
 * icon + label.
 */
export function MapThemeToggle({ mapTheme, variant, disabled, className }: MapThemeToggleProps) {
  return (
    <MapControlButton
      icon={mapTheme.Icon}
      label={`Map look: ${mapTheme.label} (tap to change)`}
      title={mapTheme.label}
      onClick={mapTheme.cycleTheme}
      variant={variant}
      disabled={disabled}
      className={className}
    />
  );
}
