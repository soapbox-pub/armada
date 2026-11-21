import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import { FormattedMessage, useIntl } from "@/i18n";
import { type DiceRoll as Roll } from "@/lib/dice";
import { getPolyhedron, type Polyhedron, type V3 } from "@/lib/diceGeometry";
import { impact, notify, selectionChanged } from "@/lib/haptics";
import { reducedMotion } from "@/lib/reducedMotion";
import { nowSecs } from "@/lib/relayClock";
import { cn } from "@/lib/utils";

type Quat = [number, number, number, number];
type Tone = "plain" | "crit" | "fumble";

const TUMBLE_MS = 1100;
/** A roll this recent tumbles when it first appears; older ones are drawn settled. */
const FRESH_SECS = 15;
const DIE_SIZE = 52;

/** Each roll tumbles once per session, however often its row remounts. */
const tumbled = new Set<string>();

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

function primaryHue(): { h: number; s: number } {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  const [h, s] = raw.split(/\s+/).map((part) => parseFloat(part));
  return { h: Number.isFinite(h) ? h : 270, s: Number.isFinite(s) ? s : 60 };
}

interface DrawOpts {
  poly: Polyhedron;
  pose: Quat;
  size: number;
  /** Vertical hop, as a fraction of the size. */
  lift: number;
  /** Face label to light up, once settled. */
  lit: number | null;
  tone: Tone;
  font: string;
}

