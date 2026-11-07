import { cn } from "@/lib/utils";

// Fixed positions, so a re-render never reshuffles the sky.
const STARS = Array.from({ length: 36 }, (_, i) => ({
  left: `${(i * 47 + 11) % 97}%`,
  top: `${(i * 61 + 7) % 95}%`,
  size: 2 + ((i * 13) % 3),
  delay: `${-((i * 370) % 2600)}ms`,
}));

/** The drifting aurora and twinkling sky behind every Ultra gift. Fills its `relative` parent. */
export function GiftStage({ className, stars = true }: { className?: string; stars?: boolean }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden bg-chrome", className)}>
      <div className="absolute -left-[20%] -top-[30%] size-[75%] rounded-full bg-primary/40 blur-[80px] motion-safe:animate-gift-aurora" />
      <div className="absolute -right-[25%] top-[10%] size-[70%] rounded-full bg-accent2/30 blur-[80px] motion-safe:animate-gift-aurora [animation-delay:-6s]" />
      <div className="absolute -bottom-[35%] left-[15%] size-[70%] rounded-full bg-fuchsia-500/25 blur-[80px] motion-safe:animate-gift-aurora [animation-delay:-12s]" />
      {stars && STARS.map((s, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-white motion-safe:animate-gift-twinkle"
          style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay }}
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background/70" />
    </div>
  );
}
