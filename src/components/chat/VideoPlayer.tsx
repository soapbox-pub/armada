import { Download, Expand, Loader2, Pause, Play, Share2, Shrink, Volume1, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { MediaFallback } from "@/components/chat/MediaFallback";
import { MediaSpoilerCover } from "@/components/chat/MediaSpoiler";
import { useChatImageMenu } from "@/contexts/ChatImageMenuContext";
import { useRoutedCandidates } from "@/hooks/useBlossomCandidates";
import { useLongPress } from "@/hooks/useLongPress";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { usePlayerControls } from "@/hooks/usePlayerControls";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { useVideoThumbnail } from "@/hooks/useVideoThumbnail";
import { toast } from "@/hooks/useToast";
import { isValidBlurhash } from "@/lib/blurhash";
import { BLANK_POSTER } from "@/lib/blankPoster";
import { downloadUrl, savedDescription } from "@/lib/downloadFile";
import { formatTime } from "@/lib/formatTime";
import { useStillMedia } from "@/lib/reducedMotion";
import { companionEncryption } from "@/lib/imeta";
import { canShareFiles, shareFile } from "@/lib/share";
import { cn } from "@/lib/utils";
import { t, useIntl } from "@/i18n";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ImetaEncryption } from "@/lib/imeta";
import type { MutableRefObject, Ref } from "react";
import { holdScrollThroughFullscreen } from "@/lib/holdScrollThroughFullscreen";

interface VideoPlayerProps {
  src: string;
  /** From the imeta `thumb`/`image` field. */
  poster?: string;
  /** Sender-declared alternative sources (imeta `fallback`), same key and nonce. */
  fallbacks?: string[];
  /** imeta `dim`, e.g. "1280x720". */
  dim?: string;
  blurhash?: string;
  /** Used as the decrypted Blob's type. */
  mime?: string;
  /** AES-GCM decryption params for client-encrypted (Concord/Vector) blobs. */
  encryption?: ImetaEncryption;
  title?: string;
  artist?: string;
  autoPlay?: boolean;
  /** Tenor/Giphy-style `.mp4` that is really a GIF: autoplay, muted, chromeless. */
  gif?: boolean;
  /** Hide the ⋯ Download/Share menu when the host offers its own (lightbox). */
  hideActionsMenu?: boolean;
  videoRef?: Ref<HTMLVideoElement>;
  /** imeta `content-warning`. */
  spoiler?: boolean;
  /** imeta `alt`. */
  alt?: string;
  className?: string;
}

function parseDim(dim: string | undefined): { width: number; height: number } | undefined {
  if (!dim) return undefined;
  const match = dim.match(/^(\d+)x(\d+)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!width || !height) return undefined;
  return { width, height };
}

/** WebKit's prefixed fullscreen surface (Safari before 16.4, iPhone's video-only mode). */
type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null;
}

/** The bare `<video>` is fullscreen (native controls; their taps arrive as element clicks). */
function videoIsNativeFullscreen(video: HTMLVideoElement): boolean {
  return fullscreenElement() === video || !!(video as WebkitVideo).webkitDisplayingFullscreen;
}

/**
 * Inline video with custom chrome ported from Ditto. Placeholders are plain
 * `<img>`s (the element carries a transparent {@link BLANK_POSTER}) so the
 * WebView never paints its gray placeholder. Encrypted media is decrypted to an
 * object URL, which is also what Download/Share hands the OS (never ciphertext).
 */
