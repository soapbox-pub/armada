import { Download, Loader2, Music, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MediaFallback } from "@/components/chat/MediaFallback";
import { hasAudioMetadata, useAudioMetadata, useAudioWaveform } from "@/hooks/useAudioMetadata";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { toast } from "@/hooks/useToast";
import { t, useIntl } from "@/i18n";
import { downloadUrl, savedDescription } from "@/lib/downloadFile";
import {
  pauseOthers,
  playNextAfter,
  registerAudioPlayer,
} from "@/lib/audioPlaybackQueue";
import { formatTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

interface AudioMessageProps {
  src: string;
  mime?: string;
  /** AES-GCM decryption params for client-encrypted (Concord/Vector) blobs. */
  encryption?: ImetaEncryption;
  /** Sender-declared alternative sources (imeta `fallback`), same key and nonce. */
  fallbacks?: string[];
  /** Space-separated 0–100 amplitude samples from the imeta `waveform` field. */
  waveform?: string;
  /** Seconds, from the imeta `duration` field. */
  duration?: string;
  className?: string;
}

const BAR_COUNT = 48;

function parseWaveform(waveform: string | undefined): number[] {
  return waveform
    ?.split(/\s+/)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n)) ?? [];
}

function toBars(raw: number[] | null | undefined): number[] {
  if (!raw || raw.length === 0) {
    // Flat while the real shape is unknown.
    return Array.from({ length: BAR_COUNT }, () => 20);
  }

  if (raw.length <= BAR_COUNT) return raw;

  const bars: number[] = [];
  const step = raw.length / BAR_COUNT;
  for (let i = 0; i < BAR_COUNT; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let max = 0;
    for (let j = start; j < end && j < raw.length; j++) {
      if (raw[j] > max) max = raw[j];
    }
    bars.push(max);
  }
  return bars;
}

/**
 * Compact chat audio player (voice messages and other audio). A music file
 * with its own tags or cover art is presented as a track.
 */
