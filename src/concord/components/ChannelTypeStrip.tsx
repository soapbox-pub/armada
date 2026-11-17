import { cn } from "@/lib/utils";
import { useIntl } from "@/i18n";

import { CHANNEL_VIEW_OPTIONS } from "@/concord/lib/channelViewOptions";
import type { ChannelView } from "@/concord/lib/types";

/**
 * The channel type as one well of equal cells. `className` carries the well's
 * surface, which is the same one the fields around it sink into.
 */
export function ChannelTypeStrip({ value, onChange, disabled, className }: {
  value: ChannelView;
  onChange: (view: ChannelView) => void;
  disabled?: boolean;
  className?: string;
}) {
  const intl = useIntl();
  return (
    <div
      role="radiogroup"
      aria-label={intl.formatMessage({ id: "newChannelDialog.channelType", defaultMessage: "Channel type" })}
      className={cn("flex items-center gap-0.5 clip-corner-lg p-1", className)}
    >
      {CHANNEL_VIEW_OPTIONS.map((option) => {
        const selected = option.view === value;
        const Icon = option.icon;
        return (
          <button
            key={option.view}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.view)}
            className={cn(
              "flex h-9 flex-1 items-center justify-center gap-1.5 clip-corner-lg text-sm font-medium transition-colors disabled:opacity-50 touch:h-11",
              selected ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {intl.formatMessage(option.label)}
          </button>
        );
      })}
    </div>
  );
}
