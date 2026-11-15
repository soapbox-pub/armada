import { AlignLeft } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CHANNEL_TOPIC_MAX_BYTES } from "@/concord/lib/channelSeal";
import { utf8Len } from "@/concord/lib/types";
import { common, FormattedMessage, useIntl } from "@/i18n";

/** Set, change or clear a Channel's topic (CORD-03 §2). An empty topic removes it. */
export function ChannelTopicDialog({
  open,
  channelName,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  channelName: string;
  initial: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (topic: string) => void;
}) {
  const intl = useIntl();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const trimmed = value.trim();
  const bytes = utf8Len(trimmed);
  const tooLong = bytes > CHANNEL_TOPIC_MAX_BYTES;
  const unchanged = trimmed === initial.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "channelTopicDialog.title", defaultMessage: "Channel topic" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <AlignLeft className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="channelTopicDialog.heading" defaultMessage="channel topic" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="channelTopicDialog.description"
              defaultMessage="Shown beneath #{name} in its header. Leave it empty to remove the topic."
              values={{ name: channelName }}
            />
          </p>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (tooLong) return;
            if (!unchanged) onSubmit(trimmed);
            onOpenChange(false);
          }}
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="channel-topic"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              <FormattedMessage id="channelTopicDialog.label" defaultMessage="Topic" />
            </Label>
            <Textarea
              id="channel-topic"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={intl.formatMessage({ id: "channelTopicDialog.placeholder", defaultMessage: "What's this channel about?" })}
              autoFocus
              rows={3}
              className="bg-background/40 border-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {tooLong && (
              <p className="text-xs text-destructive">
                <FormattedMessage
                  id="channelTopicDialog.tooLong"
                  defaultMessage="Too long: {bytes} of {max} bytes."
                  values={{ bytes, max: CHANNEL_TOPIC_MAX_BYTES }}
                />
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 clip-corner-lg"
              onClick={() => onOpenChange(false)}
            >
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={unchanged || tooLong}>
              <FormattedMessage {...common.save} />
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
