import { memo, useEffect, useRef, useState } from "react";

import { FallbackImage } from "@/components/ui/FallbackImage";
import { useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import { captureMirrors, captureUrl, useCaptureSize, type CaptureSize } from "./captures";
import { reducedMotion } from "@/lib/reducedMotion";

/**
 * The pitch's screens: a slowly turning prism, one CRT per face, which powers
 * on as it comes round and reports the front face. Drag spins it, tap nudges
 * it (both move a spring target). Faces are flat elements with per-frame
 * `perspective()` transforms written directly (not React, not preserve-3d —
 * see ProductShots). The loop runs only on screen in a visible tab.
 */

export interface Channel {
  slug: string;
  word: string;
  label: string;
}

const SCANLINES = {
  backgroundImage: "repeating-linear-gradient(to bottom, rgba(0,0,0,0.32) 0 1px, transparent 1px 3px)",
} as React.CSSProperties;
const VIGNETTE = {
  backgroundImage: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.6) 100%)",
} as React.CSSProperties;

const CASING =
  "rounded-[18px] bg-[#0c0a10] p-2 shadow-[0_30px_50px_-30px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.07] sm:p-3";
const GLASS = "relative overflow-hidden rounded-[10px] aspect-[1170/2532] sm:aspect-[2400/1520]";

/** Spring rate per second. */
const EASE = 1.3;
const SPIN_S = 7;
/** Gap between faces, as a share of face width. */
const SPREAD = 0.1;
/** Set thickness as a share of width, drawn by stacked flat layers (see `ProductShots`). */
const DEPTH = 0.035;
const LAYERS = 10;
const LAYER_SHADE = Array.from({ length: LAYERS }, (_, j) => {
  const t = j / (LAYERS - 1); // 0 = back, 1 = just behind the screen
  return { background: `hsl(262 10% ${5 + t * 9}%)` } as React.CSSProperties;
});

function wrap(x: number, n: number) {
  return ((((x + n / 2) % n) + n) % n) - n / 2;
}

function powerOn(screen: Element | null) {
  if (!screen || reducedMotion()) return;
  const picture = screen.querySelector<HTMLElement>("[data-picture]");
  const red = screen.querySelector<HTMLElement>("[data-gun=red]");
  const cyan = screen.querySelector<HTMLElement>("[data-gun=cyan]");
  const tear = screen.querySelector<HTMLElement>("[data-tear]");
  picture?.animate(
    [
      { filter: "brightness(0.5) saturate(0.4)" },
      { filter: "brightness(1.25) saturate(1.2)", offset: 0.45 },
      { filter: "brightness(1) saturate(1)" },
    ],
    { duration: 1600, easing: "ease-in-out" },
  );
  const gun = (el: HTMLElement | null, dir: number) =>
    el?.animate(
      [
        { opacity: 0.45, transform: `translateX(${dir * 4}px)` },
        { opacity: 0 , transform: "translateX(0)" },
      ],
      { duration: 1400, easing: "ease-out" },
    );
  gun(red, -1);
  gun(cyan, 1);
  tear?.animate(
    [
      { opacity: 0.5, clipPath: "inset(46% 0 48% 0)", transform: "translateX(-6px)" },
      { opacity: 0, clipPath: "inset(46% 0 48% 0)", transform: "translateX(0)" },
    ],
    { duration: 600, delay: 300, easing: "ease-out", fill: "backwards" },
  );
}

/** Memoized: each face draws it four times and the prism re-renders per face change. */
const Capture = memo(function Capture({ slug, size, alt }: { slug: string; size: CaptureSize; alt: string }) {
  return (
    <FallbackImage
      src={captureUrl(slug, size)}
      fallbacks={captureMirrors(slug, size)}
      loading="lazy"
      decoding="async"
      draggable={false}
      alt={alt}
      className="block size-full"
    />
  );
});

