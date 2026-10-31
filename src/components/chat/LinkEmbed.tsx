import { Check, Copy, ExternalLink, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { InstagramEmbed } from "@/components/chat/InstagramEmbed";
import { Lightbox, type LightboxItem } from "@/components/chat/Lightbox";
import { TweetEmbed } from "@/components/chat/TweetEmbed";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import { toast } from "@/hooks/useToast";
import { useLinkPreview, useRichEmbed } from "@/hooks/useLinkPreview";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { writeClipboardText } from "@/lib/clipboard";
import { useEmbedPauseEpoch } from "@/lib/embedPause";
import {
  extractInstagramShortcode,
  extractSpotifyEmbed,
  extractStreamableId,
  extractTweetId,
  extractYouTubeId,
  giphyMp4FromPageUrl,
  isTenorPageUrl,
  odyseeEmbedUrl,
  peerTubeApiUrl,
  pickPeerTubeFile,
  type PeerTubeFile,
  tenorMp4FromThumbnail,
  youTubeStartSeconds,
} from "@/lib/linkEmbed";
import { faviconUrl } from "@/lib/faviconUrl";
import { fullDateTime } from "@/lib/formatTime";
import type { RichEmbedImage } from "@/lib/richEmbed";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { FormattedMessage, common, t, useIntl } from "@/i18n";
import {
  hasNativeYouTubePlayer,
  needsNativeYouTubePlayer,
  openNativeYouTube,
  openYouTubeTargetPage,
} from "@/lib/nativeYouTube";
import { cn } from "@/lib/utils";

interface LinkEmbedProps {
  url: string;
  className?: string;
}

/** YouTube: click-to-play facade; PeerTube: click-to-play MP4; Spotify, Streamable, Odysee: official iframe; else an OEmbed preview card. */
export function LinkEmbed({ url, className }: LinkEmbedProps) {
  const intl = useIntl();
  const youtubeId = extractYouTubeId(url);
  const spotify = extractSpotifyEmbed(url);
  const tweetId = extractTweetId(url);
  const instagramShortcode = extractInstagramShortcode(url);
  const streamableId = extractStreamableId(url);
  const odysee = odyseeEmbedUrl(url);
  const peerTube = peerTubeApiUrl(url);
  const giphyMp4 = giphyMp4FromPageUrl(url);
  // Remounting the provider iframe is the only way to stop its playback.
  const pauseEpoch = useEmbedPauseEpoch();

  if (giphyMp4) {
    return <VideoPlayer src={giphyMp4} gif className={className} />;
  }

  if (isTenorPageUrl(url)) {
    return <TenorEmbed url={url} className={className} />;
  }

  if (youtubeId) {
    return (
      <div className={cn("max-w-md", className)}>
        <YouTubeEmbed videoId={youtubeId} start={youTubeStartSeconds(url)} />
        <EmbedInfoBar url={url} />
      </div>
    );
  }

  if (tweetId) {
    return <TweetEmbed tweetId={tweetId} className={className} fallback={<PlainLink url={url} />} />;
  }

  if (instagramShortcode) {
    return (
      <InstagramEmbed
        shortcode={instagramShortcode}
        className={className}
        fallback={<PlainLink url={url} />}
      />
    );
  }

  if (spotify) {
    return (
      <div className={cn("max-w-md", className)} onClick={(e) => e.stopPropagation()}>
        <iframe
          key={pauseEpoch}
          src={`https://open.spotify.com/embed/${spotify.type}/${spotify.id}`}
          title="Spotify"
          width="100%"
          height={spotify.type === "track" ? 152 : 352}
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
          className="rounded-xl border-0"
          // No allow-top-navigation: blocks a `spotify:` app launch, which Chrome shows as
          // an "open other apps" prompt on load.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    );
  }

  if (peerTube) {
    return (
      <div className={cn("max-w-md", className)}>
        <PeerTubeEmbed api={peerTube} url={url} />
        <EmbedInfoBar url={url} />
      </div>
    );
  }

  if (streamableId || odysee) {
    return (
      <div className={cn("max-w-md", className)} onClick={(e) => e.stopPropagation()}>
        <div
          className="relative w-full overflow-hidden clip-corner-lg bg-black"
          style={{ paddingBottom: "56.25%" }}
        >
          <iframe
            key={pauseEpoch}
            src={odysee ?? `https://streamable.com/e/${streamableId}`}
            title={odysee
              ? intl.formatMessage({ id: "linkEmbed.odyseeVideo", defaultMessage: "Odysee video" })
              : intl.formatMessage({ id: "linkEmbed.streamableVideo", defaultMessage: "Streamable video" })}
            // Supersedes `allowFullScreen` (browsers warn if both are set).
            allow="autoplay; fullscreen; picture-in-picture"
            loading="lazy"
            className="absolute inset-0 h-full w-full border-0"
            // Odysee's player needs no top navigation or forms.
            sandbox={odysee ? "allow-scripts allow-same-origin allow-popups allow-presentation" : undefined}
          />
        </div>
        <EmbedInfoBar url={url} />
      </div>
    );
  }

  return <LinkPreview url={url} className={className} />;
}

/** A Tenor page link plays its GIF, as Discord shows it; the page card is the fallback. */
function TenorEmbed({ url, className }: { url: string; className?: string }) {
  const { data, isLoading } = useLinkPreview(url);
  const mp4 = tenorMp4FromThumbnail(data?.thumbnail_url);
  if (isLoading) {
    return <Skeleton className={cn("h-32 w-48 clip-corner-lg", className)} />;
  }
  if (!mp4) return <LinkPreview url={url} className={className} />;
  const dim = data?.thumbnail_width && data.thumbnail_height
    ? `${data.thumbnail_width}x${data.thumbnail_height}`
    : undefined;
  return <VideoPlayer src={mp4} dim={dim} gif alt={data?.title} className={className} />;
}

function EmbedInfoBar({ url }: { url: string }) {
  const { data } = useLinkPreview(url);
  const domain = displayDomain(url);

  return (
    <div className="px-1 pt-1.5 space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{data?.provider_name || domain}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 px-2 py-0.5 clip-corner hover:bg-primary/10 hover:text-primary transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-3" />
          <span><FormattedMessage id="linkEmbed.open" defaultMessage="Open" /></span>
        </a>
      </div>
      {data?.title && <p className="text-sm font-semibold leading-snug line-clamp-2">{data.title}</p>}
    </div>
  );
}

function PlainLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline break-all"
      onClick={(e) => e.stopPropagation()}
    >
      {url}
    </a>
  );
}

function displayDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const PREVIEW_MAX_W = 400;
const PREVIEW_MAX_H = 320;
/** An image this small on both axes is a logo/avatar, shown as a side thumbnail. */
const SMALL_IMAGE_MAX = 200;
const GRID_MAX = 4;

function LinkPreview({ url, className }: { url: string; className?: string }) {
  const { data: embed, isLoading } = useRichEmbed(url);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // The lightbox applies the media policy itself; full-size original where named.
  const lightboxMedia = useMemo<LightboxItem[]>(
    () =>
      (embed?.images ?? []).flatMap((img): LightboxItem[] => {
        const src = sanitizeImageSrc(img.full) ?? sanitizeImageSrc(img.thumb);
        if (!src) return [];
        return [{ url: src, dim: img.width && img.height ? `${img.width}x${img.height}` : undefined }];
      }),
    [embed?.images],
  );
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const nextImage = useCallback(
    () => setLightboxIndex((i) => (i === null ? i : Math.min(lightboxMedia.length - 1, i + 1))),
    [lightboxMedia.length],
  );
  const prevImage = useCallback(() => setLightboxIndex((i) => (i === null ? i : Math.max(0, i - 1))), []);

  if (isLoading) {
    return (
      <div className={cn("max-w-md clip-corner-lg border-l-4 border-primary bg-secondary/40 overflow-hidden", className)}>
        <div className="px-3 py-2.5 space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }

  if (!embed) return <PlainLink url={url} />;

  const images = embed.images;
  const single = images.length === 1 ? images[0] : undefined;
  const singleW = single?.width ?? naturalSize?.w;
  const singleH = single?.height ?? naturalSize?.h;
  const small = !!singleW && !!singleH && singleW <= SMALL_IMAGE_MAX && singleH <= SMALL_IMAGE_MAX;
  const provider = embed.provider ?? (embed.footer ? undefined : displayDomain(url));

  return (
    // A `<button>` can't nest in an `<a>`: a full-card link OVERLAY sits under
    // `pointer-events-none` content, with the copy button and images as exceptions.
    <div
      className={cn(
        "group relative block w-fit max-w-md clip-corner-lg border-l-4 border-primary bg-secondary/40 overflow-hidden",
        "hover:bg-secondary/60 transition-colors",
        className,
      )}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={embed.title || embed.author?.name || provider || displayDomain(url)}
        className="absolute inset-0 z-0"
        onClick={(e) => e.stopPropagation()}
      />

      <div className="pointer-events-none relative px-3 py-2.5">
        <div className="flex gap-3">
          <div className="min-w-0 flex-1 space-y-1.5 pr-6 touch:pr-8">
            {provider && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                {!embed.footer && <SiteIcon url={url} />}
                <span className="truncate">{provider}</span>
              </p>
            )}
            {embed.author && <EmbedAuthor name={embed.author.name} icon={embed.author.icon} />}
            {embed.title && (
              <p className="text-sm font-semibold leading-snug text-primary line-clamp-2">{embed.title}</p>
            )}
            {embed.description && (
              <p className="text-sm leading-snug whitespace-pre-line break-words line-clamp-6">
                {embed.description}
              </p>
            )}
            {embed.fields && (
              <dl className="grid grid-cols-3 gap-x-6 gap-y-1 pt-0.5">
                {embed.fields.map((field) => (
                  <div key={field.name} className="min-w-0">
                    <dt className="text-xs font-semibold">{field.name}</dt>
                    <dd className="text-sm truncate">{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          {single && small && (
            <div className="mt-6 touch:mt-8">
              <EmbedImage image={single} variant="small" onOpen={() => setLightboxIndex(0)} />
            </div>
          )}
        </div>

        {single && !small && (
          <div className="mt-2.5 w-fit max-w-full">
            <EmbedImage
              image={single}
              variant="single"
              onOpen={() => setLightboxIndex(0)}
              onSize={setNaturalSize}
            />
          </div>
        )}

        {images.length > 1 && (
          <div className="mt-2.5 grid w-[min(100%,25rem)] grid-cols-2 gap-1">
            {images.slice(0, GRID_MAX).map((image, i) => (
              <div key={`${i}:${image.thumb}`} className="relative">
                <EmbedImage image={image} variant="tile" onOpen={() => setLightboxIndex(i)} />
                {i === GRID_MAX - 1 && images.length > GRID_MAX && (
                  <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/60 text-lg font-semibold text-white">
                    +{images.length - GRID_MAX}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {embed.footer && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <SiteIcon url={url} />
            <span className="truncate">
              {embed.footer.text}
              {embed.footer.timestamp !== undefined && <> • {fullDateTime(embed.footer.timestamp)}</>}
            </span>
          </p>
        )}
      </div>

      <CopyLinkButton url={url} />

      {lightboxIndex !== null && lightboxMedia.length > 0 && (
        <Lightbox
          media={lightboxMedia}
          currentIndex={Math.min(lightboxIndex, lightboxMedia.length - 1)}
          onClose={closeLightbox}
          onNext={nextImage}
          onPrev={prevImage}
        />
      )}
    </div>
  );
}

/** Favicon via the favicon service, so the site doesn't see who scrolled past. */
function SiteIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-sm object-contain"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function EmbedAuthor({ name, icon }: { name: string; icon?: string }) {
  const src = useMediaSrc(sanitizeImageSrc(icon));
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-center gap-2 min-w-0">
      {src && !failed && (
        <img
          src={src}
          alt=""
          className="size-6 shrink-0 rounded-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      <p className="text-sm font-semibold leading-snug truncate">{name}</p>
    </div>
  );
}

/**
 * One preview image under the media policy; opens the lightbox. A `single`
 * image is shown whole at its own aspect ratio (a cover crop cuts the content).
 */
function EmbedImage({
  image,
  variant,
  onOpen,
  onSize,
}: {
  image: RichEmbedImage;
  variant: "single" | "small" | "tile";
  onOpen: () => void;
  onSize?: (size: { w: number; h: number }) => void;
}) {
  const intl = useIntl();
  const src = useMediaSrc(sanitizeImageSrc(image.thumb));
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;

  const w = image.width ?? natural?.w;
  const h = image.height ?? natural?.h;
  const box = variant === "single" && w && h ? fitPreviewBox(w, h) : undefined;

  return (
    <button
      type="button"
      aria-label={intl.formatMessage({ id: "linkEmbed.viewImage", defaultMessage: "View image" })}
      className={cn(
        "pointer-events-auto relative z-10 block max-w-full cursor-zoom-in rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        variant === "tile" && "w-full",
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
    >
      <img
        src={src}
        alt=""
        className={cn(
          "block rounded-md",
          variant === "small" && "size-20 shrink-0 object-cover",
          variant === "tile" && "aspect-square w-full object-cover",
          variant === "single" &&
            (box ? "max-w-full h-auto object-cover" : "max-w-[min(100%,25rem)] max-h-80 w-auto h-auto"),
        )}
        style={box ? { aspectRatio: box.aspectRatio, width: box.maxWidth } : undefined}
        loading="lazy"
        decoding="async"
        onLoad={(e) => {
          const { naturalWidth, naturalHeight } = e.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            const size = { w: naturalWidth, h: naturalHeight };
            setNatural(size);
            onSize?.(size);
          }
        }}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

/** Fit into the caps without upscaling, pre-narrowing portraits (same scheme as message images). */
function fitPreviewBox(w: number, h: number): { aspectRatio: string; maxWidth: number } {
  const scale = Math.min(1, PREVIEW_MAX_W / w, PREVIEW_MAX_H / h);
  return { aspectRatio: `${w} / ${h}`, maxWidth: Math.round(w * scale) };
}

/** Copies the URL; re-enables pointer events above the card-wide link overlay. */
function CopyLinkButton({ url }: { url: string }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    writeClipboardText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast({ title: t({ id: "linkEmbed.copiedLink", defaultMessage: "Copied link" }) });
      },
      () => toast({ title: t({ id: "linkEmbed.copyLinkFailed", defaultMessage: "Couldn't copy link" }), variant: "destructive" }),
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={intl.formatMessage(common.copyLink)}
      aria-label={intl.formatMessage(common.copyLink)}
      className={cn(
        "absolute top-1 right-1 z-10 grid place-items-center size-7 touch:size-9 clip-corner-lg",
        "text-muted-foreground hover:text-primary hover:bg-secondary transition-colors",
      )}
    >
      {copied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
    </button>
  );
}

/**
 * Click-to-load: a PeerTube instance is whatever host the link names, so nothing
 * is asked of it (no viewer IP to the sender) until play. Then its API names an
 * MP4 that plays in our own player, under the media policy — no foreign frame.
 * No MP4 (HLS-only, a live, private, unreachable): the link's own page opens.
 * The facade wears VideoPlayer's own play overlay, and the one click plays.
 */
function PeerTubeEmbed({ api, url }: { api: string; url: string }) {
  const intl = useIntl();
  const domain = displayDomain(url);
  const [file, setFile] = useState<PeerTubeFile | "loading" | "failed" | null>(null);
  const { data } = useLinkPreview(url);
  const poster = sanitizeImageSrc(data?.thumbnail_url);
  const thumb = useMediaSrc(poster);

  const play = () => {
    setFile("loading");
    // Bounded so the page can still open inside the click's user activation.
    fetch(api, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? r.json() : null))
      .then(pickPeerTubeFile)
      .catch(() => null)
      .then((picked) => {
        if (picked) return setFile(picked);
        // A blocked popup leaves the link below to click.
        window.open(url, "_blank", "noopener,noreferrer");
        setFile("failed");
      });
  };

  // Starts on mount with sound, on the facade click's activation; muted where
  // that has lapsed (iOS), so it never takes a second click.
  const startPlayback = useCallback((video: HTMLVideoElement | null) => {
    video?.play().catch((e: unknown) => {
      if ((e as Error)?.name !== "NotAllowedError") return;
      video.muted = true;
      void video.play().catch(() => {});
    });
  }, []);

  if (file && typeof file === "object") {
    return (
      <VideoPlayer
        src={file.fileUrl}
        poster={poster}
        dim={file.width && file.height ? `${file.width}x${file.height}` : undefined}
        title={data?.title}
        videoRef={startPlayback}
      />
    );
  }

  return (
    <div
      className="relative my-1.5 clip-corner-lg overflow-hidden bg-black"
      style={{ aspectRatio: "16 / 9" }}
      onClick={(e) => e.stopPropagation()}
    >
      {thumb && <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" />}
      {file === "failed" ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-medium text-white"
        >
          <FormattedMessage id="linkEmbed.openOnSite" defaultMessage="Open on {domain}" values={{ domain }} />
        </a>
      ) : (
        <button
          type="button"
          className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
          onClick={play}
          disabled={file === "loading"}
          aria-label={intl.formatMessage(
            { id: "linkEmbed.playVideoFrom", defaultMessage: "Play video from {domain}" },
            { domain },
          )}
        >
          <span className="size-16 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm">
            {file === "loading" ? (
              <Loader2 className="size-8 animate-spin text-white" />
            ) : (
              <Play className="size-8 text-white ml-1" fill="white" />
            )}
          </span>
        </button>
      )}
    </div>
  );
}

/** Preferred sizes; a missing size is a 120×90 gray placeholder, so probe off-screen. */
const THUMBNAIL_SIZES = ["sddefault", "hqdefault"] as const;

function thumbnailUrl(videoId: string, size: string): string {
  return `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
}

function findThumbnail(videoId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;

    function tryIndex(i: number) {
      if (i >= THUMBNAIL_SIZES.length) {
        if (!settled) {
          settled = true;
          resolve(null);
        }
        return;
      }

      const img = new Image();
      img.onload = () => {
        if (settled) return;
        if (img.naturalWidth <= 120 && img.naturalHeight <= 90) {
          tryIndex(i + 1);
        } else {
          settled = true;
          resolve(thumbnailUrl(videoId, THUMBNAIL_SIZES[i]));
        }
      };
      img.onerror = () => {
        if (!settled) tryIndex(i + 1);
      };
      img.src = thumbnailUrl(videoId, THUMBNAIL_SIZES[i]);
    }

    tryIndex(0);
  });
}

/** Click-to-load facade: no requests to YouTube until play. */
export function YouTubeEmbed({ videoId, start, className }: { videoId: string; start?: number; className?: string }) {
  const intl = useIntl();
  // Pausing media bumps the epoch, returning the embed to its facade.
  const pauseEpoch = useEmbedPauseEpoch();
  const [activatedAt, setActivatedAt] = useState<number | null>(null);
  const activated = activatedAt === pauseEpoch;
  const [resolvedThumb, setResolvedThumb] = useState<string | null>(null);
  const [nativeOpenFailed, setNativeOpenFailed] = useState(false);
  const nativeIos = needsNativeYouTubePlayer();

  const play = () => {
    if (!nativeIos) {
      setActivatedAt(pauseEpoch);
      return;
    }
    if (nativeOpenFailed) {
      openYouTubeTargetPage({ videoId, startSeconds: start });
      return;
    }

    // WKWebView can't send a Referer from capacitor://localhost (YouTube error 153):
    // use the native player; older binaries without it open the watch page.
    if (!hasNativeYouTubePlayer()) {
      openYouTubeTargetPage({ videoId, startSeconds: start });
      return;
    }
    void openNativeYouTube({ videoId, startSeconds: start }).then((opened) => {
      setNativeOpenFailed(!opened);
    });
  };

  useEffect(() => {
    let cancelled = false;
    setResolvedThumb(null);
    setNativeOpenFailed(false);

    findThumbnail(videoId).then((url) => {
      if (!cancelled) setResolvedThumb(url);
    });

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  return (
    <div
      className={cn("clip-corner-lg overflow-hidden", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
        {activated ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1${start ? `&start=${start}` : ""}`}
            title={intl.formatMessage({ id: "linkEmbed.youtubeVideo", defaultMessage: "YouTube video" })}
            // YouTube requires a Referer; send this deployment's own origin.
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        ) : (
          <button
            type="button"
            className="absolute inset-0 w-full h-full cursor-pointer bg-black group"
            onClick={play}
            aria-label={nativeOpenFailed
              ? intl.formatMessage({ id: "linkEmbed.openVideoOnYoutube", defaultMessage: "Open video on YouTube" })
              : intl.formatMessage({ id: "linkEmbed.playVideo", defaultMessage: "Play video" })}
          >
            {resolvedThumb && (
              <img src={resolvedThumb} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 flex items-center justify-center">
              {nativeOpenFailed ? (
                <span className="rounded-full bg-black/85 px-4 py-2 text-sm font-medium text-white">
                  <FormattedMessage id="linkEmbed.openOnYoutube" defaultMessage="Open on YouTube" />
                </span>
              ) : (
                <div
                  className={cn(
                    "flex items-center justify-center",
                    "w-[68px] h-[48px] rounded-xl",
                    "bg-[#212121]/80 group-hover:bg-[#ff0000] transition-colors duration-200",
                  )}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white ml-0.5">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              )}
            </div>
          </button>
        )}
      </div>
    </div>
  );
}
