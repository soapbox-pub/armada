import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { FormattedMessage, useIntl } from "@/i18n";
import { type DiceRoll as Roll } from "@/lib/dice";
import { getPolyhedron, type Polyhedron, type V3 } from "@/lib/diceGeometry";
import { impact, notify } from "@/lib/haptics";
import { reducedMotion } from "@/lib/reducedMotion";
import { nowSecs } from "@/lib/relayClock";
import { cn } from "@/lib/utils";

type Quat = [number, number, number, number];
type Tone = "plain" | "crit" | "fumble";

/** One die's tumble; each further die lands a beat later. */
const ROLL_MS = 700;
const MAX_STAGGER_MS = 80;
/** A roll this recent tumbles when it first appears; older ones are drawn settled. */
const FRESH_SECS = 15;

/** When each roll started tumbling (0: never), so a row that remounts mid-roll resumes it. */
const tumbleStarts = new Map<string, number>();

function staggerFor(count: number): number {
  return count > 1 ? Math.min(MAX_STAGGER_MS, 600 / (count - 1)) : 0;
}

function dieSize(count: number): number {
  return count === 1 ? 96 : count <= 3 ? 80 : count <= 6 ? 68 : 56;
}

/** Height above the table, 1 → 0, with the bounces of a thrown die. */
function drop(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  let b: number;
  if (t < 1 / d) b = n * t * t;
  else if (t < 2 / d) b = n * (t -= 1.5 / d) * t + 0.75;
  else if (t < 2.5 / d) b = n * (t -= 2.25 / d) * t + 0.9375;
  else b = n * (t -= 2.625 / d) * t + 0.984375;
  return 1 - b;
}

const qMul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

function qAxis(axis: V3, angle: number): Quat {
  const l = Math.hypot(...axis) || 1;
  const s = Math.sin(angle / 2) / l;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

function rotate(q: Quat, v: V3): V3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Deterministic [0, 1) from a string, so a settled die keeps its pose across remounts. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 0x1_0000_0000;
}

/** The pose that turns `value`'s face toward the viewer, slightly tilted to show the solid. */
function restingPose(poly: Polyhedron, value: number, seed: number): Quat {
  const face = poly.faces.find((f) => f.label === value) ?? poly.faces[0];
  const n = face.normal;
  const axis: V3 = [n[1], -n[0], 0]; // n × +Z
  const align = Math.hypot(axis[0], axis[1]) < 1e-6
    ? (n[2] > 0 ? [1, 0, 0, 0] as Quat : qAxis([0, 1, 0], Math.PI))
    : qAxis(axis, Math.acos(Math.max(-1, Math.min(1, n[2]))));
  const spin = qAxis([0, 0, 1], seed * Math.PI * 2);
  const tilt = qMul(qAxis([1, 0, 0], -0.22), qAxis([0, 1, 0], 0.16));
  return qMul(tilt, qMul(spin, align));
}

/** Face colours per tone; `plain` follows the theme, live, through its CSS variable. */
const TONE_FILL: Record<Tone, string> = {
  plain: "hsl(var(--primary))",
  crit: "hsl(43 90% 50%)",
  fumble: "hsl(0 75% 50%)",
};

const LIGHT: V3 = [0.32, 0.62, 0.72];
const LIGHT_LEN = Math.hypot(...LIGHT);

interface Facet {
  label: number;
  /** Polygon in a 100×100 box. */
  points: [number, number][];
  /** Black laid over the face colour: the shading. */
  shadow: number;
  lit: boolean;
  /** Label opacity, 0 when the face is too oblique to read. */
  ink: number;
  at: [number, number];
  fontSize: number;
  /** 6 and 9 are told apart by an underline, as on a real die. */
  underline: boolean;
}

/** The visible faces of `poly` in `pose`, back to front. */
function facets(poly: Polyhedron, pose: Quat, lift: number, lit: number | null): Facet[] {
  const fov = 5;
  const scale = 40;
  const project = (v: V3): [number, number] => {
    const f = fov / (fov - v[2]);
    return [50 + v[0] * scale * f, 50 - lift * 100 - v[1] * scale * f];
  };
  const verts = poly.vertices.map((v) => rotate(pose, v));
  return poly.faces
    .map((face) => {
      const n = rotate(pose, face.normal);
      const pts = face.vertices.map((i) => verts[i]);
      const centre = pts.reduce<V3>((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
      return { face, n, pts, centre };
    })
    .filter(({ n }) => n[2] > 0)
    .sort((a, b) => a.centre[2] - b.centre[2])
    .map(({ face, n, pts, centre }) => {
      const isLit = lit !== null && face.label === lit;
      const b = 0.3 + 0.7 * Math.max(0, (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / LIGHT_LEN);
      const digits = String(face.label).length;
      return {
        label: face.label,
        points: pts.map(project),
        shadow: isLit ? 0.45 * (1 - b) : 0.4 + 0.45 * (1 - b),
        lit: isLit,
        ink: n[2] > 0.3 ? (isLit ? 0.5 + n[2] * 0.5 : 0.15 + n[2] * 0.4) : 0,
        at: project(centre),
        fontSize: (scale * (poly.faces.length > 12 ? 0.3 : 0.4)) / Math.max(1, digits * 0.55),
        underline: poly.faces.length > 8 && (face.label === 6 || face.label === 9),
      };
    });
}

function paint(ctx: CanvasRenderingContext2D, faces: Facet[], fill: string, px: number, font: string) {
  const k = px / 100;
  ctx.clearRect(0, 0, px, px);
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.5 * k;
  for (const f of faces) {
    ctx.beginPath();
    f.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * k, y * k) : ctx.lineTo(x * k, y * k)));
    ctx.closePath();
    ctx.globalAlpha = 1;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.globalAlpha = f.shadow;
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.globalAlpha = f.lit ? 0.55 : 0.18;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    if (f.ink > 0) {
      ctx.globalAlpha = f.ink;
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${(f.fontSize * k).toFixed(1)}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(f.label), f.at[0] * k, f.at[1] * k);
    }
  }
  ctx.globalAlpha = 1;
}

