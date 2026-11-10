import {
  LiveKitRoom,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react";
import {
  AudioPresets,
  BaseKeyProvider,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  ParticipantEvent,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RemoteParticipant,
  type LocalTrack,
  type RoomOptions,
} from "livekit-client";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import "@livekit/components-styles";

import { InCallView } from "@/components/chat/VoiceBar";
import { CallStage } from "@/components/chat/CallStage";
import { CallAudioRenderer, ScreenShareWatchProvider } from "@/components/chat/ScreenShareWatch";
import { DisplayName } from "@/components/DisplayName";
import { DesktopPushToTalk } from "@/components/DesktopPushToTalk";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitToken } from "@/hooks/useLivekit";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { type ActiveCall, type ConcordVoiceContext, type DmVoiceContext } from "@/contexts/CallContext";
import { useVoiceIdentity, VoiceIdentityContext, type VoiceIdentityResolver } from "@/contexts/VoiceIdentityContext";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { random32, voiceSenderKey } from "@/concord/lib/derive";
import {
  bridgedTransports,
  canonicalOrigin,
  fetchAvToken,
  fetchAvTokenFromAny,
  isVerifiedScreenShareIdentity,
  occupantsElsewhere,
  rendezvousCandidates,
  verifiedAuthorOf,
  type AvToken,
} from "@/concord/lib/voice";
import { toast } from "@/hooks/useToast";
import { ToastAction } from "@/components/ui/toast";
import { dmCallKeys } from "@/lib/dmCall";
import { useCallSync } from "@/concord/hooks/useCallSync";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { callGain, callGateFor, callPriority, setCallGate, setPrioritySpeaking, subscribeCallGate } from "@/concord/lib/callGate";
import { decryptNotificationIcon } from "@/concord/lib/image";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { useMediaPolicy, useMediaSrc } from "@/hooks/useMediaPolicy";
import { ArmadaCall, hasNativeCallService } from "@/lib/nativeCall";
import { useCallMicHold } from "@/hooks/useCallMicHold";
import { useMicToggle } from "@/hooks/useMicToggle";
import { fetchNotificationIcon } from "@/lib/notificationIcon";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import {
  onVoiceDirective,
  ownAvServers,
  resolveVoiceBroker,
  useCommunityAvBrokers,
  useAvToken,
  useVoiceHeartbeat,
  useVoicePresence,
  useVoiceReactions,
} from "@/concord/hooks/useVoice";
import { channelsView } from "@/concord/lib/community";
import { useVoiceActionsFor } from "@/concord/hooks/useVoiceActions";
import { VoiceModerationContext } from "@/contexts/VoiceModerationContext";
import { CallSignalsContext, type CallRecordingSignals, type CallSignals } from "@/contexts/CallSignalsContext";
import { CallRecorderProvider, RecordingNotices } from "@/components/chat/CallRecorder";
import { getNoRecord, setNoRecord, subscribeNoRecord } from "@/lib/callRecording/prefs";
import { VoiceRejoiningContext } from "@/contexts/VoiceRejoiningContext";
import { getDisplayName } from "@/lib/getDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { playJoinSound, playLeaveSound } from "@/lib/callSounds";
import {
  getAudioProcessing,
  getPreferredCameraId,
  getScreenShareVolume,
  getUserVolume,
  liveDeviceSwitch,
  micCaptureConstraints,
  preferredAudioOutput,
  subscribeUserVolumes,
  subscribeVoiceDevices,
} from "@/lib/voiceDevices";
import { syncRnnoise } from "@/lib/voiceProcessor";
import { keepCallAwake } from "@/lib/callKeepAwake";
import { guardSilenceProbe, keepCallAudioOutput, keepCallAudioRunning } from "@/lib/voiceAudioContext";
import { DetectedSpeakersContext, useDetectedSpeakers, useSpeakers } from "@/hooks/useSpeakers";
import { useListShowing } from "@/contexts/PaneCoveredContext";
import { ignorePrivateCandidatesFrom } from "@/lib/privateIceCandidates";
import { getPushToTalkPreferences } from "@/lib/pushToTalk";
import { isRecoverableDisconnect, rejoinRoom, trackMicIntent } from "@/lib/voiceRejoin";
import { installWorkerCriticalTimers } from "@/lib/criticalTimers";
import { cn } from "@/lib/utils";
import { bytesToBase64 } from "@/lib/fileBytes";
import {
  HevcScreenShareSessionTracker,
  isHevcScreenShareParticipant,
  stopHevcCapturedMedia,
} from "@/lib/hevcScreenShare";
import {
  cancelDesktopHevcScreenShareFrames,
  desktopHevcScreenShareCapability,
  isDesktop,
  startDesktopHevcScreenShare,
  stopDesktopHevcScreenShare,
  subscribeDesktopHevcScreenShareStatus,
  type DesktopHevcScreenShareCapability,
  type DesktopHevcScreenShareStatus,
} from "@/lib/desktop";
import {
  SCREEN_SHARE_RESOLUTIONS,
  screenShareAudioPublishOptions,
  type ScreenShareQuality,
} from "@/lib/screenShareQuality";
import { nip19 } from "nostr-tools";

import { common, FormattedMessage, t } from "@/i18n";
import { clockNowMs } from "@/lib/relayClock";

/** Reports live speakers (as pubkeys) to call context. Unverified identities are skipped. */
function SpeakingReporter() {
  const { setSpeakingPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const speakers = useSpeakers();

  useEffect(() => {
    const pubkeys = new Set<string>();
    for (const identity of speakers) {
      const { pubkey, verified } = resolveIdentity(identity);
      if (verified) pubkeys.add(pubkey);
    }
    setSpeakingPubkeys(pubkeys);
  }, [speakers, resolveIdentity, setSpeakingPubkeys]);

  useEffect(() => () => setSpeakingPubkeys(new Set()), [setSpeakingPubkeys]);

  return null;
}

/** Measures who is speaking once per room, for everything beneath it. */
function DetectedSpeakersProvider({ children }: { children: React.ReactNode }) {
  const detected = useDetectedSpeakers();
  return <DetectedSpeakersContext.Provider value={detected}>{children}</DetectedSpeakersContext.Provider>;
}

/** Reports muted participants (as pubkeys) to call context. Unverified identities are skipped. */
function MutedReporter() {
  const { setMutedPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const pubkeys = new Set<string>();
    for (const p of participants) {
      if (
        !p.identity ||
        p.isMicrophoneEnabled ||
        isHevcScreenShareParticipant(p, resolveIdentity)
      ) continue;
      const { pubkey, verified } = resolveIdentity(p.identity);
      if (verified) pubkeys.add(pubkey);
    }
    setMutedPubkeys(pubkeys);
  }, [participants, resolveIdentity, setMutedPubkeys]);

  useEffect(() => () => setMutedPubkeys(new Set()), [setMutedPubkeys]);

  return null;
}

/** Reports who is screen sharing (as pubkeys) to call context, for the LIVE badges. */
function StreamingReporter() {
  const { setStreamingPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const pubkeys = new Set<string>();
    for (const p of participants) {
      if (!p.identity || !p.getTrackPublication(Track.Source.ScreenShare)) continue;
      // An H.265 companion resolves to its sharer's pubkey.
      const { pubkey, verified } = resolveIdentity(p.identity);
      if (verified) pubkeys.add(pubkey);
    }
    setStreamingPubkeys(pubkeys);
  }, [participants, resolveIdentity, setStreamingPubkeys]);

  useEffect(() => () => setStreamingPubkeys(new Set()), [setStreamingPubkeys]);

  return null;
}

/** Mirrors the mic into the Android call notification's mute button and runs its taps. */
function CallNotificationMic() {
  const { isMicrophoneEnabled, toggle } = useMicToggle();
  const { localParticipant } = useLocalParticipant();
  const published = Boolean(localParticipant.getTrackPublication(Track.Source.Microphone)?.track);

  useEffect(() => {
    if (!hasNativeCallService()) return;
    ArmadaCall.setMic({ muted: !isMicrophoneEnabled, published }).catch(() => {});
  }, [isMicrophoneEnabled, published]);

  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (!hasNativeCallService()) return;
    let handle: PluginListenerHandle | undefined;
    let cancelled = false;
    ArmadaCall.addListener("toggleMute", () => toggleRef.current())
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  return null;
}

/**
 * Reports the live roster (as pubkeys) to call context, so occupancy comes
 * from the SFU rather than kind-39004 presence, which desyncs easily.
 * Deduped per pubkey; unverified Concord identities skipped.
 */
function RosterReporter() {
  const { setVoiceRoomPubkeys } = useCall();
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const pubkeys: string[] = [];
    const seen = new Set<string>();
    for (const p of participants) {
      // The local participant has an empty identity until connected.
      if (!p.identity || isHevcScreenShareParticipant(p, resolveIdentity)) continue;
      const { pubkey, verified } = resolveIdentity(p.identity);
      if (!verified || seen.has(pubkey)) continue;
      seen.add(pubkey);
      pubkeys.push(pubkey);
    }
    setVoiceRoomPubkeys(pubkeys);
  }, [participants, resolveIdentity, setVoiceRoomPubkeys]);

  // Null on teardown so consumers fall back to relay presence.
  useEffect(() => () => setVoiceRoomPubkeys(null), [setVoiceRoomPubkeys]);

  return null;
}

