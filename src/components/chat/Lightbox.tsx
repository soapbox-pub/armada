import { ChevronLeft, ChevronRight, Copy, Download, EyeOff, Loader2, Share2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { MediaFallback } from "@/components/chat/MediaFallback";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ChatImageMenuContext } from "@/contexts/ChatImageMenuContext";
import { useOverlayBack } from "@/hooks/useAndroidBack";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { toast } from "@/hooks/useToast";
import { canCopyImages, writeClipboardImage } from "@/lib/clipboard";
import { downloadUrl, savedDescription } from "@/lib/downloadFile";
import { canShareFiles, shareFile } from "@/lib/share";
import { cn } from "@/lib/utils";
import { FormattedMessage, common, t, useIntl } from "@/i18n";

import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";

export interface LightboxItem extends EncryptedRef {
  /** Video poster frame (NIP-94 `image`/`thumb`); ignored for images. */
  poster?: string;
  /** imeta `content-warning`: swiping onto it shows a cover (other images open isn't consent). */
  spoiler?: boolean;
}

function isVideoItem(item: LightboxItem): boolean {
  return item.mime?.startsWith("video/") ?? false;
}

interface LightboxProps {
  media: LightboxItem[];
  currentIndex: number;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  /** Merged onto the root; e.g. a higher z-index when opened from a dialog. */
  className?: string;
}

const EASING = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";
const DURATION = 280;

/**
 * In percent of the slot's width, not pixels, so rotation/resizes move the
 * neighbours too (a stale pixel offset let the next slot cover the screen).
 */
function slotTransform(delta: number, offsetPx: number): string {
  return offsetPx === 0 ? `translateX(${delta * 100}%)` : `translateX(calc(${delta * 100}% + ${offsetPx}px))`;
}

/**
 * Fullscreen media lightbox ported from Ditto: swipe strip (neighbours stay
 * decoded), zoom/pan, swipe-to-dismiss, keyboard nav. Only current ± 1 slots
 * mount. Every gesture stands down when started on a `<video>`, whose native
 * controls are drags too.
 */
