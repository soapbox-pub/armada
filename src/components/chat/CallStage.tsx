import {
  useConnectionState,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import type { TrackReference } from "@livekit/components-react";
import type { NostrMetadata } from "@nostrify/nostrify";
import { Capacitor } from "@capacitor/core";
import type { Participant, RemoteParticipant } from "livekit-client";
import { ConnectionState, Track } from "livekit-client";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  EyeOff,
  Fullscreen,
  Hand,
  Info,
  Maximize2,
  Minimize2,
  MicOff,
  Monitor,
  ScreenShare,
  Shrink,
  Video,
} from "lucide-react";
import type { CSSProperties } from "react";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CameraButton,
  LeaveButton,
  MicButton,
  RaiseHandButton,
  ReactionsMenu,
  ScreenShareButton,
} from "@/components/chat/CallControls";
import { ScreenShareDiagnosticsDialog } from "@/components/chat/ScreenShareDiagnosticsDialog";
import { DeviceMenu } from "@/components/chat/VoiceBar";
import { ParticipantRecordingFlags, RecordingIndicator } from "@/components/chat/CallRecordingIndicators";
import { RecordingFlagIcons } from "@/components/RecordingFlagIcons";
import { VoiceRejoiningContext } from "@/contexts/VoiceRejoiningContext";
import { streamOwnerKey, useScreenShareWatch } from "@/contexts/ScreenShareWatchContext";
import { LiveBadge } from "@/components/VoicePresence";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useSpeakers } from "@/hooks/useSpeakers";
import {
  VoiceUserContextMenu,
  VolumeSliderRow,
  type PlaybackVolumeTarget,
} from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { defineMessages, FormattedMessage, useIntl } from "@/i18n";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useScreenShareVolume, useUserVolume } from "@/hooks/useUserVolume";
import { useCallSignals } from "@/contexts/CallSignalsContext";
import type { VoiceReactionEntry } from "@/concord/lib/voice";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { playScreenShareEndSound, playScreenShareSound } from "@/lib/callSounds";
import { pickVisible, type CallActivity } from "@/lib/callRanking";
import {
  getAvatarShape,
  shapedAvatarSpeakingStyle,
} from "@/lib/avatarShape";
import { cn } from "@/lib/utils";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { isHevcScreenShareParticipant } from "@/lib/hevcScreenShare";
import type { DesktopHevcScreenShareStatus } from "@/lib/desktop";
import type { ImetaEntry } from "@/lib/imeta";
import type { ProfileImeta } from "@/lib/profileImeta";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { PortalContainerProvider, usePortalContainer } from "@/hooks/usePortalContainer";
import { AvatarInitial } from "@/components/AvatarInitial";

const TILE_ASPECT = 16 / 9;

/**
 * Column count + tile size that fits `count` 16:9 tiles in the box with the
 * largest tiles (tiles shrink rather than scroll).
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
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
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
 * Element content-box size via ResizeObserver. A callback ref, since the grid
 * container remounts on focus/theater toggles.
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
    // Seed synchronously; the ResizeObserver callback is async.
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

/** Stable key for a focusable tile (camera/screenshare track or avatar tile). */
function trackTileKey(trackRef: TrackReference): string {
  return `${trackRef.participant.identity}:${trackRef.source}`;
}
function participantTileKey(participant: Participant): string {
  return `${participant.identity}:avatar`;
}

const LOCAL_HEVC_SCREEN_SHARE_KEY = "local:hevc-screen-share";

const FULLSCREEN_CONTROLS_IDLE_MS = 3_000;

/**
 * Android WebView advertises the Fullscreen API without reliable element
 * fullscreen, and its native call surface owns fullscreen anyway.
 */
function supportsElementFullscreen(): boolean {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return false;
  if (Capacitor.getPlatform() === "android") return false;
  return document.fullscreenEnabled !== false &&
    typeof HTMLElement.prototype.requestFullscreen === "function";
}

/**
 * Reveal fullscreen chrome on input, hide after idle. Hover, keyboard
 * `:focus-visible` and open portaled surfaces keep it up; mouse focus must not,
 * hence checking the DOM at timeout time.
 */
function useFullscreenControlsAutoHide(
  tile: HTMLElement | null,
  active: boolean,
  setVisible: React.Dispatch<React.SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!active || !tile) {
      setVisible(false);
      return;
    }

    let timer: number | null = null;
    let pointerInteracting = false;
    const controlsSelector = "[data-fullscreen-controls]";
    const openSurfaceSelector = [
      '[role="dialog"][data-state="open"]',
      '[role="menu"][data-state="open"]',
      '[role="listbox"][data-state="open"]',
    ].join(",");

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const shouldRemainVisible = () => {
      const controls = tile.querySelector<HTMLElement>(controlsSelector);
      return pointerInteracting ||
        Boolean(controls?.matches(":hover")) ||
        Boolean(controls?.querySelector(":focus-visible")) ||
        Boolean(tile.querySelector(openSurfaceSelector));
    };
    const scheduleHide = () => {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        if (shouldRemainVisible()) {
          scheduleHide();
        } else {
          setVisible(false);
        }
      }, FULLSCREEN_CONTROLS_IDLE_MS);
    };
    const reveal = () => {
      setVisible(true);
      scheduleHide();
    };
    const beginPointerInteraction = () => {
      pointerInteracting = true;
      reveal();
    };
    const endPointerInteraction = () => {
      if (!pointerInteracting) return;
      pointerInteracting = false;
      reveal();
    };

    // Mounting hidden gives the controls a real entrance transition.
    reveal();
    tile.addEventListener("pointermove", reveal, { passive: true });
    tile.addEventListener("pointerdown", beginPointerInteraction, { passive: true });
    tile.addEventListener("touchstart", beginPointerInteraction, { passive: true });
    tile.addEventListener("focusin", reveal);
    tile.addEventListener("focusout", reveal);
    document.addEventListener("keydown", reveal);
    document.addEventListener("pointerup", endPointerInteraction, { passive: true });
    document.addEventListener("pointercancel", endPointerInteraction, { passive: true });
    document.addEventListener("touchend", endPointerInteraction, { passive: true });
    document.addEventListener("touchcancel", endPointerInteraction, { passive: true });
    return () => {
      clearTimer();
      tile.removeEventListener("pointermove", reveal);
      tile.removeEventListener("pointerdown", beginPointerInteraction);
      tile.removeEventListener("touchstart", beginPointerInteraction);
      tile.removeEventListener("focusin", reveal);
      tile.removeEventListener("focusout", reveal);
      document.removeEventListener("keydown", reveal);
      document.removeEventListener("pointerup", endPointerInteraction);
      document.removeEventListener("pointercancel", endPointerInteraction);
      document.removeEventListener("touchend", endPointerInteraction);
      document.removeEventListener("touchcancel", endPointerInteraction);
    };
  }, [active, setVisible, tile]);
}

function participantIdentityKey(
  identity: string,
  resolve: ReturnType<typeof useVoiceIdentity>,
): string | null {
  if (!identity) return null;
  const mapped = resolve(identity);
  return mapped.verified ? `pubkey:${mapped.pubkey}` : `identity:${identity}`;
}

function uniqueParticipantCount(
  participants: readonly Participant[],
  resolve: ReturnType<typeof useVoiceIdentity>,
): number {
  const identities = new Set<string>();
  for (const participant of participants) {
    if (isHevcScreenShareParticipant(participant, resolve)) continue;
    const key = participantIdentityKey(participant.identity, resolve);
    if (key) identities.add(key);
  }
  return identities.size;
}

/** The shared look of a tile's bottom-left name pill. */
const nameplateClass =
  "absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white max-w-[calc(100%-0.75rem)]";

const VERIFY_GRACE_MS = 15_000;

/**
 * Window after joining in which the first video track still counts as "already
 * rolling" and auto-expands the stage (subscriptions land async, slower on E2EE).
 */
const JOIN_VIDEO_EXPAND_WINDOW_MS = 10_000;

/** The floating window is the frame, so its one tile fills it square-cornered. */
const FLOATING_TILE = "h-full w-full [&>*]:rounded-none [&>*]:ring-0";

/** Minimum hold on the floating window's active speaker, so brief interjections don't flicker it. */
const FLOATING_SPEAKER_HOLD_MS = 2_000;

/**
 * The floating window's single tile, by priority: screen share, focused tile,
 * debounced active speaker, stable fallback. Indexes into the grid's `tiles`.
 */
function usePrimaryFloatingKey(args: {
  enabled: boolean;
  focusKey: string | null;
  screenShareKey: string | null;
  speakingKey: string | null;
  fallbackKey: string | null;
}): string | null {
  const { enabled, focusKey, screenShareKey, speakingKey, fallbackKey } = args;
  const [heldSpeaker, setHeldSpeaker] = useState<string | null>(null);
  const lastSwitch = useRef(0);
  useEffect(() => {
    if (!enabled || !speakingKey) return;
    if (speakingKey === heldSpeaker) return;
    const now = Date.now();
    const wait = Math.max(0, FLOATING_SPEAKER_HOLD_MS - (now - lastSwitch.current));
    if (wait === 0) {
      lastSwitch.current = now;
      setHeldSpeaker(speakingKey);
      return;
    }
    const timer = setTimeout(() => {
      lastSwitch.current = Date.now();
      setHeldSpeaker(speakingKey);
    }, wait);
    return () => clearTimeout(timer);
  }, [enabled, speakingKey, heldSpeaker]);

  if (!enabled) return null;
  return screenShareKey ?? focusKey ?? heldSpeaker ?? speakingKey ?? fallbackKey;
}

