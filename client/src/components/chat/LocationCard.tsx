import { MapPin } from "lucide-react";
import { useState } from "react";

import { LocationMapDialog } from "@/components/chat/LocationMapDialog";
import { formatCoords } from "@/lib/location";
import { cn } from "@/lib/utils";

import type { GeoPoint } from "@/lib/location";

interface LocationCardProps {
  point: GeoPoint;
  className?: string;
}

/**
 * Lightweight in-timeline card for a shared location. Deliberately renders NO
 * map (a live MapLibre instance per bubble would exhaust the browser's WebGL
 * context budget and hit the network for every message); it's a tappable card
 * showing a pin glyph + coordinates. Tapping opens the fullscreen
 * {@link LocationMapDialog}, which loads the one interactive map on demand.
 *
 * Works identically across every transport (groups, DMs, Concord, mesh) since
 * it derives only from a parsed {@link GeoPoint}.
 */
export function LocationCard({ point, className }: LocationCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "mt-1 flex items-center gap-3 w-full max-w-xs rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-left transition-colors hover:bg-secondary/70",
          className,
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <MapPin className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Shared location</span>
          <span className="block text-xs text-muted-foreground tabular-nums truncate">
            {formatCoords(point)}
            {point.accuracy != null && ` · ±${Math.round(point.accuracy)}m`}
          </span>
        </span>
        <span className="shrink-0 text-xs font-medium text-primary">View map</span>
      </button>

      {open && <LocationMapDialog point={point} onClose={() => setOpen(false)} />}
    </>
  );
}