export function Lightbox({ media, currentIndex, onClose, onNext, onPrev, className }: LightboxProps) {
  const intl = useIntl();
  const hasMultiple = media.length > 1;
  const canGoNext = currentIndex < media.length - 1;
  const canGoPrev = currentIndex > 0;

  // Spoilers revealed in this viewing, by URL; the opened item starts revealed.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set([media[currentIndex]?.url ?? ""]));
  const covered = (item: LightboxItem) => !!item.spoiler && !revealed.has(item.url);
  const currentCovered = media[currentIndex] ? covered(media[currentIndex]) : false;

  // System back closes the lightbox instead of navigating.
  useOverlayBack(() => {
    onClose();
    return true;
  });

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // Arrows seek a focused video.
      else if ((e.target as HTMLElement | null)?.closest?.("video")) return;
      else if (e.key === "ArrowRight" && canGoNext) onNext();
      else if (e.key === "ArrowLeft" && canGoPrev) onPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNext, onPrev, canGoNext, canGoPrev]);

  // Gesture state lives in refs with direct DOM mutation (60fps, no re-render).
  const containerRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef(0);
  const verticalOffsetRef = useRef(0);
  const dragX = useRef<number | null>(null);
  const dragY = useRef<number | null>(null);
  const axis = useRef<"h" | "v" | null>(null);
  const animating = useRef(false);
  const childZoomedRef = useRef(false);

  const slotRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const setSlotTransform = useCallback(
    (idx: number, offsetPx: number, transition: string) => {
      const el = slotRefs.current.get(idx);
      if (!el) return;
      el.style.transition = transition;
      el.style.transform = slotTransform(idx - currentIndex, offsetPx);
    },
    [currentIndex],
  );

  const snapAll = useCallback(
    (offsetPx = 0) => {
      slotRefs.current.forEach((_, idx) => setSlotTransform(idx, offsetPx, "none"));
    },
    [setSlotTransform],
  );

  const applyVerticalDismiss = useCallback((offsetY: number, transition: string) => {
    const el = containerRef.current;
    if (!el) return;
    const progress = Math.min(Math.abs(offsetY) / (window.innerHeight * 0.4), 1);
    el.style.transition = transition ? `opacity ${DURATION}ms ${EASING}` : "none";
    el.style.opacity = String(1 - progress * 0.6);
    const content = el.querySelector<HTMLDivElement>("[data-lightbox-content]");
    if (content) {
      content.style.transition = transition;
      content.style.transform = `translateY(${offsetY}px)`;
    }
  }, []);

  const currentIsVideo = media[currentIndex] ? isVideoItem(media[currentIndex]) : false;

  useEffect(() => {
    dragOffsetRef.current = 0;
    snapAll(0);
    // Only image slots report zoom; clear it on a video or a stale lock freezes gestures.
    if (currentIsVideo) childZoomedRef.current = false;
  }, [currentIndex, currentIsVideo, snapAll]);

  useEffect(() => () => {
    animating.current = false;
  }, []);

  const onTouchStart = (e: React.TouchEvent) => {
    if (animating.current) return;
    // Touches on the video player belong to its controls.
    if ((e.target as HTMLElement).closest("video, [data-video-player]")) {
      dragX.current = null;
      dragY.current = null;
      return;
    }
    if (e.touches.length >= 2) {
      dragX.current = null;
      dragY.current = null;
      return;
    }
    dragX.current = e.touches[0].clientX;
    dragY.current = e.touches[0].clientY;
    axis.current = null;
    slotRefs.current.forEach((_, idx) => setSlotTransform(idx, dragOffsetRef.current, "none"));
    applyVerticalDismiss(0, "none");
    verticalOffsetRef.current = 0;
  };

  // Registered non-passively so we can preventDefault().
  const onTouchMoveRef = useRef((_e: TouchEvent) => {});
  onTouchMoveRef.current = (e: TouchEvent) => {
    if (dragX.current === null || dragY.current === null || animating.current) return;
    const dx = e.touches[0].clientX - dragX.current;
    const dy = e.touches[0].clientY - dragY.current;
    if (!axis.current) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      axis.current = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    }
    if (axis.current === "v") {
      if (childZoomedRef.current) return;
      e.preventDefault();
      verticalOffsetRef.current = dy;
      applyVerticalDismiss(dy, "none");
      return;
    }
    if (axis.current !== "h") return;
    if (childZoomedRef.current) return;
    e.preventDefault();
    const atEdge = (dx > 0 && !canGoPrev) || (dx < 0 && !canGoNext);
    dragOffsetRef.current = atEdge ? dx * 0.2 : dx;
    slotRefs.current.forEach((_, idx) => setSlotTransform(idx, dragOffsetRef.current, "none"));
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => onTouchMoveRef.current(e);
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);

  const onTouchEnd = (e: React.TouchEvent) => {
    if (axis.current === "v" && dragY.current !== null && !childZoomedRef.current) {
      const dy = e.changedTouches[0].clientY - dragY.current;
      dragX.current = null;
      dragY.current = null;
      axis.current = null;
      const committed = Math.abs(dy) > window.innerHeight * 0.15;
      if (committed) {
        animating.current = true;
        const targetY = dy > 0 ? window.innerHeight : -window.innerHeight;
        applyVerticalDismiss(targetY, `transform ${DURATION}ms ${EASING}`);
        setTimeout(() => {
          verticalOffsetRef.current = 0;
          onClose();
          animating.current = false;
        }, DURATION);
      } else {
        applyVerticalDismiss(0, `transform ${DURATION}ms ${EASING}`);
        verticalOffsetRef.current = 0;
      }
      return;
    }

    if (dragX.current === null || axis.current !== "h") {
      dragX.current = null;
      dragY.current = null;
      axis.current = null;
      slotRefs.current.forEach((_, idx) => setSlotTransform(idx, 0, `transform ${DURATION}ms ${EASING}`));
      dragOffsetRef.current = 0;
      return;
    }

    const dx = e.changedTouches[0].clientX - dragX.current;
    dragX.current = null;
    dragY.current = null;
    axis.current = null;

    const committed = Math.abs(dx) > window.innerWidth * 0.2;
    const goingNext = dx < 0 && canGoNext && committed;
    const goingPrev = dx > 0 && canGoPrev && committed;

    if (goingNext || goingPrev) {
      animating.current = true;
      const targetOffset = goingNext ? -window.innerWidth : window.innerWidth;
      const transition = `transform ${DURATION}ms ${EASING}`;
      slotRefs.current.forEach((_, idx) => setSlotTransform(idx, targetOffset, transition));
      setTimeout(() => {
        animating.current = false;
        dragOffsetRef.current = 0;
        if (goingNext) onNext();
        else onPrev();
      }, DURATION);
    } else {
      slotRefs.current.forEach((_, idx) => setSlotTransform(idx, 0, `transform ${DURATION}ms ${EASING}`));
      dragOffsetRef.current = 0;
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "IMG" ||
      target.closest("video") ||
      target.closest("button") ||
      target.closest("[data-gallery-topbar]")
    ) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    onClose();
  };

  const visibleIndices = [currentIndex - 1, currentIndex, currentIndex + 1].filter(
    (i) => i >= 0 && i < media.length,
  );

  return createPortal(
    <div
      ref={containerRef}
      className={cn("fixed inset-0 z-[200] animate-in fade-in duration-200", className)}
      onClick={handleBackdropClick}
      // React bubbles through the portal to the message row, whose own menu would
      // open on top of the image's.
      onContextMenu={(e) => e.stopPropagation()}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      <div data-lightbox-content className="absolute inset-0">
        <div
          data-gallery-topbar
          className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-4 py-3 safe-area-top"
        >
          {hasMultiple ? (
            <span className="text-white/80 text-sm font-medium tabular-nums">
              {currentIndex + 1} / {media.length}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">
            {!currentCovered && (
              <>
                <LightboxShareButton item={media[currentIndex]} />
                <LightboxDownloadButton item={media[currentIndex]} />
              </>
            )}
            <button
              type="button"
              aria-label={intl.formatMessage(common.close)}
              title={intl.formatMessage({ id: "lightbox.closeEsc", defaultMessage: "Close (Esc)" })}
              className="p-2.5 touch:p-3 clip-corner-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onClose();
              }}
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {canGoPrev && (
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "lightbox.previous", defaultMessage: "Previous" })}
            title={intl.formatMessage({ id: "lightbox.previous", defaultMessage: "Previous" })}
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-2 touch:p-2.5 clip-corner-lg bg-black/40 text-white/80 hover:text-white hover:bg-black/60 backdrop-blur-sm transition-all hidden sm:flex"
          >
            <ChevronLeft className="size-6" />
          </button>
        )}
        {canGoNext && (
          <button
            type="button"
            aria-label={intl.formatMessage(common.next)}
            title={intl.formatMessage(common.next)}
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-2 touch:p-2.5 clip-corner-lg bg-black/40 text-white/80 hover:text-white hover:bg-black/60 backdrop-blur-sm transition-all hidden sm:flex"
          >
            <ChevronRight className="size-6" />
          </button>
        )}

        <div data-lightbox-strip className="absolute inset-0 overflow-hidden">
          {visibleIndices.map((i) => {
            return (
              <div
                key={media[i].url || i}
                ref={(el) => {
                  if (el) slotRefs.current.set(i, el);
                  else slotRefs.current.delete(i);
                }}
                // Clear the status and nav bars: a tall video's controls sit at the slot's bottom edge.
                className="absolute inset-0 flex items-center justify-center will-change-transform pt-[calc(3.5rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] pb-[calc(1.5rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] px-4 sm:px-12"
                style={{ transform: slotTransform(i - currentIndex, 0) }}
              >
                {covered(media[i]) ? (
                  <button
                    type="button"
                    aria-label={intl.formatMessage({ id: "lightbox.revealSpoiler", defaultMessage: "Reveal spoiler" })}
                    onClick={(e) => {
                      e.stopPropagation();
                      const url = media[i].url;
                      setRevealed((prev) => new Set(prev).add(url));
                    }}
                    className="flex flex-col items-center gap-3 clip-corner-lg bg-white/10 px-8 py-6 text-white transition-colors hover:bg-white/15"
                  >
                    <EyeOff className="size-8" />
                    <span className="text-sm font-bold tracking-wide">
                      <FormattedMessage id="lightbox.spoiler" defaultMessage="SPOILER" />
                    </span>
                    <span className="text-xs text-white/70">
                      <FormattedMessage id="lightbox.tapToReveal" defaultMessage="Tap to reveal" />
                    </span>
                  </button>
                ) : isVideoItem(media[i]) ? (
                  <LightboxVideo video={media[i]} isActive={i === currentIndex} />
                ) : (
                  <LightboxImage
                    image={media[i]}
                    isActive={i === currentIndex}
                    onSwipeBlocked={() => {
                      dragX.current = null;
                      axis.current = null;
                    }}
                    onZoomChange={(zoomed) => {
                      if (i === currentIndex) childZoomedRef.current = zoomed;
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {hasMultiple && media.length <= 10 && (
          <div className="absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bottom-[calc(0.5rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] sm:hidden">
            {media.map((_, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-full transition-all duration-200",
                  i === currentIndex ? "size-2 bg-white" : "size-1.5 bg-white/40",
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Save the current item from its *resolved* source (blob: for encrypted/Buzz
 * media). Native writes to Documents (blob: anchors fail in the WebView);
 * non-CORS hosts fall back to opening the file.
 */
function LightboxDownloadButton({ item }: { item: LightboxItem }) {
  const intl = useIntl();
  const noun = isVideoItem(item) ? "video" : "image";
  const resolved = useResolvedMediaSrc(item);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (downloading || resolved.status !== "ready") return;
      setDownloading(true);
      try {
        const result = await downloadUrl(resolved.src, { nameHint: item.url, mime: item.mime });
        if (result.status === "downloaded") {
          toast({ title: t({ id: "lightbox.saved", defaultMessage: "Saved" }), description: savedDescription(result.location) });
        } else {
          toast({
            title: t({ id: "lightbox.openedInNewTab", defaultMessage: "Opened in a new tab" }),
            description: t(
              {
                id: "lightbox.openedInstead",
                defaultMessage: "{noun, select, video {This video couldn't be saved directly, so it opened instead.} other {This image couldn't be saved directly, so it opened instead.}}",
              },
              { noun },
            ),
          });
        }
      } catch {
        toast({
          title: t({ id: "lightbox.downloadFailed", defaultMessage: "Download failed" }),
          description: t(
            {
              id: "lightbox.saveFailed",
              defaultMessage: "{noun, select, video {Could not save this video. Please try again.} other {Could not save this image. Please try again.}}",
            },
            { noun },
          ),
          variant: "destructive",
        });
      } finally {
        setDownloading(false);
      }
    },
    [downloading, resolved, item.url, item.mime, noun],
  );

  if (resolved.status !== "ready") return null;
  return (
    <button
      type="button"
      aria-label={intl.formatMessage(
        { id: "lightbox.downloadNoun", defaultMessage: "{noun, select, video {Download video} other {Download image}}" },
        { noun },
      )}
      title={intl.formatMessage({ id: "lightbox.download", defaultMessage: "Download" })}
      disabled={downloading}
      className="p-2.5 touch:p-3 clip-corner-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
      onClick={handleDownload}
    >
      {downloading ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" />}
    </button>
  );
}

/**
 * Share the FILE, never the URL (ciphertext or a document-local blob: is
 * useless to recipients). Hidden where the share sheet can't carry files.
 */
function LightboxShareButton({ item }: { item: LightboxItem }) {
  const intl = useIntl();
  const noun = isVideoItem(item) ? "video" : "image";
  const resolved = useResolvedMediaSrc(item);
  const [sharing, setSharing] = useState(false);

  const handleShare = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (sharing || resolved.status !== "ready") return;
      setSharing(true);
      try {
        const shared = await shareFile(resolved.src, {
          nameHint: item.url,
          mime: item.mime,
          dialogTitle: t(
            { id: "lightbox.shareNoun", defaultMessage: "{noun, select, video {Share video} other {Share image}}" },
            { noun },
          ),
        });
        if (!shared) {
          toast({
            title: t(
              { id: "lightbox.shareFailed", defaultMessage: "{noun, select, video {Couldn't share this video} other {Couldn't share this image}}" },
              { noun },
            ),
            description: t({ id: "lightbox.tryDownloading", defaultMessage: "Try downloading it instead." }),
            variant: "destructive",
          });
        }
      } finally {
        setSharing(false);
      }
    },
    [sharing, resolved, item.url, item.mime, noun],
  );

  if (resolved.status !== "ready" || !canShareFiles()) return null;
  return (
    <button
      type="button"
      aria-label={intl.formatMessage(
        { id: "lightbox.shareNoun", defaultMessage: "{noun, select, video {Share video} other {Share image}}" },
        { noun },
      )}
      title={intl.formatMessage(common.share)}
      disabled={sharing}
      className="p-2.5 touch:p-3 clip-corner-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
      onClick={handleShare}
    >
      {sharing ? <Loader2 className="size-5 animate-spin" /> : <Share2 className="size-5" />}
    </button>
  );
}

/**
 * A lightbox video via {@link VideoPlayer}. No zoom/pan; starts paused and
 * pauses when no longer current.
 */
function LightboxVideo({ video, isActive }: { video: LightboxItem; isActive: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!isActive) videoRef.current?.pause();
  }, [isActive]);

  // Context crosses the portal: without a fresh provider a long-press would open
  // the message's action sheet behind the lightbox, locking pointer events.
  return (
    <ChatImageMenuContext.Provider value={null}>
      <div className="w-full h-full flex items-center justify-center">
        <VideoPlayer
          videoRef={videoRef}
          src={video.url}
          poster={video.poster}
          mime={video.mime}
          dim={video.dim}
          blurhash={video.blurhash}
          encryption={video.encryption}
          fallbacks={video.fallbacks}
          // The top bar already has Download and Share.
          hideActionsMenu
          // Fill the slot without the inline player's framed card.
          className="my-0 w-full max-w-4xl max-h-full border-0 rounded-none bg-transparent"
        />
      </div>
    </ChatImageMenuContext.Provider>
  );
}

/**
 * The image's own menu actions (chat image menu minus "Open"), each gated like
 * its chat counterpart.
 */
async function saveLightboxImage(src: string, image: EncryptedRef): Promise<void> {
  try {
    const result = await downloadUrl(src, { nameHint: image.url, mime: image.mime });
    toast(
      result.status === "downloaded"
        ? { title: t({ id: "lightbox.saved", defaultMessage: "Saved" }), description: savedDescription(result.location) }
        : {
            title: t({ id: "lightbox.openedInNewTab", defaultMessage: "Opened in a new tab" }),
            description: t(
              {
                id: "lightbox.openedInstead",
                defaultMessage: "{noun, select, video {This video couldn't be saved directly, so it opened instead.} other {This image couldn't be saved directly, so it opened instead.}}",
              },
              { noun: "image" },
            ),
          },
    );
  } catch {
    toast({
      title: t({ id: "lightbox.downloadFailed", defaultMessage: "Download failed" }),
      description: t(
        {
          id: "lightbox.saveFailed",
          defaultMessage: "{noun, select, video {Could not save this video. Please try again.} other {Could not save this image. Please try again.}}",
        },
        { noun: "image" },
      ),
      variant: "destructive",
    });
  }
}

async function shareLightboxImage(src: string, image: EncryptedRef): Promise<void> {
  const shared = await shareFile(src, {
    nameHint: image.url,
    mime: image.mime,
    dialogTitle: t(
      { id: "lightbox.shareNoun", defaultMessage: "{noun, select, video {Share video} other {Share image}}" },
      { noun: "image" },
    ),
  });
  if (!shared) {
    toast({
      title: t(
        { id: "lightbox.shareFailed", defaultMessage: "{noun, select, video {Couldn't share this video} other {Couldn't share this image}}" },
        { noun: "image" },
      ),
      description: t({ id: "lightbox.tryDownloading", defaultMessage: "Try downloading it instead." }),
      variant: "destructive",
    });
  }
}

async function copyLightboxImage(src: string): Promise<void> {
  try {
    await writeClipboardImage(src);
    toast({
      title: t(common.copied),
      description: t({ id: "lightbox.copiedDescription", defaultMessage: "The image is on your clipboard." }),
    });
  } catch {
    toast({
      title: t({ id: "lightbox.copyFailed", defaultMessage: "Couldn't copy this image" }),
      description: t({ id: "lightbox.copyFailedDescription", defaultMessage: "Try downloading or sharing it instead." }),
      variant: "destructive",
    });
  }
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function LightboxImage({
  image,
  isActive,
  onSwipeBlocked,
  onZoomChange,
}: {
  image: EncryptedRef;
  isActive: boolean;
  onSwipeBlocked?: () => void;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const intl = useIntl();
  const { resolved, onError, failed, reset } = useMediaWithFallback(image);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scale = useRef(1);
  const panX = useRef(0);
  const panY = useRef(0);

  const pinchStart = useRef<
    { dist: number; midX: number; midY: number; scale: number; panX: number; panY: number } | null
  >(null);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastTap = useRef(0);
  const mouseDrag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const notifyZoom = useCallback(() => {
    onZoomChange?.(scale.current > 1);
  }, [onZoomChange]);

  const applyTransform = useCallback((animated = false) => {
    const el = wrapRef.current;
    if (!el) return;
    el.style.transition = animated ? "transform 0.25s ease" : "none";
    el.style.transform = `translate(${panX.current}px, ${panY.current}px) scale(${scale.current})`;
  }, []);

  const clampPan = useCallback((s = scale.current) => {
    const el = imgRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const iw = el.offsetWidth * s;
    const ih = el.offsetHeight * s;
    const cw = wrap.parentElement?.offsetWidth ?? window.innerWidth;
    const ch = wrap.parentElement?.offsetHeight ?? window.innerHeight;
    const maxX = Math.max(0, (iw - cw) / 2);
    const maxY = Math.max(0, (ih - ch) / 2);
    panX.current = Math.max(-maxX, Math.min(maxX, panX.current));
    panY.current = Math.max(-maxY, Math.min(maxY, panY.current));
  }, []);

  useEffect(() => {
    scale.current = 1;
    panX.current = 0;
    panY.current = 0;
    applyTransform();
    notifyZoom();
  }, [image.url, applyTransform, notifyZoom]);

  function dist(t: React.TouchList | TouchList) {
    const dx = t[1].clientX - t[0].clientX;
    const dy = t[1].clientY - t[0].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchStart.current = {
        dist: dist(e.touches),
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        scale: scale.current,
        panX: panX.current,
        panY: panY.current,
      };
      panStart.current = null;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        if (scale.current > 1) {
          scale.current = 1;
          panX.current = 0;
          panY.current = 0;
        } else {
          scale.current = 2.5;
          const rect = wrapRef.current?.getBoundingClientRect();
          if (rect) {
            const cx = e.touches[0].clientX - rect.left - rect.width / 2;
            const cy = e.touches[0].clientY - rect.top - rect.height / 2;
            panX.current = (-cx * (scale.current - 1)) / scale.current;
            panY.current = (-cy * (scale.current - 1)) / scale.current;
            clampPan();
          }
        }
        applyTransform(true);
        notifyZoom();
      }
      lastTap.current = now;
      // After the double-tap above, so a finger held from the zooming tap pans at once.
      panStart.current = scale.current > 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, panX: panX.current, panY: panY.current }
        : null;
    }
  };

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStart.current) {
        e.preventDefault();
        const p = pinchStart.current;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (p.scale * dist(e.touches)) / p.dist));
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        scale.current = newScale;
        panX.current = p.panX + (midX - p.midX);
        panY.current = p.panY + (midY - p.midY);
        clampPan(newScale);
        applyTransform();
        notifyZoom();
      } else if (e.touches.length === 1 && panStart.current && scale.current > 1) {
        e.preventDefault();
        const p = panStart.current;
        panX.current = p.panX + (e.touches[0].clientX - p.x);
        panY.current = p.panY + (e.touches[0].clientY - p.y);
        clampPan();
        applyTransform();
        onSwipeBlocked?.();
      }
    },
    [applyTransform, clampPan, notifyZoom, onSwipeBlocked],
  );

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchStart.current = null;
    if (e.touches.length === 0) {
      panStart.current = null;
      if (scale.current < MIN_SCALE) {
        scale.current = MIN_SCALE;
        panX.current = 0;
        panY.current = 0;
        applyTransform(true);
        notifyZoom();
      } else {
        clampPan();
        applyTransform(true);
      }
    }
  };

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        scale.current = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.current * factor));
        if (scale.current === MIN_SCALE) {
          panX.current = 0;
          panY.current = 0;
        } else {
          clampPan();
        }
        applyTransform();
        notifyZoom();
      } else if (scale.current > 1) {
        e.preventDefault();
        panX.current -= e.deltaX;
        panY.current -= e.deltaY;
        clampPan();
        applyTransform();
      }
    },
    [applyTransform, clampPan, notifyZoom],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale.current <= 1) return;
    e.preventDefault();
    mouseDrag.current = { x: e.clientX, y: e.clientY, panX: panX.current, panY: panY.current };
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!mouseDrag.current) return;
    panX.current = mouseDrag.current.panX + (e.clientX - mouseDrag.current.x);
    panY.current = mouseDrag.current.panY + (e.clientY - mouseDrag.current.y);
    clampPan();
    applyTransform();
  };
  const handleMouseUp = () => {
    if (!mouseDrag.current) return;
    mouseDrag.current = null;
    clampPan();
    applyTransform(true);
  };

  // Non-passive touchmove/wheel so we can preventDefault().
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tm = (e: TouchEvent) => handleTouchMove(e);
    const wh = (e: WheelEvent) => handleWheel(e);
    el.addEventListener("touchmove", tm, { passive: false });
    el.addEventListener("wheel", wh, { passive: false });
    return () => {
      el.removeEventListener("touchmove", tm);
      el.removeEventListener("wheel", wh);
    };
  }, [handleTouchMove, handleWheel]);

  // Built once the source resolves.
  const resolvedSrc = resolved.status === "ready" ? resolved.src : null;
  const actions: { id: string; label: string; icon: typeof Copy; onSelect: () => void }[] = [];
  if (resolvedSrc) {
    actions.push({
      id: "img-save",
      label: intl.formatMessage({ id: "lightbox.saveImage", defaultMessage: "Save image" }),
      icon: Download,
      onSelect: () => void saveLightboxImage(resolvedSrc, image),
    });
    if (canShareFiles()) {
      actions.push({
        id: "img-share",
        label: intl.formatMessage(
          { id: "lightbox.shareNoun", defaultMessage: "{noun, select, video {Share video} other {Share image}}" },
          { noun: "image" },
        ),
        icon: Share2,
        onSelect: () => void shareLightboxImage(resolvedSrc, image),
      });
    }
    if (canCopyImages()) {
      actions.push({
        id: "img-copy",
        label: intl.formatMessage({ id: "lightbox.copyImage", defaultMessage: "Copy image" }),
        icon: Copy,
        onSelect: () => void copyLightboxImage(resolvedSrc),
      });
    }
  }

  const inner = (
    <div
      ref={containerRef}
      // Every gesture here is ours: the browser must not claim a pan, pinch or double-tap zoom.
      className="w-full h-full flex items-center justify-center overflow-hidden touch-none"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: scale.current > 1 ? "grab" : "default" }}
    >
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <MediaFallback url={image.url} onRetry={reset} kind="image" className="bg-muted" />
        </div>
      )}

      {isActive && !failed && (resolved.status === "loading" || !loaded) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {image.blurhash ? (
            <BlurhashCanvas
              hash={image.blurhash}
              className="absolute inset-0 opacity-40"
              style={{ objectFit: "contain" }}
            />
          ) : (
            <div className="size-8 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
          )}
        </div>
      )}

      <div
        ref={wrapRef}
        style={{
          transformOrigin: "center center",
          willChange: "transform",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {resolved.status === "ready" && (
          <img
            ref={imgRef}
            src={resolved.src}
            alt=""
            draggable={false}
            className={cn(
              "block max-w-full max-h-full object-contain select-none transition-opacity duration-300",
              loaded ? "opacity-100" : "opacity-0",
            )}
            onLoad={() => setLoaded(true)}
            onError={onError}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>
  );

  if (actions.length === 0) return inner;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{inner}</ContextMenuTrigger>
      {/* Above the lightbox's own z-[200] backdrop, or it opens behind it. */}
      <ContextMenuContent className="w-48" style={{ zIndex: 210 }}>
        {actions.map((action) => (
          <ContextMenuItem key={action.id} onSelect={action.onSelect}>
            <action.icon className="size-4" />
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