const msg = defineMessages({
  showDetails: { id: "callStage.showDetails", defaultMessage: "Show stream details" },
  exitFullscreen: { id: "callStage.exitFullscreen", defaultMessage: "Exit fullscreen" },
  viewFullscreen: { id: "callStage.viewFullscreen", defaultMessage: "View stream fullscreen" },
  handRaised: { id: "callStage.handRaised", defaultMessage: "Hand raised" },
  call: { id: "callStage.call", defaultMessage: "Call" },
  connecting: { id: "callStage.connecting", defaultMessage: "Connecting…" },
});

/**
 * Display name with Concord's verification race (CORD-07 §4): LiveKit and the
 * presence claim arrive separately, so show "Verifying…" during a grace window
 * before "Unverified". Anchored at the later of their join and ours, so it's
 * stable across tile remounts and can't be reset remotely.
 */
function useTileDisplayName(participant: Participant): {
  pubkey: string;
  displayName: string;
  verified: boolean;
  metadata: NostrMetadata | undefined;
  imeta: ProfileImeta | undefined;
} {
  const room = useRoomContext();
  const { pubkey, verified } = useVoiceIdentity()(participant.identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const scopedName = useScopedDisplayName(pubkey, metadata);
  const intl = useIntl();

  const mountedAt = useRef(Date.now());
  const anchor =
    Math.max(participant.joinedAt?.getTime() ?? 0, room.localParticipant.joinedAt?.getTime() ?? 0) ||
    mountedAt.current;
  const deadline = anchor + VERIFY_GRACE_MS;
  const [, setTick] = useState(0);
  const inGrace = !verified && Date.now() < deadline;
  useEffect(() => {
    if (!inGrace) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, deadline - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [inGrace, deadline]);

  return {
    pubkey,
    displayName: verified
      ? scopedName
      : inGrace
        ? intl.formatMessage({ id: "callStage.verifying", defaultMessage: "Verifying…" })
        : intl.formatMessage({ id: "callStage.unverified", defaultMessage: "Unverified" }),
    verified,
    metadata,
    imeta: author.data?.imeta,
  };
}

/**
 * Keep a remote participant's mic and screen-share gains applied independently,
 * re-applying on identity or persisted-volume changes. No-op for local.
 */
function useApplyPlaybackVolumes(participant: Participant, pubkey: string) {
  const [userVolume] = useUserVolume(pubkey);
  const [screenShareVolume] = useScreenShareVolume(pubkey);
  useEffect(() => {
    if (!participant.isLocal) {
      const remote = participant as RemoteParticipant;
      remote.setVolume(userVolume, Track.Source.Microphone);
      remote.setVolume(screenShareVolume, Track.Source.ScreenShareAudio);
    }
  }, [participant, userVolume, screenShareVolume, pubkey]);
}

/** Per-participant playback-volume menu on the tile nameplate; shares the right-click menus' store. */
function VolumeMenu({
  pubkey,
  displayName,
  verified,
  target = "user",
  nameplateClassName,
  children,
}: {
  pubkey: string;
  displayName: string;
  /** Whether `pubkey` is a verified claim — see {@link VoiceUserContextMenu}. */
  verified: boolean;
  target?: PlaybackVolumeTarget;
  nameplateClassName?: string;
  children: React.ReactNode;
}) {
  const [userVolume, setUserVolume] = useUserVolume(pubkey);
  const [screenShareVolume, setScreenShareVolume] = useScreenShareVolume(pubkey);
  const volume = target === "screenShare" ? screenShareVolume : userVolume;
  const setVolume = target === "screenShare" ? setScreenShareVolume : setUserVolume;
  const pct = Math.round(volume * 100);
  const intl = useIntl();
  const name = <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={target === "screenShare"
            ? intl.formatMessage({ id: "callStage.screenShareVolumeFor", defaultMessage: "Screen share volume for {name}" }, { name: displayName })
            : intl.formatMessage({ id: "callStage.volumeFor", defaultMessage: "Volume for {name}" }, { name: displayName })}
          className={cn(
            nameplateClass,
            "cursor-pointer transition-[bottom] hover:bg-black/80",
            nameplateClassName,
          )}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium truncate">
            {target === "screenShare" ? (
              <FormattedMessage id="callStage.screenShareOf" defaultMessage="{name}'s screen share" values={{ name }} />
            ) : (
              name
            )}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
        </div>
        <VolumeSliderRow
          volume={volume}
          apply={setVolume}
          displayName={displayName}
          target={target}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Blurred avatar filling a camera-off tile (the Signal look). */
function BlurredAvatarBackdrop({ picture, imeta }: { picture?: string; imeta?: ImetaEntry }) {
  // kind-0 content: same sanitizer, media policy and decryption as the avatar itself.
  const src = sanitizeImageSrc(picture);
  if (!src) return null;
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <FallbackImage
        src={src}
        imeta={imeta}
        alt=""
        // Scale up so blurred edges never reveal the tile background.
        className="h-full w-full scale-150 object-cover blur-2xl"
        draggable={false}
      />
      <div className="absolute inset-0 bg-black/40" />
    </div>
  );
}

/** Raised-hand badge on a tile (Concord calls only). */
function RaisedHandBadge({ pubkey }: { pubkey: string }) {
  const { raisedHands } = useVoiceActivity();
  const intl = useIntl();
  if (!raisedHands.has(pubkey)) return null;
  return (
    <div
      className="absolute top-1.5 left-1.5 z-10 flex items-center justify-center rounded-md bg-warning text-warning-foreground size-6 shadow-md animate-in fade-in-0 zoom-in-75"
      aria-label={intl.formatMessage(msg.handRaised)}
    >
      <Hand className="size-3.5" />
    </div>
  );
}

/** Deterministic −70..70px jitter per nonce, so simultaneous reactions fan out. */
function reactionOffset(nonce: string): number {
  let h = 0;
  for (let i = 0; i < nonce.length; i++) h = (h * 31 + nonce.charCodeAt(i)) | 0;
  return (h % 141) - 70;
}

interface ReactionSpawn {
  x: number;
  y: number;
  rise: number;
}

/**
 * Every reaction rises from bottom-center of the stage box, not the sender's
 * tile: tile position shifts with layout, and the floater's pill already says who.
 */
const REACTION_RISE_RATIO = 0.7;
const REACTION_RISE_MIN = 160;
const REACTION_RISE_MAX = 420;
const REACTION_BOTTOM_MARGIN = 24;
// Keep the floater clear of the top and side edges (`overflow-hidden` would clip it).
const REACTION_TOP_MARGIN = 8;
const REACTION_EDGE_MARGIN = 72;

function computeSpawnPoint(container: HTMLElement | null, nonce: string): ReactionSpawn {
  const box = container?.getBoundingClientRect();
  if (!box || box.width === 0 || box.height === 0) {
    return { x: 0, y: 0, rise: REACTION_RISE_MIN };
  }
  const y = box.height - REACTION_BOTTOM_MARGIN;
  // Clamped fraction of box height, capped so it never rises past the top.
  let rise = Math.min(Math.max(box.height * REACTION_RISE_RATIO, REACTION_RISE_MIN), REACTION_RISE_MAX);
  rise = Math.min(rise, Math.max(y - REACTION_TOP_MARGIN, 0));
  const margin = Math.min(REACTION_EDGE_MARGIN, box.width / 2);
  const x = Math.min(Math.max(box.width / 2 + reactionOffset(nonce), margin), box.width - margin);
  return { x, y, rise };
}

/**
 * Memoized: `entry`/`spawn` are stable for a reaction's ~4s life, so other
 * floaters skip re-renders.
 */
const StageReactionFloater = memo(function StageReactionFloater({
  entry,
  spawn,
}: {
  entry: VoiceReactionEntry;
  spawn: ReactionSpawn;
}) {
  const author = useAuthor(entry.author);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(entry.author, metadata);
  return (
    <div
      className="absolute flex items-center gap-1.5 animate-reaction-rise"
      style={{
        left: spawn.x,
        top: spawn.y,
        "--rise": `${spawn.rise}px`,
      } as CSSProperties}
    >
      <span className="font-emoji text-4xl leading-none drop-shadow shrink-0">{entry.emoji}</span>
      {/* Matches the tile nameplate's width budget so names don't clip. */}
      <span className="flex items-center gap-1 rounded-full bg-black/70 pl-0.5 pr-2 py-0.5 text-xs text-white shadow shrink-0 max-w-56">
        <Avatar className="size-4 shrink-0">
          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt="" />
          <AvatarFallback className="bg-primary/30 text-primary text-monogram">
            <AvatarInitial name={displayName} pubkey={entry.author} />
          </AvatarFallback>
        </Avatar>
        <span className="truncate min-w-0">
          <DisplayName pubkey={entry.author} name={displayName} />
        </span>
      </span>
    </div>
  );
});

/**
 * Stage-wide emoji reaction overlay. One instance per render branch;
 * `containerRef` sizes it and is the spawn coordinate origin.
 */
function StageReactions({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const { reactions } = useCallSignals();
  // A ref, not state, so a new reaction gets its spawn in THIS render (state
  // would skip its pop-in frame). The cached object keeps the floater memo intact.
  const spawns = useRef(new Map<string, ReactionSpawn>());

  // Drop aged-out spawns so the map stays bounded.
  useEffect(() => {
    const live = new Set(reactions.map((r) => r.nonce));
    for (const nonce of spawns.current.keys()) {
      if (!live.has(nonce)) spawns.current.delete(nonce);
    }
  }, [reactions]);

  if (reactions.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden>
      {reactions.map((r) => {
        let spawn = spawns.current.get(r.nonce);
        if (!spawn) {
          spawn = computeSpawnPoint(containerRef.current, r.nonce);
          spawns.current.set(r.nonce, spawn);
        }
        return <StageReactionFloater key={r.nonce} entry={r} spawn={spawn} />;
      })}
    </div>
  );
}

function VideoTile({
  trackRef,
  isSpeaking,
  focused,
  large = focused,
  onToggleFocus,
}: {
  trackRef: TrackReference;
  isSpeaking: boolean;
  focused: boolean;
  large?: boolean;
  onToggleFocus: () => void;
}) {
  const participant = trackRef.participant;
  const { pubkey, displayName, verified, metadata, imeta } = useTileDisplayName(participant);
  const intl = useIntl();
  const shape = getAvatarShape(metadata);
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;
  const { enabled: endToEndEncrypted } = useCallSignals();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  const inheritedPortalContainer = usePortalContainer();
  const fullscreenAvailable = isScreenShare && supportsElementFullscreen();
  useFullscreenControlsAutoHide(tileRef.current, fullscreen, setFullscreenControlsVisible);
  const portalContainer = fullscreen
    ? tileRef.current ?? inheritedPortalContainer
    : inheritedPortalContainer;
  const fullscreenNameplateClass = fullscreen && fullscreenControlsVisible
    ? "bottom-[calc(4rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
    : undefined;
  // Avatar unless there's a LIVE track: turning video off mutes the track
  // before the publication clears, which would render a black tile.
  const hasVideo = Boolean(trackRef.publication?.track) && !trackRef.publication?.isMuted;
  const isLocal = participant.isLocal;
  const { streamingPubkeys } = useVoiceActivity();
  const streaming = !isScreenShare && verified && streamingPubkeys.has(pubkey);
  const { watch, stopWatching } = useScreenShareWatch();
  const resolveIdentity = useVoiceIdentity();
  useApplyPlaybackVolumes(participant, pubkey);
  const hasVolumeMenu = !isLocal;
  const volumeTarget: PlaybackVolumeTarget = isScreenShare ? "screenShare" : "user";

  useEffect(() => {
    if (!isScreenShare) return;
    const update = () => setFullscreen(document.fullscreenElement === tileRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [isScreenShare]);

  const toggleFullscreen = () => {
    if (!tileRef.current || !fullscreenAvailable) return;
    if (document.fullscreenElement === tileRef.current) {
      void document.exitFullscreen().catch((error) =>
        console.warn("failed to exit screen-share fullscreen", error)
      );
      return;
    }
    void tileRef.current.requestFullscreen({ navigationUI: "hide" }).catch((error) =>
      console.warn("failed to enter screen-share fullscreen", error)
    );
  };

  const openDetails = () => {
    setDetailsOpen(true);
  };

  const nameplate = (
    <>
      {isScreenShare ? (
        <ScreenShare className="size-3 shrink-0" />
      ) : !participant.isMicrophoneEnabled ? (
        <MicOff className="size-3 shrink-0 text-destructive" />
      ) : null}
      {!isScreenShare && verified && <ParticipantRecordingFlags pubkey={pubkey} />}
      <span className="truncate">
        <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} />
        {isScreenShare && "'s screen"}
        {isLocal && " (you)"}
      </span>
    </>
  );

  const tile = (
    <div
      ref={tileRef}
      className={cn(
        "group relative flex items-center justify-center bg-black rounded-lg overflow-hidden ring-1 ring-white/10 h-full w-full transition-shadow fullscreen:rounded-none fullscreen:ring-0",
        // Screenshare tiles never get the speaking ring.
        !isScreenShare &&
          isSpeaking &&
          "ring-2 ring-success shadow-[0_0_0_4px_hsl(var(--success)/0.35)]",
      )}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          // Mirror your own camera (not screenshare).
          className={cn(
            "h-full w-full",
            isScreenShare || focused ? "object-contain" : "object-cover",
            isLocal && !isScreenShare && "-scale-x-100",
          )}
        />
      ) : (
        <>
          <BlurredAvatarBackdrop picture={metadata?.picture} imeta={imeta?.picture} />
          <Avatar shape={shape} className={cn("relative", large ? "size-24" : "size-16")}>
            <AvatarImage src={metadata?.picture} imeta={imeta?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-xl">
              <AvatarInitial name={displayName} pubkey={pubkey} />
            </AvatarFallback>
          </Avatar>
        </>
      )}
      {isScreenShare && !isLocal && (
        <button
          type="button"
          onClick={() => {
            if (document.fullscreenElement === tileRef.current) void document.exitFullscreen().catch(() => {});
            stopWatching(streamOwnerKey(participant.identity, resolveIdentity));
          }}
          className="absolute top-1.5 left-1.5 z-10 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-1 text-xs text-white/90 opacity-0 transition-opacity hover:bg-black/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <EyeOff className="size-3.5" />
          <FormattedMessage id="callStage.stopWatching" defaultMessage="Stop watching" />
        </button>
      )}
      {isScreenShare && (
        <>
          <button
            type="button"
            aria-label={intl.formatMessage(msg.showDetails)}
            title={intl.formatMessage(msg.showDetails)}
            onClick={openDetails}
            className="absolute top-1.5 right-[4.625rem] rounded-md bg-black/60 p-1 text-white/90 opacity-0 transition-opacity hover:bg-black/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Info className="size-3.5" />
          </button>
          {fullscreenAvailable && (
            <button
              type="button"
              aria-label={intl.formatMessage(fullscreen ? msg.exitFullscreen : msg.viewFullscreen)}
              title={intl.formatMessage(fullscreen ? msg.exitFullscreen : msg.viewFullscreen)}
              onClick={toggleFullscreen}
              className="absolute top-1.5 right-10 rounded-md bg-black/60 p-1 text-white/90 opacity-0 transition-opacity hover:bg-black/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            >
              {fullscreen ? <Shrink className="size-3.5" /> : <Fullscreen className="size-3.5" />}
            </button>
          )}
        </>
      )}
      <FocusButton focused={focused} onClick={onToggleFocus} />
      {!isScreenShare && <RaisedHandBadge pubkey={pubkey} />}
      {streaming && (
        <LiveBadge
          className="absolute bottom-1.5 right-1.5 z-10"
          onWatch={isLocal ? undefined : () => watch(pubkey)}
        />
      )}
      {hasVolumeMenu ? (
        <VolumeMenu
          pubkey={pubkey}
          displayName={displayName}
          verified={verified}
          target={volumeTarget}
          nameplateClassName={fullscreenNameplateClass}
        >
          {nameplate}
        </VolumeMenu>
      ) : (
        <div
          className={cn(
            nameplateClass,
            "transition-[bottom]",
            fullscreenNameplateClass,
          )}
        >
          {nameplate}
        </div>
      )}
      {fullscreen && (
        <div
          data-fullscreen-controls=""
          className={cn(
            "absolute inset-x-0 bottom-0 z-40 transition-[opacity,transform] duration-200",
            fullscreenControlsVisible
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-2 opacity-0",
          )}
        >
          <StageControls
            portalContainer={portalContainer}
            className="bg-background/90 pb-[max(0.375rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] text-foreground shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md"
          />
        </div>
      )}
    </div>
  );

  const decoratedTile = hasVolumeMenu ? (
    <VoiceUserContextMenu
      pubkey={pubkey}
      displayName={displayName}
      verified={verified}
      volumeTarget={volumeTarget}
    >
      {tile}
    </VoiceUserContextMenu>
  ) : (
    tile
  );

  return (
    <PortalContainerProvider value={portalContainer}>
      {decoratedTile}
      {isScreenShare && (
        <ScreenShareDiagnosticsDialog
          open={detailsOpen}
          portalContainer={portalContainer}
          track={trackRef.publication?.videoTrack}
          encrypted={endToEndEncrypted}
          participantName={displayName}
          onOpenChange={setDetailsOpen}
        />
      )}
    </PortalContainerProvider>
  );
}

/** Local trusted-capture preview for the auxiliary H.265 publisher. */
function LocalHevcScreenShareTile({
  track,
  status,
  encrypted,
  focused,
  onToggleFocus,
}: {
  track: MediaStreamTrack;
  status: DesktopHevcScreenShareStatus;
  encrypted: boolean;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(false);
  const intl = useIntl();
  const inheritedPortalContainer = usePortalContainer();
  const fullscreenAvailable = supportsElementFullscreen();
  useFullscreenControlsAutoHide(tileRef.current, fullscreen, setFullscreenControlsVisible);
  const portalContainer = fullscreen
    ? tileRef.current ?? inheritedPortalContainer
    : inheritedPortalContainer;
  const fullscreenNameplateClass = fullscreen && fullscreenControlsVisible
    ? "bottom-[calc(4rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
    : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = new MediaStream([track]);
    void video.play().catch((error) =>
      console.warn("failed to play local H.265 capture preview", error),
    );
    return () => {
      video.srcObject = null;
    };
  }, [track]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === tileRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const openDetails = () => {
    setDetailsOpen(true);
  };

  const toggleFullscreen = () => {
    if (!tileRef.current || !fullscreenAvailable) return;
    if (document.fullscreenElement === tileRef.current) {
      void document.exitFullscreen().catch((error) =>
        console.warn("failed to exit screen-share fullscreen", error),
      );
      return;
    }
    void tileRef.current.requestFullscreen({ navigationUI: "hide" }).catch((error) =>
      console.warn("failed to enter screen-share fullscreen", error),
    );
  };

  return (
    <PortalContainerProvider value={portalContainer}>
      <div
        ref={tileRef}
        className="group relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-black ring-1 ring-white/10 fullscreen:rounded-none fullscreen:ring-0"
      >
        <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
        <button
          type="button"
          aria-label={intl.formatMessage(msg.showDetails)}
          title={intl.formatMessage(msg.showDetails)}
          onClick={openDetails}
          className="absolute top-1.5 right-[4.625rem] rounded-md bg-black/60 p-1 text-white/90 opacity-0 transition-opacity hover:bg-black/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Info className="size-3.5" />
        </button>
        {fullscreenAvailable && (
          <button
            type="button"
            aria-label={intl.formatMessage(fullscreen ? msg.exitFullscreen : msg.viewFullscreen)}
            title={intl.formatMessage(fullscreen ? msg.exitFullscreen : msg.viewFullscreen)}
            onClick={toggleFullscreen}
            className="absolute top-1.5 right-10 rounded-md bg-black/60 p-1 text-white/90 opacity-0 transition-opacity hover:bg-black/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            {fullscreen ? <Shrink className="size-3.5" /> : <Fullscreen className="size-3.5" />}
          </button>
        )}
        <FocusButton focused={focused} onClick={onToggleFocus} />
        <div
          className={cn(
            nameplateClass,
            "transition-[bottom]",
            fullscreenNameplateClass,
          )}
        >
          <ScreenShare className="size-3 shrink-0" />
          <span className="truncate">
            <FormattedMessage id="callStage.yourScreenHevc" defaultMessage="Your screen (H.265)" />
          </span>
        </div>
        {fullscreen && (
          <div
            data-fullscreen-controls=""
            className={cn(
              "absolute inset-x-0 bottom-0 z-40 transition-[opacity,transform] duration-200",
              fullscreenControlsVisible
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-2 opacity-0",
            )}
          >
            <StageControls
              portalContainer={portalContainer}
              className="bg-background/90 pb-[max(0.375rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] text-foreground shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md"
            />
          </div>
        )}
      </div>
      <ScreenShareDiagnosticsDialog
        open={detailsOpen}
        portalContainer={portalContainer}
        encrypted={encrypted}
        participantName={intl.formatMessage({ id: "callStage.yourScreenLower", defaultMessage: "your screen" })}
        nativeHevcStatus={status}
        onOpenChange={setDetailsOpen}
      />
    </PortalContainerProvider>
  );
}

function FocusButton({ focused, onClick }: { focused: boolean; onClick: () => void }) {
  const intl = useIntl();
  return (
    <button
      type="button"
      aria-label={
        focused
          ? intl.formatMessage({ id: "callStage.exitFocus", defaultMessage: "Exit focus" })
          : intl.formatMessage({ id: "callStage.focusTile", defaultMessage: "Focus this tile" })
      }
      onClick={onClick}
      className={cn(
        "absolute top-1.5 right-1.5 rounded-md bg-black/60 p-1 text-white/90 hover:bg-black/80 hover:text-white",
        // Always visible on touch (no hover).
        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity [@media(hover:none)]:opacity-100",
      )}
    >
      {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  );
}

/** A stream nobody here has opted into yet: who is live, and a button to watch. */
function StreamInviteTile({ participant, owner }: { participant: Participant; owner: string }) {
  const { pubkey, displayName, verified, metadata, imeta } = useTileDisplayName(participant);
  const { watch } = useScreenShareWatch();
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg bg-black ring-1 ring-white/10">
      <BlurredAvatarBackdrop picture={metadata?.picture} imeta={imeta?.picture} />
      <div className="relative flex max-w-full items-center gap-1.5 px-3 text-sm text-white">
        <LiveBadge onWatch={() => watch(owner)} />
        <span className="truncate">
          <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} />
        </span>
      </div>
      <button
        type="button"
        onClick={() => watch(owner)}
        className="relative inline-flex items-center gap-1.5 rounded-md bg-primary px-3 h-8 touch:h-11 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <ScreenShare className="size-4" />
        <FormattedMessage id="callStage.watchStream" defaultMessage="Watch stream" />
      </button>
    </div>
  );
}

/** Avatar tile for a participant without video, so the stage shows everyone. */
function AvatarTile({
  participant,
  isSpeaking,
  focused,
  large = focused,
  onToggleFocus,
}: {
  participant: Participant;
  isSpeaking: boolean;
  focused: boolean;
  large?: boolean;
  onToggleFocus: () => void;
}) {
  const { pubkey, displayName, verified, metadata, imeta } = useTileDisplayName(participant);
  const shape = getAvatarShape(metadata);
  const hasCustomShape = !!shape;
  const isLocal = participant.isLocal;
  const muted = !participant.isMicrophoneEnabled;
  const { streamingPubkeys } = useVoiceActivity();
  const streaming = verified && streamingPubkeys.has(pubkey);
  const { watch } = useScreenShareWatch();
  useApplyPlaybackVolumes(participant, pubkey);

  // Emoji-shaped avatars get a silhouette drop-shadow (a box ring would clip).
  const ringStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  const nameplate = (
    <>
      {muted && <MicOff className="size-3 shrink-0 text-destructive" />}
      {verified && <ParticipantRecordingFlags pubkey={pubkey} />}
      <span className="truncate">
        <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} />
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
      <BlurredAvatarBackdrop picture={metadata?.picture} imeta={imeta?.picture} />
      <div
        className={cn(
          "relative rounded-full transition-shadow",
          !hasCustomShape && isSpeaking && "ring-2 ring-success shadow-[0_0_0_4px_hsl(var(--success)/0.35)]",
        )}
        style={ringStyle}
      >
        <Avatar shape={shape} className={large ? "size-28" : "size-16"}>
          <AvatarImage src={metadata?.picture} imeta={imeta?.picture} alt={displayName} />
          <AvatarFallback className="bg-primary/20 text-primary text-xl">
            <AvatarInitial name={displayName} pubkey={pubkey} />
          </AvatarFallback>
        </Avatar>
      </div>
      <FocusButton focused={focused} onClick={onToggleFocus} />
      <RaisedHandBadge pubkey={pubkey} />
      {streaming && (
        <LiveBadge
          className="absolute bottom-1.5 right-1.5 z-10"
          onWatch={isLocal ? undefined : () => watch(pubkey)}
        />
      )}
      {!isLocal ? (
        <VolumeMenu pubkey={pubkey} displayName={displayName} verified={verified}>
          {nameplate}
        </VolumeMenu>
      ) : (
        <div className={nameplateClass}>{nameplate}</div>
      )}
    </div>
  );

  return !isLocal ? (
    <VoiceUserContextMenu pubkey={pubkey} displayName={displayName} verified={verified}>
      {tile}
    </VoiceUserContextMenu>
  ) : (
    tile
  );
}

/**
 * Prev/next over the floating preview with several screen shares. Selection
 * uses a stable sorted key list: raw track order differs per client.
 */
function ShareSelector({
  participant,
  index,
  total,
  onPrev,
  onNext,
}: {
  participant: Participant | null;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { pubkey: sharer, label } = useShareSharerLabel(participant);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const intl = useIntl();
  const prevLabel = intl.formatMessage({ id: "callStage.prevShare", defaultMessage: "Previous screen share" });
  const nextLabel = intl.formatMessage({ id: "callStage.nextShare", defaultMessage: "Next screen share" });
  return (
    <div
      className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1 py-0.5 text-2xs text-white"
      // Don't let clicks reach the tile's focus toggle.
      onPointerDown={stop}
      onClick={stop}
    >
      <button
        type="button"
        aria-label={prevLabel}
        title={prevLabel}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
        className="rounded p-0.5 hover:bg-white/20"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="flex items-center gap-1 max-w-40 truncate">
        <ScreenShare className="size-3 shrink-0" />
        <span className="truncate">
          <DisplayName pubkey={sharer} name={label} />
        </span>
        <span className="tabular-nums text-white/60">
          {index + 1}/{total}
        </span>
      </span>
      <button
        type="button"
        aria-label={nextLabel}
        title={nextLabel}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
        className="rounded p-0.5 hover:bg-white/20"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}

/** Only a verified claim resolves to a profile; local/unverified are fixed literals. */
function useShareSharerLabel(participant: Participant | null): {
  pubkey?: string;
  label: string;
} {
  const resolve = useVoiceIdentity();
  const identity = participant?.identity ?? "";
  const { pubkey, verified } = resolve(identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const scopedName = useScopedDisplayName(pubkey, author.data?.metadata);
  const intl = useIntl();
  if (!participant) return { label: "" };
  if (participant.isLocal) return { label: intl.formatMessage({ id: "callStage.yourScreen", defaultMessage: "Your screen" }) };
  return verified
    ? { pubkey, label: scopedName }
    : { label: intl.formatMessage({ id: "callStage.screenShare", defaultMessage: "Screen share" }) };
}

/**
 * Media controls inside the stage: docked, floating and theater all stand in
 * for the call bar, which steps aside while they are on screen.
 */
function StageControls({
  className,
  portalContainer,
}: {
  className?: string;
  portalContainer?: HTMLElement;
}) {
  return (
    <div className={cn("flex items-center justify-center gap-1.5 px-2 py-1.5 shrink-0 border-t border-white/10", className)}>
      <MicButton />
      <CameraButton />
      <ScreenShareButton
        portalContainer={portalContainer}
      />
      <RaiseHandButton />
      <ReactionsMenu
        portalContainer={portalContainer}
      />
      <DeviceMenu />
      <LeaveButton />
    </div>
  );
}

/** Elapsed time since `since`; its own component so only it re-renders per tick. */
function CallClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1_000));
  const h = Math.floor(secs / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  const s = String(secs % 60).padStart(2, "0");
  return (
    <span className="tabular-nums">
      {h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`}
    </span>
  );
}

/**
 * The call's state in words. A DM reads "Calling…" until the peer is in the
 * room; after that, and in channels, the clock runs.
 */
function CallStatus({ calling, since }: { calling: boolean; since: number }) {
  const connectionState = useConnectionState();
  const rejoining = useContext(VoiceRejoiningContext);
  if (
    connectionState === ConnectionState.Reconnecting ||
    (rejoining && connectionState !== ConnectionState.Connected)
  ) {
    return (
      <span className="text-warning">
        <FormattedMessage id="callStage.reconnecting" defaultMessage="Reconnecting…" />
      </span>
    );
  }
  if (connectionState === ConnectionState.Connecting) return <span><FormattedMessage {...msg.connecting} /></span>;
  if (calling) return <span><FormattedMessage id="callStage.calling" defaultMessage="Calling…" /></span>;
  return <CallClock since={since} />;
}

type HeroSize = "xl" | "lg" | "md" | "sm" | "xs";

const HERO_SIZES: Record<HeroSize, { avatar: string; initial: string; badge: string; icon: string }> = {
  xl: { avatar: "size-32", initial: "text-4xl", badge: "size-8", icon: "size-4" },
  lg: { avatar: "size-24", initial: "text-3xl", badge: "size-7", icon: "size-4" },
  md: { avatar: "size-20", initial: "text-2xl", badge: "size-6", icon: "size-3.5" },
  sm: { avatar: "size-16", initial: "text-xl", badge: "size-6", icon: "size-3.5" },
  xs: { avatar: "size-12", initial: "text-base", badge: "size-5", icon: "size-3" },
};

/**
 * Avatars shrink as the room fills, so a group call stays one compact cluster.
 * A desktop chat pane is wide enough to keep a group large.
 */
function heroSize(count: number, theater: boolean, wide: boolean): HeroSize {
  if (theater) return count <= 4 ? "xl" : count <= 9 ? "lg" : "md";
  if (wide) return count <= 6 ? "lg" : "md";
  return count <= 2 ? "md" : count <= 4 ? "sm" : "xs";
}

/** More than this many people and the rest collapse into a "+N". */
const HERO_MAX_DOCKED = 8;
const HERO_MAX_THEATER = 16;

/** A hero avatar: large, in the person's own shape, glowing while they speak. */
function HeroAvatarView({
  pubkey,
  metadata,
  name,
  caption,
  speaking,
  muted,
  handRaised,
  recording,
  refusing,
  streaming,
  onWatch,
  pending,
  size,
  theater,
}: {
  pubkey: string | undefined;
  metadata: NostrMetadata | undefined;
  name: string;
  caption: string;
  speaking: boolean;
  muted: boolean;
  handRaised?: boolean;
  recording?: boolean;
  refusing?: boolean;
  streaming?: boolean;
  /** Tunes into their stream; absent for our own. */
  onWatch?: () => void;
  /** Not in the room yet (a DM still ringing). */
  pending?: boolean;
  size: HeroSize;
  theater: boolean;
}) {
  const shape = getAvatarShape(metadata);
  const hasCustomShape = !!shape;
  const s = HERO_SIZES[size];
  const intl = useIntl();
  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      <div className="relative">
        <div
          className={cn(
            "rounded-full transition-[box-shadow,transform] duration-100",
            speaking && "scale-105",
            !hasCustomShape && speaking &&
              "ring-[3px] ring-success shadow-[0_0_28px_6px_hsl(var(--success)/0.45)]",
          )}
          // A mask clips box rings, so a custom shape glows as a silhouette.
          style={hasCustomShape && speaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined}
        >
          <Avatar shape={shape} className={cn("shadow-xl", s.avatar, pending && "opacity-80")}>
            <AvatarImage src={metadata?.picture} alt={name} />
            <AvatarFallback className={cn("bg-primary/20 text-primary", s.initial)}>
              <AvatarInitial name={name} pubkey={pubkey} />
            </AvatarFallback>
          </Avatar>
        </div>
        {muted && (
          <span
            className={cn(
              "absolute bottom-0 right-0 flex items-center justify-center rounded-full bg-background text-destructive shadow",
              s.badge,
            )}
            aria-label={intl.formatMessage({ id: "callStage.muted", defaultMessage: "Muted" })}
          >
            <MicOff className={s.icon} />
          </span>
        )}
        {handRaised && (
          <span
            className={cn(
              "absolute top-0 right-0 flex items-center justify-center rounded-full bg-warning text-warning-foreground shadow",
              s.badge,
            )}
            aria-label={intl.formatMessage(msg.handRaised)}
          >
            <Hand className={s.icon} />
          </span>
        )}
        {(recording || refusing) && (
          <span
            className={cn(
              "absolute top-0 left-0 flex items-center justify-center gap-0.5 rounded-full bg-background shadow",
              s.badge,
            )}
          >
            <RecordingFlagIcons recording={Boolean(recording)} refusing={Boolean(refusing)} className={s.icon} />
          </span>
        )}
        {streaming && (
          <LiveBadge className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 shadow" onWatch={onWatch} />
        )}
      </div>
      <span className={cn("max-w-28 truncate text-muted-foreground", theater ? "text-sm" : "text-xs")}>
        {caption}
      </span>
    </div>
  );
}

function HeroParticipant({
  participant,
  speaking,
  size,
  theater,
}: {
  participant: Participant;
  speaking: boolean;
  size: HeroSize;
  theater: boolean;
}) {
  const { pubkey, displayName, verified, metadata } = useTileDisplayName(participant);
  const intl = useIntl();
  const { raisedHands, streamingPubkeys } = useVoiceActivity();
  const { watch } = useScreenShareWatch();
  const recordingSignals = useCallSignals().recording;
  const streaming = verified && streamingPubkeys.has(pubkey);
  const view = (
    <div>
      <HeroAvatarView
        pubkey={verified ? pubkey : undefined}
        metadata={metadata}
        name={displayName}
        caption={participant.isLocal ? intl.formatMessage({ id: "callStage.you", defaultMessage: "You" }) : displayName}
        speaking={speaking}
        muted={!participant.isMicrophoneEnabled}
        handRaised={raisedHands.has(pubkey)}
        recording={verified && Boolean(recordingSignals?.recorders.has(pubkey))}
        refusing={verified && Boolean(recordingSignals?.refusing.has(pubkey))}
        streaming={streaming}
        onWatch={participant.isLocal ? undefined : () => watch(pubkey)}
        size={size}
        theater={theater}
      />
    </div>
  );
  return participant.isLocal ? (
    view
  ) : (
    <VoiceUserContextMenu pubkey={pubkey} displayName={displayName} verified={verified}>
      {view}
    </VoiceUserContextMenu>
  );
}

/** The peer a DM is ringing, before they're in the room. */
function HeroPendingPeer({ pubkey, size, theater }: { pubkey: string; size: HeroSize; theater: boolean }) {
  const metadata = useAuthor(pubkey).data?.metadata;
  const name = useScopedDisplayName(pubkey, metadata);
  return (
    <HeroAvatarView
      pubkey={pubkey}
      metadata={metadata}
      name={name}
      caption={name}
      speaking={false}
      muted={false}
      pending
      size={size}
      theater={theater}
    />
  );
}

function HeroBackdrop({ pubkey }: { pubkey?: string }) {
  const metadata = useAuthor(pubkey).data?.metadata;
  return <BlurredAvatarBackdrop picture={metadata?.picture} />;
}

/**
 * A call with no video on screen: everyone large, in their own shapes, with the
 * controls beneath. A DM sits over the peer's blurred
 * picture. Docked above the chat, or the whole screen as `theater`.
 */
function CallHero({
  variant,
  callLabel,
  people,
  overflow,
  pendingPubkey,
  backdropPubkey,
  speakingIds,
  calling,
  since,
  videoCount,
  onShowVideo,
  onToggleTheater,
  exiting,
  wide,
}: {
  variant: "docked" | "theater";
  callLabel?: React.ReactNode;
  /** Who is on screen, in display order: others first, then us. */
  people: readonly Participant[];
  /** Others left off screen, shown as "+N". */
  overflow: number;
  /** A DM peer still ringing, shown ahead of `people`. */
  pendingPubkey?: string;
  backdropPubkey?: string;
  speakingIds: ReadonlySet<string>;
  calling: boolean;
  since: number;
  videoCount: number;
  onShowVideo: () => void;
  onToggleTheater: () => void;
  exiting: boolean;
  /** A desktop layout: room for larger avatars. */
  wide: boolean;
}) {
  const theater = variant === "theater";
  const boxRef = useRef<HTMLDivElement>(null);
  const intl = useIntl();
  const controlSize = theater ? "rounded-lg size-14 touch:size-14" : "size-10 touch:size-11";
  const controls = (
    <div className={cn("flex flex-wrap items-center justify-center", theater ? "gap-4" : "gap-2.5")}>
      {videoCount > 0 && (
        <button
          type="button"
          onClick={onShowVideo}
          aria-label={intl.formatMessage({ id: "callStage.showVideo", defaultMessage: "Show video" })}
          title={intl.formatMessage({ id: "callStage.showVideo", defaultMessage: "Show video" })}
          className={cn(
            "inline-flex items-center justify-center shrink-0 bg-primary/20 text-primary hover:bg-primary/30 transition-colors",
            controlSize,
          )}
        >
          <Video className="size-4" />
        </button>
      )}
      <MicButton className={controlSize} />
      <CameraButton className={controlSize} />
      <ScreenShareButton className={controlSize} />
      <RaiseHandButton className={controlSize} />
      <ReactionsMenu className={controlSize} />
      <DeviceMenu className={controlSize} />
      <LeaveButton className={controlSize} />
    </div>
  );

  const count = people.length + (pendingPubkey ? 1 : 0);
  const size = heroSize(count, theater, wide);
  const cluster = (
    <div
      className={cn(
        "flex flex-wrap items-start justify-center",
        count <= 2 ? (theater ? "gap-12" : "gap-8") : theater ? "gap-8" : "gap-4",
      )}
    >
      {pendingPubkey && <HeroPendingPeer pubkey={pendingPubkey} size={size} theater={theater} />}
      {people.map((p) => (
        <HeroParticipant
          key={p.identity}
          participant={p}
          speaking={speakingIds.has(p.identity)}
          size={size}
          theater={theater}
        />
      ))}
      {overflow > 0 && (
        <div
          className={cn(
            "flex items-center justify-center rounded-full bg-foreground/10 font-medium text-muted-foreground tabular-nums",
            HERO_SIZES[size].avatar,
            theater ? "text-lg" : "text-sm",
          )}
        >
          +{overflow}
        </div>
      )}
    </div>
  );

  const title = (
    <div className="text-center min-w-0 max-w-full">
      <div className={cn("font-semibold truncate", theater ? "text-2xl" : "text-base")}>{callLabel}</div>
      <div
        className={cn(
          "flex items-center justify-center gap-2 text-muted-foreground",
          theater ? "text-sm mt-1" : "text-xs",
        )}
      >
        <CallStatus calling={calling} since={since} />
        <RecordingIndicator />
      </div>
    </div>
  );

  const theaterLabel = theater
    ? intl.formatMessage({ id: "callStage.exitFullScreen", defaultMessage: "Exit full screen" })
    : intl.formatMessage({ id: "callStage.fullScreen", defaultMessage: "Full screen" });
  const theaterToggle = (
    <button
      type="button"
      onClick={onToggleTheater}
      aria-label={theaterLabel}
      title={theaterLabel}
      className="absolute right-2 z-10 rounded-md p-1.5 touch:p-2.5 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
      style={{
        top: theater
          ? "calc(0.5rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))"
          : "0.5rem",
      }}
    >
      {theater ? <Shrink className="size-4" /> : <Maximize2 className="size-4" />}
    </button>
  );

  const backdrop = backdropPubkey && (
    <>
      <HeroBackdrop pubkey={backdropPubkey} />
      <div className="absolute inset-0 bg-chrome-deep/60" />
    </>
  );

  if (theater) {
    return (
      <div ref={boxRef} className="relative flex h-full w-full flex-col overflow-hidden bg-chrome-deep">
        {backdrop}
        {theaterToggle}
        <div className="relative flex flex-1 flex-col items-center justify-center gap-8 px-6 overflow-y-auto">
          {cluster}
          {title}
        </div>
        <div className="relative flex justify-center px-4 pt-4 pb-[max(2rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]">
          {controls}
        </div>
        <StageReactions containerRef={boxRef} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "shrink-0 mx-gutter mt-stack",
        exiting
          ? "animate-out fade-out-0 slide-out-to-top-2 duration-200 fill-mode-forwards"
          : "animate-in fade-in-0 slide-in-from-top-2 duration-200",
      )}
    >
      <div
        ref={boxRef}
        role="region"
        aria-label={intl.formatMessage(msg.call)}
        className="relative clip-corner-lg overflow-hidden bg-chrome-deep shadow-lg"
      >
        {backdrop}
        {theaterToggle}
        <div className="relative flex flex-col items-center gap-3 px-4 pt-5 pb-3">
          {cluster}
          {title}
          {controls}
        </div>
        <StageReactions containerRef={boxRef} />
      </div>
    </div>
  );
}

/** localStorage key + bounds for the drag-resizable docked stage height (px). */
const DOCKED_HEIGHT_KEY = "armada:call-stage:docked-height";
const DOCKED_MIN = 220;

function dockedMax(): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return Math.max(DOCKED_MIN, Math.round(vh * 0.85));
}

function clampDocked(px: number): number {
  return Math.min(Math.max(px, DOCKED_MIN), dockedMax());
}

function loadDockedHeight(): number {
  try {
    const raw = localStorage.getItem(DOCKED_HEIGHT_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(n)) return clampDocked(n);
  } catch {
    // ignore malformed/blocked storage
  }
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return clampDocked(Math.round(vh * 0.42));
}

function saveDockedHeight(px: number): void {
  try {
    localStorage.setItem(DOCKED_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // ignore quota/private-mode failures
  }
}

/**
 * The call stage: every participant as a tile, at the top of the chat. Rendered
 * inside `LiveKitRoom` and portaled into the chat's slot by `CallProvider`.
 */
export function CallStage({
  callLabel,
  open,
}: {
  callLabel?: React.ReactNode;
  open: boolean;
}) {
  const { setStageOpen, stageFloating, floatingVariant, stageDocked, exiting, activeCall } = useCall();
  const isDesktop = useIsDesktop();
  const intl = useIntl();
  const { enabled: endToEndEncrypted, hevcScreenShare } = useCallSignals();
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const resolveIdentity = useVoiceIdentity();
  const participantCount = uniqueParticipantCount(participants, resolveIdentity);
  const speakers = useSpeakers();
  const speakingIds = useMemo(() => new Set(speakers), [speakers]);
  const { raisedHands, streamingPubkeys } = useVoiceActivity();
  const lastSpoke = useRef(new Map<string, number>());
  const heardAt = Date.now();
  for (const identity of speakers) lastSpoke.current.set(identity, heardAt);

  const [focusKey, setFocusKey] = useState<string | null>(null);

  // One CallStage persists across the theater/floating/docked branches, so one
  // ref serves the reaction overlay throughout.
  const stageBoxRef = useRef<HTMLDivElement | null>(null);

  const allVideoTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  ).filter((t): t is TrackReference => Boolean(t.publication));
  const localHevcPreview =
    hevcScreenShare?.active && hevcScreenShare.previewTrack?.readyState === "live"
      ? hevcScreenShare.previewTrack
      : null;
  const { watching } = useScreenShareWatch();
  // Others' screen shares are opt-in: unwatched ones offer an invite tile instead.
  const videoTracks = allVideoTracks.filter(
    (track) =>
      track.source !== Track.Source.ScreenShare ||
      (!(localHevcPreview && track.participant.identity === hevcScreenShare?.publisherIdentity) &&
        (track.participant.isLocal ||
          watching.has(streamOwnerKey(track.participant.identity, resolveIdentity)))),
  );
  // One per streamer; our own H.265 companion is previewed locally instead.
  const streamOwners = new Map<string, Participant>();
  for (const p of participants) {
    if (p.isLocal || p.identity === hevcScreenShare?.publisherIdentity) continue;
    if (!p.getTrackPublication(Track.Source.ScreenShare)) continue;
    const owner = streamOwnerKey(p.identity, resolveIdentity);
    if (!streamOwners.has(owner)) streamOwners.set(owner, p);
  }
  const unwatchedStreams = [...streamOwners].filter(([owner]) => !watching.has(owner));

  // Everyone gets exactly one camera or avatar tile; screenshares are extra.
  const withCamera = new Set(
    videoTracks.filter((t) => t.source === Track.Source.Camera).map((t) => t.participant.identity),
  );
  const cameraPubkeys = new Set(
    videoTracks
      .filter((track) => track.source === Track.Source.Camera)
      .map((track) => resolveIdentity(track.participant.identity))
      .filter((identity) => identity.verified)
      .map((identity) => identity.pubkey),
  );
  const avatarPubkeys = new Set<string>();
  const avatarOnly = [...participants]
    .sort((left, right) => Number(right.isLocal) - Number(left.isLocal))
    .filter((participant) => {
      if (
        isHevcScreenShareParticipant(participant, resolveIdentity) ||
        withCamera.has(participant.identity)
      ) {
        return false;
      }
      const identity = resolveIdentity(participant.identity);
      if (!identity.verified) return true;
      if (cameraPubkeys.has(identity.pubkey) || avatarPubkeys.has(identity.pubkey)) return false;
      avatarPubkeys.add(identity.pubkey);
      return true;
    });
  // The strip's roster: one avatar per person, camera or not.
  const rosterPubkeys = new Set<string>();
  const roster = [...participants].sort((l, r) => Number(r.isLocal) - Number(l.isLocal)).filter((participant) => {
    if (isHevcScreenShareParticipant(participant, resolveIdentity)) return false;
    const identity = resolveIdentity(participant.identity);
    if (!identity.verified) return true;
    if (rosterPubkeys.has(identity.pubkey)) return false;
    rosterPubkeys.add(identity.pubkey);
    return true;
  });

  // The clock starts when someone else is first in the room (a DM is "Calling…"
  // until then), or at join in a channel. Kept here: the strip remounts.
  const joinedAt = useRef(Date.now());
  const [othersSince, setOthersSince] = useState<number | null>(null);
  const hasOthers = participantCount > 1;
  useEffect(() => {
    if (hasOthers) setOthersSince((at) => at ?? Date.now());
  }, [hasOthers]);
  const isDmCall = Boolean(activeCall?.dm);
  const calling = isDmCall && othersSince === null;
  const clockSince = isDmCall ? othersSince ?? joinedAt.current : joinedAt.current;

  const streamOwnersSig = [...streamOwners.keys()].sort().join("|");
  const prevStreamOwners = useRef<string[]>([]);
  useEffect(() => {
    const owners = streamOwnersSig ? streamOwnersSig.split("|") : [];
    const prev = prevStreamOwners.current;
    if (owners.some((o) => !prev.includes(o))) {
      playScreenShareSound();
    } else if (
      prev.some((o) => !owners.includes(o)) &&
      prev.length > 0 &&
      connectionState === ConnectionState.Connected
    ) {
      // Leaving the call also empties streamOwners as the room tears down;
      // LeaveButton already plays its own chirp for that transition.
      playScreenShareEndSound();
    }
    prevStreamOwners.current = owners;
  }, [streamOwnersSig, connectionState]);

  // Auto-expand and spotlight only on a NEW visible share (ours, or one just
  // watched), so a user-closed stage stays closed.
  const remoteScreenShareKeys = videoTracks
    .filter((t) => t.source === Track.Source.ScreenShare)
    .map(trackTileKey);
  const screenShareKeys = localHevcPreview
    ? [...remoteScreenShareKeys, LOCAL_HEVC_SCREEN_SHARE_KEY]
    : remoteScreenShareKeys;
  const prevScreenShareKeys = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevScreenShareKeys.current;
    const appeared = screenShareKeys.find((k) => !prev.includes(k));
    if (appeared) {
      setStageOpen(true);
      setFocusKey(appeared);
    }
    prevScreenShareKeys.current = screenShareKeys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShareKeys.join("|")]);

  // Auto-expand when video is already rolling on join. One-shot: the first video
  // sighting consumes it, so a later camera doesn't reopen a closed stage.
  const sawVideo = useRef(false);
  const hasVideoTracks = videoTracks.length > 0 || Boolean(localHevcPreview);
  useEffect(() => {
    if (!hasVideoTracks || sawVideo.current) return;
    sawVideo.current = true;
    if (Date.now() - joinedAt.current <= JOIN_VIDEO_EXPAND_WINDOW_MS) setStageOpen(true);
  }, [hasVideoTracks, setStageOpen]);

  const tiles = useMemo(() => {
    // `large`: the tile has the stage to itself (a bigger avatar) without being focused.
    const list: { key: string; render: (focused: boolean, large?: boolean) => React.ReactNode }[] = [];
    if (localHevcPreview && hevcScreenShare) {
      list.push({
        key: LOCAL_HEVC_SCREEN_SHARE_KEY,
        render: (focused) => (
          <LocalHevcScreenShareTile
            track={localHevcPreview}
            status={hevcScreenShare.status}
            encrypted={endToEndEncrypted}
            focused={focused}
            onToggleFocus={() =>
              setFocusKey((current) =>
                current === LOCAL_HEVC_SCREEN_SHARE_KEY ? null : LOCAL_HEVC_SCREEN_SHARE_KEY,
              )
            }
          />
        ),
      });
    }
    for (const trackRef of videoTracks) {
      const key = trackTileKey(trackRef);
      list.push({
        key,
        render: (focused, large) => (
          <VideoTile
            trackRef={trackRef}
            isSpeaking={speakingIds.has(trackRef.participant.identity)}
            focused={focused}
            large={large}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
    for (const [owner, p] of unwatchedStreams) {
      list.push({
        key: `${owner}:stream-invite`,
        render: () => <StreamInviteTile participant={p} owner={owner} />,
      });
    }
    for (const p of avatarOnly) {
      const key = participantTileKey(p);
      list.push({
        key,
        render: (focused, large) => (
          <AvatarTile
            participant={p}
            isSpeaking={speakingIds.has(p.identity)}
            focused={focused}
            large={large}
            onToggleFocus={() => setFocusKey((cur) => (cur === key ? null : key))}
          />
        ),
      });
    }
    return list;
  }, [
    videoTracks,
    unwatchedStreams,
    avatarOnly,
    speakingIds,
    localHevcPreview,
    hevcScreenShare,
    endToEndEncrypted,
  ]);

  // Focused tile gone: back to the grid.
  useEffect(() => {
    if (focusKey && !tiles.some((t) => t.key === focusKey)) setFocusKey(null);
  }, [focusKey, tiles]);

  const focused = focusKey ? tiles.find((t) => t.key === focusKey) : undefined;

  // Share keys in a STABLE order (by identity): the track array order flips
  // between clients and on resubscribe.
  const sortedShareKeys = useMemo(
    () => [...screenShareKeys].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screenShareKeys.join("|")],
  );
  // One share auto-selects; with several, keep the pick while live.
  const [selectedShareKey, setSelectedShareKey] = useState<string | null>(null);
  useEffect(() => {
    setSelectedShareKey((cur) => {
      if (sortedShareKeys.length === 0) return null;
      if (cur && sortedShareKeys.includes(cur)) return cur; // keep stable
      return sortedShareKeys[0]; // auto-select (single) or recover (ended)
    });
  }, [sortedShareKeys]);
  // A manually focused share tile is the selection.
  useEffect(() => {
    if (focusKey && sortedShareKeys.includes(focusKey)) setSelectedShareKey(focusKey);
  }, [focusKey, sortedShareKeys]);
  const screenShareKey =
    selectedShareKey && sortedShareKeys.includes(selectedShareKey)
      ? selectedShareKey
      : sortedShareKeys[0] ?? null;
  const selectedShareIndex = screenShareKey ? sortedShareKeys.indexOf(screenShareKey) : -1;
  const cycleShare = useCallback(
    (dir: 1 | -1) => {
      if (sortedShareKeys.length === 0) return;
      const cur = selectedShareKey;
      const base = cur && sortedShareKeys.includes(cur) ? sortedShareKeys.indexOf(cur) : 0;
      const next = (base + dir + sortedShareKeys.length) % sortedShareKeys.length;
      const nextKey = sortedShareKeys[next];
      setSelectedShareKey(nextKey);
      // Move focus with the cycle, or the effect above snaps the selection back.
      // Only if focus was already on a share.
      setFocusKey((f) => (f && sortedShareKeys.includes(f) ? nextKey : f));
    },
    [sortedShareKeys, selectedShareKey],
  );
  // `speakers` is loudest-first.
  const speakingKey = useMemo(() => {
    for (const identity of speakers) {
      const cam = tiles.find((t) => t.key === `${identity}:${Track.Source.Camera}`);
      if (cam) return cam.key;
      const avatar = tiles.find((t) => t.key === `${identity}:avatar`);
      if (avatar) return avatar.key;
    }
    return null;
  }, [speakers, tiles]);
  const fallbackKey =
    tiles.find((t) => t.key.endsWith(`:${Track.Source.Camera}`))?.key ?? tiles[0]?.key ?? null;

  const primaryKey = usePrimaryFloatingKey({
    enabled: stageFloating,
    focusKey,
    screenShareKey,
    speakingKey,
    fallbackKey,
  });
  const primaryTile =
    (primaryKey && tiles.find((t) => t.key === primaryKey)) || tiles[0] || undefined;
  const showingShare = Boolean(screenShareKey && primaryKey === screenShareKey);
  // Render the selected share from its own TrackReference keyed by publication
  // SID, so switching always reattaches the compact <video>.
  const selectedShareTrackRef = useMemo(
    () =>
      videoTracks.find(
        (t) => t.source === Track.Source.ScreenShare && trackTileKey(t) === screenShareKey,
      ) ?? null,
    [videoTracks, screenShareKey],
  );
  const selectedShareParticipant = selectedShareTrackRef?.participant ?? null;

  // Persisted; clamped to [DOCKED_MIN, ~85vh].
  const [dockedHeight, setDockedHeight] = useState(() => loadDockedHeight());
  const dockedResize = useRef<{ startY: number; startH: number; pointerId: number } | null>(null);
  const onDockedResizeMove = useCallback((e: PointerEvent) => {
    const a = dockedResize.current;
    if (!a || e.pointerId !== a.pointerId) return;
    setDockedHeight(clampDocked(a.startH + (e.clientY - a.startY)));
  }, []);
  const endDockedResize = useCallback(
    (e: PointerEvent) => {
      const a = dockedResize.current;
      if (!a || e.pointerId !== a.pointerId) return;
      dockedResize.current = null;
      window.removeEventListener("pointermove", onDockedResizeMove);
      window.removeEventListener("pointerup", endDockedResize);
      window.removeEventListener("pointercancel", endDockedResize);
      setDockedHeight((h) => {
        saveDockedHeight(h);
        return h;
      });
    },
    [onDockedResizeMove],
  );
  const beginDockedResize = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dockedResize.current = { startY: e.clientY, startH: dockedHeight, pointerId: e.pointerId };
      window.addEventListener("pointermove", onDockedResizeMove);
      window.addEventListener("pointerup", endDockedResize);
      window.addEventListener("pointercancel", endDockedResize);
      e.preventDefault();
    },
    [dockedHeight, onDockedResizeMove, endDockedResize],
  );
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onDockedResizeMove);
      window.removeEventListener("pointerup", endDockedResize);
      window.removeEventListener("pointercancel", endDockedResize);
    },
    [onDockedResizeMove, endDockedResize],
  );

  const [theater, setTheater] = useState(false);
  // A collapsed stage is back to the chat; with video gone theater keeps the hero.
  useEffect(() => {
    if (!open) setTheater(false);
  }, [open]);
  // On a phone, video takes the screen the moment it starts (the Signal model);
  // leaving theater returns to the chat with the stage docked above it.
  const hadVideo = useRef(false);
  useEffect(() => {
    const started = hasVideoTracks && !hadVideo.current;
    hadVideo.current = hasVideoTracks;
    if (started && !isDesktop && stageDocked && open) setTheater(true);
  }, [hasVideoTracks, isDesktop, stageDocked, open]);
  useEffect(() => {
    if (!theater) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTheater(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theater]);
  useAndroidBack(() => {
    setTheater(false);
    return true;
  }, theater, "overlay");

  // Over video, theater's chrome floats and fades after idle like a player's.
  const [theaterEl, setTheaterEl] = useState<HTMLDivElement | null>(null);
  const [theaterChromeVisible, setTheaterChromeVisible] = useState(false);
  const overlayChrome = theater && hasVideoTracks;
  useFullscreenControlsAutoHide(theaterEl, overlayChrome, setTheaterChromeVisible);
  const theaterChromeHidden = overlayChrome && !theaterChromeVisible;

  const [gridRef, gridSize] = useElementSize<HTMLDivElement>();
  const GRID_GAP = 8; // matches gap-2
  const grid = fitGrid(tiles.length, gridSize.width, gridSize.height, GRID_GAP);

  // 1:1 is a conversation, not a grid: the other person fills the stage and our
  // camera is a corner inset (absent while it's off).
  const localIdentity = participants.find((p) => p.isLocal)?.identity;
  const isLocalTile = (key: string) =>
    localIdentity !== undefined && key.startsWith(`${localIdentity}:`);
  const oneOnOne =
    participantCount === 2 && screenShareKeys.length === 0 && tiles.length <= 2
      ? {
          remote: tiles.find((t) => !isLocalTile(t.key)),
          self: tiles.find((t) => t.key === `${localIdentity}:${Track.Source.Camera}`),
        }
      : null;

  const header = (
    <div
      className="flex items-center gap-2 px-3 py-2 shrink-0"
      style={
        theater
          ? { paddingTop: "calc(0.5rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))" }
          : undefined
      }
    >
      <span className="text-sm font-medium truncate min-w-0 flex-1">{callLabel}</span>
      <RecordingIndicator />
      <span className="text-xs text-muted-foreground shrink-0">
        <CallStatus calling={calling} since={clockSince} />
      </span>
      {focused && (
        <button
          type="button"
          className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          onClick={() => setFocusKey(null)}
        >
          <Minimize2 className="size-3.5" />
          <FormattedMessage id="callStage.showAll" defaultMessage="Show all" />
        </button>
      )}
      {participantCount > 2 && (
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          <FormattedMessage id="callStage.inCall" defaultMessage="{count} in call" values={{ count: participantCount }} />
        </span>
      )}
      <button
        type="button"
        aria-label={
          theater
            ? intl.formatMessage({ id: "callStage.exitTheater", defaultMessage: "Exit theater mode" })
            : intl.formatMessage({ id: "callStage.theater", defaultMessage: "Theater mode" })
        }
        className="shrink-0 rounded-md p-1 touch:p-2.5 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        onClick={() => setTheater((t) => !t)}
      >
        {theater ? <Shrink className="size-4" /> : <Monitor className="size-4" />}
      </button>
      {!theater && (
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "callStage.hideVideo", defaultMessage: "Hide video" })}
          title={intl.formatMessage({ id: "callStage.hideVideo", defaultMessage: "Hide video" })}
          className="shrink-0 rounded-md p-1 touch:p-2.5 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          onClick={() => setStageOpen(false)}
        >
          <ChevronUp className="size-4" />
        </button>
      )}
    </div>
  );

  // The reaction overlay sizes against this media area. Shared by theater and docked.
  const body = (
    <div ref={stageBoxRef} className="relative flex-1 min-h-0 flex flex-col">
      {focused ? (
        // Spotlight: focused tile fills the height, the rest in a scrolling strip.
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
      ) : oneOnOne?.remote ? (
        <div className="relative flex-1 min-h-0 p-3 pt-0">
          {/* A camera fills edge to edge; an avatar tile gets its large avatar. */}
          {oneOnOne.remote.render(false, true)}
          {oneOnOne.self && (
            <div className="absolute bottom-5 right-5 z-10 w-1/4 min-w-24 max-w-44 aspect-video shadow-lg">
              {oneOnOne.self.render(false)}
            </div>
          )}
        </div>
      ) : (
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
      )}
      <StageReactions containerRef={stageBoxRef} />
    </div>
  );

  const heroMode = !open || !hasVideoTracks;
  const others = roster.filter((p) => !p.isLocal);
  const self = roster.find((p) => p.isLocal);
  const dmPeer = activeCall?.dm?.peer;
  const pendingPubkey = dmPeer && others.length === 0 ? dmPeer : undefined;
  const activityOf = (p: Participant): CallActivity => {
    const { pubkey, verified } = resolveIdentity(p.identity);
    return {
      streaming: verified && streamingPubkeys.has(pubkey),
      handRaised: verified && raisedHands.has(pubkey),
      lastSpokeAt: lastSpoke.current.get(p.identity),
    };
  };
  const hero = (variant: "docked" | "theater") => {
    // We always stay on screen.
    const max = variant === "theater" ? HERO_MAX_THEATER : HERO_MAX_DOCKED;
    const room = max - (pendingPubkey ? 1 : 0) - (self ? 1 : 0);
    const visible = pickVisible(others, room, activityOf, Date.now());
    return (
      <CallHero
        variant={variant}
        callLabel={callLabel}
        people={self ? [...visible, self] : visible}
        overflow={others.length - visible.length}
        pendingPubkey={pendingPubkey}
        backdropPubkey={dmPeer}
        speakingIds={speakingIds}
        calling={calling}
        since={clockSince}
        videoCount={videoTracks.length + (localHevcPreview ? 1 : 0)}
        onShowVideo={() => setStageOpen(true)}
        onToggleTheater={() => {
          setStageOpen(true);
          setTheater((t) => !t);
        }}
        exiting={exiting}
        wide={isDesktop}
      />
    );
  };

  if (theater && heroMode) {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage(msg.call)}
        className="fixed inset-0 z-50 animate-in fade-in-0 duration-150"
      >
        {hero("theater")}
      </div>,
      document.body,
    );
  }

  if (theater) {
    return createPortal(
      // A dialog, so type-to-focus doesn't route keys to the chat underneath.
      <div
        ref={setTheaterEl}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage(msg.call)}
        className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm animate-in fade-in-0 duration-150"
      >
        <div
          className={cn(
            "transition-opacity duration-200",
            overlayChrome && "absolute inset-x-0 top-0 z-40 bg-gradient-to-b from-background/90 to-transparent",
            theaterChromeHidden && "pointer-events-none opacity-0",
          )}
        >
          {header}
        </div>
        {body}
        {/* The call bar is behind this overlay, so theater has its own controls. */}
        <div
          data-fullscreen-controls=""
          className={cn(
            "transition-[opacity,transform] duration-200",
            overlayChrome && "absolute inset-x-0 bottom-0 z-40",
            theaterChromeHidden && "pointer-events-none translate-y-2 opacity-0",
          )}
        >
          <StageControls
            className={cn(
              "pb-[max(0.375rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]",
              overlayChrome && "border-t-0 bg-background/90 backdrop-blur-md",
            )}
          />
        </div>
      </div>,
      document.body,
    );
  }

  if (stageFloating) {
    // Floating: ONE primary tile. Same stage instance, reparented — no subscription
    // torn down. On mobile MobileCallBar carries the controls, so omit them here.
    const isMobileFloating = floatingVariant === "mobile";
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        {/* Both floating variants resize by width, so the media area is 16:9 of it. */}
        <div ref={stageBoxRef} className="relative w-full bg-black aspect-video">
          {showingShare && selectedShareTrackRef ? (
            // Keyed by publication SID so a switch mounts a fresh <video> (no stuck frame);
            // only this tile remounts.
            <div
              key={`${selectedShareTrackRef.participant.identity}:${selectedShareTrackRef.publication?.trackSid ?? "ss"}`}
              className={FLOATING_TILE}
            >
              <VideoTile
                trackRef={selectedShareTrackRef}
                isSpeaking={false}
                focused
                onToggleFocus={() =>
                  setFocusKey((cur) => (cur === screenShareKey ? null : screenShareKey))
                }
              />
            </div>
          ) : primaryTile ? (
            <div key={primaryTile.key} className={FLOATING_TILE}>
              {primaryTile.render(true)}
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
              <FormattedMessage {...msg.connecting} />
            </div>
          )}
          {showingShare && sortedShareKeys.length > 1 && (
            <ShareSelector
              participant={selectedShareParticipant}
              index={selectedShareIndex}
              total={sortedShareKeys.length}
              onPrev={() => cycleShare(-1)}
              onNext={() => cycleShare(1)}
            />
          )}
          <StageReactions containerRef={stageBoxRef} />
        </div>
        {!isMobileFloating && <StageControls />}
      </div>
    );
  }

  // Docked: the stage only while there is video to show (and it's not
  // collapsed); otherwise the hero, sized to its content.
  if (heroMode || exiting) return hero("docked");

  return (
    <div
      className={cn(
        "shrink-0 mx-gutter mt-stack overflow-hidden ease-out animate-in fade-in-0 duration-200",
        // No transition while dragging (it would lag the pointer).
        dockedResize.current ? "" : "transition-[max-height] duration-200",
      )}
      // Must clear the resizable box plus its top margin.
      style={{ maxHeight: dockedHeight + 16 }}
    >
      <div
        className="clip-corner-lg bg-chrome-deep shadow-lg flex flex-col"
        style={{ height: dockedHeight }}
      >
        {header}
        {body}
        <StageControls />
        <div
          onPointerDown={beginDockedResize}
          role="separator"
          aria-label={intl.formatMessage({ id: "callStage.resize", defaultMessage: "Resize call pane" })}
          aria-orientation="horizontal"
          className="group/resize shrink-0 h-2.5 flex items-center justify-center cursor-ns-resize touch-none"
        >
          <div className="h-1 w-10 rounded-full bg-foreground/20 group-hover/resize:bg-foreground/40 transition-colors" />
        </div>
      </div>
    </div>
  );
}
