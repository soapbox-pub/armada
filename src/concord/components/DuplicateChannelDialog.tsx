import { Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NAME_MAX_BYTES } from "@/concord/lib/types";
import { common, FormattedMessage, useIntl } from "@/i18n";

/**
 * Name a duplicate of a Channel (Vector's Duplicate Channel): the same type, privacy,
 * topic, place and permissions, under the name given. Nothing said there comes along.
 */
export function DuplicateChannelDialog({
  open,
  source,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  source: string;
  onOpenChange: (open: boolean) => void;
  /** Resolves once made; a rejection stays in the dialog with its reason. */
  onSubmit: (name: string) => Promise<void>;
}) {
  const intl = useIntl();
  const [value, setValue] = useState(source);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setValue(source);
    setError(null);
  }, [open, source]);

  const trimmed = value.trim();
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <ChromeDialogContent title={intl.formatMessage({ id: "duplicateChannelDialog.title", defaultMessage: "Duplicate channel" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Copy className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="duplicateChannelDialog.heading" defaultMessage="duplicate channel" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="duplicateChannelDialog.description"
              defaultMessage="A new channel like #{name}, with the same settings and permissions. Nothing said there comes along."
              values={{ name: source }}
            />
          </p>
        </div>

        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmed || busy) return;
            setBusy(true);
            setError(null);
            onSubmit(trimmed)
              .then(() => onOpenChange(false))
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="duplicate-channel-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FormattedMessage id="duplicateChannelDialog.nameLabel" defaultMessage="Channel name" />
            </Label>
            <Input
              id="duplicate-channel-name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              autoFocus
              maxLength={NAME_MAX_BYTES}
            />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" disabled={busy} onClick={() => onOpenChange(false)}>
              <FormattedMessage {...common.cancel} />
            </Button>
            <Button type="submit" className="flex-1 clip-corner-lg" disabled={!trimmed || busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              <FormattedMessage id="duplicateChannelDialog.submit" defaultMessage="Duplicate" />
            </Button>
          </div>
        </form>
      </ChromeDialogContent>
    </Dialog>
  );
}