/** Reports whether a remote member holding PRIORITY_SPEAKER is talking, which ducks the rest (CORD-07 §7). */
function PriorityDuckWatcher() {
  const room = useRoomContext();
  const resolveIdentity = useVoiceIdentity();
  const resolveRef = useRef(resolveIdentity);
  resolveRef.current = resolveIdentity;
  useEffect(() => {
    const judge = () => {
      setPrioritySpeaking(room.activeSpeakers.some((p) => !p.isLocal && p.identity && callPriority(resolveRef.current(p.identity).pubkey)));
    };
    judge();
    room.on(RoomEvent.ActiveSpeakersChanged, judge);
    const offGate = subscribeCallGate(judge);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, judge);
      offGate();
      setPrioritySpeaking(false);
    };
  }, [room]);
  return null;
}

/** Keeps remote mic/screen-share gains in sync with stored volumes while the stage is closed. */
function PlaybackVolumeApplier() {
  const resolveIdentity = useVoiceIdentity();
  const participants = useParticipants();

  useEffect(() => {
    const apply = () => {
      for (const p of participants) {
        if (
          p.isLocal ||
          !p.identity ||
          isHevcScreenShareParticipant(p, resolveIdentity)
        ) continue;
        const { pubkey } = resolveIdentity(p.identity);
        const remote = p as RemoteParticipant;
        // A member the call doesn't let speak is not heard, and a priority speaker ducks the rest (CORD-04 §8, CORD-07 §7).
        const gain = callGain(pubkey);
        remote.setVolume(gain * getUserVolume(pubkey), Track.Source.Microphone);
        remote.setVolume(gain * getScreenShareVolume(pubkey), Track.Source.ScreenShareAudio);
      }
    };
    apply();
    const offVolumes = subscribeUserVolumes(apply);
    const offGate = subscribeCallGate(apply);
    return () => {
      offVolumes();
      offGate();
    };
  }, [participants, resolveIdentity]);

  return null;
}

/**
 * Keeps the live room on the remembered mic and speaker. Device pickers (the
 * call bar's DeviceSelectGroup and Settings' VoiceDeviceSettings) only call
 * rememberVoiceDevice; this is the one place that switches the room, so a
 * pick from either applies mid-call without two switches racing. On
 * (re)connect the speaker belongs to keepCallAudioOutput (CallAudioKeeper).
 */
function VoiceDeviceSync() {
  const room = useRoomContext();

  useEffect(() => {
    const follow = (kind: MediaDeviceKind) => {
      if (room.state !== ConnectionState.Connected) return;
      const deviceId = liveDeviceSwitch(kind, room.getActiveDevice(kind));
      if (!deviceId) return;
      void room.switchActiveDevice(kind, deviceId).catch(() => {
        // Device may be gone since it was remembered — keep the current one.
      });
    };
    // A mic picked while reconnecting was remembered but not applied.
    const followMic = () => follow("audioinput");
    followMic();
    room.on(RoomEvent.Connected, followMic).on(RoomEvent.Reconnected, followMic);
    const unsubscribe = subscribeVoiceDevices(follow);
    return () => {
      room.off(RoomEvent.Connected, followMic).off(RoomEvent.Reconnected, followMic);
      unsubscribe();
    };
  }, [room]);

  return null;
}

/** Join/leave chirps. Must render inside a `LiveKitRoom`. */
function CallSoundEffects() {
  const room = useRoomContext();
  const resolveIdentity = useVoiceIdentity();
  const resolveRef = useRef(resolveIdentity);
  resolveRef.current = resolveIdentity;

  useEffect(() => {
    const timers = new Set<number>();
    const participantKey = (identity: string): string | null => {
      if (!identity) return null;
      const resolved = resolveRef.current(identity);
      return resolved.verified ? `pubkey:${resolved.pubkey}` : `identity:${identity}`;
    };
    const hasSibling = (participant: RemoteParticipant): boolean => {
      const key = participantKey(participant.identity);
      if (!key) return false;
      return [room.localParticipant, ...room.remoteParticipants.values()].some(
        (candidate) =>
          candidate !== participant && participantKey(candidate.identity) === key,
      );
    };
    const schedule = (participant: RemoteParticipant, kind: "join" | "leave") => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (isHevcScreenShareParticipant(participant, resolveRef.current)) return;
        if (kind === "join" && room.remoteParticipants.get(participant.identity) !== participant) return;
        // Our own reconnect reports every remote as gone.
        if (kind === "leave" && room.state !== ConnectionState.Connected) return;
        if (hasSibling(participant)) return;
        if (kind === "join") playJoinSound();
        else playLeaveSound();
      }, 750);
      timers.add(timer);
    };
    const onJoin = (participant: RemoteParticipant) => schedule(participant, "join");
    const onLeave = (participant: RemoteParticipant) => schedule(participant, "leave");
    const onConnected = () => playJoinSound();
    // Already connected on mount (fast reconnect): play now.
    if (room.state === ConnectionState.Connected) {
      playJoinSound();
    } else {
      room.on(RoomEvent.Connected, onConnected);
    }
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [room]);

  return null;
}

/**
 * Applies RNNoise to the published mic track. `audioCaptureDefaults` carries
 * only constraints, so the processor is re-attached on every (re)publish.
 */
function MicNoiseProcessor() {
  const { localParticipant } = useLocalParticipant();

  useEffect(() => {
    const apply = () => {
      const enabled = getAudioProcessing().rnnoise;
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.audioTrack;
      if (track instanceof LocalAudioTrack) void syncRnnoise(track, enabled);
    };
    apply();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, apply);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, apply);
    };
  }, [localParticipant]);

  return null;
}

/** Rejoins a dropped call (see voiceRejoin.ts); `onGiveUp` ends it. */
function AutoRejoin({
  serverUrl,
  token,
  onRejoiningChange,
  onGiveUp,
}: {
  serverUrl: string;
  token: string;
  onRejoiningChange: (rejoining: boolean) => void;
  onGiveUp: (reason?: DisconnectReason) => void;
}) {
  const room = useRoomContext();
  const onGiveUpRef = useRef(onGiveUp);
  onGiveUpRef.current = onGiveUp;
  const onRejoiningRef = useRef(onRejoiningChange);
  onRejoiningRef.current = onRejoiningChange;

  useEffect(() => {
    const intent = trackMicIntent(room);
    let active: AbortController | null = null;
    const onDisconnected = (reason?: DisconnectReason) => {
      // A failed attempt inside the loop disconnects too; the loop owns retries.
      if (active || !isRecoverableDisconnect(reason)) return;
      const ctrl = new AbortController();
      active = ctrl;
      onRejoiningRef.current(true);
      void rejoinRoom(room, serverUrl, token, { signal: ctrl.signal, micWanted: intent.wanted }).then((ok) => {
        if (ctrl.signal.aborted) return;
        active = null;
        onRejoiningRef.current(false);
        if (!ok) onGiveUpRef.current(reason);
      });
    };
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      active?.abort();
      intent.dispose();
    };
  }, [room, serverUrl, token]);

  return null;
}

/**
 * Publishes the mic once, on the first connect. On Connected, not SignalConnected,
 * so it lands after LiveKitRoom applies `audio={false}`; rejoins follow trackMicIntent.
 */
function UnmuteOnJoin() {
  const room = useRoomContext();
  useEffect(() => {
    // Push to talk owns the mic and starts it muted.
    if (isDesktop() && getPushToTalkPreferences().enabled) return;
    let done = false;
    const unmute = () => {
      if (done) return;
      done = true;
      void (async () => {
        if (!room.canPlaybackAudio) await room.startAudio().catch(() => {});
        await room.localParticipant.setMicrophoneEnabled(true);
      })().catch((err) => console.warn("voice: could not unmute on join", err));
    };
    if (room.state === ConnectionState.Connected) unmute();
    else room.once(RoomEvent.Connected, unmute);
    return () => {
      done = true;
      room.off(RoomEvent.Connected, unmute);
    };
  }, [room]);
  return null;
}

function CallAudioKeeper() {
  const room = useRoomContext();
  useEffect(() => keepCallAudioRunning(room), [room]);
  useEffect(() => keepCallAudioOutput(room), [room]);
  useEffect(() => keepCallAwake(), []);
  return null;
}

/**
 * `musicHighQuality` (96 kbps) mono, with RED + DTX asserted explicitly in case
 * defaults change. `forceStereo: false` because LiveKit otherwise negotiates
 * stereo from the published track's channelCount, which a processor's output or
 * a device ignoring the mono constraint can report as 2; screen-share audio
 * passes its own `forceStereo: true`.
 */
const audioPublishDefaults = {
  audioPreset: AudioPresets.musicHighQuality,
  red: true,
  dtx: true,
  forceStereo: false,
} as const;

/**
 * Backgrounding the native WebView fires `freeze`/`pagehide`, which LiveKit's
 * `disconnectOnPageLeave` treats as unload and drops the call. Web keeps it on.
 */
const disconnectOnPageLeave = !Capacitor.isNativePlatform();

