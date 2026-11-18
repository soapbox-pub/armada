import {
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipants,
} from "@livekit/components-react";
import { ConnectionState, LocalAudioTrack, Track } from "livekit-client";
import type { Participant } from "livekit-client";
import {
  Check,
  Headphones,
  Loader2,
  Mic,
  PictureInPicture2,
  ScreenShare,
  Settings2,
  Video,
  Volume2,
} from "lucide-react";

import "@livekit/components-styles";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useCallback, useContext, useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuSheetTile } from "@/components/ui/menu-sheet";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useMenuSheet } from "@/hooks/useMenuSheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CameraButton, LeaveButton, MicButton, ScreenShareButton } from "@/components/chat/CallControls";
import { RecordingMenuItems } from "@/components/chat/CallRecorder";
import { RecordingIndicator } from "@/components/chat/CallRecordingIndicators";
import { VolumeSliderRow } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCallRoutes } from "@/hooks/useCallRoutes";
import { toast } from "@/hooks/useToast";
import { routeLabel, type CallRoute } from "@/lib/callRoutes";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useScreenShareVolume, useUserVolume } from "@/hooks/useUserVolume";
import { useVoiceIdentity } from "@/contexts/VoiceIdentityContext";
import { VoiceRejoiningContext } from "@/contexts/VoiceRejoiningContext";
import { getAvatarShape } from "@/lib/avatarShape";
import {
  audioDeviceLabel,
  getAudioProcessing,
  micCaptureConstraints,
  platformRoutesCallAudio,
  rememberVoiceDevice,
  setAudioProcessing,
  supportsSpeakerSelection,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";
import { syncRnnoise } from "@/lib/voiceProcessor";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";
import { cn } from "@/lib/utils";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { AvatarInitial } from "@/components/AvatarInitial";

/**
 * Whether `kind` is audio with unnamed devices, so a capture is worth opening to
 * read the names. Never for cameras: an audio menu must not raise the camera
 * prompt, and on Android a pending prompt stalls every later getUserMedia.
 */
function useNeedsAudioLabels(kind: MediaDeviceKind): boolean {
  const [needs, setNeeds] = useState(false);
  useEffect(() => {
    if (kind === "videoinput") return;
    let cancelled = false;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        // The default entry stays unlabeled on Android even with a grant.
        const unnamed = list.some((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && !d.label);
        if (!cancelled) setNeeds(unnamed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return needs;
}

function DeviceSelectGroup({
  kind,
  label,
  icon,
}: {
  kind: MediaDeviceKind;
  label: string;
  icon: React.ReactNode;
}) {
  const intl = useIntl();
  const sheet = useMenuSheet() !== null;
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    requestPermissions: useNeedsAudioLabels(kind),
  });

  if (devices.length === 0) return null;

  // LiveKit records the system default as "" when, under webAudioMix, it
  // can't map "default" to a concrete device.
  const activeId = activeDeviceId || "default";
  const nameOf = (device: MediaDeviceInfo, index: number) => audioDeviceLabel(
    device,
    intl.formatMessage({ id: "voiceBar.deviceNumbered", defaultMessage: "{label} {number}" }, { label, number: index + 1 }),
  );
  const choose = (deviceId: string) => {
    // VoiceDeviceSync (PersistentVoiceRoom.tsx) switches the room to a
    // remembered mic or speaker; switching here too would race it.
    if (kind === "videoinput") void setActiveMediaDevice(deviceId);
    rememberVoiceDevice(kind, deviceId);
  };

  if (sheet) {
    const index = devices.findIndex((d) => d.deviceId === activeId);
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger value={index >= 0 ? nameOf(devices[index], index) : undefined}>
          {icon}
          {label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup value={activeId} onValueChange={choose}>
            {devices.map((device, i) => (
              <DropdownMenuRadioItem key={device.deviceId} value={device.deviceId}>
                {nameOf(device, i)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <>
      <DropdownMenuLabel className="flex items-center gap-2 text-xs">
        {icon}
        {label}
      </DropdownMenuLabel>
      {devices.map((device, index) => (
        <DropdownMenuItem key={device.deviceId} onSelect={() => choose(device.deviceId)} className="gap-2">
          <Check className={cn("size-3.5 shrink-0", device.deviceId === activeId ? "opacity-100" : "opacity-0")} />
          <span className="truncate">{nameOf(device, index)}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * Android's output route, chosen natively (CallRouteSelector): the system's
 * communication devices, since Chromium's device list reroutes the whole
 * phone and never offers the earpiece.
 */
function CallRouteGroup() {
  const sheet = useMenuSheet() !== null;
  const { supported, routes, active, select } = useCallRoutes();
  if (!supported || routes.length === 0) return null;

  const choose = (route: CallRoute) => {
    void select(route.id).then((ok) => {
      if (!ok) {
        toast({
          title: t({ id: "voiceBar.switchOutputFailed", defaultMessage: "Couldn't switch output" }),
          description: t(
            { id: "voiceBar.switchOutputFailedDescription", defaultMessage: "{route} is no longer available." },
            { route: routeLabel(route) },
          ),
          variant: "destructive",
        });
      }
    });
  };

  if (sheet) {
    const current = routes.find((r) => r.id === active);
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger value={current ? routeLabel(current) : undefined}>
          <Volume2 className="size-3.5" />
          <FormattedMessage id="voiceBar.output" defaultMessage="Output" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={active == null ? undefined : String(active)}
            onValueChange={(id) => {
              const route = routes.find((r) => String(r.id) === id);
              if (route) choose(route);
            }}
          >
            {routes.map((route) => (
              <DropdownMenuRadioItem key={route.id} value={String(route.id)}>
                {routeLabel(route)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <>
      <DropdownMenuLabel className="flex items-center gap-2 text-xs">
        <Volume2 className="size-3.5" />
        <FormattedMessage id="voiceBar.output" defaultMessage="Output" />
      </DropdownMenuLabel>
      {routes.map((route) => (
        <DropdownMenuItem key={route.id} onSelect={() => choose(route)} className="gap-2">
          <Check className={cn("size-3.5 shrink-0", route.id === active ? "opacity-100" : "opacity-0")} />
          <span className="truncate">{routeLabel(route)}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
    </>
  );
}

/** Call/audio settings gear: device pickers, audio processing and per-participant volume. */
export function DeviceMenu({ className }: { className?: string }) {
  const intl = useIntl();
  const { localParticipant } = useLocalParticipant();
  const [processing, setProcessing] = useState<AudioProcessingPrefs>(() => getAudioProcessing());

  // Browser constraints (noise/echo/gain) only apply at track creation, so they
  // need restartTrack; RNNoise is a processor toggled in place via syncRnnoise.
  const update = useCallback(
    (patch: Partial<AudioProcessingPrefs>) => {
      setProcessing((prev) => {
        const next = { ...prev, ...patch };
        setAudioProcessing(next);
        const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
        const track = pub?.audioTrack;
        if (track instanceof LocalAudioTrack) {
          if ("rnnoise" in patch) {
            void syncRnnoise(track, next.rnnoise);
          } else {
            // restartTrack drops any active processor, so re-apply RNNoise. The
            // options replace the track's constraints wholesale, so carry the
            // mono capture and the device in use.
            const { deviceId } = track.constraints;
            void track
              .restartTrack({ ...micCaptureConstraints(next), ...(deviceId ? { deviceId } : {}) })
              .then(() => syncRnnoise(track, next.rnnoise))
              .catch((err) => console.warn("failed to apply audio processing", err));
          }
        }
        return next;
      });
    },
    [localParticipant],
  );

  const toggles: { key: keyof AudioProcessingPrefs; label: string }[] = [
    ...(rnnoiseSupported()
      ? [{ key: "rnnoise" as const, label: intl.formatMessage({ id: "voiceBar.processing.noiseCancellation", defaultMessage: "Noise cancellation" }) }]
      : []),
    { key: "noiseSuppression", label: intl.formatMessage({ id: "voiceBar.processing.noiseSuppression", defaultMessage: "Noise suppression" }) },
    { key: "echoCancellation", label: intl.formatMessage({ id: "voiceBar.processing.echoCancellation", defaultMessage: "Echo cancellation" }) },
    { key: "autoGainControl", label: intl.formatMessage({ id: "voiceBar.processing.autoGainControl", defaultMessage: "Auto gain control" }) },
  ];

  const title = intl.formatMessage({ id: "voiceBar.audioSettings", defaultMessage: "Audio settings" });
  // On the touch sheet each picker is one row opening a page, so no rule divides them.
  const rule = useIsTouch() ? null : <DropdownMenuSeparator />;

  return (
    <DropdownMenu touchSheet>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={title}
              className={cn(
                "inline-flex items-center justify-center rounded-md size-8 touch:size-11 shrink-0 transition-colors",
                "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
                className,
              )}
            >
              <Settings2 className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="max-w-72 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
        sheetIdentity={{ lead: <MenuSheetTile><Settings2 /></MenuSheetTile>, title }}
      >
        {platformRoutesCallAudio() && <CallRouteGroup />}
        {!platformRoutesCallAudio() && (
          <>
            <DeviceSelectGroup kind="audioinput" label={intl.formatMessage({ id: "voiceBar.microphone", defaultMessage: "Microphone" })} icon={<Mic className="size-3.5" />} />
            {supportsSpeakerSelection() && (
              <>
                {rule}
                <DeviceSelectGroup
                  kind="audiooutput"
                  label={intl.formatMessage({ id: "voiceBar.speaker", defaultMessage: "Speaker" })}
                  icon={<Volume2 className="size-3.5" />}
                />
              </>
            )}
            {rule}
          </>
        )}
        <DeviceSelectGroup kind="videoinput" label={intl.formatMessage({ id: "voiceBar.camera", defaultMessage: "Camera" })} icon={<Video className="size-3.5" />} />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">
          <FormattedMessage id="voiceBar.processing" defaultMessage="Processing" />
        </DropdownMenuLabel>
        {toggles.map(({ key, label }) => (
          <DropdownMenuSwitchItem
            key={key}
            checked={processing[key]}
            onCheckedChange={(checked) => update({ [key]: checked })}
          >
            {label}
          </DropdownMenuSwitchItem>
        ))}
        <RecordingMenuItems />
        <ParticipantVolumeGroup />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Remote participant's mic and screen-share volume. Local participant is skipped (not played back locally). */
function ParticipantVolumeRow({ participant }: { participant: Participant }) {
  const intl = useIntl();
  const inSheet = useMenuSheet() !== null;
  const resolveIdentity = useVoiceIdentity();
  const { pubkey, verified } = resolveIdentity(participant.identity);
  const author = useAuthor(verified ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const scopedName = useScopedDisplayName(pubkey, metadata);
  const name = verified ? scopedName : intl.formatMessage({ id: "voiceBar.unverified", defaultMessage: "Unverified" });
  const [volume, setVolume] = useUserVolume(pubkey);
  const [screenShareVolume, setScreenShareVolume] = useScreenShareVolume(pubkey);
  const hasScreenShareAudio = Boolean(
    participant.getTrackPublication(Track.Source.ScreenShareAudio),
  );

  return (
    // No drawer drag here, or the sheet would swallow a slider drag.
    <div data-vaul-no-drag className={inSheet ? "px-3 py-2" : "px-2 py-1.5"} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
          <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
          <AvatarFallback className="bg-success/20 text-success text-monogram">
            <AvatarInitial name={name} pubkey={verified ? pubkey : undefined} />
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm flex-1">
          <DisplayName pubkey={verified ? pubkey : undefined} name={name} />
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(volume * 100)}%
        </span>
      </div>
      <VolumeSliderRow volume={volume} apply={setVolume} displayName={name} />
      {hasScreenShareAudio && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <ScreenShare className="size-3.5" />
            <span className="flex-1">
              <FormattedMessage id="voiceBar.screenShare" defaultMessage="Screen share" />
            </span>
            <span className="tabular-nums">{Math.round(screenShareVolume * 100)}%</span>
          </div>
          <VolumeSliderRow
            volume={screenShareVolume}
            apply={setScreenShareVolume}
            displayName={name}
            target="screenShare"
          />
        </div>
      )}
    </div>
  );
}

/** Per-user volume controls for every remote participant. */
function ParticipantVolumeGroup() {
  const participants = useParticipants();
  const remotes = participants.filter((p) => !p.isLocal && p.identity);
  if (remotes.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs">
        <FormattedMessage id="voiceBar.participants" defaultMessage="Participants" />
      </DropdownMenuLabel>
      {remotes.map((p) => (
        <ParticipantVolumeRow key={p.sid || p.identity} participant={p} />
      ))}
    </>
  );
}

interface InCallViewProps {
  label?: React.ReactNode;
  onLabelClick?: () => void;
  stacked?: boolean;
  /** The fixed mobile bar: a larger label, no divider. */
  compact?: boolean;
}

/** In-call controls + summary. Must be rendered inside a LiveKitRoom context. */
export function InCallView({ label, onLabelClick, stacked, compact }: InCallViewProps) {
  // `stageVisible`, not `stageOpen`: away from the call's channel the visible
  // stage is the floating window, which `stageOpen` doesn't describe.
  const intl = useIntl();
  const { stageVisible, toggleStage } = useCall();
  const participantCount = useParticipants().length;
  const connectionState = useConnectionState();
  const rejoining = useContext(VoiceRejoiningContext);

  // Between rejoin attempts the room reads Disconnected/Connecting; keep Leave reachable.
  if (
    connectionState === ConnectionState.Reconnecting ||
    (rejoining && connectionState !== ConnectionState.Connected)
  ) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-warning" />
        <span className="flex-1 min-w-0 truncate text-sm text-warning">
          <FormattedMessage id="voiceBar.reconnecting" defaultMessage="Reconnecting…" />
        </span>
        <LeaveButton />
      </div>
    );
  }

  if (connectionState === ConnectionState.Connecting) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-2 min-h-12">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          <FormattedMessage id="voiceBar.connecting" defaultMessage="Connecting to voice…" />
        </span>
      </div>
    );
  }

  const stageLabel = stageVisible
    ? intl.formatMessage({ id: "voiceBar.hideStage", defaultMessage: "Hide call stage" })
    : intl.formatMessage({ id: "voiceBar.showStage", defaultMessage: "Show call stage" });
  const labelClass = cn("flex-1 min-w-0 truncate font-semibold", compact ? "text-sm" : "text-xs");
  const headerEl = (
    <div className="flex items-center gap-1.5 min-w-0 px-1">
      <Headphones className="size-4 text-success shrink-0" />
      {label ? (
        onLabelClick ? (
          <button
            type="button"
            onClick={onLabelClick}
            className={cn(labelClass, "text-foreground hover:underline text-left")}
          >
            {label}
          </button>
        ) : (
          <span className={cn(labelClass, "text-foreground")}>{label}</span>
        )
      ) : (
        <span className={cn(labelClass, "text-success")}>
          <FormattedMessage id="voiceBar.connected" defaultMessage="Voice connected" />
        </span>
      )}
      <RecordingIndicator />
      {/* The w-60 channel column fits only five controls, so desktop toggles the stage here. */}
      {!compact && (
        <button
          type="button"
          onClick={toggleStage}
          aria-label={stageLabel}
          aria-pressed={stageVisible}
          className="shrink-0 flex items-center gap-1.5 rounded-md bg-foreground/10 px-2 py-1 touch:px-3 touch:py-2 text-2xs font-medium text-foreground hover:bg-foreground/20"
        >
          <Video className="size-3.5" />
          <span className="tabular-nums">{participantCount}</span>
          <span>{stageVisible ? intl.formatMessage({ id: "voiceBar.hide", defaultMessage: "Hide" }) : intl.formatMessage({ id: "voiceBar.show", defaultMessage: "Show" })}</span>
        </button>
      )}
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-1.5 px-2 py-2", stacked && "min-w-0")}>
      {headerEl}
      <div className={cn("flex items-center gap-1.5", !compact && "pt-1.5 border-t border-foreground/10")}>
        <MicButton />
        <CameraButton />
        <ScreenShareButton />
        <DeviceMenu />
        {compact && (
          <button
            type="button"
            onClick={toggleStage}
            aria-label={stageLabel}
            aria-pressed={stageVisible}
            title={stageLabel}
            className={cn(
              "shrink-0 inline-flex items-center justify-center rounded-md size-8 touch:size-11 transition-colors",
              stageVisible
                ? "bg-foreground/10 text-foreground hover:bg-foreground/20"
                : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
            )}
          >
            <PictureInPicture2 className="size-4" />
          </button>
        )}
        <div className="flex-1" />
        <LeaveButton />
      </div>
    </div>
  );
}
