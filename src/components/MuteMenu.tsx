import { Bell, BellOff, ChevronDown } from "lucide-react";
import { useState } from "react";

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useMuteStatus } from "@/hooks/useMuteStatus";
import { FormattedMessage, useIntl } from "@/i18n";
import { MUTE_DURATIONS, muteUntilFor } from "@/lib/muteDurations";
import { cn } from "@/lib/utils";

interface MuteControlProps {
  /** The scope's own running mute, from `muteUntil`. */
  until: number | undefined;
  onMute: (until: number) => void;
  onUnmute: () => void;
}

/** The mute rows at the end of a context-menu notification submenu. */
export function MuteContextItems({ until, onMute, onUnmute }: MuteControlProps) {
  const intl = useIntl();
  const status = useMuteStatus();
  return (
    <>
      <ContextMenuSeparator />
      {until !== undefined ? (
        <ContextMenuItem onSelect={onUnmute}>
          <Bell className="mr-2 size-4" />
          <span className="flex min-w-0 flex-col">
            <FormattedMessage id="muteMenu.unmute" defaultMessage="Unmute" />
            <span className="text-xs text-muted-foreground">{status(until)}</span>
          </span>
        </ContextMenuItem>
      ) : (
        <>
          <ContextMenuLabel className="text-xs font-medium text-muted-foreground">
            <FormattedMessage id="muteMenu.mute" defaultMessage="Mute" />
          </ContextMenuLabel>
          {MUTE_DURATIONS.map((d) => (
            <ContextMenuItem key={d.secs ?? "forever"} onSelect={() => onMute(muteUntilFor(d.secs))}>
              {intl.formatMessage(d.label)}
            </ContextMenuItem>
          ))}
        </>
      )}
    </>
  );
}

/** The mute rows at the end of a dropdown-menu notification submenu. */
export function MuteDropdownItems({ until, onMute, onUnmute }: MuteControlProps) {
  const intl = useIntl();
  const status = useMuteStatus();
  return (
    <>
      <DropdownMenuSeparator />
      {until !== undefined ? (
        <DropdownMenuItem onClick={onUnmute}>
          <Bell className="mr-2 size-4" />
          <span className="flex min-w-0 flex-col">
            <FormattedMessage id="muteMenu.unmute" defaultMessage="Unmute" />
            <span className="text-xs text-muted-foreground">{status(until)}</span>
          </span>
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            <FormattedMessage id="muteMenu.mute" defaultMessage="Mute" />
          </DropdownMenuLabel>
          {MUTE_DURATIONS.map((d) => (
            <DropdownMenuItem key={d.secs ?? "forever"} onClick={() => onMute(muteUntilFor(d.secs))}>
              {intl.formatMessage(d.label)}
            </DropdownMenuItem>
          ))}
        </>
      )}
    </>
  );
}

const PANEL_ROW = "flex w-full items-center gap-3 px-3 py-2 text-sm text-left transition-colors clip-corner-lg hover:bg-foreground/10";

/**
 * For a header panel of plain buttons: "Unmute …" while muted, else "Mute …",
 * which unfolds the durations in place. `onDone` closes the panel.
 */
export function MutePanelItems({
  until,
  onMute,
  onUnmute,
  muteLabel,
  unmuteLabel,
  onDone,
}: MuteControlProps & { muteLabel: string; unmuteLabel: string; onDone: () => void }) {
  const intl = useIntl();
  const status = useMuteStatus();
  const [choosing, setChoosing] = useState(false);
  if (until !== undefined) {
    return (
      <button
        type="button"
        className={PANEL_ROW}
        onClick={() => {
          onUnmute();
          onDone();
        }}
      >
        <Bell className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-col">
          {unmuteLabel}
          <span className="text-xs text-muted-foreground">{status(until)}</span>
        </span>
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className={PANEL_ROW}
        aria-expanded={choosing}
        onClick={() => setChoosing((v) => !v)}
      >
        <BellOff className="size-4 shrink-0" />
        <span className="flex-1">{muteLabel}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", choosing && "rotate-180")} />
      </button>
      {choosing && MUTE_DURATIONS.map((d) => (
        <button
          key={d.secs ?? "forever"}
          type="button"
          className={cn(PANEL_ROW, "pl-10")}
          onClick={() => {
            onMute(muteUntilFor(d.secs));
            setChoosing(false);
            onDone();
          }}
        >
          {intl.formatMessage(d.label)}
        </button>
      ))}
    </>
  );
}

/** A dropdown-menu row: "Unmute …" while muted, else a submenu of durations. */
export function MuteDropdownItem({
  until,
  onMute,
  onUnmute,
  muteLabel,
  unmuteLabel,
}: MuteControlProps & { muteLabel: string; unmuteLabel: string }) {
  const intl = useIntl();
  const status = useMuteStatus();
  if (until !== undefined) {
    return (
      <DropdownMenuItem onClick={onUnmute}>
        <Bell className="size-4" />
        <span className="flex min-w-0 flex-col">
          {unmuteLabel}
          <span className="text-xs text-muted-foreground">{status(until)}</span>
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <BellOff className="size-4" />
        {muteLabel}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {MUTE_DURATIONS.map((d) => (
          <DropdownMenuItem key={d.secs ?? "forever"} onClick={() => onMute(muteUntilFor(d.secs))}>
            {intl.formatMessage(d.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
