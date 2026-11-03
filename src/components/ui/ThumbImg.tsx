import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes } from "react";

import { MotionImg } from "@/components/ui/MotionImg";
import { ThumbAnimation } from "@/components/ui/ThumbAnimation";
import { useImageThumb } from "@/hooks/useImageThumb";

/** How far outside the viewport a `loading="lazy"` thumbnail starts loading. */
const LAZY_MARGIN = "400px";

/**
 * `<img>` shown downscaled to its own box (`lib/imageThumb.ts`), for images
 * drawn far below their natural size and cropped to cover it. The box is
 * measured once from a placeholder with the same classes, which is what starts
 * the fetch: with `loading="lazy"`, only once that placeholder nears the screen.
 */
export function ThumbImg({ src, className, style, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const lazy = props.loading === "lazy";
  const [box, setBox] = useState(0);
  const observer = useRef<IntersectionObserver | null>(null);
  const measure = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const size = () => Math.max(el.offsetWidth, el.offsetHeight) || 64;
    if (!lazy || typeof IntersectionObserver === "undefined") {
      setBox(size());
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      setBox(size());
    }, { rootMargin: LAZY_MARGIN });
    io.observe(el);
    observer.current = io;
  }, [lazy]);
  useEffect(() => () => observer.current?.disconnect(), []);
  const thumb = useImageThumb(src, box);
  if (thumb.pending) return <span ref={measure} aria-hidden className={className} style={{ ...style, display: "inline-block" }} />;
  if (thumb.anim) return <ThumbAnimation anim={thumb.anim} className={className} style={style} alt={props.alt} title={props.title} />;
  return <MotionImg {...props} src={thumb.src} className={className} style={style} />;
}
