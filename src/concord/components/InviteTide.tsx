import { useEffect, useRef } from "react";
import { reducedMotion } from "@/lib/reducedMotion";

/**
 * Invite backdrop: a radial sonar sweep in text, sibling of {@link AsciiSea}.
 * Swell uses the community's hue (djb2), crests `--accent2`. Masked to fill
 * the space below the content.
 */

/** Trough to crest. The doubled low entries bias the field toward calm. */
const SWELL_RAMP = "  ..::--~~";
const CREST_GLYPH = "*";
const CREST_THRESHOLD = 0.9;
/** Deliberately not 60 — a terminal doesn't animate smoothly. */
const FPS = 12;

export function InviteTide({ hue, className = "" }: { hue: number; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = reducedMotion();

    // Two registered layers; a cell belongs to one, never both.
    const swellLayer = document.createElement("div");
    const crestLayer = document.createElement("div");
    for (const layer of [swellLayer, crestLayer]) {
      layer.style.cssText = "position:absolute;inset:0;";
      host.appendChild(layer);
    }

    // Measure the cell in the field's own font; the aspect keeps rings round.
    const probe = document.createElement("div");
    probe.textContent = "0";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;top:0;left:0;";
    host.appendChild(probe);

    let swellRows: HTMLDivElement[] = [];
    let crestRows: HTMLDivElement[] = [];
    let cols = 0;
    let rowCount = 0;
    let aspect = 0.6;

    const build = () => {
      const cell = probe.getBoundingClientRect();
      const cw = cell.width || 8;
      const chh = cell.height || 14;
      // Cells are taller than wide; scale x by aspect so rings are circular.
      aspect = cw / chh;
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
        const swell = document.createElement("div");
        swell.style.color = `hsl(${hue} 70% 62% / ${(0.05 + 0.24 * near).toFixed(3)})`;
        swellLayer.appendChild(swell);
        swellRows.push(swell);
        const crest = document.createElement("div");
        crest.style.color = `hsl(var(--accent2) / ${(0.04 + 0.3 * near).toFixed(3)})`;
        crestLayer.appendChild(crest);
        crestRows.push(crest);
      }
    };

    const paint = (t: number) => {
      const cx = cols / 2;
      for (let y = 0; y < rowCount; y++) {
        const near = y / Math.max(rowCount - 1, 1);
        const amp = 0.35 + 0.65 * near;
        let swell = "";
        let crest = "";
        for (let x = 0; x < cols; x++) {
          const dx = (x - cx) * aspect;
          const d = Math.sqrt(dx * dx + y * y);
          // A lateral drift keeps it from resolving into a plain bullseye.
          const h =
            Math.sin(d * 0.42 - t * 1.5) +
            0.55 * Math.sin(d * 0.16 + t * 0.6) +
            0.4 * Math.sin(x * 0.09 + t * 0.35 + y * 0.12);
          // h ∈ [-1.95, 1.95] → n ∈ [0, 1].
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

    let released = false;
    const remeasure = () => {
      if (released) return;
      build();
      if (reduced) paint(0);
    };

    const observer = new ResizeObserver(remeasure);
    observer.observe(host);
    build();

    // A webfont swap changes advance width without resizing the host, so re-measure after fonts settle.
    document.fonts?.ready.then(remeasure).catch(() => {});

    if (reduced) {
      // Reduced motion: one frame, drawn once.
      paint(0);
      return () => {
        released = true;
        observer.disconnect();
        host.replaceChildren();
      };
    }

    const frame = 1000 / FPS;
    const start = performance.now();
    let last = 0;
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < frame) return;
      last = now;
      paint((now - start) / 1000);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      released = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      host.replaceChildren();
    };
  }, [hue]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        maskImage: "linear-gradient(to bottom, transparent 30%, black 70%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 30%, black 70%)",
        // Contain repaints: every frame rewrites ~80 text nodes.
        contain: "layout paint",
      }}
      className={`pointer-events-none absolute inset-0 select-none overflow-hidden font-mono text-[0.8125rem] leading-none [white-space:pre] ${className}`}
    />
  );
}

export default InviteTide;
