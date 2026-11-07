import { ArrowDown, ArrowUp, ChevronDown, FolderMinus, KeyRound, Pencil, Trash2 } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

interface ChannelCategoryHeading2Props {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Dot on the heading so collapsing never hides unread. */
  hasUnread?: boolean;
  /** Rename the category. Undefined without MANAGE_CHANNELS. */
  onRename?: () => void;
  onUngroup?: () => void;
  /** A vsk-13 Category's own actions (CORD-03 §4, CORD-04 §8); absent on the legacy Roster. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onPermissions?: () => void;
  onDelete?: () => void;
  /** A drag is aimed inside this category. */
  highlight?: boolean;
  children?: React.ReactNode;
}

export function ChannelCategoryHeading({
  name,
  collapsed,
  onToggle,
  hasUnread,
  onRename,
  onUngroup,
  onMoveUp,
  onMoveDown,
  onPermissions,
  onDelete,
  highlight,
  children,
}: ChannelCategoryHeading2Props) {
  const intl = useIntl();
  const heading = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      // Touch grows the tap target to 44px without moving the text.
      className={cn(
        "flex w-full items-center gap-1 px-2 pt-3 pb-0.5 touch:pt-4 touch:pb-2.5 text-left text-2xs font-semibold uppercase tracking-wider transition-colors",
        highlight ? "text-primary" : "text-muted-foreground/80 hover:text-foreground",
      )}
    >
      <ChevronDown
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
      />
      <span className="truncate">{name}</span>
      {collapsed && hasUnread && (
        <span className="ml-1 size-1.5 shrink-0 rounded-full bg-primary" aria-label={intl.formatMessage({ id: "channelCategoryHeading.unread", defaultMessage: "Unread" })} />
      )}
      {children}
    </button>
  );

  if (!onRename && !onUngroup && !onPermissions && !onDelete) return heading;
  return (
    <ContextMenu>
      {/* Radix handles both right-click and press-and-hold. */}
      <ContextMenuTrigger asChild>{heading}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {onRename && (
          <ContextMenuItem onSelect={onRename}>
            <Pencil className="size-4" />
            <FormattedMessage id="channelCategoryHeading.rename" defaultMessage="Rename category" />
          </ContextMenuItem>
        )}
        {onUngroup && (
          <ContextMenuItem onSelect={onUngroup}>
            <FolderMinus className="size-4" />
            <FormattedMessage id="channelCategoryHeading.ungroup" defaultMessage="Ungroup channels" />
          </ContextMenuItem>
        )}
        {onMoveUp && (
          <ContextMenuItem onSelect={onMoveUp}>
            <ArrowUp className="size-4" />
            <FormattedMessage id="channelCategoryHeading.moveUp" defaultMessage="Move up" />
          </ContextMenuItem>
        )}
        {onMoveDown && (
          <ContextMenuItem onSelect={onMoveDown}>
            <ArrowDown className="size-4" />
            <FormattedMessage id="channelCategoryHeading.moveDown" defaultMessage="Move down" />
          </ContextMenuItem>
        )}
        {onPermissions && (
          <ContextMenuItem onSelect={onPermissions}>
            <KeyRound className="size-4" />
            <FormattedMessage id="channelPermissions.title" defaultMessage="Permissions" />
          </ContextMenuItem>
        )}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="size-4" />
              <FormattedMessage id="channelCategoryHeading.delete" defaultMessage="Delete category" />
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
