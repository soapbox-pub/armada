import { ArrowDown, ArrowUp, Link2, ListVideo, MonitorPlay, Play, Plus, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { MediaFallback } from "@/components/chat/MediaFallback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useWebxdcApi, type AppSync } from "@/hooks/useWebxdcApi";
import { useYouTubeTitle } from "@/hooks/useYouTubeTitle";
import { getDisplayName } from "@/lib/getDisplayName";
import {
  hasNativeYouTubePlayer,
  needsNativeYouTubePlayer,
  openNativeYouTube,
  openYouTubeTargetPage,
} from "@/lib/nativeYouTube";
import {
  applySnapshotToVideo,
  classifyWatchLink,
  directVideoTitle,
  DRIFT_TOLERANCE,
  EMPTY_SNAPSHOT,
  isSnapshot,
  queueItemPlayer,
  targetPlaybackTime,
  videoMatchesSnapshot,
  type QueueItem,
  type WatchSnapshot,
} from "@/lib/watchalong";
import { loadYouTubeApi, YT_STATE, type YTPlayer } from "@/lib/youtubeApi";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, useIntl } from "@/i18n";

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * A watchalong with a shared queue (YouTube or direct video links), synced via
 * the {@link AppSync} plane. Wire format: `lib/watchalong.ts`. Embedded YouTube
 * ads can't be skipped and desync playback; the drift guard resyncs after.
 */