installWorkerCriticalTimers();
guardSilenceProbe();

function useRoomOptions(extra?: Partial<RoomOptions>): RoomOptions {
  return useMemo<RoomOptions>(() => {
    const cameraId = getPreferredCameraId();
    const audioOutput = preferredAudioOutput();
    return {
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave,
      // Mono capture and the user's processing prefs — see micCaptureConstraints.
      audioCaptureDefaults: micCaptureConstraints(),
      ...(audioOutput ? { audioOutput } : {}),
      videoCaptureDefaults: {
        ...(cameraId ? { deviceId: cameraId } : {}),
        resolution: VideoPresets.h720.resolution,
      },
      publishDefaults: {
        ...audioPublishDefaults,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      },
      ...extra,
      // Web Audio GainNodes allow >100% gain and per-source control. Keep after
      // `extra` so callers can't disable it.
      webAudioMix: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function LoadingBar({ placeBar, label }: { placeBar: PlaceBar; label: React.ReactNode }) {
  return placeBar(
    <div className="flex items-center justify-center gap-2 px-3 py-2 clip-corner-lg bg-chrome-deep min-h-12 shadow-lg">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>,
  );
}

function ErrorBar({ placeBar, error, onLeave }: { placeBar: PlaceBar; error: unknown; onLeave: () => void }) {
  return placeBar(
    <div className="flex items-center gap-2 px-3 py-2 clip-corner-lg bg-chrome-deep min-h-12 shadow-lg">
      <span className="text-sm text-destructive flex-1 min-w-0 truncate">
        {error instanceof Error ? (
          <FormattedMessage
            id="persistentVoiceRoom.joinFailedDetail"
            defaultMessage="Could not join voice: {detail}"
            values={{ detail: error.message }}
          />
        ) : (
          <FormattedMessage id="persistentVoiceRoom.joinFailed" defaultMessage="Could not join voice." />
        )}
      </span>
      <Button className="h-8 px-3 text-sm shrink-0" variant="outline" onClick={onLeave}>
        <FormattedMessage {...common.back} />
      </Button>
    </div>,
  );
}

/** `dockable`: a mobile bar the docked strip/stage replaces while it is on screen. */
type PlaceBar = (mobile: React.ReactNode, desktop?: React.ReactNode, dockable?: boolean) => React.ReactNode;

/** The call notification's picture as a small `data:` URL. Android only. */
function useCallNotificationIcon(
  key: string | undefined,
  load: () => Promise<string | undefined>,
): string | undefined {
  const { data } = useQuery({
    queryKey: ["call-notification-icon", key],
    queryFn: async () => (await load()) ?? null,
    enabled: Boolean(key) && hasNativeCallService(),
    staleTime: Infinity,
    retry: false,
  });
  return data ?? undefined;
}

/** Fixed mobile call bar; writes its measured height to `--call-bar-h` so the shell reserves exactly that. */
function MobileCallBar({
  shellRef,
  exiting,
  children,
}: {
  shellRef: React.RefObject<HTMLDivElement | null>;
  exiting: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { setCallBarHeight } = useCall();
  const listShowing = useListShowing();

  useEffect(() => {
    const bar = ref.current;
    const shell = shellRef.current;
    if (!bar || !shell) return;
    const apply = () => {
      const h = bar.offsetHeight;
      shell.style.setProperty("--call-bar-h", `${h}px`);
      // Shared via context: the mobile preview positions off this (CSS var inheritance isn't guaranteed).
      setCallBarHeight(h);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => {
      ro.disconnect();
      shell.style.removeProperty("--call-bar-h");
      setCallBarHeight(0);
    };
  }, [shellRef, setCallBarHeight]);

  return (
    <div
      ref={ref}
      className={cn(
        // The inset is spelled out: the shell zeroes `--safe-area-pad-bottom` for everything above the bar.
        "fixed bottom-0 inset-x-0 z-40 px-2 pb-[max(0.75rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] sidebar:hidden",
        // Over the list, continue the rail (60px, 72px on touch) and channel column beneath it.
        listShowing
          ? "bg-[linear-gradient(to_right,hsl(var(--chrome-deep))_60px,hsl(var(--chrome))_60px)] touch:bg-[linear-gradient(to_right,hsl(var(--chrome-deep))_72px,hsl(var(--chrome))_72px)]"
          : "bg-background",
        exiting
          ? "animate-out fade-out-0 slide-out-to-bottom-4 duration-200 fill-mode-forwards"
          : "animate-in fade-in-0 slide-in-from-bottom-4 duration-300",
      )}
    >
      {children}
    </div>
  );
}

function makePlaceBar(
  slots: HTMLElement[],
  exiting: boolean,
  shellRef: React.RefObject<HTMLDivElement | null>,
  docked: boolean,
): PlaceBar {
  return (mobile, desktop, dockable) => (
    <>
      {!(dockable && docked) && (
        <MobileCallBar shellRef={shellRef} exiting={exiting}>
          {mobile}
        </MobileCallBar>
      )}
      {slots.length === 0 && (
        // No call-bar slot on this route: float bottom-left so the call stays visible.
        // The entry delay hides the one-frame slot gap between slot-owning pages.
        <div
          className={cn(
            "fixed bottom-3 left-3 z-40 w-80 max-w-[calc(100vw-1.5rem)] max-sidebar:hidden",
            exiting
              ? "animate-out fade-out-0 slide-out-to-bottom-2 duration-200 fill-mode-forwards"
              : "animate-in fade-in-0 slide-in-from-bottom-2 duration-200 delay-150 fill-mode-backwards",
          )}
        >
          {desktop ?? mobile}
        </div>
      )}
      {slots.map((el, i) =>
        createPortal(
          <div
            className={cn(
              // On mobile the fixed MobileCallBar is the voice UI; avoid duplicating it.
              "px-1 pb-1 max-sidebar:hidden",
              exiting
                ? "animate-out fade-out-0 slide-out-to-bottom-2 duration-200 fill-mode-forwards"
                : "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
            )}
          >
            {desktop ?? mobile}
          </div>,
          el,
          `call-slot-${i}`,
        ),
      )}
    </>
  );
}

type PlaceStage = (stage: React.ReactNode) => React.ReactNode;

/**
 * Portal the stage into CallProvider's stable host so it stays MOUNTED all call:
 * unmounting paused remote video (adaptiveStream) and lost E2EE screenshares.
 */
function makePlaceStage(host: HTMLElement): PlaceStage {
  return (stage) => createPortal(stage, host, "call-stage");
}

/** Connected LiveKit room + bars, shared by the NIP-29, Concord and DM paths. */
function VoiceRoomShell({
  serverUrl,
  token,
  options,
  room,
  onDisconnected,
  placeBar,
  placeStage,
  stageOpen,
  label,
  scopeRelayUrl,
  joinUnmuted = false,
}: {
  serverUrl: string;
  token: string;
  options: RoomOptions;
  /** Pre-constructed Room (E2EE paths). */
  room?: Room;
  onDisconnected: (reason?: DisconnectReason) => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
  label: React.ReactNode;
  scopeRelayUrl?: string;
  /** 1:1 calls: a call answered is a call spoken in, so join with the mic live. */
  joinUnmuted?: boolean;
}) {
  const [rejoining, setRejoining] = useState(false);
  // Before connect: the mode has to be on before the playback streams open (callMicHold.ts).
  const micReady = useCallMicHold();
  // A layout effect, so it is in place before LiveKitRoom's connect effect runs.
  useLayoutEffect(() => ignorePrivateCandidatesFrom(serverUrl), [serverUrl]);
  // Recoverable drops belong to AutoRejoin.
  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (!isRecoverableDisconnect(reason)) onDisconnected(reason);
    },
    [onDisconnected],
  );
  if (!micReady) return <LoadingBar placeBar={placeBar} label={<FormattedMessage id="persistentVoiceRoom.openingMic" defaultMessage="Opening the microphone…" />} />;
  const mobileBar = (
    <ServerScopeProvider relayUrl={scopeRelayUrl}>
      <div className="clip-corner-lg bg-chrome-deep shadow-lg">
        <InCallView label={label} compact />
      </div>
    </ServerScopeProvider>
  );
  const desktopBar = (
    <ServerScopeProvider relayUrl={scopeRelayUrl}>
      <div className="clip-corner-lg bg-chrome-deep shadow-lg">
        <InCallView label={label} stacked />
      </div>
    </ServerScopeProvider>
  );

  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      room={room}
      connect
      // Join muted: the mic button (or UnmuteOnJoin) publishes after connect.
      audio={false}
      video={false}
      options={options}
      onDisconnected={handleDisconnected}
      style={{ display: "contents" }}
    >
      <AutoRejoin
        serverUrl={serverUrl}
        token={token}
        onRejoiningChange={setRejoining}
        onGiveUp={onDisconnected}
      />
      {joinUnmuted && <UnmuteOnJoin />}
      <ScreenShareWatchProvider>
      <CallAudioRenderer />
      <CallAudioKeeper />
      <CallSoundEffects />
      <MicNoiseProcessor />
      <VoiceDeviceSync />
      <DesktopPushToTalk />
      <MutedReporter />
      <StreamingReporter />
      <CallNotificationMic />
      <RosterReporter />
      <PlaybackVolumeApplier />
      <PriorityDuckWatcher />
      <DetectedSpeakersProvider>
      <SpeakingReporter />
      <CallRecorderProvider>
      <RecordingNotices />
      <VoiceRejoiningContext.Provider value={rejoining}>
        {placeStage(
          <ServerScopeProvider relayUrl={scopeRelayUrl}>
            <CallStage callLabel={label} open={stageOpen} />
          </ServerScopeProvider>,
        )}
        {placeBar(mobileBar, desktopBar, true)}
      </VoiceRejoiningContext.Provider>
      </CallRecorderProvider>
      </DetectedSpeakersProvider>
      </ScreenShareWatchProvider>
    </LiveKitRoom>
  );
}

/** NIP-29 voice room: token from the relay's LiveKit endpoint; no media E2EE (relay-trusted SFU). */
function Nip29VoiceRoom({
  call,
  onLeave,
  placeBar,
  placeStage,
  stageOpen,
}: {
  call: ActiveCall;
  onLeave: () => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
}) {
  const navigate = useNavigate();
  const { data: tokenData, error, isLoading } = useLivekitToken(call.relayUrl, call.groupId, true);
  const { data: details } = useGroup(call.relayUrl, call.groupId);
  const { data: relayInfo } = useRelayInfo(call.relayUrl);
  const channelName = details?.group?.name ?? "voice";
  const serverName = relayInfo?.name ?? call.relayUrl.replace(/^wss?:\/\//, "");
  const options = useRoomOptions();

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  const goToChannel = useCallback(() => {
    navigate(`/s/${relayToRouteParam(call.relayUrl)}/${encodeURIComponent(call.groupId)}`);
  }, [navigate, call.relayUrl, call.groupId]);

  const { registerFocusActiveCall, registerCallSummary } = useCall();
  useEffect(() => {
    registerFocusActiveCall(goToChannel);
    return () => registerFocusActiveCall(null);
  }, [registerFocusActiveCall, goToChannel]);

  // The server icon the rail shows, else the group's own picture.
  const iconSrc = useMediaSrc(sanitizeImageSrc(relayInfo?.icon ?? details?.group?.picture));
  const icon = useCallNotificationIcon(iconSrc, () => fetchNotificationIcon(iconSrc));

  // Android ongoing-call notification label (plain text, no emoji images).
  useEffect(() => {
    registerCallSummary({ title: `#${channelName}`, subtitle: serverName, icon });
    return () => registerCallSummary(null);
  }, [registerCallSummary, channelName, serverName, icon]);

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label={<FormattedMessage id="persistentVoiceRoom.requestingAccess" defaultMessage="Requesting voice access…" />} />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;

  const label = (
    <button type="button" onClick={goToChannel} className="hover:underline text-left">
      <span className="hidden sidebar:inline text-muted-foreground/70">{serverName} </span>#{channelName}
    </button>
  );

  return (
    <VoiceRoomShell
      serverUrl={tokenData.url}
      token={tokenData.token}
      options={options}
      onDisconnected={handleDisconnected}
      placeBar={placeBar}
      placeStage={placeStage}
      stageOpen={stageOpen}
      label={label}
      scopeRelayUrl={call.relayUrl}
    />
  );
}

/**
 * Per-sender key provider for Concord AV (CORD-07 §3): keys per participant
 * identity, AES-256-GCM. Ratcheting disabled (`ratchetWindowSize: 0`,
 * `failureTolerance: -1`): keys are externally derived, and auto-ratchet would diverge.
 */
class SenderKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  }

  /** Install `material` as `identity`'s frame-key material (HKDF input). */
  async setSenderMaterial(material: Uint8Array, identity: string): Promise<void> {
    const key = await crypto.subtle.importKey("raw", material.slice().buffer, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
    this.onSetEncryptionKey(key, identity);
  }
}

/**
 * One shared frame key for DM calls: two senders with a fresh per-call secret,
 * and no presence plane to exchange identities. Same ratchet settings as SenderKeyProvider.
 */
class SharedKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  }

  async setSharedMaterial(material: Uint8Array): Promise<void> {
    const key = await crypto.subtle.importKey("raw", material.slice().buffer, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
    this.onSetEncryptionKey(key);
  }
}

/**
 * Build the E2EE worker + Room. Worker construction is guarded (404'd chunk
 * after deploy, CSP, unsupported module workers) so the caller renders a
 * leavable error; E2EE rooms must never fall back to plaintext.
 */
function buildE2eeRoom(keyProvider: BaseKeyProvider): {
  room: Room | null;
  worker: Worker | null;
  error?: unknown;
} {
  let worker: Worker;
  try {
    worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.error("voice: E2EE worker failed to start", err);
    return { room: null, worker: null, error: err };
  }
  const cameraId = getPreferredCameraId();
  const audioOutput = preferredAudioOutput();
  const opts: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    // See useRoomOptions: source-specific 0–200% playback needs GainNodes.
    webAudioMix: true,
    disconnectOnPageLeave,
    e2ee: { keyProvider, worker },
    audioCaptureDefaults: micCaptureConstraints(),
    ...(audioOutput ? { audioOutput } : {}),
    videoCaptureDefaults: {
      ...(cameraId ? { deviceId: cameraId } : {}),
      resolution: VideoPresets.h720.resolution,
    },
    publishDefaults: {
      ...audioPublishDefaults,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
      screenShareEncoding: VideoPresets.h1080.encoding,
    },
  };
  return { room: new Room(opts), worker };
}

/** Concord call bar title; a button back to the voice channel. Exported for tests. */
export function ConcordCallLabel({
  community,
  channel,
  onFocus,
}: {
  community: string;
  channel: string;
  onFocus: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocus}
      className="flex items-center gap-1 min-w-0 hover:underline text-left"
    >
      <span className="text-muted-foreground/70 truncate">{community}</span>
      <span className="shrink-0">#{channel}</span>
    </button>
  );
}

