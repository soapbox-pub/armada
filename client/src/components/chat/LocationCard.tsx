import { MapPin } from "lucide-react";
import { useState } from "react";

import { CompassNavigationDialog } from "@/components/chat/CompassNavigationDialog";
import { LocationMapDialog } from "@/components/chat/LocationMapDialog";
import { formatCoords } from "@/lib/location";
import { cn } from "@/lib/utils";

import type { GeoPoint } from "@/lib/location";

interface LocationCardProps {
  point: GeoPoint;
  className?: string;
}

/** Which fullscreen viewer (if any) is open for this shared location. */
type View = "none" | "map" | "compass";

/**
 * Lightweight in-timeline card for a shared location. Deliberately renders NO
 * map (a live MapLibre instance per bubble would exhaust the browser's WebGL
 * context budget and hit the network for every message); it's a tappable card
 * showing a pin glyph + coordinates. Tapping opens the fullscreen
 * {@link LocationMapDialog}, which loads the one interactive map on demand; from
 * there "Navigate" swaps to the fullscreen {@link CompassNavigationDialog}
 * (offline GPS + magnetometer). Only one viewer is mounted at a time.
 *
 * Works identically across every transport (groups, DMs, Concord, mesh) since
 * it derives only from a parsed {@link GeoPoint}.
 */
export function LocationCard({ point, className }: LocationCardProps) {
  const [view, setView] = useState<View>("none");

  return (
    <>
      <button
        type="button"
        onClick={() => setView("map")}
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

      {view === "map" && (
        <LocationMapDialog
          point={point}
          onClose={() => setView("none")}
          onNavigate={() => setView("compass")}
        />
      )}
      {view === "compass" && (
        <CompassNavigationDialog
          target={point}
          onClose={() => setView("none")}
          onOpenMap={() => setView("map")}
        />
      )}
    </>
  );
}
