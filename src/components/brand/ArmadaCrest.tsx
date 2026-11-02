import { useIntl } from "@/i18n";
import { APP_NAME } from "@/lib/platform";

/**
 * The Armada mark, animated as a one-shot ~1.1s draw. Path strings are shared
 * verbatim with `public/logo.svg`, `index.html`'s boot splash and
 * `android/.../drawable/crest_vector.xml` — keep them in sync.
 *
 * Every element's *static* state is its final resting state (keyframes supply
 * only the entrance), so `prefers-reduced-motion` lands on the finished mark.
 */

export const SAIL =
  "M64 4.225l-39.97 88.5h17.13l2.31-5.2 2.76-6.22-2.22-1.43-1.42-12.84h9.99l4.89-11.01L64 41.335l11.42 25.7h9.99l-1.43 12.84-2.22 1.43 2.77 6.22 2.31 5.2h17.13z";
export const CARET =
  "M76.84 79.165c-.15 0-.31-.05-.44-.15l-12.41-9.65-12.41 9.65c-.31.24-.76.19-1-.13a.706.706 0 0 1 .13-1l12.85-9.99c.26-.2.62-.2.88 0l12.85 9.99a.715.715 0 0 1-.43 1.28z";
export const WAVES = [
  "M95.4 104.865H32.59c-1.18 0-2.14-.96-2.14-2.14s.96-2.14 2.14-2.14H95.4c1.18 0 2.14.96 2.14 2.14s-.96 2.14-2.14 2.14z",
  "M83.98 115.565H44.01a1.43 1.43 0 1 1 0-2.86h39.97a1.43 1.43 0 1 1 0 2.86z",
  "M73.99 123.775H54.01a1.071 1.071 0 0 1 0-2.14h19.98a1.071 1.071 0 0 1 0 2.14z",
];

// Eases must appear as literals in the `animate-[…]` classes (Tailwind only
// generates what it sees): pen `cubic-bezier(0.65,0,0.35,1)`, sweep
// `cubic-bezier(0.22,1,0.36,1)`.

/**
 * One shape, drawn with three stacked copies: a *sheen* (static drop-shadow
 * whose opacity animates — animating `filter` repaints every frame), the
 * *fill*, and a stroke-only *trace* (`pathLength="1"` normalizes the dash).
 * Inline opacities are resting states; running CSS animations outrank them.
 */
function DrawnPath({
  d,
  fillRule,
  delay = 0,
}: {
  d: string;
  fillRule?: "evenodd" | "nonzero";
  delay?: number;
}) {
  return (
    <>
      <path
        d={d}
        fillRule={fillRule}
        fill="hsl(var(--primary))"
        className="animate-[armada-sheen_0.9s_ease-in-out_both]"
        style={{
          opacity: 0,
          filter: "drop-shadow(0 0 10px hsl(var(--primary) / 0.6))",
          animationDelay: `${delay + 0.64}s`,
        }}
      />
      <path
        d={d}
        fillRule={fillRule}
        fill="hsl(var(--primary))"
        className="animate-[armada-ink_0.42s_ease-out_both]"
        style={{ animationDelay: `${delay + 0.4}s` }}
      />
      <path
        d={d}
        fillRule={fillRule}
        pathLength={1}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-[armada-trace_0.78s_cubic-bezier(0.65,0,0.35,1)_both]"
        style={{ opacity: 0, strokeDasharray: 1, animationDelay: `${delay + 0.08}s` }}
      />
    </>
  );
}

/**
 * The three wave lines: an entrance sweep on the path and, with `loop`, an idle
 * scan on a wrapper `<g>` (separate elements so they don't fight over one
 * `transform`). Both `scaleX` about x=64; the scan starts and ends at scaleX(1).
 */
function Waves({ loop }: { loop: boolean }) {
  return (
    <g fill="hsl(var(--accent2, 180 90% 55%))">
      {WAVES.map((d, i) => (
        <g
          key={i}
          // Only when asked: SVG child transforms aren't composited, so this restyles
          // every frame while on screen.
          className={loop ? "animate-[armada-wake_6s_ease-in-out_infinite]" : undefined}
          // No fill mode, so the sweep owns the transform during the entrance.
          style={{ transformOrigin: "64px 0", animationDelay: `${0.9 + i * 0.6}s` }}
        >
          <path
            d={d}
            className="animate-[armada-sweep_0.52s_cubic-bezier(0.22,1,0.36,1)_both]"
            style={{ transformOrigin: "64px 0", animationDelay: `${i * 0.07}s` }}
          />
        </g>
      ))}
    </g>
  );
}

