import { Bell, BellOff, AtSign } from "lucide-react";

import { MuteContextItems } from "@/components/MuteMenu";
import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

import { useMenuSheet } from "@/hooks/useMenuSheet";
import { useMuteStatus } from "@/hooks/useMuteStatus";
import { FormattedMessage, useIntl } from "@/i18n";

import type { NotifLevel } from "@/hooks/useNotifLevels";

/**
 * Per-conversation notification level submenu; applies to every delivery path
 * via `useNotifLevels`. `level` is the RESOLVED level chosen (channel → community →
 * global, ignoring mutes), and selecting always writes an explicit override.
 * With `mute`, the submenu also mutes the scope for a while or until unmuted.
 */
export function NotifLevelMenu(props: {
  label?: string;
  level: NotifLevel;
  onChange: (level: NotifLevel) => void;
  mute?: {
    until: number | undefined;
    onMute: (until: number) => void;
    onUnmute: () => void;
  };
}) {
  const intl = useIntl();
  const muteStatus = useMuteStatus();
  const { level, onChange, mute } = props;
  const muted = mute?.until !== undefined;
  // A touch sheet is headed by what it was opened on, so the row needn't name it again.
  const inSheet = useMenuSheet() !== null;
  const label = (!inSheet && props.label) || intl.formatMessage({ id: "notifLevelMenu.label", defaultMessage: "Notifications" });
  const current = muted
    ? muteStatus(mute.until!)
    : level === "nothing"
      ? intl.formatMessage({ id: "notifLevelMenu.nothing", defaultMessage: "Nothing" })
      : level === "mentions"
        ? intl.formatMessage({ id: "notifLevelMenu.mentions", defaultMessage: "Only @mentions" })
        : intl.formatMessage({ id: "notifLevelMenu.all", defaultMessage: "All messages" });
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger value={current}>
        {muted || level === "nothing" ? (
          <BellOff className="mr-2 size-4" />
        ) : level === "mentions" ? (
          <AtSign className="mr-2 size-4" />
        ) : (
          <Bell className="mr-2 size-4" />
        )}
        {label}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-56">
        <ContextMenuRadioGroup value={level} onValueChange={(v) => onChange(v as NotifLevel)}>
          <ContextMenuRadioItem value="all">
            <Bell className="mr-2 size-4" /> <FormattedMessage id="notifLevelMenu.all" defaultMessage="All messages" />
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="mentions">
            <AtSign className="mr-2 size-4" /> <FormattedMessage id="notifLevelMenu.mentions" defaultMessage="Only @mentions" />
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="nothing">
            <BellOff className="mr-2 size-4" /> <FormattedMessage id="notifLevelMenu.nothing" defaultMessage="Nothing" />
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        {mute && <MuteContextItems {...mute} />}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
