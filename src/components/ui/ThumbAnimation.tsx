import { useEffect, useRef, type CSSProperties } from "react";

import type { AnimatedThumb } from "@/lib/imageThumb";
import { isTrayResting, onTrayRest } from "@/lib/trayRest";

/**
 * Plays an {@link AnimatedThumb} on a canvas, which takes the classes an
 * `<img>` would (a canvas is a replaced element, so sizing and `object-fit`
 * carry over). Subscribed only while on screen and the desktop window isn't
 * resting, so nothing ticks for a row nobody can see. `loops` caps the loops
 * played each time it comes into view, then holds the first frame.
 */
export function ThumbAnimation({ anim, className, style, alt, title, loops }: { anim: AnimatedThumb; className?: string; style?: CSSProperties; alt?: string; title?: string; loops?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const draw = (frame: ImageBitmap) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frame, 0, 0);
    };
    let visible = false;
    let off: (() => void) | undefined;
    const sync = () => {
      if (visible && !isTrayResting()) off ??= anim.subscribe(draw, loops);
      else {
        off?.();
        off = undefined;
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    io.observe(canvas);
    const offRest = onTrayRest(sync);
    return () => {
      io.disconnect();
      offRest();
      off?.();
    };
  }, [anim, loops]);
  return (
    <canvas
      ref={ref}
      width={anim.width}
      height={anim.height}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      title={title}
      className={className}
      style={style}
    />
  );
}
