import { useId, type CSSProperties } from "react";

import { CARET, SAIL, WAVES } from "./ArmadaCrest";

/**
 * The Armada mark struck from the heavens: the sky gathers, a bolt comes down
 * a pillar of light, and the sail is blown into shards that rain onto a
 * burning sea. One-shot, then the wreck smoulders under the light.
 *
 * Every element's *static* style is its final resting state (keyframes supply
 * the sequence), so `prefers-reduced-motion` lands on the wreck. Render inside
 * an element carrying {@link WRECK_SCOPE} with {@link ArmadaWreckKeyframes}.
 */

export const WRECK_SCOPE = "armada-wreck";

/** Seconds from mount to the strike. */
export const WRECK_IMPACT = 1;
/** Seconds the rays take to gather; they then hold until the strike. */
const GATHER = 1.1;
/** Seconds from mount until the debris has settled. */
export const WRECK_SETTLED = WRECK_IMPACT + 1.9;

const BLAST = { x: 64, y: 40 };
const GOLD = "#ffd76a";
const WHITE = "#fffbe8";
const FIRE = "#ff8a3d";

/** Deterministic noise, so the wreck is the same every visit. */
function rand(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function anim(name: string, dur: number, delay: number, ease = "ease-out", tail = "both"): string {
  return `${name} ${dur}s ${ease} ${delay.toFixed(3)}s ${tail}`;
}

type Shard = { points: string; style: CSSProperties };

/**
 * A jittered triangulation of the sail's bounding box. Each triangle is clipped
 * to the sail where it is drawn, so together they are exactly the mark.
 */
function buildShards(): Shard[] {
  const cols = [22, 43, 64, 85, 106];
  const rows = [2, 20.6, 39.2, 57.8, 76.4, 95];
  const pt = (r: number, c: number): [number, number] => {
    const inner = r > 0 && r < rows.length - 1 && c > 0 && c < cols.length - 1;
    const k = r * 7 + c;
    return [
      cols[c] + (inner ? (rand(k) - 0.5) * 14 : 0),
      rows[r] + (inner ? (rand(k + 50) - 0.5) * 12 : 0),
    ];
  };

  const tris: [number, number][][] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) {
      const a = pt(r, c), b = pt(r, c + 1), d = pt(r + 1, c), e = pt(r + 1, c + 1);
      if ((r + c) % 2) tris.push([a, b, e], [a, e, d]);
      else tris.push([a, b, d], [b, e, d]);
    }
  }

  return tris.map((tri, i) => {
    const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    const vx = cx - BLAST.x, vy = cy - BLAST.y;
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len, uy = vy / len;

    const reach = 18 + 26 * rand(i + 100);
    const px = ux * reach;
    const py = uy * reach - 10 * rand(i + 200);
    const pr = (rand(i + 300) - 0.5) * 260;

    let dx: number, dy: number, rot: number;
    let fade = 1;
    if (rand(i + 900) < 0.2) {
      // Smithereens: flung clear and burnt away.
      dx = ux * 150;
      dy = uy * 150 + 40;
      rot = pr * 3;
      fade = 0;
    } else {
      const lx = Math.min(158, Math.max(-30, 64 + (cx - 64) * 2.2 + (rand(i + 400) - 0.5) * 50));
      const ly = 96 + rand(i + 500) * 20;
      dx = lx - cx;
      dy = ly - cy;
      rot = pr * 1.6 + (rand(i + 700) - 0.5) * 90;
    }

    const rest = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(0)}deg)`;
    return {
      points: tri.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "),
      style: {
        "--px": `${px.toFixed(1)}px`,
        "--py": `${py.toFixed(1)}px`,
        "--pr": `${pr.toFixed(0)}deg`,
        "--dx": `${dx.toFixed(1)}px`,
        "--dy": `${dy.toFixed(1)}px`,
        "--rot": `${rot.toFixed(0)}deg`,
        "--fade": fade,
        opacity: fade,
        transform: rest,
        transformBox: "fill-box",
        transformOrigin: "center",
        animation: anim("armada-wreck-shard", 1.9, WRECK_IMPACT + rand(i + 600) * 0.06, "linear"),
      } as CSSProperties,
    };
  });
}

const SHARDS = buildShards();

const SPARKS = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2 + (rand(i + 1000) - 0.5) * 0.3;
  const l = 40 + 35 * rand(i + 1100);
  return {
    x2: BLAST.x + Math.cos(a) * l,
    y2: BLAST.y + Math.sin(a) * l,
    color: i % 3 ? GOLD : WHITE,
    dur: 0.55 + 0.35 * rand(i + 1200),
  };
});

const EMBERS = Array.from({ length: 10 }, (_, i) => ({
  x: 30 + 68 * rand(i + 1300),
  y: 100 + 8 * rand(i + 1400),
  rise: 30 + 30 * rand(i + 1500),
  dur: 2.2 + rand(i + 1600),
  delay: WRECK_IMPACT + 0.5 + 2.5 * rand(i + 1700),
}));

const SMOKE = [46, 58, 70, 82].map((x, i) => ({ x, delay: WRECK_IMPACT + 0.4 + i * 1.1 }));

/** Where the light comes from: far above the scene, so it reaches down from the top of the page. */
const HEAVEN = -480;

/** Shafts of light fanning down from above, symmetric so their box's top centre is the source. */
const RAYS = [-34, -20, -9, 9, 20, 34].map((spread) => {
  const w = 5 + Math.abs(spread) / 8;
  return `64,${HEAVEN} ${64 + spread * 2.4 - w},112 ${64 + spread * 2.4 + w},112`;
});

/** The bolt: a jagged stroke from the top of the sky to the heart of the sail. */
const BOLT_STEPS = 16;
const BOLT_POINTS = Array.from({ length: BOLT_STEPS + 1 }, (_, i) => {
  const t = i / BOLT_STEPS;
  const jag = i === 0 || i === BOLT_STEPS ? 0 : (rand(i + 1800) - 0.5) * 44 * (1 - t * 0.6);
  return [BLAST.x + jag, HEAVEN + (BLAST.y - HEAVEN) * t] as const;
});
const BOLT = "M" + BOLT_POINTS.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L");
const FORK_FROM = BOLT_POINTS[12];
const BOLT_FORK = `M${FORK_FROM[0].toFixed(1)} ${FORK_FROM[1].toFixed(1)} l-12 14 l4 9 l-8 12`;

export function ArmadaWreck({ className = "" }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const sailClip = `wreck-sail-${uid}`;
  const leftClip = `wreck-left-${uid}`;
  const rightClip = `wreck-right-${uid}`;
  const pillarGrad = `wreck-pillar-${uid}`;
  const rayGrad = `wreck-ray-${uid}`;
  const flashGrad = `wreck-flash-${uid}`;
  const fireGrad = `wreck-fire-${uid}`;
  const smokeGrad = `wreck-smoke-${uid}`;
  const blur = `wreck-blur-${uid}`;

  const strike = (dur: number, extra = 0) => anim("armada-wreck-bolt", dur, WRECK_IMPACT - 0.14 + extra, "linear");

  return (
    <svg viewBox="-40 -72 208 200" fill="none" aria-hidden="true" overflow="visible" className={className}>
      <defs>
        <clipPath id={sailClip}>
          <path d={SAIL} />
        </clipPath>
        <clipPath id={leftClip}>
          <rect x={-40} y={0} width={104} height={128} />
        </clipPath>
        <clipPath id={rightClip}>
          <rect x={64} y={0} width={104} height={128} />
        </clipPath>
        <linearGradient id={pillarGrad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={WHITE} stopOpacity={0.95} />
          <stop offset="0.55" stopColor={GOLD} stopOpacity={0.55} />
          <stop offset="1" stopColor={GOLD} stopOpacity={0} />
        </linearGradient>
        <linearGradient id={rayGrad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={GOLD} stopOpacity={0.5} />
          <stop offset="1" stopColor={GOLD} stopOpacity={0} />
        </linearGradient>
        <radialGradient id={flashGrad}>
          <stop offset="0" stopColor={WHITE} />
          <stop offset="0.4" stopColor={GOLD} />
          <stop offset="1" stopColor={FIRE} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={fireGrad}>
          <stop offset="0" stopColor={FIRE} stopOpacity={0.7} />
          <stop offset="1" stopColor={FIRE} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={smokeGrad}>
          <stop offset="0" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.5} />
          <stop offset="1" stopColor="hsl(var(--muted-foreground))" stopOpacity={0} />
        </radialGradient>
        <filter id={blur} x="-50%" y="-5%" width="200%" height="110%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>

      {/* The heavens open: rays gather over the sail before the strike. */}
      <g
        style={{
          opacity: 0.6,
          transformBox: "fill-box",
          transformOrigin: "50% 0%",
          animation: [
            anim("armada-wreck-rays", GATHER, 0, "ease-out"),
            anim("armada-wreck-sway", 9, WRECK_IMPACT + 0.6, "ease-in-out", "infinite"),
          ].join(", "),
        }}
      >
        {RAYS.map((points, i) => (
          <polygon key={i} points={points} fill={`url(#${rayGrad})`} />
        ))}
      </g>

      {/* The pillar of light the bolt rides down, lingering over the wreck. */}
      <polygon
        points={`58,${HEAVEN} 70,${HEAVEN} 92,112 36,112`}
        fill={`url(#${pillarGrad})`}
        filter={`url(#${blur})`}
        style={{
          opacity: 0.3,
          animation: [
            anim("armada-wreck-pillar", 1.6, WRECK_IMPACT - 0.2),
            anim("armada-wreck-breathe", 4, WRECK_IMPACT + 1.4, "ease-in-out", "infinite"),
          ].join(", "),
        }}
      />

      <ellipse
        cx={64}
        cy={104}
        rx={44}
        ry={10}
        fill={`url(#${fireGrad})`}
        style={{
          opacity: 0.7,
          animation: [
            anim("armada-wreck-glow", 0.6, WRECK_IMPACT),
            anim("armada-wreck-flicker", 1.7, WRECK_IMPACT + 0.6, "ease-in-out", "infinite"),
          ].join(", "),
        }}
      />

      {/* The sea, split by the blast. Clipped in the halves' own space so they part. */}
      <g fill="hsl(var(--accent2, 180 90% 55%))">
        {[
          { clip: leftClip, dx: -7 },
          { clip: rightClip, dx: 7 },
        ].map(({ clip, dx }) => (
          <g
            key={clip}
            style={{
              "--split": `${dx}px`,
              transform: `translateX(${dx}px)`,
              animation: anim("armada-wreck-split", 0.9, WRECK_IMPACT, "cubic-bezier(0.22,1,0.36,1)"),
            } as CSSProperties}
          >
            {WAVES.map((d, i) => (
              <path key={i} d={d} clipPath={`url(#${clip})`} />
            ))}
          </g>
        ))}
      </g>

      {SMOKE.map(({ x, delay }) => (
        <circle
          key={x}
          cx={x}
          cy={96}
          r={7}
          fill={`url(#${smokeGrad})`}
          style={{
            opacity: 0,
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: anim("armada-wreck-smoke", 4.4, delay, "ease-out", "infinite"),
          }}
        />
      ))}

      {/* The ship, whole, until the strike. Shards over it share its colour, so their seams never show. */}
      <g
        fill="hsl(var(--primary))"
        style={{
          opacity: 0,
          animation: [
            anim("armada-wreck-vanish", WRECK_IMPACT, 0, "linear"),
            anim("armada-wreck-tremble", 0.5, WRECK_IMPACT - 0.5, "linear"),
          ].join(", "),
        }}
      >
        <path d={SAIL} />
        <path d={CARET} fillOpacity={0.85} />
      </g>

      {/* Three drift groups bob the debris on the water at different phases. */}
      <g fill="hsl(var(--primary))">
        {[0, 1, 2].map((group) => (
          <g
            key={group}
            style={{
              animation: anim(
                "armada-wreck-drift",
                3.2 + group * 0.6,
                WRECK_SETTLED + group * 0.4,
                "ease-in-out",
                "infinite",
              ),
            }}
          >
            {SHARDS.filter((_, i) => i % 3 === group).map((shard, i) => (
              <g key={i} style={shard.style}>
                <polygon points={shard.points} clipPath={`url(#${sailClip})`} />
              </g>
            ))}
          </g>
        ))}
        <path
          d={CARET}
          fillOpacity={0.85}
          style={{
            opacity: 0,
            transform: "translateY(26px)",
            animation: anim("armada-wreck-sink", 1.6, WRECK_IMPACT, "ease-in"),
          }}
        />
      </g>

      {/* The bolt: a wide halo stroke and a white-hot core, drawn top-down then flickering out. */}
      {[
        { width: 7, color: GOLD, opacity: 0.55 },
        { width: 2, color: WHITE, opacity: 1 },
      ].map(({ width, color, opacity }) => (
        <g
          key={width}
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={opacity}
        >
          <path d={BOLT} pathLength={1} style={{ opacity: 0, strokeDasharray: "1 2", animation: strike(0.6) }} />
          <path
            d={BOLT_FORK}
            pathLength={1}
            strokeWidth={width * 0.6}
            style={{ opacity: 0, strokeDasharray: "1 2", animation: strike(0.6, 0.06) }}
          />
        </g>
      ))}

      <circle
        cx={BLAST.x}
        cy={BLAST.y}
        r={12}
        fill={`url(#${flashGrad})`}
        style={{
          opacity: 0,
          transformBox: "fill-box",
          transformOrigin: "center",
          animation: anim("armada-wreck-flash", 0.8, WRECK_IMPACT),
        }}
      />

      {[
        { color: WHITE, delay: 0 },
        { color: GOLD, delay: 0.12 },
      ].map(({ color, delay }) => (
        <circle
          key={color}
          cx={BLAST.x}
          cy={BLAST.y}
          r={10}
          stroke={color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: 0,
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: anim("armada-wreck-ring", 1, WRECK_IMPACT + delay, "cubic-bezier(0.22,1,0.36,1)", "forwards"),
          }}
        />
      ))}

      <g strokeWidth={1.3} strokeLinecap="round">
        {SPARKS.map((s, i) => (
          <line
            key={i}
            x1={BLAST.x}
            y1={BLAST.y}
            x2={s.x2}
            y2={s.y2}
            stroke={s.color}
            pathLength={1}
            style={{
              opacity: 0,
              strokeDasharray: "0.14 2",
              animation: anim("armada-wreck-spark", s.dur, WRECK_IMPACT, "cubic-bezier(0.1,0.8,0.3,1)"),
            }}
          />
        ))}
      </g>

      {EMBERS.map((e, i) => (
        <circle
          key={i}
          cx={e.x}
          cy={e.y}
          r={0.9}
          fill={i % 2 ? GOLD : FIRE}
          style={{
            "--rise": `${-e.rise}px`,
            opacity: 0,
            animation: anim("armada-wreck-ember", e.dur, e.delay, "ease-out", "infinite"),
          } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/**
 * Full-bleed light for the page around the wreck: the sky darkening before
 * the strike, its flash, and the glow from above that stays. Place inside a
 * `relative` container.
 */
export function WreckSky() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 bg-black"
        style={{ opacity: 0, animation: anim("armada-wreck-dusk", DUSK_DUR, 0, "linear") }}
      />
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(255,215,106,0.16),transparent_65%)]"
        style={{ animation: anim("armada-wreck-glow", 1.6, WRECK_IMPACT) }}
      />
      <div
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(255,251,232,0.9),rgba(255,215,106,0.35)_40%,transparent_75%)]"
        style={{ opacity: 0, animation: anim("armada-wreck-whiteout", 1.3, WRECK_IMPACT) }}
      />
    </div>
  );
}

