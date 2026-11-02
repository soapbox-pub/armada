import { useEffect, useRef, type RefObject } from "react";
import { reducedMotion } from "@/lib/reducedMotion";

/**
 * The landing page's ASCII sea background. Two registered layers share one
 * grid: cyan swell (`--accent2`) and rose crests (`--primary`). Perspective
 * runs top (chop) to bottom (swell). Rows are built once per resize; only
 * `textContent` changes, at {@link FPS}.
 */

/** Trough to crest. The doubled low entries bias the sea toward calm water. */
const SWELL_RAMP = "  ..,,--~~";
const CREST_GLYPH = "≈";
/** Normalized wave height above which a cell becomes a crest. */
const CREST_THRESHOLD = 0.88;
/** Deliberately not 60: a terminal doesn't animate smoothly. */
const FPS = 14;
/** Scroll distance, in viewports, over which `depth` runs 0 → 1. */
const DEPTH_SPAN = 1;
const SEA_FADE_START = 0;
const SEA_FADE_END = 0.5;
/** Resting waterline, % down the viewport. */
const TEASER_STOP = 72;
/** Horizon feather height, %. Must leave a solid band below `TEASER_STOP + HORIZON_FEATHER` in the splash. */
const HORIZON_FEATHER = 18;
/** Wave-phase units a full descent travels. */
const PHASE_TRAVEL = 2.5;

