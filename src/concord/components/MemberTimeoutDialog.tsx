import { Timer } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { getDisplayName } from "@/lib/getDisplayName";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { common, defineMessage, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";

/** The lengths a Timeout can run, Discord's, up to the 28-day cap (CORD-04 §8). */
const LENGTHS: ReadonlyArray<{ secs: number; label: MessageDescriptor }> = [
  { secs: 60, label: defineMessage({ id: "memberTimeoutDialog.minute", defaultMessage: "60 seconds" }) },
  { secs: 5 * 60, label: defineMessage({ id: "memberTimeoutDialog.fiveMinutes", defaultMessage: "5 minutes" }) },
  { secs: 10 * 60, label: defineMessage({ id: "memberTimeoutDialog.tenMinutes", defaultMessage: "10 minutes" }) },
  { secs: 60 * 60, label: defineMessage({ id: "memberTimeoutDialog.hour", defaultMessage: "1 hour" }) },
  { secs: 24 * 60 * 60, label: defineMessage({ id: "memberTimeoutDialog.day", defaultMessage: "1 day" }) },
  { secs: 7 * 24 * 60 * 60, label: defineMessage({ id: "memberTimeoutDialog.week", defaultMessage: "1 week" }) },
];

/** Time a member out (CORD-04 §8): they can't post, react or name themselves until it ends. */
export function MemberTimeoutDialog({
  open,
  pubkey,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  pubkey: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (seconds: number) => Promise<void>;
}) {
  const intl = useIntl();
  const name = getDisplayName(useAuthor(pubkey).data?.metadata, pubkey);
  const [secs, setSecs] = useState(LENGTHS[0].secs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setSecs(LENGTHS[0].secs);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "memberTimeoutDialog.title", defaultMessage: "Time out member" })}>
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Timer className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="memberTimeoutDialog.heading" defaultMessage="time out {name}" values={{ name }} />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="memberTimeoutDialog.description" defaultMessage="Until it ends they can read but not post, react or speak in calls, and what they send meanwhile stays hidden." />
          </p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2" role="radiogroup">
          {LENGTHS.map((l) => (
            <Button
              key={l.secs}
              type="button"
              role="radio"
              aria-checked={secs === l.secs}
              variant={secs === l.secs ? "default" : "secondary"}
              className="clip-corner-lg touch:h-11"
              onClick={() => setSecs(l.secs)}
            >
              {intl.formatMessage(l.label)}
            </Button>
          ))}
        </div>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button
            type="button"
            className="flex-1 clip-corner-lg"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              onSubmit(secs)
                .then(() => onOpenChange(false))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setSaving(false));
            }}
          >
            <FormattedMessage id="memberTimeoutDialog.confirm" defaultMessage="Time out" />
          </Button>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