const DUSK_DUR = WRECK_IMPACT + 1.6;
const DUSK_PEAK = ((WRECK_IMPACT / DUSK_DUR) * 100).toFixed(1);
const DUSK_LIFT = (((WRECK_IMPACT + 0.1) / DUSK_DUR) * 100).toFixed(1);

/** Seconds from mount until an undelayed {@link wreckRise} starts: a beat after the debris settles. */
export const WRECK_RISE = WRECK_SETTLED + 2;
const RISE_DUR = 1.2;
/** Seconds from mount until an undelayed {@link wreckRise} has finished. */
export const WRECK_RISEN = WRECK_RISE + RISE_DUR;

/** Fades an element in from below, moments after the strike. */
export const wreckRise = (delay: number): CSSProperties => ({
  animation: anim("armada-wreck-rise", RISE_DUR, WRECK_RISE + delay),
});

/** Scoped keyframes for the wreck. Render once per screen. */
export function ArmadaWreckKeyframes() {
  return (
    <style>{`
      @keyframes armada-wreck-rays {
        from { opacity: 0; }
        to   { opacity: 0.6; }
      }
      @keyframes armada-wreck-sway {
        0%, 100% { transform: rotate(0deg); }
        50%      { transform: rotate(0.4deg); }
      }
      /* Faint as the sky gathers, blinding at the strike, then lingering. */
      @keyframes armada-wreck-pillar {
        0%   { opacity: 0.08; }
        14%  { opacity: 1; }
        100% { opacity: 0.3; }
      }
      @keyframes armada-wreck-breathe {
        0%, 100% { opacity: 0.3; }
        50%      { opacity: 0.45; }
      }
      @keyframes armada-wreck-glow {
        from { opacity: 0; }
      }
      @keyframes armada-wreck-flicker {
        0%, 100% { opacity: 0.7; }
        30%      { opacity: 0.5; }
        55%      { opacity: 0.85; }
        80%      { opacity: 0.6; }
      }
      @keyframes armada-wreck-split {
        0%   { transform: translateX(0); }
        100% { transform: translateX(var(--split)); }
      }
      /* Whole up to the strike, gone at it. */
      @keyframes armada-wreck-vanish {
        0%, 99.9% { opacity: 1; }
        100%      { opacity: 0; }
      }
      @keyframes armada-wreck-tremble {
        0%   { transform: translate(0, 0); }
        20%  { transform: translate(-0.6px, 0.3px); }
        40%  { transform: translate(0.8px, -0.4px); }
        60%  { transform: translate(-1px, 0.5px); }
        80%  { transform: translate(1.2px, -0.3px); }
        100% { transform: translate(0, 0); }
      }
      /* Blown up and out, then falling to the water. The rotation interpolates
         by angle, since both stops use the same function list, so shards spin. */
      @keyframes armada-wreck-shard {
        0% {
          opacity: 1;
          transform: translate(0px, 0px) rotate(0deg);
          animation-timing-function: cubic-bezier(0.1, 0.7, 0.3, 1);
        }
        30% {
          opacity: 1;
          transform: translate(var(--px), var(--py)) rotate(var(--pr));
          animation-timing-function: cubic-bezier(0.45, 0, 0.4, 1);
        }
        100% { opacity: var(--fade); transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); }
      }
      @keyframes armada-wreck-drift {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-1.4px); }
      }
      @keyframes armada-wreck-sink {
        0%   { opacity: 1; transform: translateY(0); }
        100% { opacity: 0; transform: translateY(26px); }
      }
      /* Drawn top-down in a blink, then two afterimages and out. */
      @keyframes armada-wreck-bolt {
        0%   { opacity: 1; stroke-dashoffset: 1; }
        22%  { opacity: 1; stroke-dashoffset: 0; }
        40%  { opacity: 0.25; stroke-dashoffset: 0; }
        52%  { opacity: 1; stroke-dashoffset: 0; }
        70%  { opacity: 0.5; stroke-dashoffset: 0; }
        100% { opacity: 0; stroke-dashoffset: 0; }
      }
      @keyframes armada-wreck-flash {
        0%   { opacity: 0; transform: scale(0.3); }
        12%  { opacity: 1; transform: scale(2.4); }
        100% { opacity: 0; transform: scale(4.5); }
      }
      @keyframes armada-wreck-ring {
        0%   { opacity: 1; transform: scale(0.2); }
        100% { opacity: 0; transform: scale(7); }
      }
      /* A short dash run from the blast to the line's end. */
      @keyframes armada-wreck-spark {
        0%   { opacity: 1; stroke-dashoffset: 0.14; }
        70%  { opacity: 1; }
        100% { opacity: 0; stroke-dashoffset: -1; }
      }
      @keyframes armada-wreck-smoke {
        0%   { opacity: 0; transform: translateY(0) scale(0.6); }
        20%  { opacity: 0.7; }
        100% { opacity: 0; transform: translateY(-62px) scale(2.4); }
      }
      @keyframes armada-wreck-ember {
        0%   { opacity: 0; transform: translate(0, 0); }
        15%  { opacity: 1; }
        50%  { transform: translate(2px, calc(var(--rise) * 0.5)); }
        100% { opacity: 0; transform: translate(-1px, var(--rise)); }
      }
      @keyframes armada-wreck-quake {
        0%   { transform: translate(0, 0); }
        10%  { transform: translate(-7px, 5px); }
        20%  { transform: translate(6px, -4px); }
        32%  { transform: translate(-4px, 3px); }
        46%  { transform: translate(3px, -2px); }
        62%  { transform: translate(-1.5px, 1px); }
        100% { transform: translate(0, 0); }
      }
      /* The sky darkens as the heavens gather, and the strike lifts it. */
      @keyframes armada-wreck-dusk {
        0%   { opacity: 0; }
        ${DUSK_PEAK}%  { opacity: 0.5; }
        ${DUSK_LIFT}%  { opacity: 0; }
        100% { opacity: 0; }
      }
      @keyframes armada-wreck-whiteout {
        0%   { opacity: 0; }
        5%   { opacity: 1; }
        100% { opacity: 0; }
      }
      @keyframes armada-wreck-rise {
        from { opacity: 0; transform: translateY(24px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .${WRECK_SCOPE}, .${WRECK_SCOPE} * { animation: none !important; }
      }
      html[data-reduce-motion] .${WRECK_SCOPE}, html[data-reduce-motion] .${WRECK_SCOPE} * { animation: none !important; }
    `}</style>
  );
}

/** The camera shake at the strike, for the element holding the wreck. */
export const wreckQuake: CSSProperties = {
  animation: anim("armada-wreck-quake", 0.7, WRECK_IMPACT, "linear"),
};
