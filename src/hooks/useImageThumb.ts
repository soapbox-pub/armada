import { useEffect, useState } from "react";

import { acquireThumb, releaseThumb, settledThumb, thumbBucket, thumbsSupported } from "@/lib/imageThumb";
import { useStillMedia } from "@/lib/reducedMotion";

/**
 * `src` downscaled to `boxPx` CSS pixels (see `lib/imageThumb.ts`). `pending`
 * while it is being made, so the caller can keep its placeholder up rather than
 * flash the full-size image; then the thumbnail, or `src` itself when one
 * couldn't be made. `boxPx` 0 (not measured yet) is pending.
 */
export function useImageThumb(src: string | undefined, boxPx: number): { src: string | undefined; pending: boolean } {
  const still = useStillMedia();
  const enabled = thumbsSupported();
  const bucket = enabled && boxPx > 0 ? thumbBucket(boxPx, typeof devicePixelRatio === "number" ? devicePixelRatio : 1) : 0;
  const [done, setDone] = useState<{ key: string; url: string | null }>();

  const key = src && bucket ? `${still ? "s" : "a"}${bucket}|${src}` : undefined;
  useEffect(() => {
    if (!src || !bucket) return;
    const t = acquireThumb(src, bucket, still);
    let live = true;
    void t.promise.then((url) => {
      if (live) setDone({ key: t.key, url });
    });
    return () => {
      live = false;
      releaseThumb(t.key);
    };
  }, [src, bucket, still]);

  if (!src || !enabled) return { src, pending: false };
  if (!key) return { src: undefined, pending: true };
  // A remount of a cached thumbnail renders it at once, without a pending frame.
  const url = done?.key === key ? done.url : settledThumb(key);
  if (url === undefined) return { src: undefined, pending: true };
  return { src: url ?? src, pending: false };
}
