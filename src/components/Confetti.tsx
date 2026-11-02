import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { reducedMotion } from "@/lib/reducedMotion";

const COLORS = ["#a855f7", "#ec4899", "#f59e0b", "#22c55e", "#3b82f6", "#f43f5e", "#facc15"];
const COUNT = 180;
const DURATION_MS = 4000;

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  color: string;
  wobble: number;
}

/** One burst of confetti over the whole window, from both bottom corners. Remount (new `key`) to fire again. */
export function Confetti() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || reducedMotion()) return;

    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const pieces: Piece[] = Array.from({ length: COUNT }, (_, i) => {
      const left = i % 2 === 0;
      const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.7;
      const speed = height * (0.018 + Math.random() * 0.014);
      return {
        x: left ? 0 : width,
        y: height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 6 + Math.random() * 6,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        color: COLORS[i % COLORS.length],
        wobble: Math.random() * Math.PI * 2,
      };
    });

    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const elapsed = now - started;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = Math.max(0, Math.min(1, (DURATION_MS - elapsed) / 800));
      for (const p of pieces) {
        p.vy += 0.35;
        p.vx *= 0.99;
        p.vy *= 0.99;
        p.wobble += 0.1;
        p.x += p.vx + Math.sin(p.wobble);
        p.y += p.vy;
        p.rotation += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.wobble)));
        ctx.restore();
      }
      if (elapsed < DURATION_MS) frame = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, width, height);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return createPortal(
    <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-[400] size-full" />,
    document.body,
  );
}
