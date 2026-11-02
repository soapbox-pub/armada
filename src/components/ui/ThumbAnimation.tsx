import { useEffect, useRef, type CSSProperties } from "react";

import type { AnimatedThumb } from "@/lib/imageThumb";

/**
 * Plays an {@link AnimatedThumb} on a canvas, which takes the classes an
 * `<img>` would (a canvas is a replaced element, so sizing and `object-fit`
 * carry over). Subscribed only while on screen, so nothing ticks for a row
 * scrolled out of view.
 */
export function ThumbAnimation({ anim, className, style, alt }: { anim: AnimatedThumb; className?: string; style?: CSSProperties; alt?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const draw = (frame: ImageBitmap) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frame, 0, 0);
    };
    let off: (() => void) | undefined;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) off ??= anim.subscribe(draw);
      else {
        off?.();
        off = undefined;
      }
    });
    io.observe(canvas);
    return () => {
      io.disconnect();
      off?.();
    };
  }, [anim]);
  return (
    <canvas
      ref={ref}
      width={anim.width}
      height={anim.height}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className={className}
      style={style}
    />
  );
}
