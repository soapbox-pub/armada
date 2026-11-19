import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, BellOff, Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ChromeDialogContent,
  ChromeDialogFooter,
  ChromeDialogHeader,
  Dialog,
  DialogClose,
} from "@/components/ui/dialog";
import { FormattedMessage, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";

/** Pages can't open `brave://` URLs, so the address is offered for copying. */
const BRAVE_PRIVACY_SETTINGS = "brave://settings/privacy";

/** Settings: Brave's push service is off. The how-to lives in a dialog. */
export function BravePushServiceNotice({ onRetry, retrying }: {
  /** Retry runs `subscribe()`, so it must stay a direct click handler. */
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <FormattedMessage id="bravePush.off" defaultMessage="Brave has background notifications turned off." />
      </p>
      <div className="flex flex-wrap gap-2">
        <BravePushHelpButton size="sm" className="touch:h-11" />
        <Button size="sm" variant="ghost" className="touch:h-11" onClick={onRetry} disabled={retrying}>
          <FormattedMessage id="bravePush.retry" defaultMessage="Try again" />
        </Button>
      </div>
    </div>
  );
}

/** Opens the steps to turn Brave's push service on, and what that exposes. */
export function BravePushHelpButton({ size, className, aboveWizard }: {
  size?: "sm" | "lg";
  className?: string;
  /** The post-login wizard stacks above dialogs (`z-[260]`), so one opened from it must go higher. */
  aboveWizard?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant="secondary" className={className} onClick={() => setOpen(true)}>
        <FormattedMessage id="bravePush.howTo" defaultMessage="How to turn them on" />
      </Button>
      <BravePushHelpDialog open={open} onOpenChange={setOpen} aboveWizard={aboveWizard} />
    </>
  );
}

function BravePushHelpDialog({ open, onOpenChange, aboveWizard }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aboveWizard?: boolean;
}) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    writeClipboardText(BRAVE_PRIVACY_SETTINGS).then(() => setCopied(true), () => {});
  };

  const title = intl.formatMessage({ id: "bravePush.dialogTitle", defaultMessage: "Turn on notifications in Brave" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={title}
        className={aboveWizard ? "z-[270]" : undefined}
        overlayClassName={aboveWizard ? "z-[270]" : undefined}
      >
        <ChromeDialogHeader icon={BellOff} tone="warning" title={title} />
        <ol className="mt-6 space-y-3 text-sm">
          <Step n={1}>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <FormattedMessage
                id="bravePush.step1"
                defaultMessage="Open <code>brave://settings/privacy</code>"
                values={{ code: (chunks) => <code className="bg-muted px-1 py-0.5 font-mono text-xs">{chunks}</code> }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-7 touch:size-11"
                onClick={copy}
                aria-label={intl.formatMessage({ id: "bravePush.copyAddress", defaultMessage: "Copy address" })}
              >
                {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
              </Button>
            </span>
          </Step>
          <Step n={2}>
            <FormattedMessage id="bravePush.step2" defaultMessage="Turn on “Use Google services for push messaging”" />
          </Step>
          <Step n={3}>
            <FormattedMessage id="bravePush.step3" defaultMessage="Restart Brave and try again" />
          </Step>
        </ol>
        <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
          <FormattedMessage
            id="bravePush.safe"
            defaultMessage="Brave delivers notifications through Google, as Chrome does. They're encrypted: Google can't read them or see who sent them, only that one arrived."
          />
        </p>
        <ChromeDialogFooter>
          <DialogClose asChild>
            <Button>
              <FormattedMessage id="bravePush.gotIt" defaultMessage="Got it" />
            </Button>
          </DialogClose>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center clip-corner bg-primary/15 font-mono text-xs text-primary">
        {n}
      </span>
      <span className="min-h-6 pt-0.5 text-foreground">{children}</span>
    </li>
  );
}
