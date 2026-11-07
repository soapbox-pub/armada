import { Copy, MoreVertical, Volume2, VolumeX } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { useVoiceModerationActions } from "@/contexts/VoiceModerationContext";
import { useUserModeration } from "@/hooks/useUserModeration";
import { UserModerationMenuSection } from "@/components/chat/ModerationMenuSection";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { useScreenShareVolume, useUserVolume } from "@/hooks/useUserVolume";
import { writeClipboardText } from "@/lib/clipboard";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";
import { MAX_PLAYBACK_VOLUME } from "@/lib/voiceDevices";

export type PlaybackVolumeTarget = "user" | "screenShare";

export function VolumeSliderRow({
  volume,
  apply,
  displayName,
  target = "user",
}: {
  volume: number;
  apply: (next: number) => void;
  displayName: string;
  target?: PlaybackVolumeTarget;
}) {
  const intl = useIntl();
  const muted = volume === 0;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={intl.formatMessage(
          {
            id: "voiceUserContextMenu.toggleMute",
            defaultMessage:
              "{muted, select, true {Unmute} other {Mute}} {target, select, screenShare {screen share} other {user}}",
          },
          { muted: String(muted), target },
        )}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => apply(muted ? 1 : 0)}
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      <Slider
        value={[volume]}
        min={0}
        max={MAX_PLAYBACK_VOLUME}
        step={0.05}
        aria-label={target === "screenShare"
          ? intl.formatMessage({ id: "voiceUserContextMenu.screenShareVolume", defaultMessage: "Screen share volume for {name}" }, { name: displayName })
          : intl.formatMessage({ id: "voiceUserContextMenu.volume", defaultMessage: "Volume for {name}" }, { name: displayName })}
        aria-valuetext={`${Math.round(volume * 100)}%`}
        onValueChange={([v]) => apply(v)}
      />
    </div>
  );
}

/**
 * Shared voice-user menu body (volume, local mute, copy npub) for both
 * context and dropdown menus. `showVolume={false}` for the local user.
 */
function useVoiceMenuItems(
  pubkey: string,
  displayName: string,
  showVolume: boolean,
  verified: boolean,
  volumeTarget: PlaybackVolumeTarget,
) {
  // Only VERIFIED pubkeys: acting on an unclaimed identity would hit someone else.
  const moderation = useUserModeration(verified ? pubkey : undefined);
  const voiceActions = useVoiceModerationActions(verified ? pubkey : undefined);
  const actions = voiceActions.length > 0 ? [...voiceActions, ...moderation.actions] : moderation.actions;
  const [userVolume, setUserVolume] = useUserVolume(pubkey);
  const [screenShareVolume, setScreenShareVolume] = useScreenShareVolume(pubkey);
  const volume = volumeTarget === "screenShare" ? screenShareVolume : userVolume;
  const setVolume = volumeTarget === "screenShare" ? setScreenShareVolume : setUserVolume;
  const muted = volume === 0;
  const pct = Math.round(volume * 100);

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    writeClipboardText(npub).then(
      () => toast({ title: t({ id: "voiceUserContextMenu.copiedNpub", defaultMessage: "Copied npub" }) }),
      () => toast({ title: t({ id: "voiceUserContextMenu.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" }),
    );
  };

  const renderMenuItems = function renderMenuItems({
    Item,
    CheckboxItem,
    Label,
    Separator,
    Sub,
    SubTrigger,
    SubContent,
  }: {
    Item: typeof ContextMenuItem | typeof DropdownMenuItem;
    CheckboxItem: typeof ContextMenuCheckboxItem | typeof DropdownMenuCheckboxItem;
    Label: typeof ContextMenuLabel | typeof DropdownMenuLabel;
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
    Sub: typeof ContextMenuSub | typeof DropdownMenuSub;
    SubTrigger: typeof ContextMenuSubTrigger | typeof DropdownMenuSubTrigger;
    SubContent: typeof ContextMenuSubContent | typeof DropdownMenuSubContent;
  }) {
    return (
      <>
        <Label className="flex items-center justify-between gap-2">
          <span className="truncate">
            {volumeTarget === "screenShare" ? (
              <FormattedMessage
                id="voiceUserContextMenu.screenShareOf"
                defaultMessage="{name}'s screen share"
                values={{ name: <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} /> }}
              />
            ) : (
              <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} />
            )}
          </span>
          {showVolume && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">{pct}%</span>
          )}
        </Label>
        {showVolume && (
          <>
            {/* Not a menu Item: Radix item semantics would swallow slider drags. */}
            <div className="px-2 pb-2 pt-1">
              <VolumeSliderRow
                volume={volume}
                apply={setVolume}
                displayName={displayName}
                target={volumeTarget}
              />
            </div>
            <Separator />
            <CheckboxItem checked={muted} onSelect={() => setVolume(muted ? 1 : 0)}>
              {volumeTarget === "screenShare" ? (
                <FormattedMessage id="voiceUserContextMenu.muteScreenShare" defaultMessage="Mute screen share" />
              ) : (
                <FormattedMessage id="voiceUserContextMenu.mute" defaultMessage="Mute" />
              )}
            </CheckboxItem>
          </>
        )}
        <Item className="gap-2" onSelect={copyNpub}>
          <Copy className="size-4" />
          <FormattedMessage id="voiceUserContextMenu.copyNpub" defaultMessage="Copy npub" />
        </Item>
        {actions.length > 0 && (
          <>
            <Separator />
            <UserModerationMenuSection parts={{ Item, Sub, SubTrigger, SubContent }} actions={actions} />
          </>
        )}
      </>
    );
  };
  return { renderMenuItems, dialogs: moderation.dialogs };
}