export function Watchalong({ sync }: { sync: AppSync }) {
  const intl = useIntl();
  const api = useWebxdcApi(sync);
  const { user } = useCurrentUser();

  const [snap, setSnap] = useState<WatchSnapshot>(EMPTY_SNAPSHOT);
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  const [ready, setReady] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const applyingRemote = useRef(false);
  const nativeIosPlayer = needsNativeYouTubePlayer();
  const [nativePlayerErrorFor, setNativePlayerErrorFor] = useState("");

  const current = snap.current >= 0 ? snap.queue[snap.current] : undefined;
  const currentKey = current ? current.id : "";
  const currentPlayer = queueItemPlayer(current);

  const commit = useCallback(
    (next: Omit<WatchSnapshot, "rev" | "at">) => {
      const snapshot: WatchSnapshot = { ...next, rev: snapRef.current.rev + 1, at: Date.now() };
      setSnap(snapshot);
      api.sendUpdate({ payload: snapshot }, "");
    },
    [api],
  );

  const applySnapshot = useCallback((incoming: WatchSnapshot) => {
    if (incoming.rev <= snapRef.current.rev) return;
    setSnap(incoming);
  }, []);

  useEffect(() => {
    void api.setUpdateListener((update) => {
      if (isSnapshot(update.payload)) applySnapshot(update.payload);
    }, 0);
  }, [api, applySnapshot]);

  // Push the latest snapshot's play/seek state onto the live player.
  const syncPlayerToSnapshot = useCallback((player: YTPlayer) => {
    const s = snapRef.current;
    applyingRemote.current = true;
    try {
      const targetTime = targetPlaybackTime(s, Date.now());
      if (Math.abs(player.getCurrentTime() - targetTime) > DRIFT_TOLERANCE) {
        player.seekTo(targetTime, true);
      }
      if (s.playing) player.playVideo();
      else player.pauseVideo();
    } finally {
      setTimeout(() => (applyingRemote.current = false), 400);
    }
  }, []);

  const advance = useCallback(() => {
    const s = snapRef.current;
    const next = s.current + 1;
    if (next < s.queue.length) commit({ ...s, current: next, playing: true, time: 0 });
    else commit({ ...s, playing: false });
  }, [commit]);

  useEffect(() => {
    if (nativeIosPlayer || currentPlayer !== "youtube" || !current || !containerRef.current) return;
    let destroyed = false;
    let player: YTPlayer | null = null;
    const entry = current;

    // The API REPLACES the node it's given, so give it one React doesn't own.
    const host = containerRef.current;
    const mount = document.createElement("div");
    mount.className = "h-full w-full";
    host.appendChild(mount);

    loadYouTubeApi().then((YT) => {
      if (destroyed) return;
      player = new YT.Player(mount, {
        videoId: entry.videoId,
        width: "100%",
        height: "100%",
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          autoplay: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          ...(entry.playlistId ? { listType: "playlist", list: entry.playlistId } : {}),
        },
        events: {
          onReady: (e) => {
            playerRef.current = e.target;
            setReady(true);
            syncPlayerToSnapshot(e.target);
          },
          onStateChange: (e) => {
            if (applyingRemote.current) return;
            const s = snapRef.current;
            const time = e.target.getCurrentTime();
            if (e.data === YT_STATE.PLAYING) commit({ ...s, playing: true, time });
            else if (e.data === YT_STATE.PAUSED) commit({ ...s, playing: false, time });
            else if (e.data === YT_STATE.ENDED) advance();
          },
        },
      });
    });

    return () => {
      destroyed = true;
      try {
        player?.destroy();
      } catch {
        /* ignore */
      }
      host.replaceChildren();
      playerRef.current = null;
      setReady(false);
    };
    // Rebuild only when the now-playing *entry* changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, nativeIosPlayer]);

  // When the snapshot's play/time changes (entry unchanged), nudge the player.
  useEffect(() => {
    if (playerRef.current && ready) syncPlayerToSnapshot(playerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.playing, snap.time, snap.at, ready]);

  const addToQueue = useCallback(() => {
    const link = classifyWatchLink(urlInput);
    if (link.kind === "invalid") {
      setInputError(link.reason);
      return;
    }
    setInputError(null);
    setUrlInput("");
    const item: QueueItem = link.kind === "youtube"
      ? { id: newId(), videoId: link.videoId, playlistId: link.playlistId, addedBy: user?.pubkey }
      : { id: newId(), url: link.url, addedBy: user?.pubkey };
    const s = snapRef.current;
    const queue = [...s.queue, item];
    const startNow = s.current < 0 || s.current >= s.queue.length;
    commit({
      queue,
      current: startNow ? queue.length - 1 : s.current,
      playing: startNow ? true : s.playing,
      time: startNow ? 0 : s.time,
      rate: s.rate,
    });
  }, [urlInput, user?.pubkey, commit]);

  const playIndex = useCallback(
    (index: number) => commit({ ...snapRef.current, current: index, playing: true, time: 0 }),
    [commit],
  );

  const skip = useCallback(
    (delta: number) => {
      const s = snapRef.current;
      const next = s.current + delta;
      if (next >= 0 && next < s.queue.length) commit({ ...s, current: next, playing: true, time: 0 });
    },
    [commit],
  );

  const move = useCallback(
    (index: number, delta: number) => {
      const s = snapRef.current;
      const to = index + delta;
      if (to < 0 || to >= s.queue.length) return;
      const queue = [...s.queue];
      [queue[index], queue[to]] = [queue[to], queue[index]];
      // Keep `current` pointing at the same now-playing entry after the swap.
      let curr = s.current;
      if (s.current === index) curr = to;
      else if (s.current === to) curr = index;
      commit({ ...s, queue, current: curr });
    },
    [commit],
  );

  const removeIndex = useCallback(
    (index: number) => {
      const s = snapRef.current;
      const queue = s.queue.filter((_, i) => i !== index);
      let curr = s.current;
      if (index < s.current) curr = s.current - 1;
      else if (index === s.current) curr = Math.min(s.current, queue.length - 1);
      commit({ ...s, queue, current: queue.length ? curr : -1, playing: queue.length ? s.playing : false });
    },
    [commit],
  );

  const hasQueue = snap.queue.length > 0;
  const canPrev = snap.current > 0;
  const canNext = snap.current >= 0 && snap.current < snap.queue.length - 1;

  const openIosPlayer = useCallback(() => {
    const s = snapRef.current;
    const entry = s.current >= 0 ? s.queue[s.current] : undefined;
    if (!entry) return;

    const startSeconds = targetPlaybackTime(s, Date.now());
    const target = {
      videoId: entry.videoId,
      playlistId: entry.playlistId,
      startSeconds,
      autoplay: s.playing,
    };
    setNativePlayerErrorFor("");

    if (!hasNativeYouTubePlayer()) {
      openYouTubeTargetPage(target);
      return;
    }
    void openNativeYouTube(target).then((opened) => {
      setNativePlayerErrorFor(opened ? "" : entry.id);
    });
  }, []);

  // A viewer's own play/pause/seek/speed on the `<video>` becomes the room's state.
  const commitPlayback = useCallback(
    (patch: Pick<WatchSnapshot, "playing" | "time" | "rate">) => commit({ ...snapRef.current, ...patch }),
    [commit],
  );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-9 touch:h-11 min-w-0 flex-1 items-center gap-1.5 px-2 clip-corner-lg",
              inputError ? "bg-destructive/10" : "bg-foreground/5",
            )}
          >
            <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <Input
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                setInputError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") addToQueue();
              }}
              inputMode="url"
              placeholder={intl.formatMessage({ id: "watchalong.linkPlaceholder", defaultMessage: "Paste a YouTube or video link" })}
              aria-label={intl.formatMessage({ id: "watchalong.linkLabel", defaultMessage: "YouTube or video link" })}
              className="h-full flex-1 min-w-0 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <Button size="sm" className="h-9 touch:h-11 clip-corner-lg" onClick={addToQueue} disabled={!urlInput.trim()}>
            <Plus className="size-4" />
            <FormattedMessage {...common.add} />
          </Button>
        </div>
        {inputError && <p className="mt-1 px-1 text-xs text-destructive">{inputError}</p>}
      </div>

      {/* Capped to ~45vh so the queue stays on-screen (the stage isn't scrollable). */}
      {current ? (
        <div className="mx-auto w-full max-h-[45vh] aspect-video overflow-hidden clip-corner-lg bg-black relative">
          {currentPlayer === "video" && current.url ? (
            <DirectVideoPlayer
              key={currentKey}
              url={current.url}
              snap={snap}
              onPlayback={commitPlayback}
              onEnded={advance}
            />
          ) : currentPlayer !== "youtube" ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/70">
              <FormattedMessage id="watchalong.unsupported" defaultMessage="This video can't be played in this version of Armada." />
            </div>
          ) : nativeIosPlayer ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-chrome-deep px-6 text-center text-white">
              <MonitorPlay className="size-10 text-primary" />
              <div>
                <p className="text-sm font-semibold"><FormattedMessage id="watchalong.iosPlayerTitle" defaultMessage="YouTube opens in Armada's video player" /></p>
                <p className="mt-1 text-xs text-white/60"><FormattedMessage id="watchalong.iosPlayerBody" defaultMessage="It starts at the shared watch position." /></p>
              </div>
              <Button type="button" className="clip-corner-lg" onClick={openIosPlayer}>
                <Play className="size-4 fill-current" />
                <FormattedMessage id="watchalong.openPlayer" defaultMessage="Open player" />
              </Button>
              {nativePlayerErrorFor === currentKey && (
                <button
                  type="button"
                  className="text-xs text-white/70 underline underline-offset-2"
                  onClick={() => openYouTubeTargetPage(current)}
                >
                  <FormattedMessage id="watchalong.openOnYouTube" defaultMessage="Open on YouTube instead" />
                </button>
              )}
            </div>
          ) : (
            <div ref={containerRef} className="absolute inset-0 h-full w-full" />
          )}
          {currentPlayer === "youtube" && !nativeIosPlayer && !ready && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
              <FormattedMessage id="watchalong.loadingPlayer" defaultMessage="Loading player…" />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 clip-corner-lg bg-foreground/5 py-10 text-center">
          <MonitorPlay className="size-7 text-muted-foreground" />
          <p className="text-xs text-muted-foreground"><FormattedMessage id="watchalong.empty" defaultMessage="Paste a link above to start the queue." /></p>
        </div>
      )}

      {hasQueue && (
        <div className="flex items-center justify-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 touch:size-11 clip-corner-lg text-muted-foreground"
                aria-label={intl.formatMessage({ id: "watchalong.previous", defaultMessage: "Previous" })}
                disabled={!canPrev}
                onClick={() => skip(-1)}
              >
                <SkipBack className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent><FormattedMessage id="watchalong.previous" defaultMessage="Previous" /></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 touch:size-11 clip-corner-lg text-muted-foreground"
                aria-label={intl.formatMessage(common.next)}
                disabled={!canNext}
                onClick={() => skip(1)}
              >
                <SkipForward className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <FormattedMessage {...common.next} />
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {hasQueue && (
        <div>
          <div className="flex items-center gap-1.5 pb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            <ListVideo className="size-3 text-primary" />
            <FormattedMessage id="watchalong.upNext" defaultMessage="Up next · {count}" values={{ count: snap.queue.length }} />
          </div>
          <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
            {snap.queue.map((item, i) => (
              <QueueRow
                key={item.id}
                item={item}
                isCurrent={i === snap.current}
                canUp={i > 0}
                canDown={i < snap.queue.length - 1}
                onPlay={() => playIndex(i)}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => removeIndex(i)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A direct video entry, driven by the shared snapshot like the YouTube embed;
 * self-made changes are ignored briefly so applying never echoes. The URL is
 * peer-supplied, so it loads through the media policy (`useMediaWithFallback`).
 */
function DirectVideoPlayer({
  url,
  snap,
  onPlayback,
  onEnded,
}: {
  url: string;
  snap: WatchSnapshot;
  onPlayback: (patch: Pick<WatchSnapshot, "playing" | "time" | "rate">) => void;
  onEnded: () => void;
}) {
  const { resolved, onError, failed, fallbackProps } = useMediaWithFallback({ url });
  const src = resolved.status === "ready" ? resolved.src : undefined;

  const videoRef = useRef<HTMLVideoElement>(null);
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  const applying = useRef(false);
  const applyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [blocked, setBlocked] = useState(false);
  // Set while a play we requested is unsettled or refused, so a late `seeked`
  // doesn't broadcast a browser-forced pause as the room pausing.
  const playNotOurs = useRef(false);

  const apply = useCallback(() => {
    const video = videoRef.current;
    // Seeking before metadata is a no-op in some engines; loadedmetadata re-applies.
    if (!video || video.readyState < 1) return;
    applying.current = true;
    clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => (applying.current = false), 400);
    const playing = applySnapshotToVideo(video, snapRef.current, Date.now());
    if (!playing) return;
    playNotOurs.current = true;
    playing.then(
      () => {
        playNotOurs.current = false;
        setBlocked(false);
      },
      (err: unknown) => {
        if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked(true);
        else playNotOurs.current = false;
      },
    );
  }, []);

  useEffect(() => () => clearTimeout(applyTimer.current), []);

  useEffect(() => {
    apply();
  }, [apply, snap.playing, snap.time, snap.at, snap.rate, src]);

  const report = useCallback(() => {
    const video = videoRef.current;
    if (!video || applying.current || playNotOurs.current) return;
    if (videoMatchesSnapshot(video, snapRef.current, Date.now())) return;
    onPlayback({ playing: !video.paused, time: video.currentTime, rate: video.playbackRate });
  }, [onPlayback]);

  const handlePause = useCallback(() => {
    // `ended` handles the end-of-file pause (it advances).
    if (videoRef.current?.ended) return;
    report();
  }, [report]);

  if (failed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <MediaFallback {...fallbackProps} kind="video" />
      </div>
    );
  }

  return (
    <>
      <video
        ref={videoRef}
        src={src}
        className="absolute inset-0 h-full w-full"
        controls
        playsInline
        preload="auto"
        onLoadedMetadata={apply}
        onError={onError}
        onPlay={report}
        onPause={handlePause}
        onSeeked={report}
        onRateChange={report}
        onEnded={onEnded}
      />
      {blocked && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <Button
            type="button"
            onClick={() => {
              setBlocked(false);
              playNotOurs.current = false;
              apply();
            }}
          >
            <Play className="size-4 fill-current" />
            <FormattedMessage id="watchalong.joinPlayback" defaultMessage="Join playback" />
          </Button>
        </div>
      )}
    </>
  );
}

/** One queue row; title resolved via keyless oEmbed. */
function QueueRow({
  item,
  isCurrent,
  canUp,
  canDown,
  onPlay,
  onUp,
  onDown,
  onRemove,
}: {
  item: QueueItem;
  isCurrent: boolean;
  canUp: boolean;
  canDown: boolean;
  onPlay: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const intl = useIntl();
  const { data: meta } = useYouTubeTitle(item.videoId);
  const thumbnail = useMediaSrc(sanitizeImageSrc(meta?.thumbnail));
  const author = useAuthor(item.addedBy);
  const adderName = item.addedBy ? getDisplayName(author.data?.metadata, item.addedBy) : undefined;

  const title = item.playlistId
    ? intl.formatMessage({ id: "watchalong.playlist", defaultMessage: "Playlist" })
    : meta?.title ??
      (item.videoId
        ? `youtu.be/${item.videoId}`
        : item.url
          ? directVideoTitle(item.url)
          : intl.formatMessage({ id: "watchalong.video", defaultMessage: "Video" }));

  return (
    <div
      className={cn(
        "group/row flex items-center gap-2.5 clip-corner px-2 py-1.5 transition-colors",
        isCurrent ? "bg-primary/10" : "hover:bg-foreground/5",
      )}
    >
      <button type="button" onClick={onPlay} className="flex items-center gap-2.5 min-w-0 flex-1 text-left" aria-label={intl.formatMessage({ id: "watchalong.play", defaultMessage: "Play {title}" }, { title })}>
        <div className="relative flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden clip-corner bg-black/80">
          {item.playlistId ? (
            <ListVideo className="size-4 text-white/80" />
          ) : thumbnail ? (
            <img src={thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <MonitorPlay className="size-4 text-white/80" />
          )}
          {isCurrent && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Play className="size-3.5 fill-white text-white" />
            </span>
          )}
        </div>
        <div className="min-w-0">
          <p className={cn("truncate text-xs", isCurrent ? "font-semibold text-foreground" : "font-medium")}>{title}</p>
          <p className="truncate text-2xs text-muted-foreground">
            {isCurrent ? (
              <FormattedMessage id="watchalong.nowPlaying" defaultMessage="Now playing" />
            ) : adderName ? (
              <FormattedMessage
                id="watchalong.addedBy"
                defaultMessage="Added by {name}"
                values={{ name: <DisplayName pubkey={item.addedBy} name={adderName} /> }}
              />
            ) : (
              meta?.author ?? ""
            )}
          </p>
        </div>
      </button>
      <div className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 touch:opacity-100 focus-within:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" className="size-6 touch:size-11 clip-corner-lg text-muted-foreground" aria-label={intl.formatMessage({ id: "watchalong.moveUp", defaultMessage: "Move up" })} disabled={!canUp} onClick={onUp}>
          <ArrowUp className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6 touch:size-11 clip-corner-lg text-muted-foreground" aria-label={intl.formatMessage({ id: "watchalong.moveDown", defaultMessage: "Move down" })} disabled={!canDown} onClick={onDown}>
          <ArrowDown className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6 touch:size-11 clip-corner-lg text-muted-foreground hover:text-destructive" aria-label={intl.formatMessage({ id: "watchalong.removeFromQueue", defaultMessage: "Remove from queue" })} onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
