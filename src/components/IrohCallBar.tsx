import { Loader2, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from "lucide-react";

import { HiveIcon } from "@/components/icons/TransportIcons";
import { Button } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

export interface IrohCallControlsProps {
  muted: boolean;
  canSpeak: boolean;
  onToggleMute: () => void;
  /** Our camera and screen are on; absent where we may not send video here. */
  camera?: boolean;
  screen?: boolean;
  onToggleCamera?: () => void;
  onToggleScreen?: () => void;
  onLeave: () => void;
  /** The stage's larger buttons. */
  large?: boolean;
}

/** Mic, camera, screen and leave for a call that is peer to peer alone. */
export function IrohCallControls({ muted, canSpeak, onToggleMute, camera, screen, onToggleCamera, onToggleScreen, onLeave, large }: IrohCallControlsProps) {
  const intl = useIntl();
  const micLabel = muted
    ? intl.formatMessage({ id: "callControls.unmuteMic", defaultMessage: "Unmute microphone" })
    : intl.formatMessage({ id: "callControls.muteMic", defaultMessage: "Mute microphone" });
  const cameraLabel = camera
    ? intl.formatMessage({ id: "irohCallBar.cameraOff", defaultMessage: "Turn off camera" })
    : intl.formatMessage({ id: "irohCallBar.cameraOn", defaultMessage: "Turn on camera" });
  const screenLabel = screen
    ? intl.formatMessage({ id: "irohCallBar.screenOff", defaultMessage: "Stop sharing your screen" })
    : intl.formatMessage({ id: "irohCallBar.screenOn", defaultMessage: "Share your screen" });
  const leaveLabel = intl.formatMessage({ id: "callControls.leave", defaultMessage: "Leave call" });
  const size = large ? "size-10 touch:size-11" : "size-9 touch:size-11";
  return (
    <div className={cn("flex items-center shrink-0", large ? "gap-2.5" : "gap-2")}>
      <Button
        size="icon"
        variant={muted ? "secondary" : "ghost"}
        className={cn(size, "shrink-0")}
        onClick={onToggleMute}
        disabled={!canSpeak}
        aria-label={micLabel}
        aria-pressed={muted}
        title={micLabel}
      >
        {muted || !canSpeak ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </Button>
      {onToggleCamera && (
        <Button size="icon" variant={camera ? "secondary" : "ghost"} className={cn(size, "shrink-0")} onClick={onToggleCamera} aria-label={cameraLabel} aria-pressed={camera} title={cameraLabel}>
          {camera ? <Video className="size-4" /> : <VideoOff className="size-4" />}
        </Button>
      )}
      {onToggleScreen && (
        <Button size="icon" variant={screen ? "secondary" : "ghost"} className={cn(size, "shrink-0")} onClick={onToggleScreen} aria-label={screenLabel} aria-pressed={screen} title={screenLabel}>
          <MonitorUp className="size-4" />
        </Button>
      )}
      <Button size="icon" variant="destructive" className={cn(size, "shrink-0")} onClick={onLeave} aria-label={leaveLabel} title={leaveLabel}>
        <PhoneOff className="size-4" />
      </Button>
    </div>
  );
}

/**
 * The call bar of a voice Channel joined peer to peer only, because no LiveKit
 * server could be reached: who is linked, the microphone, video, and leaving.
 */
export function IrohCallBar({
  label,
  connecting,
  linked,
  stacked = false,
  ...controls
}: IrohCallControlsProps & {
  label: React.ReactNode;
  connecting: boolean;
  linked: number;
  /** The desktop sidebar's narrow slot: the controls go under the text. */
  stacked?: boolean;
}) {
  return (
    <div
      className={cn("flex gap-2 px-3 py-2 clip-corner-lg bg-chrome-deep min-h-12 shadow-lg", stacked ? "flex-col" : "items-center")}
      data-testid="iroh-call-bar"
    >
      <div className="flex-1 min-w-0 text-sm">
        <div className="truncate">{label}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {connecting ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <HiveIcon className="size-3.5 text-success" aria-hidden />}
          <span className="truncate">
            {connecting ? (
              <FormattedMessage id="irohCallBar.connecting" defaultMessage="Connecting peer to peer…" />
            ) : (
              <FormattedMessage
                id="irohCallBar.linked"
                defaultMessage="{count, plural, =0 {Peer to peer, waiting for others} one {Peer to peer with # member} other {Peer to peer with # members}}"
                values={{ count: linked }}
              />
            )}
          </span>
        </div>
      </div>
      <div className={cn(stacked && "flex justify-end")}>
        <IrohCallControls {...controls} />
      </div>
    </div>
  );
}
