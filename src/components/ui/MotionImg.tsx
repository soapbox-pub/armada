import { forwardRef, useRef, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

import { mayAnimate, useStillMedia } from "@/lib/reducedMotion";

/**
 * `<img>` that shows only the first frame of an animated image while media is
 * held still. That frame is drawn into a canvas with the same classes and style:
 * a canvas is a replaced element, so sizing and `object-fit` carry over, and a
 * cross-origin image may be DRAWN without CORS (only reading it back is refused).
 * The ref reaches the `<img>` only while it is the one rendered.
 */
export const MotionImg = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(function MotionImg(props, ref) {
  const still = useStillMedia();
  if (!still || !mayAnimate(props.src)) return <img ref={ref} {...props} />;
  return <StillImg {...props} />;
});

/** Longest edge a frozen frame is kept at, whatever its box. */
const MAX_STILL_EDGE = 2048;

function StillImg({ src, onLoad, className, style, alt, title, ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawnFor, setDrawnFor] = useState<string>();
  const drawn = drawnFor !== undefined && drawnFor === src;

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const canvas = canvasRef.current;
    // At `load` an animated image is on its first frame.
    if (canvas && img.naturalWidth > 0) {
      // A canvas's pixels are never discarded the way a decoded <img>'s are, so
      // keep only what the box shows: enough to cover it at this pixel ratio.
      const dpr = typeof devicePixelRatio === "number" ? Math.max(1, devicePixelRatio) : 1;
      const cover = Math.max(img.clientWidth * dpr / img.naturalWidth, img.clientHeight * dpr / img.naturalHeight);
      const edge = MAX_STILL_EDGE / Math.max(img.naturalWidth, img.naturalHeight);
      const scale = Math.min(1, edge, cover > 0 ? cover : 1);
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
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
