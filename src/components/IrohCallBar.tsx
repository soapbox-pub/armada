import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";

import { HiveIcon } from "@/components/icons/TransportIcons";
import { Button } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/i18n";

/**
 * The call bar of a voice Channel joined peer to peer only, because no LiveKit
 * server could be reached: who is linked, the microphone, and leaving.
 */
export function IrohCallBar({
  label,
  connecting,
  linked,
  muted,
  canSpeak,
  onToggleMute,
  onLeave,
}: {
  label: React.ReactNode;
  connecting: boolean;
  linked: number;
  muted: boolean;
  canSpeak: boolean;
  onToggleMute: () => void;
  onLeave: () => void;
}) {
  const intl = useIntl();
  const micLabel = muted
    ? intl.formatMessage({ id: "callControls.unmuteMic", defaultMessage: "Unmute microphone" })
    : intl.formatMessage({ id: "callControls.muteMic", defaultMessage: "Mute microphone" });
  const leaveLabel = intl.formatMessage({ id: "callControls.leave", defaultMessage: "Leave call" });
  return (
    <div className="flex items-center gap-2 px-3 py-2 clip-corner-lg bg-chrome-deep min-h-12 shadow-lg" data-testid="iroh-call-bar">
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
      <Button
        size="icon"
        variant={muted ? "secondary" : "ghost"}
        className="size-9 touch:size-11 shrink-0"
        onClick={onToggleMute}
        disabled={!canSpeak}
        aria-label={micLabel}
        aria-pressed={muted}
        title={micLabel}
      >
        {muted || !canSpeak ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </Button>
      <Button size="icon" variant="destructive" className="size-9 touch:size-11 shrink-0" onClick={onLeave} aria-label={leaveLabel} title={leaveLabel}>
        <PhoneOff className="size-4" />
      </Button>
    </div>
  );
}
