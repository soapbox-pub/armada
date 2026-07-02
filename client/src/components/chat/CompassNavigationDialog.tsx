import { Map as MapIcon, Navigation, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";

import { CompassFace } from "@/components/chat/CompassFace";
import { useGeoWatch } from "@/hooks/useGeoWatch";
import { useHeading } from "@/hooks/useHeading";
import { bearing, cardinalDirection, formatCoords, formatDistance, haversine } from "@/lib/location";

import type { GeoPoint } from "@/lib/location";

interface CompassNavigationDialogProps {
  /** The destination to navigate to. */
  target: GeoPoint;
  /** Close the compass and return to the chat. */
  onClose: () => void;
  /** Close the compass and open the map centered on the target. */
  onOpenMap: () => void;
}

/** Distance (m) under which we consider you "arrived". */
const ARRIVAL_RADIUS = 15;

/** Format a GPS accuracy radius (meters) for the "± Xm" readout. */
function formatTolerance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Fullscreen offline navigation compass, rendered over a portal (like the map).
 * A north-up dial with an arrow pointing at the shared location, a big distance
 * + cardinal readout, and a GPS-accuracy line. Uses device GPS
 * ({@link useGeoWatch}) + magnetometer ({@link useHeading}); no map tiles or
 * network required. Adopts the app theme via CSS variables.
 *
 * Top-right X returns to the chat; top-left map icon swaps to the fullscreen
 * map centered on the target.
 */
export function CompassNavigationDialog({ target, onClose, onOpenMap }: CompassNavigationDialogProps) {
  const { position, accuracy, error } = useGeoWatch(true);
  const { heading, requestPermission } = useHeading();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // iOS requires a user gesture to grant orientation access; ask on mount (a
  // no-op elsewhere). Also retried by the tap-to-enable hint below.
  useEffect(() => {
    requestPermission();
  }, [requestPermission]);

  const { distance, bearingDeg, arrow, arrived, hasFix } = useMemo(() => {
    if (!position) {
      return { distance: 0, bearingDeg: 0, arrow: 0, arrived: false, hasFix: false };
    }
    const d = haversine(position, target);
    const b = bearing(position, target);
    const a = heading == null ? b : (b - heading + 360) % 360;
    return { distance: d, bearingDeg: b, arrow: a, arrived: d <= ARRIVAL_RADIUS, hasFix: true };
  }, [position, target, heading]);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-background text-foreground"
      role="dialog"
      aria-modal="true"
      onClick={requestPermission}
    >
      {/* Top bar: map icon (left) + close (right). */}
      <div className="absolute top-safe-4 inset-x-4 z-10 flex items-start justify-between">
        <button
          type="button"
          aria-label="View on map"
          className="p-2 rounded-full bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          onClick={onOpenMap}
        >
          <MapIcon className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Close navigation"
          className="p-2 rounded-full bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          onClick={onClose}
        >
          <X className="size-6" />
        </button>
      </div>

      <div className="mx-auto flex h-full w-full max-w-lg flex-col p-4 pt-safe">
        {/* Header: destination coords. */}
        <div className="pt-14 text-center">
          <div className="text-sm uppercase tracking-widest text-muted-foreground">Going to</div>
          <div className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
            {formatCoords(target)}
          </div>
        </div>

        {/* The dial — dominant element. */}
        <div className="flex flex-1 items-center justify-center py-4">
          <div className="relative aspect-square w-full max-w-[20rem]">
            <CompassFace className="absolute inset-0 size-full" />
            <div
              className="absolute left-1/2 top-1/2 flex aspect-square w-[58%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border"
              style={{
                background: "hsl(var(--primary) / 0.08)",
                borderColor: "hsl(var(--primary) / 0.26)",
              }}
            >
              <Navigation
                className="size-[38%] transition-transform duration-300 ease-out"
                strokeWidth={1.75}
                style={{
                  color: "hsl(var(--primary))",
                  transform: `rotate(${arrow}deg)`,
                  filter: "drop-shadow(0 0 18px hsl(var(--primary) / 0.6))",
                }}
                fill="hsl(var(--primary))"
                fillOpacity={0.2}
              />
            </div>
          </div>
        </div>

        {/* Readout. */}
        {error ? (
          <div className="pb-8 text-center text-sm text-destructive">{error}</div>
        ) : !hasFix ? (
          <div className="pb-8 text-center font-mono text-sm uppercase tracking-widest text-muted-foreground">
            Waiting for GPS fix…
          </div>
        ) : arrived ? (
          <div className="pb-8 text-center">
            <div className="text-3xl font-bold text-primary">You're here</div>
          </div>
        ) : (
          <div className="pb-8 text-center">
            <div className="flex items-baseline justify-center gap-3">
              <span className="text-5xl font-black tabular-nums">{formatDistance(distance)}</span>
              <span className="text-5xl font-black text-primary">{cardinalDirection(bearingDeg)}</span>
            </div>
            <div className="mt-2 font-mono text-xs uppercase tracking-widest text-muted-foreground/60">
              {accuracy != null ? `GPS ± ${formatTolerance(accuracy)}` : "GPS accuracy unknown"}
              {heading == null && " · point device flat to enable compass"}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
