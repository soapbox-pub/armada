import { useCallback, useState } from "react";

import { emojify } from "@/components/chat/emojify";
import { useImageFallback } from "@/hooks/useBlossomCandidates";
import { buildEmojiMap } from "@/lib/customEmoji";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";
import { MotionImg } from "@/components/ui/MotionImg";

const PIXEL_ART_MAX = 16;

interface CustomEmojiImgProps {
  name: string;
  url: string;
  className?: string;
  /** Rendered when the image fails (default: nothing, not a broken icon). */
  fallback?: React.ReactNode;
}

/** A NIP-30 custom emoji; pixelated scaling at ≤16×16 natural size. */
export function CustomEmojiImg({
  name,
  url,
  className = "inline h-[1.2em] w-[1.2em] object-contain align-text-bottom",
  fallback = null,
}: CustomEmojiImgProps) {
  const [pixelated, setPixelated] = useState(false);
  // Usually Blossom blobs: try the viewer's other servers first.
  const { src, onError, failed } = useImageFallback(url);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalWidth <= PIXEL_ART_MAX && img.naturalHeight <= PIXEL_ART_MAX) {
      setPixelated(true);
    }
  }, []);

  // Never render loopback/private URLs: they trigger Chrome's Local Network
  // Access prompt for every viewer. Policy-held emoji also show the fallback.
  if (failed || !src || isLocalNetworkUrl(url)) return <>{fallback}</>;

  return (
    <MotionImg
      src={src}
      alt={`:${name}:`}
      title={`:${name}:`}
      className={className}
      style={pixelated ? { imageRendering: "pixelated" } : undefined}
      loading="lazy"
      decoding="async"
      onLoad={handleLoad}
      onError={onError}
    />
  );
}

interface EmojifiedTextProps {
  children: string;
  tags: string[][];
  imgClassName?: string;
}

/** Renders text with NIP-30 custom emoji shortcodes replaced by inline images. */
export function EmojifiedText({ children, tags, imgClassName }: EmojifiedTextProps) {
  const emojiMap = buildEmojiMap(tags);
  if (emojiMap.size === 0) return <>{children}</>;
  return <>{emojify(children, emojiMap, imgClassName)}</>;
}