function draw(ctx: CanvasRenderingContext2D, { poly, pose, size, lift, lit, tone, font }: DrawOpts) {
  const dpr = window.devicePixelRatio || 1;
  const px = size * dpr;
  const cx = px / 2;
  const cy = px / 2 - lift * px;
  const scale = px * 0.4;
  const fov = 5;
  const project = (v: V3): [number, number] => {
    const f = fov / (fov - v[2]);
    return [cx + v[0] * scale * f, cy - v[1] * scale * f];
  };
  const { h, s } = tone === "crit" ? { h: 43, s: 90 } : tone === "fumble" ? { h: 0, s: 75 } : primaryHue();
  const light: V3 = [0.32, 0.62, 0.72];
  const ll = Math.hypot(...light);

  ctx.clearRect(0, 0, px, px);
  const verts = poly.vertices.map((v) => rotate(pose, v));
  const faces = poly.faces
    .map((face) => {
      const n = rotate(pose, face.normal);
      const pts = face.vertices.map((i) => verts[i]);
      const centre = pts.reduce<V3>((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length], [0, 0, 0]);
      return { face, n, pts, centre };
    })
    .filter(({ n }) => n[2] > 0)
    .sort((a, b) => a.centre[2] - b.centre[2]);

  for (const { face, n, pts, centre } of faces) {
    const hl = lit !== null && face.label === lit;
    const b = 0.3 + 0.7 * Math.max(0, (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / ll);
    const fill = hl ? 30 + b * 26 : 12 + b * 24;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = project(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = `hsl(${h} ${hl ? s : s * 0.55}% ${fill.toFixed(0)}%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} ${s * 0.7}% ${(hl ? 70 : 45 + b * 15).toFixed(0)}% / ${hl ? 0.9 : 0.6})`;
    ctx.lineWidth = Math.max(1, size / 40) * dpr;
    ctx.lineJoin = "round";
    ctx.stroke();

    if (n[2] > 0.3) {
      const [lx, ly] = project(centre);
      const text = String(face.label);
      const fs = (scale * (poly.faces.length > 12 ? 0.3 : 0.4)) / Math.max(1, text.length * 0.55);
      ctx.font = `700 ${fs.toFixed(1)}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = hl ? `hsl(${h} 90% 94% / ${0.5 + n[2] * 0.5})` : `hsl(${h} 35% 85% / ${0.15 + n[2] * 0.45})`;
      ctx.fillText(text, lx, ly + fs * 0.04);
      // 6 and 9 are told apart by an underline, as on a real die.
      if (poly.faces.length > 8 && (face.label === 6 || face.label === 9)) {
        ctx.fillRect(lx - fs * 0.22, ly + fs * 0.42, fs * 0.44, Math.max(1, fs * 0.07));
      }
    }
  }
}

interface DieProps {
  sides: number;
  value: number;
  seed: number;
  tumble: boolean;
  tone: Tone;
  size?: number;
}

/** One die: tumbles into place once when `tumble`, otherwise draws its resting frame. */
const Die = memo(function Die({ sides, value, seed, tumble, tone, size = DIE_SIZE }: DieProps) {
  const intl = useIntl();
  const ref = useRef<HTMLCanvasElement>(null);
  const poly = getPolyhedron(sides);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !poly) return;
    const font = getComputedStyle(canvas).fontFamily || "sans-serif";
    const rest = restingPose(poly, value, seed);
    const frame = (pose: Quat, lift: number, settled: boolean) =>
      draw(ctx, { poly, pose, size, lift, lit: settled ? value : null, tone, font });
    if (!tumble) {
      frame(rest, 0, true);
      return;
    }
    // Wind the rest pose backwards about a random axis and ease it home, so the
    // tumble lands exactly on the result with no correcting snap.
    const axis: V3 = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
    const turns = (3 + Math.random() * 2) * Math.PI * 2;
    const duration = TUMBLE_MS * (0.85 + Math.random() * 0.3);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - (1 - t) ** 3;
      const lift = 0.12 * Math.abs(Math.sin(t * Math.PI * 2.5)) * (1 - t) ** 1.5;
      frame(qMul(rest, qAxis(axis, turns * (1 - e))), lift, t >= 1);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [poly, value, seed, tumble, tone, size]);

  const label = intl.formatMessage({ id: "diceRoll.die", defaultMessage: "d{sides}: {value}" }, { sides, value });
  if (!poly) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-flex h-9 min-w-9 items-center justify-center rounded-lg bg-primary/15 px-2 font-bold tabular-nums text-foreground",
          tumble && "animate-in zoom-in-50 spin-in-12 duration-500",
        )}
      >
        <span className="mr-0.5 text-[10px] font-semibold text-muted-foreground">d{sides}</span>
        {value}
      </span>
    );
  }
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      width={size * dpr}
      height={size * dpr}
      style={{ width: size, height: size }}
      className="shrink-0"
    />
  );
});

interface DiceRollBodyProps {
  roll: Roll;
  /** The message id: seeds each die's pose and marks the roll as tumbled. */
  id: string;
  createdAt: number;
  /** Whose roll it is, rendered before "rolled". */
  name: ReactNode;
  /** The viewer rolled it: the tumble gets haptics. */
  own: boolean;
}

/** A `/roll` message: who rolled what, the dice themselves, and the total. */
export const DiceRollBody = memo(function DiceRollBody({ roll, id, createdAt, name, own }: DiceRollBodyProps) {
  const [tumble] = useState(
    () => !tumbled.has(id) && !reducedMotion() && Math.abs(nowSecs() - createdAt) <= FRESH_SECS,
  );
  useEffect(() => {
    tumbled.add(id);
  }, [id]);

  useEffect(() => {
    if (!tumble || !own) return;
    impact("heavy");
    const ticks = setInterval(selectionChanged, 90);
    const done = setTimeout(() => {
      clearInterval(ticks);
      notify("success");
    }, TUMBLE_MS);
    return () => {
      clearInterval(ticks);
      clearTimeout(done);
    };
  }, [tumble, own]);

  // A single d20, modifiers aside, gets the natural 20 / natural 1 treatment.
  const single = roll.dice.length === 1 && roll.dice[0].sides === 20 && roll.dice[0].sign === 1 ? roll.dice[0].value : 0;
  const tone: Tone = single === 20 ? "crit" : single === 1 ? "fumble" : "plain";
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
      <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
        {roll.dice.map((die, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {(i > 0 || die.sign === -1) && (
              <span className="text-muted-foreground">{die.sign === -1 ? "−" : "+"}</span>
            )}
            <Die sides={die.sides} value={die.value} seed={hash01(`${id}:${i}`)} tumble={tumble} tone={tone} />
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
              "ml-1 text-2xl font-bold tabular-nums text-foreground",
              tumble && "animate-in fade-in zoom-in-75 fill-mode-both delay-1000 duration-300",
            )}
          >
            = {roll.total}
          </span>
        )}
        {tone !== "plain" && (
          <span
            className={cn(
              "ml-2 rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide",
              tone === "crit" ? "bg-amber-400/20 text-amber-500" : "bg-destructive/15 text-destructive",
              tumble && "animate-in fade-in zoom-in-50 fill-mode-both delay-1000 duration-300",
            )}
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
