import {
  useParticipants,
  useRoomContext,
  useSpeakingParticipants,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import type { NostrMetadata } from "@nostrify/nostrify";
import type { Participant, RemoteParticipant } from "livekit-client";
import { Track } from "livekit-client";
import { Maximize2, Minimize2, MicOff, ScreenShare, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VoiceUserContextMenu, VolumeSliderRow } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useUserVolume } from "@/hooks/useUserVolume";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { playScreenShareSound } from "@/lib/callSounds";
import {
  getAvatarShape,
  shapedAvatarSpeakingStyle,
} from "@/lib/avatarShape";
import { cn } from "@/lib/utils";

// Back-compat re-export: the slot moved to its own (LiveKit-free) module so
// pages can render it without pulling the voice stack into their chunks.
export { CallStageSlot } from "@/components/chat/CallStageSlot";

/** The tile aspect ratio (16:9) used for fit calculations. */
const TILE_ASPECT = 16 / 9;

/**
 * Compute the grid layout (column count + per-tile pixel size) that fits all
 * `count` 16:9 tiles inside a `width`×`height` box while maximizing tile size —
 * so tiles scale down to fit instead of overflowing into a scroll. Tries every
 * column count and keeps the one yielding the largest tiles.
 */
function fitGrid(
  count: number,
  width: number,
  height: number,
  gap: number,
): { cols: number; tileW: number; tileH: number } {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 1, tileW: 0, tileH: 0 };
  }
  let best = { cols: 1, tileW: 0, tileH: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // Available space per cell after gaps.
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    // Fit a 16:9 tile inside the cell.
    let tileW = cellW;
    let tileH = tileW / TILE_ASPECT;
    if (tileH > cellH) {
      tileH = cellH;
      tileW = tileH * TILE_ASPECT;
    }
    if (tileW > best.tileW) best = { cols, tileW, tileH };
  }
  return best;
}

/**
 * Track an element's content-box size via ResizeObserver. Uses a callback ref
 * so the observer is (re)attached whenever the measured element mounts — the
 * grid container unmounts/remounts as focus toggles, and a plain
 * useRef + useEffect([]) would leave a stale 0×0 size on the new element.
 */
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    if (!el) {
      observerRef.current = null;
      return;
    }
    // Seed immediately so the first paint after (re)mount has real dimensions,
    // not 0×0 (the ResizeObserver callback is async).
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  return [ref, size] as const;
}

/**
 * A stable key identifying a focusable tile: a participant's camera/screenshare
 * track, or an audio-only participant's avatar tile. Used to track which tile is
 * spotlighted across re-renders (track publications come and go).
 */
function trackTileKey(trackRef: TrackReference): string {
  return `${trackRef.participant.identity}:${trackRef.source}`;
}
function participantTileKey(participant: Participant): string {
  return `${participant.identity}:avatar`;
}

/** The shared look of a tile's bottom-left name pill. */
const nameplateClass =
  "absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white max-w-[calc(100%-0.75rem)]";

/** How long an unclaimed Concord identity reads as "Verifying…" before "Unverified". */
const VERIFY_GRACE_MS = 15_000;

/**
 * The name to render for a participant, folding in Concord's verification race
 * (CORD-07 §4): a participant's LiveKit connection and their signed presence
 * claim travel over independent channels (the SFU vs the Nostr relays), so a
 * just-joined participant is briefly unclaimed — and labeling that instant
 * "Unverified" reads as an integrity warning when nothing is wrong yet. While
 * the grace window is open the tile says "Verifying…"; only an identity that
 * stays unclaimed (or contested) past it earns "Unverified". The window is
 * anchored at the later of the participant's join and our own — a fresh viewer
 * has to rewarm its own presence fold too — so it's stable across tile
 * remounts (grid ↔ spotlight, camera on/off) and can't be reset remotely.
 */