export function VideoPlayer({
  src,
  poster,
  dim,
  blurhash,
  mime,
  encryption,
  fallbacks,
  title,
  artist,
  autoPlay,
  gif = false,
  hideActionsMenu = false,
  videoRef: forwardedRef,
  spoiler = false,
  alt,
  className,
}: VideoPlayerProps) {
  const intl = useIntl();
  const [revealed, setRevealed] = useState(false);
  const spoilerCover = spoiler && !revealed ? <MediaSpoilerCover onReveal={() => setRevealed(true)} /> : null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Still media: a GIF holds its first frame, playing on hover or a tap.
  const still = useStillMedia();
  const [gifPlaying, setGifPlaying] = useState(false);

  // The lightbox pauses the element itself via a forwarded ref.
  const setVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      videoRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) (forwardedRef as MutableRefObject<HTMLVideoElement | null>).current = node;
    },
    [forwardedRef],
  );

  const { resolved, onError, failed, fallbackProps } = useMediaWithFallback({ url: src, encryption, mime, fallbacks });
  const ready = resolved.status === "ready";
  const mediaSrc = ready ? resolved.src : "";

  // Encrypted posters share the video's key/nonce (not `ox`); same media policy.
  const posterEncryption = useMemo(() => companionEncryption(encryption), [encryption]);
  const posterRoute = useRoutedCandidates(poster || undefined);
  const posterCandidate = posterRoute.sources[0];
  const resolvedPoster = useResolvedMediaSrc({
    url: posterCandidate ?? "",
    encryption: posterEncryption,
    mime: "image/jpeg",
  });
  const posterSrc = posterCandidate && resolvedPoster.status === "ready" ? resolvedPoster.src : undefined;

  // No poster: generate one from the first frame (Android WebView paints none).
  // Cached under the pre-resolution `src` (object URLs are per-decrypt).
  const generatedPoster = useVideoThumbnail({
    src: gif ? "" : mediaSrc,
    identity: src,
    poster: posterSrc,
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);
  // Without `dim`: from the thumbnail or video metadata; 16:9 until known.
  const [discoveredAspect, setDiscoveredAspect] = useState<string | undefined>(undefined);

  const dimensions = parseDim(dim);
  const aspectRatio = dimensions
    ? `${dimensions.width} / ${dimensions.height}`
    : (discoveredAspect ?? "16 / 9");

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const { showControls, revealControls, scheduleHide, isMuted, volume, toggleMute, handleVolumeChange } =
    usePlayerControls({ mediaRef: videoRef, containerRef, isPlaying });

  // Document listeners attach only from this player's own button press until it
  // exits, rather than two per mounted player.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [watchingFullscreen, setWatchingFullscreen] = useState(false);
  useEffect(() => {
    if (!watchingFullscreen) return;
    const update = () => {
      const inside = !!containerRef.current && fullscreenElement() === containerRef.current;
      setIsFullscreen(inside);
      if (!inside) setWatchingFullscreen(false);
    };
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("webkitfullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("webkitfullscreenchange", update);
    };
  }, [watchingFullscreen]);

  // Mirrors message-image Save/Share. Inert outside a message row (the lightbox
  // clears it) and in fullscreen (the sheet would open behind it).
  const chatMenu = useChatImageMenu();
  const mediaActions = useMemo<MessageActionItem[]>(() => {
    if (gif || !mediaSrc) return [];
    const list: MessageActionItem[] = [
      { id: "vid-save", label: intl.formatMessage({ id: "videoPlayer.saveVideo", defaultMessage: "Save video" }), icon: Download, onSelect: () => void saveVideo(mediaSrc, { url: src, mime }) },
    ];
    if (canShareFiles()) {
      list.push({
        id: "vid-share",
        label: intl.formatMessage({ id: "videoPlayer.shareVideo", defaultMessage: "Share video" }),
        icon: Share2,
        onSelect: () => void shareVideo(mediaSrc, { url: src, mime }),
      });
    }
    return list;
  }, [gif, mediaSrc, src, mime, intl]);
  const longPress = useLongPress(
    chatMenu?.isTouch && mediaActions.length > 0 && !isFullscreen
      ? () => {
          if (!fullscreenElement()) chatMenu.openSheet(mediaActions);
        }
      : undefined,
  );

  // Desktop: stage actions and bubble to the row's context menu. Touch: suppress the callout.
  const handleContextMenu = (e: React.MouseEvent) => {
    // A spoiler's cover is the only way to the video; no Save/Share around it.
    if (spoilerCover) return;
    longPress.onContextMenu(e);
    if (mediaActions.length === 0) return;
    if (chatMenu?.isTouch) e.preventDefault();
    else if (chatMenu) chatMenu.stage(mediaActions);
  };

  const autoplayAttempted = useRef(false);
  useEffect(() => {
    if (gif || !autoPlay || !mediaSrc) return;
    autoplayAttempted.current = false;

    const video = videoRef.current;
    if (!video) return;

    const attemptPlay = () => {
      if (autoplayAttempted.current) return;
      autoplayAttempted.current = true;
      video.muted = true;
      video.play().catch(() => {
        // Autoplay blocked by browser — leave paused, user can click to play.
      });
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      attemptPlay();
    } else {
      video.addEventListener("loadeddata", attemptPlay, { once: true });
      return () => video.removeEventListener("loadeddata", attemptPlay);
    }
  }, [gif, autoPlay, mediaSrc]);

  // Media Session API — OS lock-screen / notification controls.
  useEffect(() => {
    if (gif) return;
    if (!("mediaSession" in navigator)) return;
    if (!hasStarted) return;
    const video = videoRef.current;
    if (!video) return;

    const art = generatedPoster || posterSrc;
    const artwork: MediaImage[] = art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || t({ id: "videoPlayer.video", defaultMessage: "Video" }),
      artist: artist || "",
      artwork,
    });

    navigator.mediaSession.setActionHandler("play", () => video.play().catch(() => {}));
    navigator.mediaSession.setActionHandler("pause", () => video.pause());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) video.currentTime = details.seekTime;
    });
    navigator.mediaSession.setActionHandler("previoustrack", null);
    navigator.mediaSession.setActionHandler("nexttrack", null);

    return () => {
      if (!("mediaSession" in navigator)) return;
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  }, [gif, hasStarted, title, artist, posterSrc, generatedPoster]);

  useEffect(() => {
    if (gif || !("mediaSession" in navigator) || !hasStarted) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [gif, isPlaying, hasStarted]);

  useEffect(() => {
    if (gif || !("mediaSession" in navigator) || !hasStarted || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: videoRef.current?.playbackRate ?? 1,
        position: Math.min(currentTime, duration),
      });
    } catch {
      /* setPositionState may throw on some browsers */
    }
  }, [gif, currentTime, duration, hasStarted]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  };

  // Fullscreen the whole player so our chrome comes along; iPhone Safari (video-only)
  // falls back to the native player.
  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const container = containerRef.current as WebkitElement | null;
    const video = videoRef.current as WebkitVideo | null;
    if (!container) return;
    // Older engines return nothing rather than a promise, hence the `?.`.
    if (fullscreenElement() === container) {
      const doc = document as WebkitDocument;
      if (document.exitFullscreen) void (document.exitFullscreen() as Promise<void> | undefined)?.catch(() => {});
      else doc.webkitExitFullscreen?.();
      return;
    }
    const nativeFallback = () => {
      setWatchingFullscreen(false);
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else void (video?.requestFullscreen?.() as Promise<void> | undefined)?.catch(() => {});
    };
    setWatchingFullscreen(true);
    holdScrollThroughFullscreen(container);
    if (container.requestFullscreen) {
      void (container.requestFullscreen({ navigationUI: "hide" }) as Promise<void> | undefined)?.catch(nativeFallback);
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    } else {
      nativeFallback();
    }
  };

  const handleSeek = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    const bar = progressRef.current;
    if (!video || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
  };

  const handleVideoClick = (e: React.MouseEvent) => {
    // Swallow the click ending a long-press so it doesn't toggle playback.
    longPress.onClick(e);
    if (e.defaultPrevented) return;
    e.stopPropagation();
    // Native fullscreen controls act on the element themselves; don't double-toggle.
    if (videoRef.current && videoIsNativeFullscreen(videoRef.current)) return;
    if (!hasStarted) {
      videoRef.current?.play();
      return;
    }
    togglePlay(e);
    revealControls();
  };

  if (gif) {
    return (
      <div
        className={cn("relative my-1.5 clip-corner-lg overflow-hidden max-w-xs bg-transparent", className)}
        style={{ aspectRatio }}
        onClick={(e) => {
          e.stopPropagation();
          if (!still) return;
          const video = videoRef.current;
          if (video?.paused) void video.play().catch(() => {});
          else video?.pause();
        }}
        onPointerEnter={still ? (e) => e.pointerType === "mouse" && void videoRef.current?.play().catch(() => {}) : undefined}
        onPointerLeave={still ? (e) => e.pointerType === "mouse" && videoRef.current?.pause() : undefined}
      >
        {spoilerCover}
        {ready && still && !gifPlaying && !spoilerCover && (
          <span aria-hidden className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
            <Play className="size-3.5 fill-current" />
          </span>
        )}
        {ready ? (
          <video
            ref={setVideoRef}
            src={mediaSrc}
            autoPlay={!still}
            onPlay={() => setGifPlaying(true)}
            onPause={() => setGifPlaying(false)}
            loop
            muted
            playsInline
            disablePictureInPicture
            preload="metadata"
            aria-label={spoilerCover ? undefined : alt}
            className="w-full h-full object-contain"
            onError={onError}
          />
        ) : failed ? (
          <MediaFallback {...fallbackProps} kind="gif" />
        ) : (
          <div className="relative w-full h-full flex items-center justify-center">
            {isValidBlurhash(blurhash) && (
              <BlurhashCanvas hash={blurhash} className="absolute inset-0 w-full h-full" />
            )}
            <Loader2 className="relative size-6 animate-spin text-white/80" />
          </div>
        )}
      </div>
    );
  }

  if (failed) {
    return <MediaFallback {...fallbackProps} kind="video" />;
  }

  return (
    <div
      ref={containerRef}
      data-video-player
      className={cn(
        "relative my-1.5 clip-corner-lg overflow-hidden max-w-md bg-black group",
        className,
        isFullscreen && "m-0 w-full h-full max-w-none max-h-none rounded-none [clip-path:none] bg-black",
      )}
      style={isFullscreen ? undefined : { aspectRatio }}
      onMouseMove={revealControls}
      onMouseLeave={() => {
        if (isPlaying) scheduleHide();
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={handleContextMenu}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
    >
      {spoilerCover}

      {isValidBlurhash(blurhash) && !hasStarted && !(generatedPoster && posterLoaded) && (
        <BlurhashCanvas hash={blurhash} className="absolute inset-0 w-full h-full" />
      )}

      <video
        ref={setVideoRef}
        // An empty string would make the element load the page URL itself.
        src={mediaSrc || undefined}
        aria-label={spoilerCover ? undefined : alt}
        // Keeps the WebView from painting its own gray placeholder.
        poster={BLANK_POSTER}
        className={cn(
          "absolute inset-0 w-full h-full cursor-pointer",
          isFullscreen ? "object-contain" : "object-cover",
          "fullscreen:object-contain fullscreen:static fullscreen:max-h-none fullscreen:h-full fullscreen:w-full",
          // Hidden while the thumbnail covers it; revealed on playback or first frame.
          "transition-opacity duration-150",
          hasStarted || (videoReady && !generatedPoster) ? "opacity-100" : "opacity-0",
        )}
        playsInline
        loop
        preload="metadata"
        {...({ "webkit-playsinline": "true" } as React.HTMLAttributes<HTMLVideoElement>)}
        {...({ "x-webkit-airplay": "allow" } as React.HTMLAttributes<HTMLVideoElement>)}
        onClick={handleVideoClick}
        onPlay={() => {
          setIsPlaying(true);
          setHasStarted(true);
        }}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => {
          const video = videoRef.current;
          if (!video) return;
          setDuration(video.duration ?? 0);
          if (!dimensions && video.videoWidth > 0 && video.videoHeight > 0) {
            setDiscoveredAspect((prev) => prev ?? `${video.videoWidth} / ${video.videoHeight}`);
          }
        }}
        onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
        onLoadedData={() => setVideoReady(true)}
        onError={onError}
      />

      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="size-6 animate-spin text-white/80" />
        </div>
      )}

      {generatedPoster && !hasStarted && (
        <img
          src={generatedPoster}
          alt=""
          aria-hidden
          className={cn(
            "absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-150",
            posterLoaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={(e) => {
            setPosterLoaded(true);
            const img = e.currentTarget;
            if (!dimensions && img.naturalWidth > 0 && img.naturalHeight > 0) {
              setDiscoveredAspect((prev) => prev ?? `${img.naturalWidth} / ${img.naturalHeight}`);
            }
          }}
          decoding="async"
        />
      )}

      {/* Available before playback, so a video can be saved without playing it. */}
      {ready && !hideActionsMenu && !spoilerCover && (
        <div
          className={cn(
            "absolute top-2 right-2 z-10 transition-opacity duration-200",
            showControls || !hasStarted ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <VideoDownloadButton src={resolved.src} nameHint={src} mime={mime} />
        </div>
      )}

      {/* Only once there's a loaded poster or decoded frame behind it. */}
      {ready && !hasStarted && (videoReady || posterLoaded) && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
          onClick={handleVideoClick}
        >
          <div className="size-16 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm">
            <Play className="size-8 text-white ml-1" fill="white" />
          </div>
        </div>
      )}

      {hasStarted && (
        <div
          className={cn(
            "absolute bottom-0 left-0 right-0 transition-opacity duration-200",
            "bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-8 pb-2 px-3",
            // Clear the home indicator and a landscape notch in fullscreen. On
            // Android the hidden navigation bar reads as no inset, but its
            // swipe-up gesture zone is still there: touch screens keep clear of it.
            isFullscreen &&
              "pb-[max(0.5rem,env(safe-area-inset-bottom))] [@media(pointer:coarse)]:pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]",
            showControls ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <div
            ref={progressRef}
            className="w-full h-1 bg-white/30 rounded-full cursor-pointer mb-2 group/progress"
            onClick={handleSeek}
          >
            <div className="h-full bg-primary rounded-full relative" style={{ width: `${progress}%` }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 size-3 bg-primary rounded-full opacity-0 group-hover/progress:opacity-100 transition-opacity" />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="text-white hover:text-white/80 transition-colors"
              aria-label={isPlaying ? intl.formatMessage({ id: "videoPlayer.pause", defaultMessage: "Pause" }) : intl.formatMessage({ id: "videoPlayer.play", defaultMessage: "Play" })}
            >
              {isPlaying ? (
                <Pause className="size-5" fill="white" />
              ) : (
                <Play className="size-5 ml-0.5" fill="white" />
              )}
            </button>

            <div className="flex items-center gap-1.5 group/vol">
              <button
                type="button"
                onClick={toggleMute}
                className="text-white hover:text-white/80 transition-colors shrink-0"
                aria-label={isMuted ? intl.formatMessage({ id: "videoPlayer.unmute", defaultMessage: "Unmute" }) : intl.formatMessage({ id: "videoPlayer.mute", defaultMessage: "Mute" })}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="size-5" />
                ) : volume < 0.5 ? (
                  <Volume1 className="size-5" />
                ) : (
                  <Volume2 className="size-5" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                onClick={(e) => e.stopPropagation()}
                aria-label={intl.formatMessage({ id: "videoPlayer.volume", defaultMessage: "Volume" })}
                className={cn(
                  "w-0 opacity-0 group-hover/vol:w-16 group-hover/vol:opacity-100 group-focus-within/vol:w-16 group-focus-within/vol:opacity-100",
                  "transition-all duration-200 cursor-pointer accent-white h-1",
                )}
              />
            </div>

            <span className="text-white text-xs tabular-nums min-w-0">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div className="flex-1" />

            <button
              type="button"
              onClick={handleFullscreen}
              className="text-white hover:text-white/80 transition-colors"
              aria-label={isFullscreen ? intl.formatMessage({ id: "videoPlayer.exitFullscreen", defaultMessage: "Exit fullscreen" }) : intl.formatMessage({ id: "videoPlayer.fullscreen", defaultMessage: "Fullscreen" })}
            >
              {isFullscreen ? <Shrink className="size-[18px]" /> : <Expand className="size-[18px]" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Save from the resolved (decrypted) source, mirroring the lightbox's download.
 * Non-CORS hosts fall back to opening the file ({@link downloadUrl}).
 */
async function saveVideo(src: string, ref: { url: string; mime?: string }): Promise<void> {
  try {
    const result = await downloadUrl(src, { nameHint: ref.url, mime: ref.mime });
    toast(
      result.status === "downloaded"
        ? { title: t({ id: "videoPlayer.saved", defaultMessage: "Saved" }), description: savedDescription(result.location) }
        : {
            title: t({ id: "videoPlayer.openedInTab", defaultMessage: "Opened in a new tab" }),
            description: t({ id: "videoPlayer.openedInTabDescription", defaultMessage: "This video couldn't be saved directly, so it opened instead." }),
          },
    );
  } catch {
    toast({
      title: t({ id: "videoPlayer.downloadFailed", defaultMessage: "Download failed" }),
      description: t({ id: "videoPlayer.downloadFailedDescription", defaultMessage: "Could not save this video. Please try again." }),
      variant: "destructive",
    });
  }
}

/** Share the file, never the URL. */
async function shareVideo(src: string, ref: { url: string; mime?: string }): Promise<void> {
  const shared = await shareFile(src, { nameHint: ref.url, mime: ref.mime, dialogTitle: t({ id: "videoPlayer.shareVideo", defaultMessage: "Share video" }) });
  if (!shared) {
    toast({
      title: t({ id: "videoPlayer.shareFailed", defaultMessage: "Couldn't share this video" }),
      description: t({ id: "videoPlayer.shareFailedDescription", defaultMessage: "Try downloading it instead." }),
      variant: "destructive",
    });
  }
}

function VideoDownloadButton({ src, nameHint, mime }: { src: string; nameHint: string; mime?: string }) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);

  const handleDownload = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy(true);
      try {
        await saveVideo(src, { url: nameHint, mime });
      } finally {
        setBusy(false);
      }
    },
    [busy, src, nameHint, mime],
  );

  return (
    <button
      type="button"
      aria-label={intl.formatMessage({ id: "videoPlayer.downloadVideo", defaultMessage: "Download video" })}
      title={intl.formatMessage({ id: "videoPlayer.download", defaultMessage: "Download" })}
      disabled={busy}
      onClick={handleDownload}
      className="size-9 touch:size-11 clip-corner-lg bg-black/60 text-white flex items-center justify-center backdrop-blur-sm hover:bg-black/80 transition-colors disabled:opacity-60 disabled:cursor-wait"
    >
      {busy ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" />}
    </button>
  );
}