/** Right-click voice user menu; pair with {@link VoiceUserMenuButton} for touch. */
export function VoiceUserContextMenu({
  pubkey,
  displayName,
  showVolume = true,
  verified = true,
  volumeTarget = "user",
  children,
}: {
  pubkey: string;
  displayName: string;
  showVolume?: boolean;
  volumeTarget?: PlaybackVolumeTarget;
  /** Unverified claims render the name as plain text so they can't borrow another profile's emoji. */
  verified?: boolean;
  children: React.ReactNode;
}) {
  const { renderMenuItems, dialogs } = useVoiceMenuItems(
    pubkey,
    displayName,
    showVolume,
    verified,
    volumeTarget,
  );

  return (
    <>
    <ContextMenu>
      {/* Stop propagation, or the enclosing channel row's context menu opens too. */}
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {renderMenuItems({
          Item: ContextMenuItem,
          CheckboxItem: ContextMenuCheckboxItem,
          Label: ContextMenuLabel,
          Separator: ContextMenuSeparator,
          Sub: ContextMenuSub,
          SubTrigger: ContextMenuSubTrigger,
          SubContent: ContextMenuSubContent,
        })}
      </ContextMenuContent>
    </ContextMenu>
    {dialogs}
    </>
  );
}

/** Tap-triggered "⋮" version of {@link VoiceUserContextMenu}. */
export function VoiceUserMenuButton({
  pubkey,
  displayName,
  showVolume = true,
  verified = true,
  volumeTarget = "user",
  className,
}: {
  pubkey: string;
  displayName: string;
  showVolume?: boolean;
  volumeTarget?: PlaybackVolumeTarget;
  verified?: boolean;
  className?: string;
}) {
  const { renderMenuItems, dialogs } = useVoiceMenuItems(
    pubkey,
    displayName,
    showVolume,
    verified,
    volumeTarget,
  );
  const intl = useIntl();

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "voiceUserContextMenu.actionsFor", defaultMessage: "Actions for {name}" }, { name: displayName })}
          // Stop propagation, including the channel row's press-and-hold reorder.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          className={cn(
            "shrink-0 inline-flex items-center justify-center clip-corner-lg text-muted-foreground hover:text-foreground hover:bg-secondary data-[state=open]:text-foreground",
            className,
          )}
        >
          <MoreVertical className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {renderMenuItems({
          Item: DropdownMenuItem,
          CheckboxItem: DropdownMenuCheckboxItem,
          Label: DropdownMenuLabel,
          Separator: DropdownMenuSeparator,
          Sub: DropdownMenuSub,
          SubTrigger: DropdownMenuSubTrigger,
          SubContent: DropdownMenuSubContent,
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    {dialogs}
    </>
  );
}
