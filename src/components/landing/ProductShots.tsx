import { useEffect, useRef } from "react";

import { FallbackImage } from "@/components/ui/FallbackImage";
import { useIntl } from "@/i18n";

import { captureMirrors, captureUrl } from "./captures";
import { reducedMotion } from "@/lib/reducedMotion";

/**
 * Display and phone showing real app captures (regenerate with
 * `e2e/landing-screenshots.spec.ts`). Each device is a flat element under its
 * own `perspective()`, with thickness as stacked layers: preserve-3d makes
 * Chrome raster at ~1x (blurry on 2x). Paint order stands in for depth sort.
 * Pointer lean is via custom properties, never React renders. Under `sm`
 * only the phone shows.
 */

/** Pointer offset from the stage's centre, -0.5..0.5 on each axis. */
const STAGE_STYLE = { "--px": "0", "--py": "0" } as React.CSSProperties;

interface Pose {
  /** Resting turn and tilt, degrees. */
  ry: number;
  rx: number;
  rz: number;
  /** Pointer push, degrees per unit of offset. */
  leanY: number;
  leanX: number;
  /** Viewing distance, px. Wide panels need more, or back layers shrink in enough to hide the edge. */
  perspective: number;
  /** Body thickness in px, and how many layers draw it. */
  depth: number;
  layers: number;
}

const DISPLAY: Pose = { ry: 16, rx: 4, rz: 0, leanY: 10, leanX: 6, perspective: 3200, depth: 30, layers: 15 };
const PHONE: Pose = { ry: -24, rx: 6, rz: 3, leanY: 18, leanX: 10, perspective: 1600, depth: 26, layers: 13 };

function transformAt(p: Pose, z: number): string {
  return (
    `perspective(${p.perspective}px) rotateY(calc(${p.ry}deg + var(--px) * ${p.leanY}deg)) ` +
    `rotateX(calc(${p.rx}deg - var(--py) * ${p.leanX}deg)) rotateZ(${p.rz}deg) translateZ(${-z}px)`
  );
}

/** Body layers back to front, progressively lighter; built once per device at load. */
function bodyLayers(p: Pose, radius: number): React.CSSProperties[] {
  return Array.from({ length: p.layers }, (_, i) => {
    const t = i / (p.layers - 1); // 0 = back, 1 = just behind the screen
    return {
      transform: transformAt(p, p.depth * (1 - t)),
      borderRadius: radius,
      background: `hsl(262 10% ${14 + t * 24}%)`,
    };
  });
}

const DISPLAY_RADIUS = 12;
const PHONE_RADIUS = 30;
const DISPLAY_BODY = bodyLayers(DISPLAY, DISPLAY_RADIUS);
const PHONE_BODY = bodyLayers(PHONE, PHONE_RADIUS);
const DISPLAY_FACE = { transform: transformAt(DISPLAY, 0), borderRadius: DISPLAY_RADIUS } as React.CSSProperties;
const PHONE_FACE = { transform: transformAt(PHONE, 0), borderRadius: PHONE_RADIUS } as React.CSSProperties;

const MOVES = "transition-transform duration-700 ease-out motion-reduce:transition-none";

function Body({ layers }: { layers: React.CSSProperties[] }) {
  return (
    <>
      {layers.map((style, i) => (
        <div key={i} aria-hidden="true" className={`absolute inset-0 ${MOVES}`} style={style} />
      ))}
    </>
  );
}

/** Crossfading capture; only the current one and its neighbours are mounted. */
function Screen({
  slugs,
  index,
  size,
  ratio,
  className,
  alt,
}: {
  slugs: readonly string[];
  index: number;
  size: "desktop" | "mobile";
  ratio: string;
  className: string;
  alt: string;
}) {
  const n = slugs.length;
  return (
    <div className={`relative w-full overflow-hidden ${ratio} ${className}`}>
      {slugs.map((slug, i) => {
        const offset = (i - index + n) % n;
        if (offset !== 0 && offset !== 1 && offset !== n - 1) return null;
        return (
          <FallbackImage
            key={slug}
            src={captureUrl(slug, size)}
            fallbacks={captureMirrors(slug, size)}
            loading="lazy"
            decoding="async"
            alt={offset === 0 ? alt : ""}
            aria-hidden={offset !== 0}
            className={`absolute inset-0 size-full transition-opacity duration-500 ease-out motion-reduce:transition-none ${
              offset === 0 ? "opacity-100" : "opacity-0"
            }`}
          />
        );
      })}
    </div>
  );
}

export function ProductShots({
  slugs,
  index,
  label,
}: {
  /** Capture slugs, as keyed in `captures.ts`. */
  slugs: readonly string[];
  index: number;
  label: string;
}) {
  const intl = useIntl();
  const stageRef = useRef<HTMLDivElement>(null);

  // Touch and reduced motion keep resting poses.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (reducedMotion()) return;

    let rect: DOMRect | undefined;
    let x = 0;
    let y = 0;
    let raf = 0;

    const apply = () => {
      raf = 0;
      stage.style.setProperty("--px", x.toFixed(3));
      stage.style.setProperty("--py", y.toFixed(3));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    // Measure once per visit, not per move, to avoid forced reflows.
    const onEnter = () => {
      rect = stage.getBoundingClientRect();
    };
    const onMove = (e: PointerEvent) => {
      rect ??= stage.getBoundingClientRect();
      x = Math.max(-0.5, Math.min(0.5, (e.clientX - rect.left) / rect.width - 0.5));
      y = Math.max(-0.5, Math.min(0.5, (e.clientY - rect.top) / rect.height - 0.5));
      schedule();
    };
    const onLeave = () => {
      rect = undefined;
      x = 0;
      y = 0;
      schedule();
    };

    stage.addEventListener("pointerenter", onEnter);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", onLeave);
    return () => {
      stage.removeEventListener("pointerenter", onEnter);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={stageRef} style={STAGE_STYLE} className="relative flex w-full items-center justify-center py-10">
      <div className="relative hidden w-[74%] sm:block">
        <Body layers={DISPLAY_BODY} />
        <div
          style={DISPLAY_FACE}
          className={`relative border border-[hsl(var(--primary)/0.35)] bg-[#08060b] p-[0.9%] ${MOVES}`}
        >
          <Screen
            slugs={slugs}
            index={index}
            size="desktop"
            ratio="aspect-[2400/1520]"
            className="rounded-[6px]"
            alt={intl.formatMessage({ id: "productShots.desktopAlt", defaultMessage: "Armada on desktop: {label}" }, { label })}
          />
        </div>
      </div>

      {/* After the display, so it paints over the display's edge. */}
      <div className="relative w-60 shrink-0 sm:-ml-[5%] sm:mt-[12%] sm:w-[21%]">
        <Body layers={PHONE_BODY} />
        <div
          style={PHONE_FACE}
          className={`relative border border-[hsl(var(--accent2)/0.35)] bg-[#08060b] p-[3.5%] ${MOVES}`}
        >
          <Screen
            slugs={slugs}
            index={index}
            size="mobile"
            ratio="aspect-[1170/2532]"
            className="rounded-[24px]"
            alt={intl.formatMessage({ id: "productShots.phoneAlt", defaultMessage: "Armada on a phone: {label}" }, { label })}
          />
        </div>
      </div>
    </div>
  );
}
