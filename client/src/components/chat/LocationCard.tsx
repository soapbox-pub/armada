import { Map as MapIcon, MapPin, Navigation } from "lucide-react";
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
 * In-timeline card for a shared location.
 *
 * **No network / no sensors on render.** Mesh/offline must draw without tiles
 * (and one WebGL map per bubble would exhaust the browser's context budget),
 * and merely rendering a received message must never touch
 * `navigator.geolocation`. So the card is fully static: a tiles-free grid
 * backdrop with the shared pin, the coordinates, and two actions. The
 * fullscreen viewers do use sensors/tiles, but only while open — an explicit
 * user action.
 *
 * "View Map" opens the on-demand {@link LocationMapDialog}; "Navigate" opens
 * the offline GPS + magnetometer {@link CompassNavigationDialog}. Only one
 * viewer is mounted at a time. Works identically across every transport
 * (groups, DMs, Concord, mesh) since it derives only from a parsed
 * {@link GeoPoint}.
 */
export function LocationCard({ point, className }: LocationCardProps) {
  const [view, setView] = useState<View>("none");

  return (
    <>
      <div
        className={cn(
          "relative mt-1 w-full max-w-sm overflow-hidden rounded-xl border border-border bg-secondary/35 text-left shadow-sm",
          className,
        )}
      >
        {/* Faint coordinate grid backdrop, filling the whole card. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "linear-gradient(to right, hsl(var(--primary) / 0.12) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--primary) / 0.12) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />

        <div className="relative">
          <div className="flex h-20 items-center justify-center">
            {/* Shared destination pin (tip anchored at the box centre). */}
            <MapPin
              className="size-10 text-primary drop-shadow-[0_0_5px_hsl(var(--primary)/0.35)]"
              fill="hsl(var(--primary) / 0.25)"
            />
          </div>

          <div className="space-y-3 px-3 py-3">
            <div className="min-w-0">
              <span className="text-sm font-semibold text-foreground">Shared location</span>
              <div className="mt-0.5 truncate font-mono text-xs tabular-nums text-muted-foreground">
                {formatCoords(point)}
                {point.accuracy != null && ` · ±${Math.round(point.accuracy)}m`}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background/45 px-3 text-sm font-medium text-foreground backdrop-blur-sm transition-colors hover:bg-secondary/70"
                onClick={() => setView("map")}
              >
                <MapIcon className="size-4" />
                View Map
              </button>
              <button
                type="button"
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                onClick={() => setView("compass")}
              >
                <Navigation className="size-4" />
                Navigate
              </button>
            </div>
          </div>
        </div>
      </div>

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
