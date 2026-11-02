import { useEffect, useRef } from "react";

import { CELL, FRAMES, SignalStaticField, WARMUP_FRAMES, hashSeed } from "./signalStaticField";
import { reducedMotion } from "@/lib/reducedMotion";

/**
 * Dead-channel interference over the jack-in screen. `level` (from resolved
 * sync phases) sets strength; noise is seeded by the pubkey; each `signal`
 * change flashes a rose band. No draw loop: a pre-baked sprite plays via a
 * compositor `steps()` animation so it survives main-thread stalls. Renders
 * nothing under prefers-reduced-motion.
 */
export function SignalStatic({
  level,
  seed,
  signal,
}: {
  level: number;
  seed: string;
  /** Opaque fingerprint of live wire activity; every change is an impulse. */
  signal?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    if (reducedMotion()) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // One-shot render of the whole loop (re-run only on resize).
    const render = () => {
      const w = Math.max(1, Math.ceil(host.clientWidth / CELL));
      const h = Math.max(1, Math.ceil(host.clientHeight / CELL));
      canvas.width = w;
      canvas.height = h * FRAMES;
      const field = new SignalStaticField(hashSeed(seed));
      field.resize(w, h);
      for (let i = 0; i < WARMUP_FRAMES; i++) field.advance();
      for (let frame = 0; frame < FRAMES; frame++) {
        field.advance();
        field.paint(ctx, frame * h);
      }
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    return () => observer.disconnect();
  }, [seed]);

  // One-shot WAAPI animation; nothing to clean up.
  useEffect(() => {
    const band = bandRef.current;
    if (signal === undefined || !band) return;
    if (reducedMotion()) return;
    band.style.top = `${5 + (hashSeed(signal) % 900) / 10}%`;
    band.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 300, easing: "ease-out" });
  }, [signal]);

  return (
    <div
      aria-hidden="true"
      // Flat-ish curve: a steep multiplier makes the field vanish mid-sync.
      style={{ opacity: level > 0 ? 0.15 + 0.35 * level : 0 }}
      className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700"
    >
      {/* 2s / steps(24) must equal FRAMES / FPS from the field module. */}
      <canvas
        ref={canvasRef}
        style={{ height: `${FRAMES * 100}%` }}
        className="absolute left-0 top-0 w-full animate-[armada-static-reel_2s_steps(24,end)_infinite] [image-rendering:pixelated]"
      />
      <div
        ref={bandRef}
        className="absolute inset-x-0 h-3 bg-gradient-to-b from-transparent via-[hsl(var(--primary)/0.6)] to-transparent opacity-0"
      />
      <style>{`
        @keyframes armada-static-reel {
          from { transform: translateY(0); }
          to   { transform: translateY(-100%); }
        }
      `}</style>
    </div>
  );
}
