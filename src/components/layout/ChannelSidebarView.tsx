import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PaneResizeHandle } from "@/components/layout/PaneResizeHandle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

interface ChannelSidebarViewProps {
  title: ReactNode;
  subtitle?: ReactNode;
  titleIcon?: ReactNode;
  /**
   * Inline panel below the header (Concord's community menu): a
   * `CollapsibleContent` triggered by `title`, pushing the list down rather than floating.
   */
  titleExpansion?: ReactNode;
  banner?: ReactNode;
  badge?: ReactNode;
  /** Label for the add-channel action; hidden when omitted. */
  addChannelLabel?: string;
  onAddChannel?: () => void;
  addChannelOpen?: boolean;
  /** Disabled "+" placeholder so headers without an add action (e.g. Mesh) line up. */
  addChannelDisabled?: boolean;
  /** Section above the "Channels" label (e.g. Concord's Mentions/Threads). */
  preChannels?: ReactNode;
  /** Sections below "Channels"; each child should be its own `<div className="space-y-0.5">`. */
  postChannels?: ReactNode;
  channelsHeaderExtra?: ReactNode;
  children: ReactNode;
  scrollRef?: React.Ref<HTMLDivElement>;
  footer?: ReactNode;
  className?: string;
}

/** Presentational channel-list shell shared by NIP-29 `ChannelSidebar` and Concord's community page. */
export function ChannelSidebarView({
  title,
  subtitle,
  titleIcon,
  titleExpansion,
  banner,
  badge,
  addChannelLabel,
  onAddChannel,
  addChannelOpen,
  addChannelDisabled,
  preChannels,
  postChannels,
  channelsHeaderExtra,
  children,
  footer,
  className,
  scrollRef,
}: ChannelSidebarViewProps) {
  const intl = useIntl();
  const addLabel = addChannelOpen ? intl.formatMessage(common.cancel) : addChannelLabel;
  const addButton = (onAddChannel || addChannelDisabled) && (
    <Button
      variant="ghost"
      size="icon"
      className="size-5 touch:size-8"
      aria-label={addLabel ?? intl.formatMessage({ id: "channelSidebarView.addChannel", defaultMessage: "Add channel" })}
      aria-expanded={addChannelOpen}
      onClick={onAddChannel}
      disabled={!onAddChannel}
    >
      <Plus className={cn("size-4 transition-transform duration-200", addChannelOpen && "rotate-45")} />
    </Button>
  );

  return (
    <aside
      className={cn(
        "relative flex flex-col w-60 sidebar:w-[var(--channel-list-w,15rem)] shrink-0 bg-chrome",
        className,
      )}
    >
      {/* Desktop: the title sits in the top-bar band (12-60px) and the block ends on
          the 80px content line, where the banner, the rail's second entry and the
          member list start. On mobile a banner fills this block as a background so
          the layout doesn't jump between servers with and without one. */}
      <div
        className={cn(
          "relative pl-5 pr-3 pb-[1.625rem] flex",
          "pt-[calc(1.5rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          "sidebar:pb-5 sidebar:pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          "sidebar:h-[calc(5rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          // Same alignment with or without a banner; the mobile banner is absolute.
          titleIcon ? "items-center gap-1" : "flex-col justify-center",
        )}
      >
        {banner && (
          <>
            <div className="sidebar:hidden absolute inset-0 overflow-hidden">{banner}</div>
            {/* Darkens the status-bar inset so light status icons stay legible over bright banners. */}
            <div
              aria-hidden
              className="sidebar:hidden absolute inset-x-0 top-0 h-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+0.5rem)] pointer-events-none bg-gradient-to-b from-[hsl(var(--chrome))] via-[hsl(var(--chrome)/0.7)] to-transparent"
            />
            <div
              aria-hidden
              className="sidebar:hidden absolute inset-x-0 bottom-0 h-2/3 pointer-events-none bg-gradient-to-t from-[hsl(var(--chrome))] via-[hsl(var(--chrome)/0.7)] to-transparent"
            />
          </>
        )}
        {titleIcon && <div className="relative shrink-0">{titleIcon}</div>}
        <div className="relative min-w-0">
          {/* Reserve the 24px icon line height so text-only titles align identically. */}
          <div className="flex items-center min-h-6">
            <h2 className="min-w-0 font-semibold truncate leading-tight tracking-wide text-sm">{title}</h2>
          </div>
          {subtitle && (
            <span className="block text-2xs text-muted-foreground truncate leading-tight">{subtitle}</span>
          )}
          {badge}
        </div>
        {/* Inside the header so it takes no room of its own. On desktop the banner's
            edge does this job. */}
        <div
          aria-hidden
          className={cn("absolute inset-x-3 bottom-0 h-0.5 bg-chrome-divider", banner && "sidebar:hidden")}
        />
      </div>

      {titleExpansion}

      {/* 80-168px: ends where the rail's first community starts, past the bell, DMs and divider. */}
      {banner && <div className="hidden sidebar:block h-[5.5rem] shrink-0 overflow-hidden">{banner}</div>}

      {/* The member list's rhythm: the first row 8px under the content line (so its
          center meets the first member's and the first community's), then sections
          that each open with a 40px heading band and no other gap. */}
      {/* pan-y: a scroller re-allows every pan, letting the browser claim a drawer swipe. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto touch-pan-y px-3 pt-2 pb-2 flex flex-col">
        {preChannels && <div className="space-y-0.5">{preChannels}</div>}

        <div className="space-y-0.5">
          <div className="flex h-10 items-center justify-between px-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FormattedMessage id="channelSidebarView.channels" defaultMessage="Channels" />
            </span>
            {addLabel ? (
              <Tooltip>
                <TooltipTrigger asChild>{addButton}</TooltipTrigger>
                <TooltipContent>{addLabel}</TooltipContent>
              </Tooltip>
            ) : (
              addButton
            )}
          </div>

          {channelsHeaderExtra}
          {children}
        </div>

        {postChannels}
      </div>

      {footer}
      <PaneResizeHandle pane="channel" />
    </aside>
  );
}
