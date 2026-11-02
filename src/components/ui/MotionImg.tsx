import { forwardRef, useRef, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

import { mayAnimate, useReducedMotion } from "@/lib/reducedMotion";

/**
 * `<img>` that shows only the first frame of an animated image while motion is
 * reduced. That frame is drawn into a canvas with the same classes and style:
 * a canvas is a replaced element, so sizing and `object-fit` carry over, and a
 * cross-origin image may be DRAWN without CORS (only reading it back is refused).
 * The ref reaches the `<img>` only while it is the one rendered.
 */
export const MotionImg = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(function MotionImg(props, ref) {
  const reduced = useReducedMotion();
  if (!reduced || !mayAnimate(props.src)) return <img ref={ref} {...props} />;
  return <StillImg {...props} />;
});

function StillImg({ src, onLoad, className, style, alt, title, ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawnFor, setDrawnFor] = useState<string>();
  const drawn = drawnFor !== undefined && drawnFor === src;

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const canvas = canvasRef.current;
    // At `load` an animated image is on its first frame.
    if (canvas && img.naturalWidth > 0) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      setDrawnFor(src);
    }
    onLoad?.(e);
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={rest["aria-hidden"]}
        title={title}
        className={className}
        style={drawn ? style : { ...style, display: "none" }}
      />
      {!drawn && (
        <img {...rest} src={src} alt={alt} title={title} className={className} style={{ ...style, opacity: 0 }} onLoad={handleLoad} />
      )}
    </>
  );
}