/**
 * The animated crest. Pair with {@link ArmadaCrestKeyframes} once per screen.
 */
export function ArmadaCrest({
  size = 132,
  className = "",
  loop = false,
}: {
  size?: number;
  className?: string;
  loop?: boolean;
}) {
  const intl = useIntl();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label={intl.formatMessage({ id: "armadaCrest.logo", defaultMessage: "{app} logo" }, { app: APP_NAME })}
      className={`relative drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      <Waves loop={loop} />
      <DrawnPath d={SAIL} />
      <path
        d={CARET}
        fill="hsl(var(--primary))"
        fillOpacity={0.85}
        className="animate-[armada-ink_0.32s_ease-out_0.86s_both]"
      />
    </svg>
  );
}

/**
 * Animated secret-key mark for onboarding's save-your-key step. Pair with
 * {@link ArmadaCrestKeyframes}.
 */
export function ArmadaKey({ size = 132, className = "" }: { size?: number; className?: string }) {
  const intl = useIntl();
  const bow = "M64 12 L88 34 L64 56 L40 34 Z M64 24 L52 34 L64 44 L76 34 Z";
  const shaft = "M58 52 H70 V64 H80 V72 H70 V80 H76 V88 H70 V92 H58 Z";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label={intl.formatMessage({ id: "armadaCrest.secretKey", defaultMessage: "Secret key" })}
      className={`relative drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      <Waves loop={false} />
      <g
        className="animate-[armada-key-turn_1.1s_ease-in-out_1.3s_both]"
        style={{ transformOrigin: "64px 34px" }}
      >
        <DrawnPath d={bow} fillRule="evenodd" />
        <DrawnPath d={shaft} delay={0.22} />
      </g>
    </svg>
  );
}

/** Animated identity mark for the profile step. Pair with {@link ArmadaCrestKeyframes}. */
export function ArmadaIdentity({ size = 132, className = "" }: { size?: number; className?: string }) {
  const intl = useIntl();
  const head = "M64 22 L80 38 L64 54 L48 38 Z";
  const shoulders = "M52 62 H76 L92 84 H36 Z";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label={intl.formatMessage({ id: "armadaCrest.profileIdentity", defaultMessage: "Profile identity" })}
      className={`relative drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      <Waves loop={false} />
      <DrawnPath d={head} />
      <DrawnPath d={shoulders} delay={0.22} />
    </svg>
  );
}

/**
 * Scoped keyframes for the crest + terminal (SVG-specific, so not in
 * tailwind.config). Honors `prefers-reduced-motion`. Render once per screen.
 */
export function ArmadaCrestKeyframes() {
  return (
    <style>{`
      /* A hairline pen traces the outline, then dissolves as the fill lands.
         \`pathLength="1"\` on the path makes the dash pattern normalized. */
      @keyframes armada-trace {
        0%   { opacity: 1; stroke-dashoffset: 1; }
        76%  { opacity: 1; stroke-dashoffset: 0; }
        100% { opacity: 0; stroke-dashoffset: 0; }
      }
      /* The fill floods in behind the trace. */
      @keyframes armada-ink {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      /* A single halo pass as the shape lands. Compositor-only — see the note
         on DrawnPath for why this isn't an animated \`filter\`. */
      @keyframes armada-sheen {
        0%, 100% { opacity: 0; }
        45%      { opacity: 1; }
      }
      /* A wave line sweeping open from the mark's centerline. Starts at a
         sliver rather than 0: a zero-scale matrix is degenerate and some
         renderers drop the paint outright. */
      @keyframes armada-sweep {
        from { opacity: 0; transform: scaleX(0.15); }
        to   { opacity: 1; transform: scaleX(1); }
      }
      /* The idle wake: each line scans slowly in and out. Begins and ends at
         the settled width so it joins the entrance seamlessly. Transform only,
         so it stays on the compositor. */
      @keyframes armada-wake {
        0%, 100% { transform: scaleX(1); }
        50%      { transform: scaleX(0.78); }
      }
      @keyframes armada-key-turn {
        0%   { transform: rotate(0deg); }
        45%  { transform: rotate(-14deg); }
        75%  { transform: rotate(6deg); }
        100% { transform: rotate(0deg); }
      }
      @keyframes armada-caret {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
      @keyframes armada-line-in {
        from { opacity: 0; transform: translateY(3px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-"] { animation: none !important; }
      }
      html[data-reduce-motion] [class*="animate-[armada-"] { animation: none !important; }
    `}</style>
  );
}
