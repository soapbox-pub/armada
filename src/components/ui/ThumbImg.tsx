import { useCallback, useState, type ImgHTMLAttributes } from "react";

import { MotionImg } from "@/components/ui/MotionImg";
import { ThumbAnimation } from "@/components/ui/ThumbAnimation";
import { useImageThumb } from "@/hooks/useImageThumb";

/**
 * `<img>` shown downscaled to its own box (`lib/imageThumb.ts`), for images
 * drawn far below their natural size and cropped to cover it. The box is
 * measured once from a placeholder with the same classes.
 */
export function ThumbImg({ src, className, style, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [box, setBox] = useState(0);
  const measure = useCallback((el: HTMLElement | null) => {
    if (el) setBox(Math.max(el.offsetWidth, el.offsetHeight) || 64);
  }, []);
  const thumb = useImageThumb(src, box);
  if (thumb.pending) return <span ref={measure} aria-hidden className={className} style={{ ...style, display: "inline-block" }} />;
  if (thumb.anim) return <ThumbAnimation anim={thumb.anim} className={className} style={style} alt={props.alt} />;
  return <MotionImg {...props} src={thumb.src} className={className} style={style} />;
}
