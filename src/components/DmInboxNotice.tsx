import { Check, Inbox, X } from "lucide-react";
import { useContext, useState } from "react";

import { Button } from "@/components/ui/button";
import { useDmInboxSetup } from "@/hooks/useDmInboxSetup";
import { useToast } from "@/hooks/useToast";
import { FormattedMessage, t, useIntl } from "@/i18n";
import { SettingsOverlayContext } from "@/lib/settingsOverlay";
import { cn } from "@/lib/utils";

function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

/**
 * One-tap kind 10050 setup for an account that has none. `dismissible` is the
 * DM list's variant; Settings always shows it while the list is missing. After
 * publishing it stays to say which relays were listed, and where to change them.
 */
export function DmInboxNotice({ dismissible = false, className }: { dismissible?: boolean; className?: string }) {
  const { missing, dismissed, publishing, publish, dismiss } = useDmInboxSetup();
  const { toast } = useToast();
  const intl = useIntl();
  const settings = useContext(SettingsOverlayContext);
  const [published, setPublished] = useState<string[] | null>(null);

  if (!published && !(missing && !(dismissible && dismissed))) return null;

  const onPublish = () => {
    publish().then(setPublished).catch((err) => {
      toast({
        title: t({ id: "dmInboxNotice.failed", defaultMessage: "Couldn't set up your inbox" }),
        description: err instanceof Error ? err.message : t({ id: "dmInboxNotice.tryAgain", defaultMessage: "Please try again." }),
        variant: "destructive",
      });
    });
  };

  const closeLabel = intl.formatMessage({ id: "dmInboxNotice.dismiss", defaultMessage: "Dismiss" });

  return (
    <div
      className={cn(
        "clip-hairline-lg [--fill:var(--muted)/0.4] [--fill-hover:var(--muted)/0.4] px-4 py-3 text-sm",
        className,
      )}
    >
      {published ? (
        <div className="flex items-start gap-2.5" role="status">
          <Check className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium">
              <FormattedMessage id="dmInboxNotice.published" defaultMessage="Other apps can message you now" />
            </p>
            <p className="text-muted-foreground">
              <FormattedMessage
                id="dmInboxNotice.publishedDetail"
                defaultMessage="Your messaging inbox is published, so they deliver to {hosts}."
                values={{
                  hosts: published.map((url, index) => (
                    <span key={url}>
                      {index > 0 && ", "}
                      <span className="font-mono text-foreground break-all">{hostOf(url)}</span>
                    </span>
                  )),
                }}
              />
            </p>
            {dismissible && (
              <Button
                size="sm"
                variant="secondary"
                className="clip-corner-lg touch:h-11"
                onClick={() => settings.show("app-relays")}
              >
                <FormattedMessage id="dmInboxNotice.manage" defaultMessage="Change in Settings" />
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={closeLabel}
            className="size-7 touch:size-11 -mr-2 -mt-1 shrink-0 text-muted-foreground"
            onClick={() => setPublished(null)}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-2.5">
          <Inbox className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-muted-foreground">
              <FormattedMessage
                id="dmInboxNotice.body"
                defaultMessage="People using other Nostr apps can't message you yet."
              />
            </p>
            <Button size="sm" className="clip-corner-lg touch:h-11" disabled={publishing} onClick={onPublish}>
              {publishing ? (
                <FormattedMessage id="dmInboxNotice.settingUp" defaultMessage="Setting up…" />
              ) : (
                <FormattedMessage id="dmInboxNotice.publish" defaultMessage="Let them message me" />
              )}
            </Button>
          </div>
          {dismissible && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              className="size-7 touch:size-11 -mr-2 -mt-1 shrink-0 text-muted-foreground"
              onClick={dismiss}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