interface ActiveHevcCapture {
  stream: MediaStream;
  identity: string;
  audioTrack?: LocalTrack;
}

/**
 * Concord (CORD-07) voice room: token from a blind broker via channel-key
 * proof, per-sender E2EE, presence over the channel itself.
 */
function ConcordVoiceRoom({
  ctx,
  onLeave,
  placeBar,
  placeStage,
  stageOpen,
}: {
  ctx: ConcordVoiceContext;
  onLeave: () => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
}) {
  const { community, channel, broker } = ctx;
  const { user } = useCurrentUser();
  const { joinConcordCall, registerFocusActiveCall, registerCallSummary, setRaisedHands } =
    useCall();
  const navigate = useNavigate();
  // Presence (§4) resolved before the token so a failed mint has a fallback.
  const fold = useVoicePresence(community, channel);
  // Live, so a staff edit to the community's brokers reaches a mounted call.
  const communityBrokers = useCommunityAvBrokers(community);

  // A probe only proves the broker answered; it can still fail to mint.
  const fallbackBrokers = useMemo(
    () =>
      channel.voice.room.pk
        ? rendezvousCandidates(channel.voice.room.pk, ownAvServers(), communityBrokers).filter((o) => o !== broker)
        : (communityBrokers.length > 0 ? communityBrokers : ownAvServers()).filter((o) => o !== broker),
    [channel.voice.room.pk, broker, communityBrokers],
  );

  const { data: tokenData, error, isLoading } = useAvToken(channel, broker, true, fallbackBrokers);

  // Raise-hand/reactions ride additive tags on the encrypted presence rumor (Armada extension).
  const [handRaised, setHandRaised] = useState(false);

  // CORD-07 §7: rejoin on key roll; hang up on ban, vault removal or channel deletion.
  useCallSync(ctx, onLeave);

  const goToChannel = useCallback(() => {
    navigate(`/c/${encodeURIComponent(community.idHex)}/${encodeURIComponent(channel.idHex)}`);
  }, [navigate, community.idHex, channel.idHex]);

  useEffect(() => {
    registerFocusActiveCall(goToChannel);
    return () => registerFocusActiveCall(null);
  }, [registerFocusActiveCall, goToChannel]);

  const { data: folded } = useControlFold(community, false);
  // Receivers enforce SPEAK and VIDEO, and a Timeout silences and hides (CORD-04 §8).
  const { timeouts } = useGuestbook(community);
  // …and a moderator's mute or deafen (CORD-07 §7).
  const present = fold.present;
  const me = user?.pubkey;
  // What this member may send: without SPEAK or VIDEO, or under a Timeout, its own tracks stop (Vector).
  const e2eeRoomRef = useRef<Room | null>(null);
  useEffect(() => {
    const gate = () => {
      const next = callGateFor(folded, channel.idHex, channel.isPrivate, timeouts, present, me, clockNowMs());
      setCallGate(next);
      if (!me) return;
      const own = next(me);
      const lp = e2eeRoomRef.current?.localParticipant;
      if (!lp) return;
      if (!own.speak && lp.isMicrophoneEnabled) void lp.setMicrophoneEnabled(false).catch(() => undefined);
      if (!own.video && lp.isCameraEnabled) void lp.setCameraEnabled(false).catch(() => undefined);
      if (!own.video && lp.isScreenShareEnabled) void lp.setScreenShareEnabled(false).catch(() => undefined);
    };
    gate();
    // A Timeout lapses on its own: judge again as time passes.
    const timer = setInterval(gate, 15_000);
    return () => {
      clearInterval(timer);
      setCallGate(undefined);
    };
  }, [folded, timeouts, present, me, channel.idHex, channel.isPrivate]);
  const iconPointer = folded?.metadata?.icon;
  const blossomServers = useBlossomServers();
  const mediaPolicy = useMediaPolicy();
  const icon = useCallNotificationIcon(iconPointer?.hash, () =>
    iconPointer ? decryptNotificationIcon(iconPointer, blossomServers, mediaPolicy) : Promise.resolve(undefined),
  );

  // Decrypted names and icon are fine here: the notification is drawn locally in-process.
  useEffect(() => {
    registerCallSummary({ title: `#${channel.name}`, subtitle: community.name, icon });
    return () => registerCallSummary(null);
  }, [registerCallSummary, channel.name, community.name, icon]);

  // Heartbeat (§4) announces the broker that actually minted the token, not the
  // nominated one, so others aren't steered to an unreachable origin.
  const [hevcIdentities, setHevcIdentities] = useState<string[]>([]);
  const noRecord = useSyncExternalStore(subscribeNoRecord, getNoRecord);
  // What the call shows of this member, carried on its presence (CORD-07 §4); set below off the room.
  const [localMedia, setLocalMedia] = useState({ muted: false, screen: false, camera: false });
  const { sendReaction, announceAdditionalIdentities, announceRecording } = useVoiceHeartbeat(
    community,
    channel,
    tokenData?.identity,
    tokenData?.origin,
    handRaised,
    hevcIdentities,
    noRecord,
    localMedia,
  );
  const reactions = useVoiceReactions(community, channel);

  // Our own flags count before the heartbeat echoes back, like the raised hand.
  const [recordingSelf, setRecordingSelf] = useState(false);
  const recorders = useMemo(() => {
    const set = new Set(fold.present.filter((p) => p.recording).map((p) => p.author));
    if (user) {
      if (recordingSelf) set.add(user.pubkey);
      else set.delete(user.pubkey);
    }
    return set;
  }, [fold, recordingSelf, user]);
  const refusing = useMemo(() => {
    const set = new Set(fold.present.filter((p) => p.noRecord).map((p) => p.author));
    if (user) {
      if (noRecord) set.add(user.pubkey);
      else set.delete(user.pubkey);
    }
    return set;
  }, [fold, noRecord, user]);
  const announce = useCallback(
    async (recording: boolean) => {
      setRecordingSelf(recording);
      const delivered = await announceRecording(recording);
      if (recording && !delivered) {
        setRecordingSelf(false);
        void announceRecording(false);
      }
      return delivered;
    },
    [announceRecording],
  );
  const recordingSignals = useMemo<CallRecordingSignals>(
    () => ({
      recorders,
      refusing,
      noRecord,
      setNoRecord,
      announce,
      names: { host: community.name, channel: channel.name },
    }),
    [recorders, refusing, noRecord, announce, community.name, channel.name],
  );

  // Includes our own raised hand before the heartbeat echoes back.
  const raisedHands = useMemo(() => {
    const set = new Set<string>();
    for (const p of fold.present) if (p.hand) set.add(p.author);
    if (handRaised && user) set.add(user.pubkey);
    return set;
  }, [fold, handRaised, user]);
  useEffect(() => {
    setRaisedHands(raisedHands);
  }, [raisedHands, setRaisedHands]);
  useEffect(() => () => setRaisedHands(new Set()), [setRaisedHands]);

  // Concord media MUST be E2EE; a failed worker renders a leavable error.
  const e2ee = useMemo((): {
    room: Room | null;
    keyProvider: SenderKeyProvider;
    worker: Worker | null;
    error?: unknown;
  } => {
    const keyProvider = new SenderKeyProvider();
    return { keyProvider, ...buildE2eeRoom(keyProvider) };
  }, []);
  e2eeRoomRef.current = e2ee.room;

  // A moderator's directive to this member, which an honest client obeys (CORD-07 §7).
  const obey = useRef({ folded, communityBrokers, onLeave, joinConcordCall, ctx });
  obey.current = { folded, communityBrokers, onLeave, joinConcordCall, ctx };
  // A moderator's directives against a participant (CORD-07 §7), for the call's tile menus.
  const voiceActionsFor = useVoiceActionsFor(community, channel, present);

  const channelPk = channel.current.group.pk;
  useEffect(() => {
    if (!me) return;
    return onVoiceDirective(channelPk, (d) => {
      if (d.target !== me) return;
      const o = obey.current;
      if (d.verb === "mute" || d.verb === "deafen") {
        void e2ee.room?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
        toast({
          title: d.verb === "mute"
            ? t({ id: "persistentVoiceRoom.directive.muted", defaultMessage: "A moderator muted you" })
            : t({ id: "persistentVoiceRoom.directive.deafened", defaultMessage: "A moderator deafened you" }),
        });
        return;
      }
      if (d.verb === "disconnect") {
        toast({ title: t({ id: "persistentVoiceRoom.directive.disconnected", defaultMessage: "A moderator disconnected you from the call" }) });
        o.onLeave();
        return;
      }
      if (d.verb !== "move") return;
      const to = channelsView(o.ctx.community, o.folded).find((c) => c.idHex === d.to && c.view === "voice");
      void (async () => {
        const broker = to?.voice.room.pk ? await resolveVoiceBroker(to.voice.room.pk, o.communityBrokers) : null;
        if (!to || !broker) {
          toast({ title: t({ id: "persistentVoiceRoom.directive.disconnected", defaultMessage: "A moderator disconnected you from the call" }) });
          o.onLeave();
          return;
        }
        toast({ title: t({ id: "persistentVoiceRoom.directive.moved", defaultMessage: "A moderator moved you to #{channel}" }, { channel: to.name }) });
        o.joinConcordCall({ community: o.ctx.community, channel: to, broker });
      })();
    });
  }, [me, channelPk, e2ee.room]);

  // Verified identities get keys derived from the media root; unverified ones
  // get a random key so their tracks never decode (§7). `applied` keeps writes idempotent.
  const applied = useRef(new Map<string, string>());
  useEffect(() => {
    if (!tokenData) return;
    const mediaKey = channel.voice.mediaKey;
    if (!mediaKey) return;
    const room = e2ee.room;
    if (!room) return;

    const syncKeys = () => {
      const identities = new Set<string>([tokenData.identity]);
      for (const p of room.remoteParticipants.values()) identities.add(p.identity);
      // Pre-warm keys so audio decodes from the first frame.
      for (const identity of fold.claims.keys()) identities.add(identity);
      for (const identity of hevcIdentities) identities.add(identity);
      for (const identity of identities) {
        const verified =
          identity === tokenData.identity ||
          hevcIdentities.includes(identity) ||
          Boolean(verifiedAuthorOf(fold, identity));
        const want = verified ? "sender" : "blocked";
        if (applied.current.get(identity) === want) continue;
        applied.current.set(identity, want);
        const material = verified ? voiceSenderKey(mediaKey, identity) : random32();
        void e2ee.keyProvider
          .setSenderMaterial(material, identity)
          // A failed install for our own identity shows up as "Unverified" to peers; make it observable.
          .catch((err) =>
            console.error("Concord voice: failed to install frame key", {
              own: identity === tokenData.identity,
              err,
            }),
          );
      }
    };

    syncKeys();
    room.on(RoomEvent.ParticipantConnected, syncKeys);
    return () => {
      room.off(RoomEvent.ParticipantConnected, syncKeys);
    };
  }, [e2ee, tokenData, fold, channel, hevcIdentities]);

  useEffect(() => {
    if (!tokenData || !e2ee.room) return;
    const room = e2ee.room;
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await room.setE2EEEnabled(true);
      } catch (err) {
        // Without E2EE we'd be undecodable to peers; the render guard refuses to join anyway.
        console.error("Concord voice: failed to enable E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee, tokenData]);
  useEffect(() => () => e2ee.worker?.terminate(), [e2ee]);

  // Chromium on Linux lacks WebRTC H.265 encoding: the desktop shell's
  // FFmpeg/VA-API path publishes a pre-encoded encrypted track as a second identity.
  const [hevcCapability, setHevcCapability] =
    useState<DesktopHevcScreenShareCapability | null>(null);
  const [hevcStatus, setHevcStatus] = useState<DesktopHevcScreenShareStatus>({
    state: "idle",
    active: false,
  });
  const hevcActive = hevcStatus.active;
  useEffect(() => {
    const room = e2ee.room;
    if (!room) return;
    const lp = room.localParticipant;
    const read = () => {
      const next = { muted: !lp.isMicrophoneEnabled, screen: lp.isScreenShareEnabled || hevcActive, camera: lp.isCameraEnabled };
      setLocalMedia((prev) => (prev.muted === next.muted && prev.screen === next.screen && prev.camera === next.camera ? prev : next));
    };
    read();
    const events = [ParticipantEvent.TrackMuted, ParticipantEvent.TrackUnmuted, ParticipantEvent.LocalTrackPublished, ParticipantEvent.LocalTrackUnpublished] as const;
    for (const e of events) lp.on(e, read);
    return () => {
      for (const e of events) lp.off(e, read);
    };
  }, [e2ee.room, hevcActive]);
  const [hevcPreview, setHevcPreview] = useState<{
    track: MediaStreamTrack;
    identity: string;
  } | null>(null);
  const hevcIdentitiesRef = useRef<string[]>([]);
  hevcIdentitiesRef.current = hevcIdentities;
  const activeHevc = useRef<ActiveHevcCapture | null>(null);
  const pendingHevcCaptures = useRef(new Set<MediaStream>());
  const hevcSessionGeneration = useRef(0);
  const hevcStartGeneration = useRef(0);
  const shellHevcSessions = useRef(new HevcScreenShareSessionTracker());

  const stopHevc = useCallback(async (stopShell: boolean) => {
    hevcStartGeneration.current += 1;
    hevcSessionGeneration.current += 1;
    const active = activeHevc.current;
    activeHevc.current = null;
    for (const pending of pendingHevcCaptures.current) stopHevcCapturedMedia(pending);
    pendingHevcCaptures.current.clear();
    shellHevcSessions.current.retire();
    setHevcPreview(null);
    const remainingIdentities = active
      ? hevcIdentitiesRef.current.filter((identity) => identity !== active.identity)
      : hevcIdentitiesRef.current;
    if (active) {
      // The shell's "stopped" event is now refused, so clear status here.
      setHevcStatus({ state: "stopped", active: false });
      hevcIdentitiesRef.current = remainingIdentities;
      setHevcIdentities(remainingIdentities);
      // End capture immediately; async IPC/relay work must not keep it alive.
      stopHevcCapturedMedia(active.stream);
    }
    cancelDesktopHevcScreenShareFrames();

    const shellCleanup = stopShell
      ? stopDesktopHevcScreenShare()
        .then((status) => shellHevcSessions.current.retire(status.sessionId))
        .catch((error) => {
          console.warn("failed to stop H.265 shell publisher", error);
        })
      : Promise.resolve();
    const audioCleanup = (async () => {
      if (!active?.audioTrack || !e2ee.room) return;
      try {
        await e2ee.room.localParticipant.unpublishTrack(active.audioTrack, true);
      } catch (error) {
        console.warn("failed to stop H.265 screen-share audio", error);
      }
    })();

    // Isolated so one rejecting doesn't block the other; presence withdrawal last.
    await Promise.all([shellCleanup, audioCleanup]);
    if (active) {
      try {
        await announceAdditionalIdentities(remainingIdentities);
      } catch (error) {
        console.warn("failed to withdraw H.265 screen-share identity", error);
      }
    }
  }, [announceAdditionalIdentities, e2ee.room]);

  // `stopHevc` changes with each new channel object, and cleanups run on every
  // dep change, so read it via a ref or a live share gets stopped.
  const stopHevcRef = useRef(stopHevc);
  stopHevcRef.current = stopHevc;

  useEffect(() => {
    let cancelled = false;
    void desktopHevcScreenShareCapability().then((capability) => {
      if (!cancelled) setHevcCapability(capability);
    });
    const unsubscribe = subscribeDesktopHevcScreenShareStatus((status) => {
      if (!shellHevcSessions.current.accept(status, Boolean(activeHevc.current))) return;
      setHevcStatus(status);
      if (status.state === "error" || status.state === "stopped") {
        shellHevcSessions.current.retire(status.sessionId);
        void stopHevcRef.current(false);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(
    () => () => {
      void stopHevcRef.current(true);
    },
    [],
  );

  const startHevc = useCallback(async (stream: MediaStream, quality: ScreenShareQuality) => {
    const room = e2ee.room;
    if (!tokenData || !room) {
      stopHevcCapturedMedia(stream);
      throw new Error(t({ id: "persistentVoiceRoom.hevc.notConnected", defaultMessage: "The Concord voice room is not connected." }));
    }
    const video = stream.getVideoTracks()[0];
    if (!video) {
      stopHevcCapturedMedia(stream);
      throw new Error(
        t({ id: "persistentVoiceRoom.hevc.noVideoTrack", defaultMessage: "The selected source did not provide a video track." }),
      );
    }

    for (const pending of pendingHevcCaptures.current) stopHevcCapturedMedia(pending);
    pendingHevcCaptures.current.clear();
    pendingHevcCaptures.current.add(stream);
    const stopCandidateCapture = () => {
      pendingHevcCaptures.current.delete(stream);
      stopHevcCapturedMedia(stream);
    };

    const startGeneration = ++hevcStartGeneration.current;
    const initialSessionGeneration = ++hevcSessionGeneration.current;
    const initialCurrent = () =>
      startGeneration === hevcStartGeneration.current &&
      initialSessionGeneration === hevcSessionGeneration.current;
    const assertInitialCurrent = () => {
      if (!initialCurrent()) throw new Error(t({ id: "persistentVoiceRoom.hevc.cancelled", defaultMessage: "The H.265 screen share was cancelled." }));
    };

    // Listen before the awaits: DOM events aren't buffered, so a cancel during
    // them would be missed. `stop()` doesn't fire this event.
    let adopted: ActiveHevcCapture | null = null;
    video.addEventListener(
      "ended",
      () => {
        if (startGeneration !== hevcStartGeneration.current) return;
        if (adopted) {
          if (activeHevc.current === adopted) void stopHevcRef.current(true);
          return;
        }
        hevcStartGeneration.current += 1;
      },
      { once: true },
    );

    let capability: DesktopHevcScreenShareCapability;
    try {
      capability = hevcCapability ?? await desktopHevcScreenShareCapability();
      assertInitialCurrent();
    } catch (error) {
      stopCandidateCapture();
      throw error;
    }
    setHevcCapability(capability);
    if (!capability.available) {
      stopCandidateCapture();
      throw new Error(capability.reason ||
          t({ id: "persistentVoiceRoom.hevc.encoderUnavailable", defaultMessage: "The Linux H.265 encoder is unavailable." }),
      );
    }

    const previous = activeHevc.current;
    activeHevc.current = null;
    shellHevcSessions.current.retire();
    setHevcPreview(null);
    const remainingIdentities = previous
      ? hevcIdentitiesRef.current.filter((identity) => identity !== previous.identity)
      : hevcIdentitiesRef.current;
    if (previous) {
      hevcIdentitiesRef.current = remainingIdentities;
      setHevcIdentities(remainingIdentities);
      stopHevcCapturedMedia(previous.stream);
    }
    cancelDesktopHevcScreenShareFrames();
    const shellCleanup = stopDesktopHevcScreenShare();
    const audioCleanup = (async () => {
      if (!previous?.audioTrack) return;
      await room.localParticipant.unpublishTrack(previous.audioTrack, true);
    })();
    const [shellResult, audioResult] = await Promise.allSettled([
      shellCleanup,
      audioCleanup,
    ]);
    if (shellResult.status === "fulfilled") {
      shellHevcSessions.current.retire(shellResult.value.sessionId);
    }
    if (audioResult.status === "rejected") {
      console.warn("failed to replace H.265 screen-share audio", audioResult.reason);
    }
    if (previous) {
      try {
        await announceAdditionalIdentities(remainingIdentities);
      } catch (error) {
        console.warn("failed to withdraw replaced H.265 screen-share identity", error);
      }
    }
    if (shellResult.status === "rejected") {
      stopCandidateCapture();
      const detail = shellResult.reason instanceof Error
        ? shellResult.reason.message
        : String(shellResult.reason);
      throw new Error(
        previous
          ? t(
              {
                id: "persistentVoiceRoom.hevc.retireFailedSwitching",
                defaultMessage:
                  "The previous H.265 screen share stopped locally, but its publisher could not be retired before switching: {detail}",
              },
              { detail },
            )
          : t(
              {
                id: "persistentVoiceRoom.hevc.retireFailed",
                defaultMessage: "The previous H.265 publisher could not be retired: {detail}",
              },
              { detail },
            ),
      );
    }
    if (startGeneration !== hevcStartGeneration.current) {
      stopCandidateCapture();
      throw new Error(
        previous
          ? t({
              id: "persistentVoiceRoom.hevc.switchCancelled",
              defaultMessage: "The previous H.265 screen share stopped while switching, and the replacement was cancelled.",
            })
          : t({ id: "persistentVoiceRoom.hevc.cancelled", defaultMessage: "The H.265 screen share was cancelled." }),
      );
    }

    const sessionGeneration = ++hevcSessionGeneration.current;
    const current = () =>
      startGeneration === hevcStartGeneration.current &&
      sessionGeneration === hevcSessionGeneration.current;
    const assertCurrent = () => {
      if (!current()) throw new Error(t({ id: "persistentVoiceRoom.hevc.cancelled", defaultMessage: "The H.265 screen share was cancelled." }));
    };

    let publisherToken;
    let keyMaterial: Uint8Array;
    try {
      publisherToken = await fetchAvToken(tokenData.origin, channel.voice.room);
      assertCurrent();
      keyMaterial = voiceSenderKey(channel.voice.mediaKey, publisherToken.identity);
    } catch (error) {
      stopCandidateCapture();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        previous
          ? t(
              {
                id: "persistentVoiceRoom.hevc.switchNoAccess",
                defaultMessage:
                  "The previous H.265 screen share stopped while switching, and the replacement could not obtain access: {detail}",
              },
              { detail },
            )
          : detail,
      );
    }
    const resolution = SCREEN_SHARE_RESOLUTIONS.find(
      (option) => option.id === quality.resolution,
    );
    if (!resolution) {
      stopCandidateCapture();
      throw new Error(
        previous
          ? t({
              id: "persistentVoiceRoom.hevc.switchInvalidResolution",
              defaultMessage:
                "The previous H.265 screen share stopped while switching, and the replacement resolution is invalid.",
            })
          : t({ id: "persistentVoiceRoom.hevc.invalidResolution", defaultMessage: "The selected H.265 resolution is invalid." }),
      );
    }

    const active: ActiveHevcCapture = { stream, identity: publisherToken.identity };
    adopted = active;
    pendingHevcCaptures.current.delete(stream);
    activeHevc.current = active;
    hevcIdentitiesRef.current = [publisherToken.identity];
    setHevcIdentities([publisherToken.identity]);
    setHevcStatus({
      state: "starting",
      active: true,
      backend: capability.backend ?? undefined,
      encoder: capability.encoder ?? undefined,
      device: capability.device ?? undefined,
      width: resolution.width,
      height: resolution.height,
      frameRate: quality.frameRate,
      bitrate: quality.maxBitrate,
      pipelineStage: t({ id: "persistentVoiceRoom.hevc.waitingFirstFrame", defaultMessage: "Waiting for first captured frame" }),
    });

    try {
      // Publish role metadata before connecting, so the auxiliary identity never shows as an extra caller.
      await announceAdditionalIdentities([publisherToken.identity]);
      assertCurrent();
      const status = await startDesktopHevcScreenShare(video, {
        url: publisherToken.url,
        token: publisherToken.token,
        keyMaterial: bytesToBase64(keyMaterial),
        width: resolution.width,
        height: resolution.height,
        frameRate: quality.frameRate,
        bitrate: quality.maxBitrate,
      });
      assertCurrent();
      if (!shellHevcSessions.current.bind(status.sessionId)) {
        throw new Error(
          t({
            id: "persistentVoiceRoom.hevc.staleSession",
            defaultMessage: "The H.265 publisher returned a retired or uncorrelated session.",
          }),
        );
      }
      setHevcPreview({ track: video, identity: publisherToken.identity });

      const audio = stream.getAudioTracks()[0];
      if (audio) {
        const publication = await room.localParticipant.publishTrack(audio, {
          ...screenShareAudioPublishOptions(),
          source: Track.Source.ScreenShareAudio,
        });
        if (!current()) {
          if (publication.track) {
            await room.localParticipant.unpublishTrack(publication.track, true);
          }
          throw new Error(t({ id: "persistentVoiceRoom.hevc.cancelled", defaultMessage: "The H.265 screen share was cancelled." }));
        }
        if (publication.track) active.audioTrack = publication.track;
      }
      setHevcStatus(status);
    } catch (error) {
      if (current() && activeHevc.current === active) {
        await stopHevc(true);
        setHevcStatus({
          state: "error",
          active: false,
          error: error instanceof Error ? error.message : t({ id: "persistentVoiceRoom.hevc.startFailed", defaultMessage: "The H.265 publisher failed to start." }),
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        previous
          ? t(
              {
                id: "persistentVoiceRoom.hevc.switchStartFailed",
                defaultMessage:
                  "The previous H.265 screen share stopped while switching, and the replacement could not start: {detail}",
              },
              { detail },
            )
          : detail,
      );
    }
  }, [
    announceAdditionalIdentities,
    channel.voice,
    e2ee.room,
    hevcCapability,
    stopHevc,
    tokenData,
  ]);

  const hevcScreenShare = useMemo(
    () => ({
      capability: hevcCapability,
      status: hevcStatus,
      active: hevcStatus.active,
      previewTrack: hevcPreview?.track ?? null,
      publisherIdentity: hevcPreview?.identity ?? null,
      start: startHevc,
      stop: async () => {
        await stopHevc(true);
        setHevcStatus({ state: "stopped", active: false, reason: "requested" });
      },
    }),
    [hevcCapability, hevcPreview, hevcStatus, startHevc, stopHevc],
  );

  const signals = useMemo<CallSignals>(
    () => ({
      enabled: Boolean(tokenData),
      myHandRaised: handRaised,
      toggleHand: () => setHandRaised((raised) => !raised),
      sendReaction,
      reactions,
      hevcScreenShare,
      recording: recordingSignals,
    }),
    [tokenData, handRaised, sendReaction, reactions, hevcScreenShare, recordingSignals],
  );

  // No automatic split healing: presence broker hints are untrusted, and one
  // member could pull the call off the configured list. Report instead.
  // Compared against the origin we actually minted through.
  const strandedFrom = useMemo(
    () => (tokenData ? occupantsElsewhere(fold, tokenData.origin) : []),
    [fold, tokenData],
  );
  const elsewhereOrigin = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of strandedFrom) {
      const origin = p.broker ? canonicalOrigin(p.broker) : null;
      if (origin) counts.set(origin, (counts.get(origin) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [origin, count] of counts) {
      if (count > bestCount) [best, bestCount] = [origin, count];
    }
    return best;
  }, [strandedFrom]);

  // Offered, never automatic: following the crowd would turn an untrusted hint into routing.
  const warnedSplit = useRef(false);
  useEffect(() => {
    if (warnedSplit.current || strandedFrom.length === 0 || !elsewhereOrigin) return;
    warnedSplit.current = true;
    const host = elsewhereOrigin.replace(/^https:\/\//, "");
    toast({
      title: t(
        {
          id: "persistentVoiceRoom.split.title",
          defaultMessage:
            "{count, plural, one {# member is} other {# members are}} on another voice server",
        },
        { count: strandedFrom.length },
      ),
      description:
        communityBrokers.length > 0
          ? t(
              {
                id: "persistentVoiceRoom.split.descriptionCommunity",
                defaultMessage:
                  "They're on {host}, not one this community sets, so they're in a separate call you won't hear.",
              },
              { host },
            )
          : t(
              {
                id: "persistentVoiceRoom.split.descriptionOwn",
                defaultMessage:
                  "They're on {host}, not your voice server, so they're in a separate call you won't hear.",
              },
              { host },
            ),
      action: (
        <ToastAction
          altText={t({ id: "persistentVoiceRoom.split.joinAlt", defaultMessage: "Join the call on {host}" }, { host })}
          onClick={() => joinConcordCall({ ...ctx, broker: elsewhereOrigin })}
        >
          {t({ id: "persistentVoiceRoom.split.join", defaultMessage: "Join them" })}
        </ToastAction>
      ),
    });
  }, [strandedFrom, elsewhereOrigin, communityBrokers, ctx, joinConcordCall]);

  // CORD-07 §4: a member on a transport we don't speak is in the call, just not one we can hear —
  // unless a member on both bridges it here.
  const warnedOtherTransport = useRef(false);
  const otherTransportCount = useMemo(() => {
    const bridged = bridgedTransports(fold);
    return fold.otherTransport.filter((p) => !bridged.has(p.transport)).length;
  }, [fold]);
  useEffect(() => {
    if (warnedOtherTransport.current || !tokenData || otherTransportCount === 0) return;
    warnedOtherTransport.current = true;
    toast({
      title: t(
        {
          id: "persistentVoiceRoom.otherTransport.title",
          defaultMessage:
            "{count, plural, one {# member is} other {# members are}} in this call peer to peer",
        },
        { count: otherTransportCount },
      ),
      description: t({
        id: "persistentVoiceRoom.otherTransport.description",
        defaultMessage: "Armada can't join peer-to-peer calls yet, so you won't hear each other.",
      }),
    });
  }, [tokenData, otherTransportCount]);

  // Others render as members only under a sole fresh presence claim (§4).
  const resolveIdentity = useCallback<VoiceIdentityResolver>(
    (identity) => {
      if (
        tokenData &&
        (identity === tokenData.identity || hevcIdentities.includes(identity)) &&
        user
      ) {
        return {
          pubkey: user.pubkey,
          verified: true,
          role: identity === tokenData.identity ? "member" : "screen-share",
        };
      }
      const author = verifiedAuthorOf(fold, identity);
      return author
        ? {
            pubkey: author,
            verified: true,
            role: isVerifiedScreenShareIdentity(fold, identity) ? "screen-share" : "member",
          }
        : { pubkey: identity, verified: false, role: "member" };
    },
    [fold, tokenData, user, hevcIdentities],
  );

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("concord voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label={<FormattedMessage id="persistentVoiceRoom.requestingAccess" defaultMessage="Requesting voice access…" />} />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;
  // Never join Concord without E2EE; show a leavable error instead.
  const room = e2ee.room;
  if (e2ee.error || !room) {
    const e2eeError =
      e2ee.error instanceof Error
        ? e2ee.error
        : new Error(
            t({
              id: "persistentVoiceRoom.encryptionUnavailable",
              defaultMessage: "Voice encryption couldn’t start in this browser. Reload to update, then rejoin.",
            }),
          );
    return <>{<ErrorBar placeBar={placeBar} error={e2eeError} onLeave={onLeave} />}</>;
  }

  const label = (
    <ConcordCallLabel community={community.name} channel={channel.name} onFocus={goToChannel} />
  );

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <CallSignalsContext.Provider value={signals}>
        <VoiceModerationContext.Provider value={voiceActionsFor}>
          <VoiceRoomShell
            serverUrl={tokenData.url}
            token={tokenData.token}
            options={{}}
            room={room}
            onDisconnected={handleDisconnected}
            placeBar={placeBar}
            placeStage={placeStage}
            stageOpen={stageOpen}
            label={label}
          />
        </VoiceModerationContext.Provider>
      </CallSignalsContext.Provider>
    </VoiceIdentityContext.Provider>
  );
}

/** How long an empty DM room waits for the peer to rejoin before hanging up. */
const DM_PEER_GONE_GRACE_MS = 60_000;
/** Data topic a DM peer announces its hang-up on, so it isn't mistaken for a drop. */
const DM_HANGUP_TOPIC = "armada.dm-call.hangup";

/**
 * DM voice room (see src/lib/dmCall.ts): blind-broker token authorized by the
 * per-call room key, media E2EE under one shared key. Signaling lives in DmCallProvider.
 */
function DmVoiceRoom({
  ctx,
  onLeave,
  placeBar,
  placeStage,
  stageOpen,
  exiting,
}: {
  ctx: DmVoiceContext;
  onLeave: () => void;
  placeBar: PlaceBar;
  placeStage: PlaceStage;
  stageOpen: boolean;
  /** The call is leaving; the room disconnects when the exit animation ends. */
  exiting: boolean;
}) {
  const { user } = useCurrentUser();
  const navigate = useNavigate();
  const keys = useMemo(() => dmCallKeys(ctx.secretHex), [ctx.secretHex]);

  // Fall through to our defaults if the call's broker fails to mint. Never
  // refetch while mounted: the token embeds our identity.
  const { data: tokenData, error, isLoading } = useQuery<AvToken>({
    queryKey: ["dm", "av-token", ctx.callId, ctx.broker],
    queryFn: () =>
      fetchAvTokenFromAny(
        [ctx.broker, ...ownAvServers().filter((o) => o !== ctx.broker)],
        keys.room,
      ),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  const peerAuthor = useAuthor(ctx.peer);
  const peerName = getDisplayName(peerAuthor.data?.metadata, ctx.peer);

  // DM media MUST be E2EE; a failed worker renders a leavable error.
  const e2ee = useMemo((): {
    room: Room | null;
    keyProvider: SharedKeyProvider;
    worker: Worker | null;
    error?: unknown;
  } => {
    const keyProvider = new SharedKeyProvider();
    return { keyProvider, ...buildE2eeRoom(keyProvider) };
  }, []);

  // Both sides derive the key from the call secret; nothing to exchange.
  useEffect(() => {
    if (!e2ee.room) return;
    void e2ee.keyProvider
      .setSharedMaterial(keys.mediaKey)
      .catch((err) => console.error("DM voice: failed to install frame key", err));
  }, [e2ee, keys]);

  useEffect(() => {
    if (!tokenData || !e2ee.room) return;
    const room = e2ee.room;
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await room.setE2EEEnabled(true);
      } catch (err) {
        console.error("DM voice: failed to enable E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee, tokenData]);
  useEffect(() => () => e2ee.worker?.terminate(), [e2ee]);

  // End when the peer leaves the SFU: the ephemeral "end" wrap may be lost,
  // which would leave activeCall stuck (permanently "busy"). Grace covers a peer
  // rejoining, and our own full reconnect reporting every remote as gone.
  useEffect(() => {
    const room = e2ee.room;
    if (!room) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onParticipantDisconnected = () => {
      if (room.remoteParticipants.size !== 0 || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (room.remoteParticipants.size === 0) onLeave();
      }, DM_PEER_GONE_GRACE_MS);
    };
    const onParticipantConnected = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    return () => {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    };
  }, [e2ee.room, onLeave]);

  // Hang-up in-band too: the "end" wrap needs a relay socket, which may be stalled.
  useEffect(() => {
    const room = e2ee.room;
    if (!exiting || !room || room.state !== ConnectionState.Connected) return;
    void room.localParticipant
      .publishData(new TextEncoder().encode("hangup"), { reliable: true, topic: DM_HANGUP_TOPIC })
      .catch(() => undefined);
  }, [e2ee.room, exiting]);

  useEffect(() => {
    const room = e2ee.room;
    if (!room) return;
    const onData = (_payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic === DM_HANGUP_TOPIC && participant) onLeave();
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [e2ee.room, onLeave]);

  // Anyone else in a 1:1 room is the peer; without the media key an intruder
  // produces only a silent tile.
  const resolveIdentity = useCallback<VoiceIdentityResolver>(
    (identity) => {
      // H.265 sidecars are Concord-only.
      if (tokenData && identity === tokenData.identity && user) {
        return { pubkey: user.pubkey, verified: true, role: "member" };
      }
      return { pubkey: ctx.peer, verified: true, role: "member" };
    },
    [tokenData, user, ctx.peer],
  );

  const goToConversation = useCallback(() => {
    navigate(`/dm/${nip19.npubEncode(ctx.peer)}`);
  }, [navigate, ctx.peer]);

  const { registerFocusActiveCall, registerCallSummary } = useCall();
  useEffect(() => {
    registerFocusActiveCall(goToConversation);
    return () => registerFocusActiveCall(null);
  }, [registerFocusActiveCall, goToConversation]);

  const picture = peerAuthor.data?.metadata?.picture;
  const avatarSrc = useMediaSrc(typeof picture === "string" && /^https:\/\//.test(picture) ? picture : undefined);
  const icon = useCallNotificationIcon(avatarSrc, () => fetchNotificationIcon(avatarSrc));

  useEffect(() => {
    registerCallSummary({ title: peerName, icon });
    return () => registerCallSummary(null);
  }, [registerCallSummary, peerName, icon]);

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
        console.warn("dm voice disconnected", { reason: DisconnectReason[reason] ?? reason });
      }
      onLeave();
    },
    [onLeave],
  );

  if (isLoading) return <>{<LoadingBar placeBar={placeBar} label={<FormattedMessage id="persistentVoiceRoom.requestingAccess" defaultMessage="Requesting voice access…" />} />}</>;
  if (error || !tokenData) return <>{<ErrorBar placeBar={placeBar} error={error} onLeave={onLeave} />}</>;
  const room = e2ee.room;
  if (e2ee.error || !room) {
    const e2eeError =
      e2ee.error instanceof Error
        ? e2ee.error
        : new Error(
            t({
              id: "persistentVoiceRoom.encryptionUnavailable",
              defaultMessage: "Voice encryption couldn’t start in this browser. Reload to update, then rejoin.",
            }),
          );
    return <>{<ErrorBar placeBar={placeBar} error={e2eeError} onLeave={onLeave} />}</>;
  }

  const label = (
    <button type="button" onClick={goToConversation} className="truncate hover:underline text-left">
      <DisplayName pubkey={ctx.peer} name={peerName} />
    </button>
  );

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <VoiceRoomShell
        serverUrl={tokenData.url}
        token={tokenData.token}
        options={{}}
        room={room}
        onDisconnected={handleDisconnected}
        placeBar={placeBar}
        placeStage={placeStage}
        stageOpen={stageOpen}
        label={label}
        joinUnmuted
      />
    </VoiceIdentityContext.Provider>
  );
}

/**
 * The persistent voice room, mounted lazily by CallProvider (in MainLayout) so
 * the connection survives navigation. UI: fixed mobile bar, or portaled desktop slot.
 */
export default function PersistentVoiceRoom({
  call,
  onLeave,
  slots,
  stageHost,
  stageOpen,
  exiting,
  shellRef,
}: {
  call: ActiveCall;
  onLeave: () => void;
  slots: HTMLElement[];
  stageHost: HTMLElement;
  stageOpen: boolean;
  exiting: boolean;
  shellRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { stageDocked } = useCall();
  const placeBar = useMemo(
    () => makePlaceBar(slots, exiting, shellRef, stageDocked),
    [slots, exiting, shellRef, stageDocked],
  );
  const placeStage = useMemo(() => makePlaceStage(stageHost), [stageHost]);

  if (call.concord) {
    return (
      <ConcordVoiceRoom
        ctx={call.concord}
        onLeave={onLeave}
        placeBar={placeBar}
        placeStage={placeStage}
        stageOpen={stageOpen}
      />
    );
  }
  if (call.dm) {
    return (
      <DmVoiceRoom
        ctx={call.dm}
        onLeave={onLeave}
        placeBar={placeBar}
        placeStage={placeStage}
        stageOpen={stageOpen}
        exiting={exiting}
      />
    );
  }
  return (
    <Nip29VoiceRoom
      call={call}
      onLeave={onLeave}
      placeBar={placeBar}
      placeStage={placeStage}
      stageOpen={stageOpen}
    />
  );
}
