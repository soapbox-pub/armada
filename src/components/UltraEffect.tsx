import { useEffect, useState } from "react";

import { useHiddenFlair, useReducedMotion } from "@/lib/reducedMotion";
import { PROFILE_EFFECTS, type ProfileEffectId } from "@/lib/ultra";
import { cn } from "@/lib/utils";

const PARTICLES = 14;
const CYCLE_MS = 3200;

// Fixed positions, so a re-render never reshuffles a burst mid-flight.
const LAYOUT = Array.from({ length: PARTICLES }, (_, i) => ({
  left: `${(i * 37 + 7) % 92 + 2}%`,
  top: `${55 + ((i * 53) % 40)}%`,
  delay: `${(i * 113) % 900}ms`,
  size: `${0.8 + ((i * 7) % 5) * 0.15}rem`,
  float: `${-60 - ((i * 29) % 90)}px`,
}));

/** A burst of the profile's Ultra effect over its container (which must be `relative`). */
export function UltraEffect({ effect, loop, className }: { effect: ProfileEffectId | undefined; loop?: boolean; className?: string }) {
  const [burst, setBurst] = useState(0);
  const reduced = useReducedMotion();
  // `loop` is the Ultra settings preview, shown whatever the viewer hides.
  const hidden = useHiddenFlair() && !loop;
  useEffect(() => {
    if (!loop || reduced) return;
    const id = setInterval(() => setBurst((n) => n + 1), CYCLE_MS);
    return () => clearInterval(id);
  }, [loop, reduced]);

  if (!effect || reduced || hidden) return null;
  const glyph = PROFILE_EFFECTS[effect];

  return (
    <div key={burst} aria-hidden className={cn("pointer-events-none absolute inset-0 z-10 overflow-hidden", className)}>
      {LAYOUT.map((p, i) => (
        <span
          key={i}
          // Emoji fonts first (bundled Twemoji last): the card's own stack puts
          // system-ui ahead of them, whose text ✨ and ⭐ are hollow outlines.
          className="absolute animate-ultra-float leading-none font-emoji"
          style={{ left: p.left, top: p.top, fontSize: p.size, animationDelay: p.delay, ["--float" as string]: p.float }}
        >
          {glyph}
        </span>
      ))}
    </div>
  );
}