export function AudioMessage({
  src,
  mime,
  encryption,
  fallbacks,
  waveform,
  duration,
  className,
}: AudioMessageProps) {
  const intl = useIntl();
  const audioRef = useRef<HTMLAudioElement>(null);
  // A play request that arrived before the <audio> mounted (encrypted blobs mount
  // after decrypt).
  const wantsPlayRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(() => {
    const parsed = Number.parseFloat(duration ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  });

  // Encrypted attachments are fetched + decrypted to an object URL first.
  const { resolved, onError, failed, fallbackProps } = useMediaWithFallback({ url: src, encryption, mime, fallbacks });

  const resolvedSrc = resolved.status === "ready" ? resolved.src : undefined;

  // Tags read from the decrypted object URL, or by range request for plain URLs.
  const meta = useAudioMetadata(src, resolvedSrc);

  // Voice messages carry a waveform; others compute one from decoded samples —
  // immediately for a `blob:`, but for a plain URL only once played (full download).
  const declared = useMemo(() => parseWaveform(waveform), [waveform]);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const waveformSrc = declared.length > 0 || !resolvedSrc
    ? undefined
    : resolvedSrc.startsWith("blob:") || hasPlayed
      ? resolvedSrc
      : undefined;
  const computed = useAudioWaveform(src, waveformSrc);

  const bars = useMemo(() => toBars(declared.length > 0 ? declared : computed), [declared, computed]);
  const progress = mediaDuration > 0 ? currentTime / mediaDuration : 0;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // NotAllowedError (no gesture): leave paused. NotSupportedError: a failed
  // candidate, so walk to the next and play it. Ignore rejections from an
  // element already replaced.
  const playOn = useCallback((audio: HTMLAudioElement) => {
    audio.play().catch((err: unknown) => {
      if (audioRef.current !== audio) return;
      if ((err as { name?: string } | null)?.name !== "NotSupportedError") return;
      wantsPlayRef.current = true;
      onErrorRef.current();
    });
  }, []);

  // Used by the play button and the coordinator (auto-advance).
  const play = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      playOn(audio);
    } else {
      wantsPlayRef.current = true;
    }
  }, [playOn]);

  // Single-playback and auto-advance. `play` is stable, so this runs once.
  useEffect(() => registerAudioPlayer({ get el() { return audioRef.current; }, play }), [play]);

  // The element is replaced on each fallback step (see its `key`); re-attach.
  const currentSrc = resolved.status === "ready" ? resolved.src : undefined;
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // The replaced element may have been torn down before its `pause` arrived.
    setIsPlaying(!audio.paused);
    setCurrentTime(audio.currentTime);
    const onPlay = () => {
      setIsPlaying(true);
      setHasPlayed(true);
      pauseOthers(audio);
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      playNextAfter(audio);
    };
    const onTime = () => setCurrentTime(audio.currentTime);
    const onDur = () => {
      if (Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
    };
    if (wantsPlayRef.current) {
      wantsPlayRef.current = false;
      playOn(audio);
    }
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDur);
    audio.addEventListener("loadedmetadata", onDur);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDur);
      audio.removeEventListener("loadedmetadata", onDur);
    };
  }, [currentSrc, playOn]);

  // An exhausted walk drops the play request, so Retry doesn't autoplay.
  useEffect(() => {
    if (failed) wantsPlayRef.current = false;
  }, [failed]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play();
    else audio.pause();
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !mediaDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * mediaDuration;
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloading || !resolvedSrc) return;
    setDownloading(true);
    try {
      const result = await downloadUrl(resolvedSrc, { nameHint: src, mime });
      if (result.status === "downloaded") {
        toast({ title: t({ id: "lightbox.saved", defaultMessage: "Saved" }), description: savedDescription(result.location) });
      } else {
        toast({ title: t({ id: "lightbox.openedInNewTab", defaultMessage: "Opened in a new tab" }) });
      }
    } catch {
      toast({ title: t({ id: "lightbox.downloadFailed", defaultMessage: "Download failed" }), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  if (failed) {
    return <MediaFallback {...fallbackProps} kind="audio" />;
  }

  // Keyed by source: changing a mounted <source>'s src does nothing without load().
  const element = resolved.status === "ready" && (
    <audio key={resolved.src} ref={audioRef} preload="metadata" className="hidden" onError={onError}>
      {mime ? <source src={resolved.src} type={mime} /> : <source src={resolved.src} />}
    </audio>
  );

  const playButton = (
    <button
      type="button"
      onClick={togglePlay}
      aria-label={
        isPlaying
          ? intl.formatMessage({ id: "audioMessage.pause", defaultMessage: "Pause" })
          : intl.formatMessage({ id: "audioMessage.play", defaultMessage: "Play" })
      }
      className="size-9 touch:size-11 shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 transition-opacity"
    >
      {isPlaying ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 ml-0.5" fill="currentColor" />}
    </button>
  );

  const scrubber = (
    <>
      <div
        className="flex-1 min-w-0 overflow-hidden flex items-center gap-[2px] h-8 cursor-pointer"
        onClick={handleSeek}
        role="slider"
        aria-label={intl.formatMessage({ id: "audioMessage.seek", defaultMessage: "Seek" })}
        aria-valuemin={0}
        aria-valuemax={Math.round(mediaDuration)}
        aria-valuenow={Math.round(currentTime)}
      >
        {bars.map((amp, i) => {
          const played = bars.length > 0 && i / bars.length <= progress;
          const h = 4 + (amp / 100) * 24;
          return (
            <div
              key={i}
              className={cn(
                "w-[3px] shrink-0 rounded-full transition-colors",
                played ? "bg-primary" : "bg-muted-foreground/40",
              )}
              style={{ height: `${h}px` }}
            />
          );
        })}
      </div>

      <span className="text-2xs text-muted-foreground tabular-nums shrink-0">
        {formatTime(isPlaying || currentTime > 0 ? currentTime : mediaDuration)}
      </span>
    </>
  );

  const downloadButton = resolvedSrc && (
    <button
      type="button"
      onClick={handleDownload}
      disabled={downloading}
      aria-label={intl.formatMessage({ id: "audioMessage.download", defaultMessage: "Download audio" })}
      title={intl.formatMessage({ id: "audioMessage.download", defaultMessage: "Download audio" })}
      className="size-7 touch:size-11 shrink-0 -mr-1 flex items-center justify-center clip-corner text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
    >
      {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
    </button>
  );

  if (hasAudioMetadata(meta)) {
    const { title, artist, album, year, coverUrl } = meta;
    const details = [artist, album, year].filter(Boolean).join(" · ");
    return (
      <div
        className={cn(
          "flex items-center gap-3 my-1.5 max-w-sm clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3] p-2 pr-3",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {element}
        <CoverArt src={coverUrl} />
        <div className="flex-1 min-w-0">
          {(title || details) && (
            <div className="min-w-0 px-0.5">
              {title && <p className="truncate text-sm font-semibold leading-snug">{title}</p>}
              {details && <p className="truncate text-xs text-muted-foreground leading-snug">{details}</p>}
            </div>
          )}
          <div className="flex items-center gap-2.5 mt-1">
            {playButton}
            {scrubber}
            {downloadButton}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 my-1.5 max-w-sm clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3] px-3 py-2",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {element}
      {playButton}
      {scrubber}
      {downloadButton}
    </div>
  );
}

/** A track's cover art, or a music glyph where it has none or it won't decode. */
function CoverArt({ src }: { src?: string }) {
  const [broken, setBroken] = useState<string | undefined>(undefined);
  return (
    <div className="size-20 shrink-0 overflow-hidden clip-corner-lg bg-secondary flex items-center justify-center text-muted-foreground">
      {src && broken !== src ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(src)} />
      ) : (
        <Music className="size-7" />
      )}
    </div>
  );
}