function useTileDisplayName(participant: Participant): {
  pubkey: string;
  displayName: string;
  metadata: NostrMetadata | undefined;
} {
  const room = useRoomContext();
  const { pubkey, verified } = useVoiceIdentity()(participant.identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const scopedName = useScopedDisplayName(pubkey, metadata);

  // Fallback anchor for the (transient) window before joinedAt is populated.
  const mountedAt = useRef(Date.now());
  const anchor =
    Math.max(participant.joinedAt?.getTime() ?? 0, room.localParticipant.joinedAt?.getTime() ?? 0) ||
    mountedAt.current;
  const deadline = anchor + VERIFY_GRACE_MS;
  const [, setTick] = useState(0);
  const inGrace = !verified && Date.now() < deadline;
  // Re-render when the grace window lapses so "Verifying…" flips to "Unverified".
  useEffect(() => {
    if (!inGrace) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, deadline - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [inGrace, deadline]);

  return {
    pubkey,
    displayName: verified ? scopedName : inGrace ? "Verifying…" : "Unverified",
    metadata,
  };
}

/**
 * Keep a remote participant's playback volume applied: LiveKit resets to 1 on
 * a fresh subscription, and the persisted per-pubkey volume can be changed
 * from any surface (this tile's nameplate dropdown, the tile's context menu,
 * or the sidebar roster's context menu — all via the shared `useUserVolume`
 * store). Re-applies on (re)join, identity resolution, and store changes.
 * No-ops for the local participant.
 */
function useApplyUserVolume(participant: Participant, pubkey: string) {
  const [volume] = useUserVolume(pubkey);
  useEffect(() => {
    if (!participant.isLocal) (participant as RemoteParticipant).setVolume(volume);
  }, [participant, volume]);
}

/**
 * A dropdown anchored on a remote participant's tile nameplate with the
 * playback-volume slider, à la Discord. Shares the per-pubkey volume store
 * with the right-click menus, so all controls stay in sync.
 */
function VolumeMenu({
  pubkey,
  displayName,
  children,
}: {
  pubkey: string;
  displayName: string;
  children: React.ReactNode;
}) {
  const [volume, setVolume] = useUserVolume(pubkey);
  const pct = Math.round(volume * 100);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Volume for ${displayName}`}
          className={cn(nameplateClass, "cursor-pointer hover:bg-black/80")}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium truncate">{displayName}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
        </div>
        <VolumeSliderRow volume={volume} apply={setVolume} displayName={displayName} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A single video tile (camera or screenshare) for one participant track. */
function VideoTile({
  trackRef,
  focused,
  onToggleFocus,
}: {
  trackRef: TrackReference;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const participant = trackRef.participant;
  const { pubkey, displayName, metadata } = useTileDisplayName(participant);
  const shape = getAvatarShape(metadata);
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;
  // A placeholder (no track) means the participant has the source but the track
  // isn't subscribed yet — show their avatar instead of video.
  const hasVideo = Boolean(trackRef.publication?.track);
  const isLocal = participant.isLocal;
  // Keep the persisted per-user volume applied to this participant's audio.
  useApplyUserVolume(participant, pubkey);
  const hasVolumeMenu = !isLocal && !isScreenShare;

  const nameplate = (
    <>
      {isScreenShare ? (
        <ScreenShare className="size-3 shrink-0" />
      ) : !participant.isMicrophoneEnabled ? (
        <MicOff className="size-3 shrink-0 text-destructive" />
      ) : null}
      <span className="truncate">
        {displayName}
        {isScreenShare && " — screen"}
        {isLocal && " (you)"}
      </span>
    </>
  );

  const tile = (
    <div
      className={cn(
        "group relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10 h-full w-full",
      )}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          // Mirror your own camera (not screenshare) so it reads naturally. The
          // video fills its (definite-height) tile and letterboxes via
          // object-contain, so a tall screenshare fits without overflowing.
          className={cn(
            "h-full w-full",
            isScreenShare || focused ? "object-contain" : "object-cover",
            isLocal && !isScreenShare && "-scale-x-100",
          )}
        />
      ) : (
        <Avatar shape={shape} className={focused ? "size-24" : "size-16"}>
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xl">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      <FocusButton focused={focused} onClick={onToggleFocus} />
      {/* Remote (non-screenshare) nameplates open the per-user volume menu. */}
      {hasVolumeMenu ? (
        <VolumeMenu pubkey={pubkey} displayName={displayName}>
          {nameplate}
        </VolumeMenu>
      ) : (
        <div className={nameplateClass}>{nameplate}</div>
      )}
    </div>
  );

  return hasVolumeMenu ? (
    <VoiceUserContextMenu pubkey={pubkey} displayName={displayName}>
      {tile}
    </VoiceUserContextMenu>
  ) : (
    tile
  );
}

/** Always-visible expand/shrink button overlaid on a tile's top-right corner. */
function FocusButton({ focused, onClick }: { focused: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={focused ? "Exit focus" : "Focus this tile"}
      onClick={onClick}
      className={cn(
        "absolute top-1.5 right-1.5 rounded-md bg-black/60 p-1.5 text-white/90 hover:bg-black/80 hover:text-white",
        // Always visible (not hover-gated) so the expand button is
        // discoverable — especially after collapsing a screenshare back to
        // the grid, where the re-expand button was previously hidden.
        "opacity-100 transition-opacity",
      )}
    >
      {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  );
}

/**
 * A tile for a participant who isn't sharing any video: a large centered avatar
 * on the same dark canvas as the video tiles, with a speaking ring and a
 * name/mute footer — so the stage shows *everyone* in the call (à la Discord),
 * not just cameras.
 */
function AvatarTile({
  participant,
  isSpeaking,
  focused,
  onToggleFocus,
}: {
  participant: Participant;
  isSpeaking: boolean;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const { pubkey, displayName, metadata } = useTileDisplayName(participant);
  const shape = getAvatarShape(metadata);
  const hasCustomShape = !!shape;
  const isLocal = participant.isLocal;
  const muted = !participant.isMicrophoneEnabled;
  // Keep the persisted per-user volume applied to this participant's audio.
  useApplyUserVolume(participant, pubkey);

  // For emoji-shaped avatars the speaking ring is a drop-shadow that hugs the
  // silhouette (a box ring would clip against the mask); circular avatars get a
  // plain ring + glow.
  const ringStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  const nameplate = (
    <>
      {muted && <MicOff className="size-3 shrink-0 text-destructive" />}
      <span className="truncate">
        {displayName}
        {isLocal && " (you)"}
      </span>
    </>
  );

  const tile = (
    <div
      className={cn(
        "group relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10",
        focused ? "h-full w-full" : "h-full w-full",
      )}
    >
      <div
        className={cn(
          "rounded-full transition-shadow",
          !hasCustomShape && isSpeaking && "ring-2 ring-success shadow-[0_0_0_4px_hsl(var(--success)/0.35)]",
        )}
        style={ringStyle}
      >
        <Avatar shape={shape} className={focused ? "size-28" : "size-16"}>
          <AvatarImage src={metadata?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xl">
            {displayName[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
      <FocusButton focused={focused} onClick={onToggleFocus} />
      {/* Remote nameplates open the per-user volume menu. */}
      {!isLocal ? (
        <VolumeMenu pubkey={pubkey} displayName={displayName}>
          {nameplate}
        </VolumeMenu>
      ) : (
        <div className={nameplateClass}>{nameplate}</div>
      )}
    </div>
  );

  return !isLocal ? (
    <VoiceUserContextMenu pubkey={pubkey} displayName={displayName}>
      {tile}
    </VoiceUserContextMenu>
  ) : (
    tile
  );
}

/**
 * The call stage: a dismissable box, shown at the top of the chat window, that
 * presents *everyone* in the call as tiles — cameras and screenshares as video,
 * audio-only participants as avatars (with a speaking ring). It animates open
 * when expanded and collapses to zero height when closed. Opening/closing is
 * driven by `open` (toggled from the corner call panel); the close button
 * collapses it via the call context.
 *
 * Rendered inside a `LiveKitRoom` context and portaled into the matching chat
 * surface's top-of-chat slot by `CallProvider`.
 */
export function CallStage({
  callLabel,
  open,
}: {
  callLabel?: React.ReactNode;
  open: boolean;
}) {
  const { setStageOpen } = useCall();
  const participants = useParticipants();
  const speakingParticipants = useSpeakingParticipants();
  const speakingIds = useMemo(
    () => new Set(speakingParticipants.map((p) => p.identity)),
    [speakingParticipants],
  );

  // Which tile is spotlighted, tracked by its stable key (or null for the grid).
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Video tracks (camera + screenshare) we've subscribed to — each a full
  // TrackReference so `VideoTrack` has a real reference to render.
  const videoTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  ).filter((t): t is TrackReference => Boolean(t.publication));

  // Participants who already have a (camera) video tile shown; the rest get an
  // avatar tile so everyone is represented exactly once (screenshares are extra
  // tiles in addition to their owner's camera/avatar tile).
  const withCamera = new Set(
    videoTracks.filter((t) => t.source === Track.Source.Camera).map((t) => t.participant.identity),
  );
  const avatarOnly = participants.filter((p) => !withCamera.has(p.identity));

  // Auto-expand the stage when a screenshare *appears* and spotlight it (à la
  // Discord). We compare against the previous render's screenshare keys so this
  // fires only on a new share — not on every render, and not re-opening after
  // the user manually closes the stage while a share is still running.
  const screenShareKeys = videoTracks
    .filter((t) => t.source === Track.Source.ScreenShare)
    .map(trackTileKey);
  const prevScreenShareKeys = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevScreenShareKeys.current;
    const appeared = screenShareKeys.find((k) => !prev.includes(k));
    if (appeared) {
      setStageOpen(true);
      setFocusKey(appeared);
      playScreenShareSound();
    }
    prevScreenShareKeys.current = screenShareKeys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShareKeys.join("|")]);

  // The ordered, keyed set of focusable tiles. A render fn per tile keeps the
  // spotlight + thumbnail strip in sync without duplicating tile markup.
  const tiles = useMemo(() => {
    const list: { key: string; render: (focused: boolean) => React.ReactNode }[] = [];
    for (const trackRef of videoTracks) {
      const key = trackTileKey(trackRef);
      list.push({
        key,
        render: (focused) => (
          <VideoTile
            trackRef={trackRef}
            focused={focused}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
    for (const p of avatarOnly) {
      const key = participantTileKey(p);
      list.push({
        key,
        render: (focused) => (
          <AvatarTile
            participant={p}
            isSpeaking={speakingIds.has(p.identity)}
            focused={focused}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
    return list;
    // `speakingIds`/identities change frequently; recompute is cheap.
  }, [videoTracks, avatarOnly, speakingIds]);

  // If the focused tile goes away (e.g. its owner stopped sharing or left),
  // drop back to the grid so we don't spotlight nothing.
  useEffect(() => {
    if (focusKey && !tiles.some((t) => t.key === focusKey)) setFocusKey(null);
  }, [focusKey, tiles]);

  const focused = focusKey ? tiles.find((t) => t.key === focusKey) : undefined;

  // Measure the grid area so tiles scale down to fit instead of overflowing.
  const [gridRef, gridSize] = useElementSize<HTMLDivElement>();
  const GRID_GAP = 8; // matches gap-2
  const grid = fitGrid(tiles.length, gridSize.width, gridSize.height, GRID_GAP);

  const header = (
    <div className="flex items-center gap-2 px-3 py-2 shrink-0">
      <span className="text-sm font-medium truncate min-w-0 flex-1">{callLabel}</span>
      {focused && (
        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          onClick={() => setFocusKey(null)}
        >
          <Minimize2 className="size-3.5" />
          Show all
        </button>
      )}
      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
        {participants.length} in call
      </span>
      <button
        type="button"
        aria-label="Hide call stage"
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        onClick={() => setStageOpen(false)}
      >
        <X className="size-4" />
      </button>
    </div>
  );

  const body = focused ? (
    // Spotlight: the focused tile fills the available height (the panel has a
    // definite height now, so the video letterboxes via object-contain); the
    // rest go in a horizontally-scrolling thumbnail strip below.
    <div className="flex-1 min-h-0 flex flex-col gap-2 p-3 pt-0">
      <div className="flex-1 min-h-0">{focused.render(true)}</div>
      {tiles.length > 1 && (
        <div className="shrink-0 flex gap-2 overflow-x-auto">
          {tiles
            .filter((t) => t.key !== focusKey)
            .map((t) => (
              <div key={t.key} className="shrink-0 w-40 aspect-video">
                {t.render(false)}
              </div>
            ))}
        </div>
      )}
    </div>
  ) : (
    // Auto-fit grid: tiles are sized to the largest 16:9 box that fits all of
    // them in the measured area, so they scale down rather than overflowing.
    <div ref={gridRef} className="flex-1 min-h-0 overflow-hidden p-3 pt-0 flex items-center justify-center">
      <div
        className="grid place-content-center"
        style={{
          gap: GRID_GAP,
          gridTemplateColumns: `repeat(${grid.cols}, ${grid.tileW}px)`,
          gridAutoRows: `${grid.tileH}px`,
        }}
      >
        {tiles.map((t) => (
          <div key={t.key} style={{ width: grid.tileW, height: grid.tileH }}>
            {t.render(false)}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        "shrink-0 mx-2 overflow-hidden transition-all duration-200 ease-out",
        open ? "mt-2 max-h-[66vh] opacity-100" : "mt-0 max-h-0 opacity-0",
      )}
    >
      <div className="clip-corner-lg bg-chrome-deep shadow-lg flex flex-col h-[42vh] max-h-[60vh]">
        {header}
        {body}
      </div>
    </div>
  );
}
