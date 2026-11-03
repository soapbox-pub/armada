import { useEffect, useRef, type CSSProperties } from "react";

import type { AnimatedThumb } from "@/lib/imageThumb";
import { isTrayResting, onTrayRest } from "@/lib/trayRest";

/**
 * Plays an {@link AnimatedThumb} on a canvas, which takes the classes an
 * `<img>` would (a canvas is a replaced element, so sizing and `object-fit`
 * carry over). Subscribed only while on screen and the desktop window isn't
 * resting, so nothing ticks for a row nobody can see.
 */
export function ThumbAnimation({ anim, className, style, alt, title }: { anim: AnimatedThumb; className?: string; style?: CSSProperties; alt?: string; title?: string }) {
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
      if (visible && !isTrayResting()) off ??= anim.subscribe(draw);
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
  }, [anim]);
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