export const TvDrum = memo(function TvDrum({
  channels,
  step,
  onTune,
  onFront,
}: {
  channels: readonly Channel[];
  step: number;
  onTune: (delta: number) => void;
  /** Must be stable. */
  onFront: (index: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const facesRef = useRef<(HTMLDivElement | null)[]>([]);
  const bodiesRef = useRef<(HTMLDivElement | null)[][]>([]);
  // Read by the frame loop, which outlives any one render.
  const targetRef = useRef(0);
  const onFrontRef = useRef(onFront);
  useEffect(() => {
    onFrontRef.current = onFront;
  });
  const prevStepRef = useRef(step);
  useEffect(() => {
    const delta = step - prevStepRef.current;
    prevStepRef.current = step;
    if (delta) targetRef.current = Math.round(targetRef.current) + delta;
  }, [step]);

  const n = channels.length;
  const [current, setCurrent] = useState(0);
  const size = useCaptureSize();
  const intl = useIntl();

  useEffect(() => {
    const root = rootRef.current;
    const spacer = spacerRef.current;
    if (!root || !spacer) return;
    const reduced = reducedMotion();
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const faceDeg = 360 / n;

    let width = spacer.offsetWidth || 600;
    let pos = targetRef.current;
    let hovered = false;
    let lean = { x: 0, y: 0 };
    let leanTarget = { x: 0, y: 0 };
    let frontShown = -1;
    let seen = false;
    let visible = false;
    let raf = 0;
    let last = performance.now();
    const start = last;

    let dragX: number | undefined;
    let dragFrom = 0;
    let moved = false;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (dragX === undefined && !hovered && !reduced && seen) targetRef.current += dt / SPIN_S;
      const k = reduced ? 1 : 1 - Math.exp(-dt * EASE);
      pos += (targetRef.current - pos) * k;
      const kl = reduced ? 1 : 1 - Math.exp(-dt * 1.6);
      lean = { x: lean.x + (leanTarget.x - lean.x) * kl, y: lean.y + (leanTarget.y - lean.y) * kl };
      const t = reduced ? 0 : (now - start) / 1000;

      // Distance from axis so neighbouring faces meet at their edges.
      const apothem = (width / 2 + width * SPREAD) / Math.tan(Math.PI / n);
      const depth = width * DEPTH;
      const persp = width * 2.8;
      const bob = Math.sin(t * 0.5) * 6;
      const tilt = -3 - lean.y * 8;

      facesRef.current.forEach((el, i) => {
        if (!el) return;
        const r = wrap(i - pos, n);
        const a = Math.abs(r);
        const ry = r * faceDeg + lean.x * 8;
        const pose =
          `perspective(${persp.toFixed(0)}px) translateY(${bob.toFixed(1)}px) ` +
          `translateZ(${(-apothem).toFixed(1)}px) rotateX(${tilt.toFixed(2)}deg) ` +
          `rotateY(${ry.toFixed(2)}deg) translateZ(${apothem.toFixed(1)}px)`;
        const z = (100 - Math.round(a * 10)) * 2;
        const shown = a < 1.6 ? "visible" : "hidden";
        el.style.visibility = shown;
        // Faces round the back are invisible: skip their writes.
        if (a >= 1.6) {
          bodiesRef.current[i]?.forEach((layer) => layer && (layer.style.visibility = shown));
          return;
        }
        el.style.transform = pose;
        el.style.zIndex = String(z);
        bodiesRef.current[i]?.forEach((layer, j) => {
          if (!layer) return;
          layer.style.transform = `${pose} translateZ(${(-depth * (1 - j / (LAYERS - 1)) - 1).toFixed(1)}px)`;
          layer.style.zIndex = String(z - 1);
          layer.style.visibility = shown;
        });
        if (a > 0.5) el.dataset.dim = "";
        else delete el.dataset.dim;
      });

      const front = ((Math.round(pos) % n) + n) % n;
      if (front !== frontShown) {
        frontShown = front;
        setCurrent(front);
        onFrontRef.current(front);
        if (seen) powerOn(facesRef.current[front]);
      }
    };

    const loop = (now: number) => {
      raf = 0;
      frame(now);
      if (visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const run = () => {
      if (!raf && visible && !document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };

    frame(last);

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        root.dataset.live = String(visible);
        if (visible && !seen) {
          seen = true;
          powerOn(facesRef.current[frontShown]);
        }
        run();
      },
      { threshold: 0.2 },
    );
    io.observe(root);
    const ro = new ResizeObserver(() => {
      width = spacer.offsetWidth || width;
      frame(performance.now());
    });
    ro.observe(spacer);
    const onVisibility = () => run();
    document.addEventListener("visibilitychange", onVisibility);

    const onMove = (e: PointerEvent) => {
      if (dragX !== undefined) {
        const dx = e.clientX - dragX;
        if (Math.abs(dx) > 6) moved = true;
        targetRef.current = dragFrom - dx / (width * 0.9);
        return;
      }
      hovered = true;
      if (!fine || reduced) return;
      const rect = root.getBoundingClientRect();
      leanTarget = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
    };
    const onLeave = () => {
      hovered = false;
      leanTarget = { x: 0, y: 0 };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragX = e.clientX;
      dragFrom = targetRef.current;
      moved = false;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragX = undefined;
      if (!moved) return;
      targetRef.current = Math.round(targetRef.current);
    };
    // A drag ending over a neighbour must not count as a tap.
    const onClick = (e: MouseEvent) => {
      if (!moved) return;
      moved = false;
      e.stopPropagation();
      e.preventDefault();
    };

    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("click", onClick, true);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("click", onClick, true);
      onUp();
    };
  }, [n]);

  return (
    <div
      ref={rootRef}
      data-live="false"
      className="group/drum relative -mx-6 w-[calc(100%+3rem)] cursor-grab touch-pan-y select-none overflow-x-clip py-10 active:cursor-grabbing"
    >
      <div ref={spacerRef} aria-hidden="true" className={cn(CASING, "invisible mx-auto w-[240px] sm:w-[540px] lg:w-[680px]")}>
        <div className={GLASS} />
      </div>

      {channels.map((channel, i) => {
        const front = i === current;
        const rel = Math.round(wrap(i - current, n));
        return [
          ...LAYER_SHADE.map((shade, j) => (
            <div
              key={`${channel.slug}-body-${j}`}
              aria-hidden="true"
              ref={(el) => {
                (bodiesRef.current[i] ??= [])[j] = el;
              }}
              className="pointer-events-none absolute left-1/2 top-10 ml-[-120px] w-[240px] rounded-[18px] p-2 sm:ml-[-270px] sm:w-[540px] sm:p-3 lg:ml-[-340px] lg:w-[680px]"
              style={shade}
            >
              <div className={GLASS} />
            </div>
          )),
          <div
            key={channel.slug}
            ref={(el) => {
              facesRef.current[i] = el;
            }}
            className="group/face absolute left-1/2 top-10 ml-[-120px] w-[240px] [backface-visibility:hidden] sm:ml-[-270px] sm:w-[540px] lg:ml-[-340px] lg:w-[680px]"
          >
            <button
              type="button"
              tabIndex={front ? -1 : 0}
              disabled={front}
              onClick={() => onTune(rel)}
              aria-label={
                front
                  ? undefined
                  : intl.formatMessage({ id: "tvDrum.tuneTo", defaultMessage: "Tune to the {word}" }, { word: channel.word })
              }
              className={cn(CASING, "block w-full text-left disabled:cursor-[inherit] focus-visible:outline-none focus-visible:ring-ring")}
            >
              <div
                className={cn(
                  GLASS,
                  "bg-black transition-[filter] duration-1000 group-data-[dim]/face:brightness-[0.4] group-data-[dim]/face:saturate-[0.35]",
                )}
              >
                <div data-picture="" className="absolute inset-0 origin-center">
                  <Capture slug={channel.slug} size={size} alt={
                    front
                      ? intl.formatMessage({ id: "tvDrum.captureAlt", defaultMessage: "Armada: {label}" }, { label: channel.label })
                      : ""
                  } />
                </div>

                <div data-gun="red" aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-0 mix-blend-screen">
                  <div className="absolute inset-0 isolate">
                    <Capture slug={channel.slug} size={size} alt="" />
                    <div className="absolute inset-0 bg-[#ff2bd6] mix-blend-multiply" />
                  </div>
                </div>
                <div data-gun="cyan" aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-0 mix-blend-screen">
                  <div className="absolute inset-0 isolate">
                    <Capture slug={channel.slug} size={size} alt="" />
                    <div className="absolute inset-0 bg-[#2bf5ff] mix-blend-multiply" />
                  </div>
                </div>
                <div data-tear="" aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-0">
                  <Capture slug={channel.slug} size={size} alt="" />
                </div>

                <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-70" style={SCANLINES} />
                <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={VIGNETTE} />

                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 transition-opacity duration-1000 group-data-[dim]/face:opacity-100"
                >
                  <div className="absolute inset-x-0 top-0 h-1/4 animate-[armada-crt-roll_6s_linear_infinite] bg-gradient-to-b from-transparent via-white/[0.07] to-transparent [animation-play-state:paused] group-data-[live=true]/drum:[animation-play-state:running] motion-reduce:animate-none" />
                </div>
              </div>
            </button>
          </div>,
        ];
      })}

      <style>{`
        @keyframes armada-crt-roll {
          from { transform: translateY(-100%); }
          to   { transform: translateY(400%); }
        }
      `}</style>
    </div>
  );
});
