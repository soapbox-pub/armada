import { Hand, Headphones, MicOff, ScreenShare } from "lucide-react";
import type { CSSProperties } from "react";

import { DisplayName } from "@/components/DisplayName";
import { RecordingFlagIcons } from "@/components/RecordingFlagIcons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceUserContextMenu, VoiceUserMenuButton } from "@/components/VoiceUserContextMenu";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getAvatarShape, shapedAvatarSpeakingStyle } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { defineMessage, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";
import type { VoiceRowTransport } from "@/concord/lib/voice";
import { cn } from "@/lib/utils";
import { AvatarInitial } from "@/components/AvatarInitial";
import { HiveIcon, HubIcon } from "@/components/icons/TransportIcons";

function ParticipantAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  return (
    <Avatar
      shape={getAvatarShape(metadata)}
      className={cn("size-5 ring-2 ring-chrome", className)}
    >
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-success/20 text-success text-monogram">
        <AvatarInitial name={name} />
      </AvatarFallback>
    </Avatar>
  );
}

function ParticipantName({ pubkey }: { pubkey: string }) {
  return (
    <div className="truncate">
      <DisplayName pubkey={pubkey} />
    </div>
  );
}

/** The person is screen sharing; with `onWatch`, a button that tunes into the stream. */
export function LiveBadge({ onWatch, className }: { onWatch?: () => void; className?: string }) {
  const intl = useIntl();
  const cls = cn(
    "shrink-0 inline-flex items-center gap-1 rounded-sm bg-destructive px-1.5 h-4 text-3xs font-bold tracking-wide text-destructive-foreground",
    className,
  );
  const content = (
    <>
      <ScreenShare className="size-3" aria-hidden />
      <FormattedMessage id="voicePresence.live" defaultMessage="LIVE" />
    </>
  );
  if (!onWatch) {
    return (
      <span className={cls} aria-label={intl.formatMessage({ id: "voicePresence.streaming", defaultMessage: "Streaming" })}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      // Rows and tiles have their own click/context-menu behaviour.
      onClick={(e) => {
        e.stopPropagation();
        onWatch();
      }}
      aria-label={intl.formatMessage({ id: "voicePresence.watchStream", defaultMessage: "Watch stream" })}
      title={intl.formatMessage({ id: "voicePresence.watchStream", defaultMessage: "Watch stream" })}
      className={cn(cls, "cursor-pointer hover:bg-destructive/85 touch:h-6 touch:px-2")}
    >
      {content}
    </button>
  );
}

/** Only streaming rows reach for the call context. */
function WatchableLiveBadge({ pubkey }: { pubkey: string }) {
  const { watchStream } = useCall();
  return <LiveBadge onWatch={() => watchStream(pubkey)} />;
}

/** Nested voice roster rows under a channel in the sidebar; `speaking` lights rows when in the call. */
export function VoiceParticipantList({
  participants,
  speaking,
  muted,
  streaming,
  raised,
  recording,
  refusing,
  transports,
  canWatch = true,
  className,
}: {
  participants: readonly string[];
  speaking?: ReadonlySet<string>;
  muted?: ReadonlySet<string>;
  /** Pubkeys screen sharing (only known while in the call). */
  streaming?: ReadonlySet<string>;
  /** Pubkeys with a raised hand (Armada client feature; Concord calls only). */
  raised?: ReadonlySet<string>;
  /** Pubkeys recording the call, and refusing to be recorded (Concord calls only). */
  recording?: ReadonlySet<string>;
  refusing?: ReadonlySet<string>;
  /** How each member is in the call beyond the SFU (CORD-07 §4 Transports). */
  transports?: ReadonlyMap<string, VoiceRowTransport>;
  /** Whether a streaming row opens the stream: only from inside the call. */
  canWatch?: boolean;
  className?: string;
}) {
  const intl = useIntl();
  if (participants.length === 0) return null;
  // Sort so rows don't reshuffle as presence/LiveKit events land.
  const sorted = [...participants].sort();
  return (
    <div className={cn("flex flex-col pb-0.5", className)} aria-label={intl.formatMessage({ id: "voicePresence.inVoice", defaultMessage: "{count} in voice" }, { count: participants.length })}>
      {sorted.map((pk) => (
        <VoiceParticipantRow
          key={pk}
          pubkey={pk}
          isSpeaking={speaking?.has(pk) ?? false}
          isMuted={muted?.has(pk) ?? false}
          isStreaming={streaming?.has(pk) ?? false}
          isRaised={raised?.has(pk) ?? false}
          isRecording={recording?.has(pk) ?? false}
          isRefusing={refusing?.has(pk) ?? false}
          transport={transports?.get(pk)}
          canWatch={canWatch}
        />
      ))}
    </div>
  );
}

/** One roster row. Right-click or the "⋮" button opens the voice user menu. */
function VoiceParticipantRow({
  pubkey,
  isSpeaking,
  isMuted,
  isStreaming,
  isRaised,
  isRecording = false,
  isRefusing = false,
  transport,
  canWatch = true,
}: {
  pubkey: string;
  isSpeaking?: boolean;
  isMuted?: boolean;
  isStreaming?: boolean;
  isRaised?: boolean;
  isRecording?: boolean;
  isRefusing?: boolean;
  transport?: VoiceRowTransport;
  canWatch?: boolean;
}) {
  const intl = useIntl();
  const author = useAuthor(pubkey);
  const { user } = useCurrentUser();
  const metadata = author.data?.metadata;
  const name = getDisplayName(metadata, pubkey);
  const hasCustomShape = !!getAvatarShape(metadata);
  const isSelf = user?.pubkey === pubkey;

  // Emoji-shaped avatars have a mask that clips rings, so use a drop-shadow filter.
  const wrapperStyle: CSSProperties | undefined =
    hasCustomShape && isSpeaking ? { filter: shapedAvatarSpeakingStyle.filter } : undefined;

  return (
    <VoiceUserContextMenu pubkey={pubkey} displayName={name} showVolume={!isSelf}>
      <div className="group/voicerow flex items-center gap-2 pl-7 pr-1 py-1 text-sm text-muted-foreground">
        <div
          className={cn(
            "rounded-full shrink-0 transition-shadow",
            !hasCustomShape && isSpeaking && "ring-2 ring-success",
          )}
          style={wrapperStyle}
        >
          <Avatar shape={getAvatarShape(metadata)} className="size-6">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
            <AvatarFallback className="bg-success/20 text-success text-3xs">
              <AvatarInitial name={name} />
            </AvatarFallback>
          </Avatar>
        </div>
        <span className={cn("truncate flex-1 min-w-0", isSpeaking && "text-success")}>
          <DisplayName pubkey={pubkey} name={name} />
        </span>
        {isStreaming && (isSelf || !canWatch ? <LiveBadge /> : <WatchableLiveBadge pubkey={pubkey} />)}
        <RecordingFlagIcons recording={isRecording} refusing={isRefusing} className="size-3.5" />
        {transport && <TransportMarker transport={transport} />}
        {isRaised && (
          <Hand
            className="size-3.5 shrink-0 text-warning"
            aria-label={intl.formatMessage({ id: "voicePresence.handRaised", defaultMessage: "Hand raised" })}
          />
        )}
        {isMuted && (
          <MicOff
            className="size-3.5 shrink-0 text-destructive"
            aria-label={intl.formatMessage({ id: "voicePresence.muted", defaultMessage: "Muted" })}
          />
        )}
        {/* Hover-revealed on pointer devices, always visible on touch. */}
        <VoiceUserMenuButton
          pubkey={pubkey}
          displayName={name}
          showVolume={!isSelf}
          className="size-6 touch:size-8 opacity-0 group-hover/voicerow:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 touch:opacity-100 transition-opacity"
        />
      </div>
    </VoiceUserContextMenu>
  );
}

const TRANSPORT_LABELS = {
  other: defineMessage({
    id: "voicePresence.otherTransport",
    defaultMessage: "In the call peer to peer, which Armada can't join yet",
  }),
  bridged: defineMessage({
    id: "voicePresence.bridgedTransport",
    defaultMessage: "In the call peer to peer, heard here through a bridge",
  }),
  both: defineMessage({
    id: "voicePresence.bothTransports",
    defaultMessage: "In the call on the LiveKit server and peer to peer",
  }),
  bridge: defineMessage({
    id: "voicePresence.bridge",
    defaultMessage: "Bridging the peer-to-peer call into this one",
  }),
} satisfies Record<VoiceRowTransport, MessageDescriptor>;

/** A roster row's peer-to-peer marker, dimmed where the member can't be heard here. */
function TransportMarker({ transport }: { transport: VoiceRowTransport }) {
  const intl = useIntl();
  const label = intl.formatMessage(TRANSPORT_LABELS[transport]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <HiveIcon
          className={cn("size-3.5 shrink-0", transport === "other" ? "text-muted-foreground" : "text-success")}
          aria-label={label}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * How many are in a call on each transport: the SFU (LiveKit) and peer to peer
 * (iroh, which Vector uses). A member on both counts on both.
 */
export function CallTransportCounts({
  sfu,
  p2p,
  className,
}: {
  sfu: number;
  p2p: number;
  className?: string;
}) {
  const intl = useIntl();
  const sfuLabel = intl.formatMessage(
    {
      id: "voicePresence.transport.sfu",
      defaultMessage: "{count, plural, one {# member} other {# members}} on the LiveKit server",
    },
    { count: sfu },
  );
  const p2pLabel = intl.formatMessage(
    {
      id: "voicePresence.transport.p2p",
      defaultMessage: "{count, plural, one {# member} other {# members}} peer to peer, as Vector calls",
    },
    { count: p2p },
  );
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-3xs font-semibold tabular-nums", className)}>
      {sfu > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-0.5 text-warning" aria-label={sfuLabel}>
              <HubIcon className="size-3.5" aria-hidden />
              {sfu}
            </span>
          </TooltipTrigger>
          <TooltipContent>{sfuLabel}</TooltipContent>
        </Tooltip>
      )}
      {p2p > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-0.5 text-success" aria-label={p2pLabel}>
              <HiveIcon className="size-3.5" aria-hidden />
              {p2p}
            </span>
          </TooltipTrigger>
          <TooltipContent>{p2pLabel}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** Overlapping avatar stack with "+N" overflow and a names tooltip. */
export function VoicePresence({
  participants,
  max = 3,
  className,
}: {
  participants: readonly string[];
  max?: number;
  className?: string;
}) {
  const intl = useIntl();
  if (participants.length === 0) return null;
  const shown = participants.slice(0, max);
  const overflow = participants.length - shown.length;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex items-center shrink-0 text-success", className)}
          aria-label={intl.formatMessage({ id: "voicePresence.inVoice", defaultMessage: "{count} in voice" }, { count: participants.length })}
        >
          <Headphones className="size-3.5 mr-1" />
          <span className="flex -space-x-1.5">
            {shown.map((pk) => (
              <ParticipantAvatar key={pk} pubkey={pk} />
            ))}
            {overflow > 0 && (
              <span className="flex items-center justify-center size-5 rounded-full ring-2 ring-chrome bg-success/20 text-success text-monogram font-semibold tabular-nums">
                +{overflow}
              </span>
            )}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-48">
        <div className="text-xs font-semibold mb-0.5">
          <FormattedMessage id="voicePresence.inVoice" defaultMessage="{count} in voice" values={{ count: participants.length }} />
        </div>
        {participants.map((pk) => (
          <ParticipantName key={pk} pubkey={pk} />
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
