import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useSyncActive, useSyncTasks } from "@/hooks/useSyncActivity";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Passive sync indicator on the channel/server icon (see
 * src/lib/syncActivity.ts). A tap-to-open Popover so it works on touch;
 * delayed so sub-second syncs never flash. `priorityScope` surfaces the on-screen conversation's task.
 */
export function SyncStatusIndicator({
  className,
  priorityScope,
}: {
  className?: string;
  /** Wire-bus scope of the conversation on screen (e.g. `c2:<channelIdHex>`). */
  priorityScope?: string;
}) {
  const intl = useIntl();
  // The task list is read only while the popover is open: it changes with every
  // task's progress, and each change re-rendered the chat header urgently.
  const active = useSyncActive();
  const shown = useDelayedFlag(active, 700);

  if (!shown || !active) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-chrome p-0.5 text-muted-foreground hover:text-foreground select-none",
            className,
          )}
          aria-label={intl.formatMessage({ id: "syncStatusIndicator.ariaLabel", defaultMessage: "Syncing. Tap for details." })}
        >
          {/* Border spinner, not a lucide SVG: a rotated SVG blurs at this size. */}
          <span
            className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-64 p-3 text-xs font-normal text-muted-foreground">
        <SyncTaskDetails priorityScope={priorityScope} />
      </PopoverContent>
    </Popover>
  );
}

function SyncTaskDetails({ priorityScope }: { priorityScope?: string }) {
  const tasks = useSyncTasks();
  if (tasks.length === 0) return null;
  const task = (priorityScope && tasks.find((t) => t.scope === priorityScope)) || tasks[0];
  const more = tasks.length - 1;
  return (
    <>
      <span className="text-foreground font-medium">
        {task.detail ? (
          <FormattedMessage
            id="syncStatusIndicator.syncingDetail"
            defaultMessage="Syncing {label}: {detail}"
            values={{ label: task.label, detail: task.detail }}
          />
        ) : (
          <FormattedMessage id="syncStatusIndicator.syncing" defaultMessage="Syncing {label}…" values={{ label: task.label }} />
        )}
      </span>
      {more > 0 && (
        <span className="mt-1 block">
          <FormattedMessage
            id="syncStatusIndicator.more"
            defaultMessage="…and {more} more {more, plural, one {conversation} other {conversations}} catching up in the background."
            values={{ more }}
          />
        </span>
      )}
    </>
  );
}