interface DieProps {
  sides: number;
  value: number;
  seed: number;
  /** `performance.now()` the roll started at, while it is tumbling. */
  startedAt?: number;
  /** This die's tumble length; later dice in a roll land later. */
  duration: number;
  tone: Tone;
  size: number;
  /** Called as the die hits its final face. */
  onLand?: () => void;
}

/**
 * One die. At rest it is static SVG coloured by CSS variables, so a timeline of
 * rolls holds no canvases and follows theme changes. A `tumble` draws on a
 * canvas while it moves, then swaps to the same SVG.
 */
const Die = memo(function Die({ sides, value, seed, startedAt, duration, tone, size, onLand }: DieProps) {
  const intl = useIntl();
  const ref = useRef<HTMLCanvasElement>(null);
  const poly = getPolyhedron(sides);
  const tumble = startedAt !== undefined;
  const [rolling, setRolling] = useState(tumble && !!poly);
  const onLandRef = useRef(onLand);
  useEffect(() => {
    onLandRef.current = onLand;
  });
  const rest = useMemo(() => (poly ? restingPose(poly, value, seed) : undefined), [poly, value, seed]);
  const still = useMemo(() => (poly && rest && !rolling ? facets(poly, rest, 0, value) : undefined), [poly, rest, rolling, value]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!rolling || !canvas || !ctx || !poly || !rest) return;
    // Resolved once per tumble: a style read per frame would force a recalc each time.
    const style = getComputedStyle(canvas);
    const fill = tone === "plain" ? `hsl(${style.getPropertyValue("--primary").trim() || "270 60% 50%"})` : TONE_FILL[tone];
    const font = style.fontFamily || "sans-serif";
    const px = canvas.width;
    // Wind the rest pose backwards about a random axis and ease it home, so the
    // tumble lands exactly on the result with no correcting snap.
    const axis: V3 = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    const turns = (1.5 + Math.random()) * Math.PI * 2;
    const start = startedAt ?? performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      paint(ctx, facets(poly, qMul(rest, qAxis(axis, turns * (1 - t) ** 3)), 0, t >= 1 ? value : null), fill, px, font);
      // The fall is a compositor-only transform: no re-layout, no clipping at the canvas edge.
      canvas.style.transform = `translateY(${(-drop(t) * size * 0.9).toFixed(1)}px)`;
      canvas.style.opacity = String(Math.min(1, t * 8));
      if (t < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      onLandRef.current?.();
      setRolling(false);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [rolling, poly, rest, tone, value, startedAt, duration, size]);

  const label = intl.formatMessage({ id: "diceRoll.die", defaultMessage: "d{sides}: {value}" }, { sides, value });
  if (!poly) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-flex h-9 min-w-9 items-center justify-center rounded-lg bg-primary/15 px-2 font-bold tabular-nums text-foreground",
          tumble && "animate-in fade-in zoom-in-50 spin-in-12 duration-500",
        )}
      >
        <span className="mr-0.5 text-[10px] font-semibold text-muted-foreground">d{sides}</span>
        {value}
      </span>
    );
  }
  if (rolling) {
    const dpr = window.devicePixelRatio || 1;
    return (
      <canvas
        ref={ref}
        role="img"
        aria-label={label}
        width={Math.round(size * dpr)}
        height={Math.round(size * dpr)}
        style={{ width: size, height: size, opacity: 0, willChange: "transform" }}
        className="shrink-0"
      />
    );
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("shrink-0", tumble && "animate-in zoom-in-90 duration-200")}
    >
      {still?.map((f) => {
        const points = f.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        return (
          <g key={f.label}>
            <polygon points={points} style={{ fill: TONE_FILL[tone] }} />
            <polygon
              points={points}
              fill="#000"
              fillOpacity={f.shadow}
              stroke="#fff"
              strokeOpacity={f.lit ? 0.55 : 0.18}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
            {f.ink > 0 && (
              <text
                x={f.at[0]}
                y={f.at[1]}
                fontSize={f.fontSize}
                fontWeight={700}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#fff"
                fillOpacity={f.ink}
              >
                {f.label}
              </text>
            )}
            {f.ink > 0 && f.underline && (
              <rect
                x={f.at[0] - f.fontSize * 0.22}
                y={f.at[1] + f.fontSize * 0.42}
                width={f.fontSize * 0.44}
                height={f.fontSize * 0.07}
                fill="#fff"
                fillOpacity={f.ink}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
});

interface DiceRollBodyProps {
  roll: Roll;
  /** The message id: seeds each die's pose and keys its tumble. */
  id: string;
  createdAt: number;
  /** Whose roll it is, rendered before "rolled". */
  name: ReactNode;
  /** The viewer rolled it: the tumble gets haptics. */
  own: boolean;
}

/** A `/roll` message: who rolled what, the dice themselves, and the total. */
export const DiceRollBody = memo(function DiceRollBody({ roll, id, createdAt, name, own }: DiceRollBodyProps) {
  const count = roll.dice.length;
  const stagger = staggerFor(count);
  // Only a polyhedron tumbles; a d100 or d7 is a chip and never lands.
  const landers = roll.dice.filter((die) => getPolyhedron(die.sides)).length;
  const total = ROLL_MS + stagger * Math.max(0, count - 1);
  const [{ startedAt, resumed }] = useState(() => {
    const now = performance.now();
    const prior = tumbleStarts.get(id);
    if (prior !== undefined) return { startedAt: now - prior < total ? prior : undefined, resumed: true };
    const fresh = !reducedMotion() && Math.abs(nowSecs() - createdAt) <= FRESH_SECS;
    return { startedAt: fresh ? now : undefined, resumed: false };
  });
  useEffect(() => {
    if (!tumbleStarts.has(id)) tumbleStarts.set(id, startedAt ?? 0);
  }, [id, startedAt]);

  const buzz = own && startedAt !== undefined && !resumed;
  useEffect(() => {
    if (buzz) impact("heavy");
  }, [buzz]);
  const landed = useRef(0);
  const onLand = useCallback(() => {
    if (!buzz) return;
    landed.current += 1;
    if (landed.current === landers) notify("success");
    else impact("light");
  }, [buzz, landers]);

  // A single d20, modifiers aside, gets the natural 20 / natural 1 treatment.
  const single = roll.dice.length === 1 && roll.dice[0].sides === 20 && roll.dice[0].sign === 1 ? roll.dice[0].value : 0;
  const tone: Tone = single === 20 ? "crit" : single === 1 ? "fumble" : "plain";
  const tumble = startedAt !== undefined;
  const reveal = tumble ? { animationDelay: `${Math.max(0, total - (performance.now() - startedAt))}ms` } : undefined;
  const showTotal = roll.dice.length > 1 || roll.modifier !== 0 || roll.dice[0]?.sign === -1;

  return (
    <div className="text-chat">
      <div className="italic text-muted-foreground">
        <FormattedMessage
          id="diceRoll.rolled"
          defaultMessage="{name} rolled <expr>{expression}</expr>"
          values={{
            name: <span className="font-semibold not-italic text-primary">{name}</span>,
            expression: roll.expression,
            expr: (chunks) => <span className="font-mono not-italic text-foreground">{chunks}</span>,
          }}
        />
        {roll.label && <span className="not-italic text-foreground"> — {roll.label}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {roll.dice.map((die, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {(i > 0 || die.sign === -1) && (
              <span className="text-muted-foreground">{die.sign === -1 ? "−" : "+"}</span>
            )}
            <Die
              sides={die.sides}
              value={die.value}
              seed={hash01(`${id}:${i}`)}
              startedAt={startedAt}
              duration={ROLL_MS + stagger * i}
              tone={tone}
              size={dieSize(count)}
              onLand={onLand}
            />
          </span>
        ))}
        {roll.modifier !== 0 && (
          <span className="font-semibold tabular-nums text-muted-foreground">
            {roll.modifier > 0 ? "+" : "−"} {Math.abs(roll.modifier)}
          </span>
        )}
        {showTotal && (
          <span
            className={cn(
              "ml-1 text-3xl font-bold tabular-nums text-foreground",
              tumble && "animate-in fade-in zoom-in-75 fill-mode-both duration-200",
            )}
            style={reveal}
          >
            = {roll.total}
          </span>
        )}
        {tone !== "plain" && (
          <span
            className={cn(
              "ml-2 rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide",
              tone === "crit" ? "bg-amber-400/20 text-amber-500" : "bg-destructive/15 text-destructive",
              tumble && "animate-in fade-in zoom-in-50 fill-mode-both duration-200",
            )}
            style={reveal}
          >
            {tone === "crit" ? (
              <FormattedMessage id="diceRoll.critical" defaultMessage="Natural 20!" />
            ) : (
              <FormattedMessage id="diceRoll.fumble" defaultMessage="Natural 1" />
            )}
          </span>
        )}
      </div>
    </div>
  );
});