export function AsciiSea({
  scrollRef,
  className = "",
}: {
  /** Read imperatively in the animation frame, never via state. */
  scrollRef?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = reducedMotion();

    const swellLayer = document.createElement("div");
    const crestLayer = document.createElement("div");
    for (const layer of [swellLayer, crestLayer]) {
      layer.style.cssText = "position:absolute;inset:0;";
      host.appendChild(layer);
    }

    // Measure the cell box in the sea's own font; re-measured if metrics change.
    const probe = document.createElement("div");
    probe.textContent = "0";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;top:0;left:0;";
    host.appendChild(probe);

    let swellRows: HTMLDivElement[] = [];
    let crestRows: HTMLDivElement[] = [];
    let cols = 0;
    let rowCount = 0;

    const build = () => {
      const cell = probe.getBoundingClientRect();
      const cw = cell.width || 8;
      const chh = cell.height || 14;
      const next = Math.max(8, Math.ceil(host.clientWidth / cw) + 2);
      const nextRows = Math.max(4, Math.ceil(host.clientHeight / chh));
      if (next === cols && nextRows === rowCount) return;
      cols = next;
      rowCount = nextRows;

      swellLayer.replaceChildren();
      crestLayer.replaceChildren();
      swellRows = [];
      crestRows = [];
      for (let y = 0; y < rowCount; y++) {
        const near = y / Math.max(rowCount - 1, 1);
        // Empty rows must keep their line height, or the painted band collapses
        // upward under the mask. `1em` is the line box (host is `leading-none`).
        const swell = document.createElement("div");
        swell.style.height = "1em";
        swell.style.color = `hsl(var(--accent2) / ${(0.07 + 0.3 * near).toFixed(3)})`;
        swellLayer.appendChild(swell);
        swellRows.push(swell);
        const crest = document.createElement("div");
        crest.style.height = "1em";
        crest.style.color = `hsl(var(--primary) / ${(0.05 + 0.4 * near).toFixed(3)})`;
        crestLayer.appendChild(crest);
        crestRows.push(crest);
      }
    };

    const depthNow = () => {
      const scroller = scrollRef?.current;
      if (!scroller?.clientHeight) return 0;
      return Math.min(1, Math.max(0, scroller.scrollTop / (scroller.clientHeight * DEPTH_SPAN)));
    };

    /** 0 behind the splash, 1 once the hero clears; smoothstepped. */
    const revealAt = (depth: number) => {
      const t = Math.min(
        1,
        Math.max(0, (depth - SEA_FADE_START) / (SEA_FADE_END - SEA_FADE_START)),
      );
      return t * t * (3 - 2 * t);
    };

    /** First row the mask shows; rows above are skipped (a few rows of margin hide the feather). */
    const firstVisibleRow = (reveal: number) =>
      Math.max(0, Math.floor(((TEASER_STOP * (1 - reveal)) / 100) * rowCount) - 3);

    const paint = (phase: number, from = 0) => {
      for (let y = Math.min(from, rowCount); y < rowCount; y++) {
        const near = y / Math.max(rowCount - 1, 1);
        const amp = 0.32 + 0.68 * near;
        const freq = 0.3 - 0.2 * near;
        let swell = "";
        let crest = "";
        for (let x = 0; x < cols; x++) {
          // Three incommensurate sines so the surface never repeats; `y` terms shear rows into one surface.
          const h =
            Math.sin(x * freq + phase * 0.9 + y * 0.55) +
            0.6 * Math.sin(x * freq * 2.3 - phase * 1.35 + y * 0.29) +
            0.4 * Math.sin(x * freq * 0.45 + phase * 0.5 - y * 0.17);
          // h ∈ [-2, 2] → n ∈ [0, 1].
          const n = 0.5 + (h / 2) * amp * 0.5;
          if (n > CREST_THRESHOLD) {
            crest += CREST_GLYPH;
            swell += " ";
          } else {
            crest += " ";
            swell += SWELL_RAMP[Math.round(n * (SWELL_RAMP.length - 1))];
          }
        }
        swellRows[y].textContent = swell;
        crestRows[y].textContent = crest;
      }
    };

    /** Raise or lower the waterline via the mask (not opacity), so the visible band renders at full strength. */
    const applyVeil = (reveal: number) => {
      const top = TEASER_STOP * (1 - reveal);
      const mask = `linear-gradient(to bottom, transparent ${top.toFixed(1)}%, black ${(
        top + HORIZON_FEATHER
      ).toFixed(1)}%)`;
      // Both spellings: unprefixed `mask-image` isn't in every typing, and WebKit wants the prefix.
      host.style.setProperty("mask-image", mask);
      host.style.setProperty("-webkit-mask-image", mask);
    };


    let released = false;
    const remeasure = () => {
      if (released) return;
      build();
      if (reduced) paint(0);
    };

    const observer = new ResizeObserver(remeasure);
    observer.observe(host);
    build();

    // A webfont swapping in changes glyph width without resizing the host, so
    // ResizeObserver won't fire; re-measure after fonts settle.
    document.fonts?.ready.then(remeasure).catch(() => {});

    if (reduced) {
      // Reduced motion: paint once; the scroll-driven waterline only rewrites the mask.
      paint(0);
      const scroller = scrollRef?.current;
      const onScroll = () => {
        applyVeil(revealAt(depthNow()));
      };
      onScroll();
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        released = true;
        scroller?.removeEventListener("scroll", onScroll);
        observer.disconnect();
        host.replaceChildren();
      };
    }

    // Per-layer compositor layers: otherwise redraws re-raster through the host's
    // mask (~2.5× cost). Only while animating, to save memory.
    for (const layer of [swellLayer, crestLayer]) layer.style.willChange = "transform";

    // Timer at the paint cadence, not a free-running rAF loop, which would wake
    // the renderer 60×/s. Each tick still paints in a rAF.
    const frame = 1000 / FPS;
    const start = performance.now();
    let lastTick = start;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let veilRaf = 0;
    let lastReveal = -1;
    let phaseDepth = depthNow();

    const veil = () => {
      const reveal = revealAt(depthNow());
      if (reveal === lastReveal) return;
      lastReveal = reveal;
      applyVeil(reveal);
    };

    const tick = (now: number) => {
      raf = 0;
      // Ease the phase toward scroll depth so a wheel flick doesn't jump more than a wavelength.
      const depth = depthNow();
      phaseDepth += (depth - phaseDepth) * (1 - Math.pow(0.94, (now - lastTick) / (1000 / 60)));
      lastTick = now;
      veil();
      paint((now - start) / 1000 + phaseDepth * PHASE_TRAVEL, firstVisibleRow(revealAt(depth)));
      schedule();
    };

    const schedule = () => {
      if (released || timer !== undefined || raf) return;
      if (document.hidden || offscreen) return;
      timer = setTimeout(() => {
        timer = undefined;
        raf = requestAnimationFrame(tick);
      }, frame);
    };

    // Waterline tracks scroll every frame; stepping at paint cadence stair-steps.
    const scroller = scrollRef?.current;
    const onScroll = () => {
      if (veilRaf) return;
      veilRaf = requestAnimationFrame(() => {
        veilRaf = 0;
        veil();
      });
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);
    // Scrolled out of view: stop painting a sea nobody sees.
    let offscreen = false;
    const io = new IntersectionObserver(([entry]) => {
      offscreen = !entry.isIntersecting;
      schedule();
    });
    io.observe(host);

    veil();
    raf = requestAnimationFrame(tick);

    return () => {
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(veilRaf);
      scroller?.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      io.disconnect();
      observer.disconnect();
      host.replaceChildren();
    };
  }, [scrollRef]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      // Resting mask baked in so the first paint shows the teaser band; the effect overrides it inline.
      style={{
        maskImage: `linear-gradient(to bottom, transparent ${TEASER_STOP}%, black ${
          TEASER_STOP + HORIZON_FEATHER
        }%)`,
        // Not `strict`: size containment would break sizing from `inset-0`.
        contain: "layout paint",
      }}
      className={`pointer-events-none absolute inset-0 select-none overflow-hidden font-mono text-[0.8125rem] leading-none [white-space:pre] ${className}`}
    />
  );
}
