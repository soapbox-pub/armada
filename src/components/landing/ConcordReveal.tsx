import { useEffect, useRef } from "react";

import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";
import { reducedMotion } from "@/lib/reducedMotion";

/** The quiz's off-ramp: the Concord grid (concordprotocol.org) glows up behind one line and a spec link. */

const MINT = "#24e8a3";

/** Grid lines under a radial glow; radii come from `--glow`, set per breakpoint. */
const GRID = {
  backgroundImage: `radial-gradient(var(--glow) at 50% 50%, ${MINT}40, ${MINT}10 55%, transparent 80%)`,
  maskImage: "linear-gradient(90deg, #000 1px, transparent 1px), linear-gradient(#000 1px, transparent 1px)",
  maskSize: "56px 56px",
  WebkitMaskImage: "linear-gradient(90deg, #000 1px, transparent 1px), linear-gradient(#000 1px, transparent 1px)",
  WebkitMaskSize: "56px 56px",
} as React.CSSProperties;

export function ConcordGrid({ shown }: { shown: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 transition-opacity [transition-duration:2000ms] [--glow:100%_62%] sm:[--glow:60%_50%]",
        shown ? "opacity-100 delay-700" : "opacity-0",
      )}
      style={GRID}
    />
  );
}

/**
 * The Concord mark as ASCII, one layer per stroke, sampled from its geometry
 * (128-unit box) at load. Cells draw in angular order with jitter.
 */
const MARK = (() => {
  const COLS = 40;
  // A monospace cell is about 0.6 as wide as it is tall at `leading-none`.
  const ROWS = Math.round(COLS * 0.6);
  const RAMP = " .:+#";
  const SUB = 4;
  const deg = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI;
  const strokes = [
    (x: number, y: number) => Math.abs(Math.hypot(x, y) - 27.3) <= 6.25,
    // Long arc, open between -56° and 56.5°.
    (x: number, y: number) => {
      const a = deg(x, y);
      return Math.abs(Math.hypot(x, y) - 49) <= 6 && (a <= -56 || a >= 56.5);
    },
    (x: number, y: number) => {
      const a = deg(x, y);
      return Math.abs(Math.hypot(x, y) - 49) <= 6 && a >= -43.5 && a <= 43.5;
    },
  ];
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return strokes.map((hit, layer) => {
    const glyphs: string[] = [];
    const order: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let n = 0;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const x = ((c + (sx + 0.5) / SUB) / COLS) * 128 - 64;
            const y = ((r + (sy + 0.5) / SUB) / ROWS) * 128 - 64;
            if (hit(x, y)) n++;
          }
        }
        const x = ((c + 0.5) / COLS) * 128 - 64;
        const y = ((r + 0.5) / ROWS) * 128 - 64;
        const turn = (((deg(x, y) + 90) % 360) + 360) % 360 / 360;
        glyphs.push(RAMP[Math.round((n / (SUB * SUB)) * (RAMP.length - 1))]);
        order.push(turn * 0.8 + layer * 0.08 + rnd() * 0.08);
      }
      glyphs.push("\n");
      order.push(-1);
    }
    return { glyphs, order, text: glyphs.join("") };
  });
})();

const MARK_COLORS = ["#5AFDB2", "#1DA57A", "#FFFFFF"];
const PEN = "@#%&$";
const DRAW_MS = 1700;
const DRAW_TICK = 40;

/** Drawn in when `shown`, writing text directly (not state); reduced motion gets it whole. */
export function ConcordMark({ shown }: { shown: boolean }) {
  const intl = useIntl();
  const layersRef = useRef<(HTMLPreElement | null)[]>([]);

  useEffect(() => {
    const layers = layersRef.current;
    if (!shown) return;
    const whole = () => MARK.forEach((m, i) => layers[i] && (layers[i]!.textContent = m.text));
    if (reducedMotion()) {
      whole();
      return;
    }
    const start = performance.now();
    const draw = () => {
      const t = (performance.now() - start - 500) / DRAW_MS;
      MARK.forEach((m, i) => {
        const el = layers[i];
        if (!el) return;
        let out = "";
        for (let k = 0; k < m.glyphs.length; k++) {
          const g = m.glyphs[k];
          const o = m.order[k];
          if (o < 0 || g === " ") out += g;
          else if (o > t) out += " ";
          else if (o > t - 0.06) out += PEN[(Math.random() * PEN.length) | 0];
          else out += g;
        }
        el.textContent = out;
      });
    };
    let id: ReturnType<typeof setInterval> | undefined;
    const wait = setTimeout(() => {
      draw();
      id = setInterval(() => {
        if (performance.now() - start - 500 > DRAW_MS + 200) {
          whole();
          clearInterval(id);
          return;
        }
        draw();
      }, DRAW_TICK);
    }, 500);
    return () => {
      clearTimeout(wait);
      if (id) clearInterval(id);
    };
  }, [shown]);

  return (
    <div
      role="img"
      aria-label={intl.formatMessage({ id: "concordReveal.markLabel", defaultMessage: "The Concord protocol mark" })}
      className="grid select-none font-mono text-[6px] leading-none sm:text-[8px]"
    >
      {MARK.map((_, i) => (
        <pre
          key={i}
          aria-hidden="true"
          ref={(el) => {
            layersRef.current[i] = el;
          }}
          className="m-0 [grid-area:1/1]"
          style={{ color: MARK_COLORS[i] }}
        >
          {MARK[i].glyphs.map((g) => (g === "\n" ? g : " ")).join("")}
        </pre>
      ))}
    </div>
  );
}

export function ConcordReveal({ shown }: { shown: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-4 transition-opacity duration-1000",
        shown ? "opacity-100 [transition-delay:1300ms]" : "opacity-0",
      )}
    >
      <p className="max-w-md text-pretty text-xs leading-relaxed text-muted-foreground sm:text-sm">
        <FormattedMessage
          id="concordReveal.body"
          defaultMessage="Messages are locked on your device with keys only your community holds. The servers only see noise."
        />
      </p>
      <a
        href="https://concordprotocol.org/"
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs tracking-wide text-[hsl(var(--accent2,180_90%_55%))] underline decoration-[hsl(var(--accent2)/0.3)] underline-offset-4 transition-colors hover:decoration-current sm:text-sm"
      >
        <FormattedMessage id="concordReveal.specLink" defaultMessage="how: the Concord protocol →" />
      </a>
    </div>
  );
}
