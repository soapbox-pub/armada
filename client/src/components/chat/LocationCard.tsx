import { Map as MapIcon, MapPin, Navigation } from "lucide-react";
import { useMemo, useState } from "react";

import { CompassNavigationDialog } from "@/components/chat/CompassNavigationDialog";
import { LocationMapDialog } from "@/components/chat/LocationMapDialog";
import { useGeoWatch } from "@/hooks/useGeoWatch";
import { formatCoords, formatDistance, haversine } from "@/lib/location";
import { cn } from "@/lib/utils";

import type { GeoPoint } from "@/lib/location";

interface LocationCardProps {
  point: GeoPoint;
  className?: string;
}

/** Which fullscreen viewer (if any) is open for this shared location. */
type View = "none" | "map" | "compass";

/** Viewbox of the mini-map preview, in abstract units. */
const PREVIEW_W = 320;
const PREVIEW_H = 128;
/** Inset (units) so pins/beacon glyphs never touch the preview edge. */
const PREVIEW_PAD = 30;
/**
 * Minimum world window (meters) the preview may zoom into. Without this, two
 * points a few meters apart get blown up to opposite corners of the box, which
 * reads as "far away" — worse than useless when GPS accuracy is ±20m. Below
 * this window the dots simply sit close together / overlap, which is honest.
 */
const MIN_SPAN_M = 60;

/** A point projected into the preview's pixel-ish coordinate space. */
interface Projected {
  x: number;
  y: number;
}

/**
 * Project the target (and your position, if known) into the preview box.
 *
 * A tiles-free "relative map": we take the local tangent plane around the
 * midpoint and use an equirectangular projection (east metres ∝ Δlon·cos(lat),
 * north metres ∝ Δlat), then scale+center so both points fit the box with
 * padding. Because the two axes share one metres-per-unit scale, the on-screen
 * geometry (distance and bearing between the dots) is true — it's a real,
 * correctly-proportioned little map, just without any basemap. With only the
 * target known we simply center it.
 */
function projectPreview(
  target: GeoPoint,
  you: GeoPoint | null,
): { target: Projected; you: Projected | null } {
  const center = { x: PREVIEW_W / 2, y: PREVIEW_H / 2 };
  if (!you) return { target: center, you: null };

  const toRad = (d: number) => (d * Math.PI) / 180;
  // Metres east/north of the target for a given point (target is the origin).
  const cosLat = Math.cos(toRad(target.lat));
  const EARTH = 6_371_000;
  const metres = (p: GeoPoint) => ({
    east: toRad(p.lon - target.lon) * cosLat * EARTH,
    north: toRad(p.lat - target.lat) * EARTH,
  });
  const t = metres(target); // {0, 0}
  const y = metres(you);

  const minE = Math.min(t.east, y.east);
  const maxE = Math.max(t.east, y.east);
  const minN = Math.min(t.north, y.north);
  const maxN = Math.max(t.north, y.north);

  const spanE = maxE - minE || 1;
  const spanN = maxN - minN || 1;
  // One shared scale keeps proportions honest; fit the larger span, but never
  // zoom in past MIN_SPAN_M (see above) so near-coincident points don't get
  // stretched to opposite corners.
  const maxScale = Math.min(PREVIEW_W - PREVIEW_PAD * 2, PREVIEW_H - PREVIEW_PAD * 2) / MIN_SPAN_M;
  const scale = Math.min(
    (PREVIEW_W - PREVIEW_PAD * 2) / spanE,
    (PREVIEW_H - PREVIEW_PAD * 2) / spanN,
    maxScale,
  );

  const midE = (minE + maxE) / 2;
  const midN = (minN + maxN) / 2;
  // +east → +x, +north → −y (screen y grows downward).
  const place = (m: { east: number; north: number }): Projected => ({
    x: PREVIEW_W / 2 + (m.east - midE) * scale,
    y: PREVIEW_H / 2 - (m.north - midN) * scale,
  });

  return { target: place(t), you: place(y) };
}

/**
 * In-timeline card for a shared location. Deliberately renders NO basemap
 * (mesh/offline must draw without network, and one WebGL map per bubble would
 * exhaust the browser's context budget). Instead the preview is a tiles-free
 * *relative* mini-map computed with plain trigonometry: the shared pin and — if
 * a GPS fix is available — your live position are projected into a small box at
 * a shared, distortion-corrected scale, joined by a dashed line, with the true
 * distance shown. Tapping "View Map" opens the on-demand {@link
 * LocationMapDialog}; "Navigate" opens the offline GPS + magnetometer {@link
 * CompassNavigationDialog}. Only one viewer is mounted at a time.
 *
 * Works identically across every transport (groups, DMs, Concord, mesh) since
 * it derives only from a parsed {@link GeoPoint}.
 */
export function LocationCard({ point, className }: LocationCardProps) {
  const [view, setView] = useState<View>("none");
  // Live position only feeds the preview; the fullscreen viewers watch too.
  const { position } = useGeoWatch(true);

  const projected = useMemo(() => projectPreview(point, position), [point, position]);
  const distance = useMemo(
    () => (position ? haversine(position, point) : null),
    [position, point],
  );

  return (
    <>
      <div
        className={cn(
          "mt-1 w-full max-w-sm overflow-hidden rounded-xl border border-border bg-secondary/35 text-left shadow-sm",
          className,
        )}
      >
        <div className="relative h-32 overflow-hidden border-b border-border/70 bg-background/45">
          {/* Faint coordinate grid backdrop. */}
          <div
            className="absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                "linear-gradient(to right, hsl(var(--primary) / 0.12) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--primary) / 0.12) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />

          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {projected.you && (
              <line
                x1={projected.you.x}
                y1={projected.you.y}
                x2={projected.target.x}
                y2={projected.target.y}
                stroke="hsl(var(--primary) / 0.65)"
                strokeWidth={2}
                strokeDasharray="5 5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {/* Shared destination pin (tip anchored on the exact point). */}
          <div
            className="absolute -translate-x-1/2 -translate-y-full text-primary drop-shadow-[0_0_10px_hsl(var(--primary)/0.5)]"
            style={{
              left: `${(projected.target.x / PREVIEW_W) * 100}%`,
              top: `${(projected.target.y / PREVIEW_H) * 100}%`,
            }}
          >
            <MapPin className="size-6" fill="hsl(var(--primary) / 0.25)" />
          </div>

          {/* Live "you are here" beacon — the same element the fullscreen map
              uses for its marker — only once a fix lands. */}
          {projected.you && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${(projected.you.x / PREVIEW_W) * 100}%`,
                top: `${(projected.you.y / PREVIEW_H) * 100}%`,
              }}
            >
              <div className="map-beacon" />
            </div>
          )}
        </div>

        <div className="space-y-3 px-3 py-3">
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-foreground">Shared location</span>
              {distance != null && (
                <span className="shrink-0 text-xs font-medium text-primary tabular-nums">
                  {formatDistance(distance)} away
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs tabular-nums text-muted-foreground">
              {formatCoords(point)}
              {point.accuracy != null && ` · ±${Math.round(point.accuracy)}m`}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background/45 px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary/70"
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
