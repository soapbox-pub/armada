import { useImetaImage } from "@/hooks/useImetaImage";
import { imetaFor } from "@/lib/profileImeta";

import type { ImetaEntry } from "@/lib/imeta";
import type { ImgHTMLAttributes, ReactNode } from "react";
import { MotionImg } from "@/components/ui/MotionImg";

interface FallbackImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  /** Already sanitized by the caller. Nothing renders without one. */
  src: string | undefined;
  /** Other URLs for the same image, tried before the viewer's own servers. */
  fallbacks?: readonly string[];
  /**
   * imeta describing `src` (e.g. `author.data?.imeta?.banner`): its declared
   * fallbacks, and decryption for an encrypted image. Ignored unless its `url` is `src`.
   */
  imeta?: ImetaEntry;
  fallback?: ReactNode;
  /** Rendered while an encrypted image decrypts. Defaults to `fallback`. */
  placeholder?: ReactNode;
}

/**
 * `<img>` that walks the blob across the viewer's Blossom servers (see
 * `useImageFallback`) before showing `fallback`. Under the media policy; a
 * gated image renders nothing.
 */
export function FallbackImage({ src, fallbacks, imeta, fallback = null, placeholder, alt, ...props }: FallbackImageProps) {
  const entry = imetaFor(src, imeta);
  const image = useImetaImage(src, entry ?? (fallbacks ? { url: src ?? "", fallbacks: [...fallbacks] } : undefined));
  if (image.pending) return <>{placeholder ?? fallback}</>;
  if (!image.src || image.failed) return <>{fallback}</>;
  return <MotionImg {...props} src={image.src} alt={alt ?? entry?.alt ?? ""} onError={image.onError} />;
}
