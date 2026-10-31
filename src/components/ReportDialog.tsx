import { Flag, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuthor } from "@/hooks/useAuthor";
import { useMutedPubkeys, useMuteUser } from "@/hooks/useMuteList";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useSendReport } from "@/hooks/useSendReport";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import {
  reportAudience,
  REPORT_REASONS,
  type ReportDestination,
  type ReportReason,
  type ReportTarget,
} from "@/lib/report";

const MAX_COMMENT = 500;

interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ReportTarget;
  destination: ReportDestination;
  /**
   * Remove the reported message from this device; offered (checked) when given.
   * Only message rows pass it: a DM report's target names only the person.
   */
  onRemoveLocal?: () => void;
}

/**
 * The one report dialog for every surface. Doesn't ask where the report goes
 * ({@link reportDestination} decides). Mute is checked by default, omitted if already muted.
 */
export function ReportDialog({ open, onOpenChange, target, destination, onRemoveLocal }: ReportDialogProps) {
  const intl = useIntl();
  const author = useAuthor(target.pubkey);
  const name = useScopedDisplayName(target.pubkey, author.data?.metadata);
  const { mutedPubkeys } = useMutedPubkeys();
  const sendReport = useSendReport();
  const muteUser = useMuteUser();

  const [reason, setReason] = useState<ReportReason | "">("");
  const [comment, setComment] = useState("");
  const [alsoMute, setAlsoMute] = useState(true);
  const [alsoRemove, setAlsoRemove] = useState(true);
  const canRemove = onRemoveLocal !== undefined;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const alreadyMuted = mutedPubkeys.has(target.pubkey);

  // Never inherit the last report's reason.
  useEffect(() => {
    if (!open) return;
    setReason("");
    setComment("");
    setAlsoMute(true);
    setAlsoRemove(true);
    setError(null);
    setBusy(false);
  }, [open]);

  const title =
    destination.kind === "network"
      ? intl.formatMessage({ id: "reportDialog.titleNetwork", defaultMessage: "Report to the Nostr network" })
      : target.eventId
        ? intl.formatMessage({ id: "reportDialog.titleMessage", defaultMessage: "Report message" })
        : (
          <FormattedMessage
            id="reportDialog.titleUser"
            defaultMessage="Report {name}?"
            values={{ name: <DisplayName pubkey={target.pubkey} name={name} /> }}
          />
        );

  const submit = async () => {
    if (!reason) return;
    setError(null);
    setBusy(true);
    try {
      await sendReport.mutateAsync({
        destination,
        target,
        reason,
        comment: comment.trim(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "reportDialog.sendFailed", defaultMessage: "Couldn't send the report." }));
      setBusy(false);
      return;
    }

    // Local and infallible, so before the mute that can still fail.
    if (canRemove && alsoRemove) onRemoveLocal?.();

    // The report landed; a mute failure mustn't read as a failed report (invites duplicates).
    if (alsoMute && !alreadyMuted) {
      try {
        await muteUser.mutateAsync(target.pubkey);
      } catch (e) {
        toast({
          title: t({ id: "reportDialog.blockFailed.title", defaultMessage: "Reported, but couldn't block" }),
          description: e instanceof Error
            ? e.message
            : t({ id: "reportDialog.blockFailed.description", defaultMessage: "Failed to update your block list." }),
          variant: "destructive",
        });
        setBusy(false);
        onOpenChange(false);
        return;
      }
    }

    toast({
      title: t({ id: "reportDialog.sent", defaultMessage: "Report sent" }),
      description: reportAudience(destination),
    });
    setBusy(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <ChromeDialogContent title={typeof title === "string" ? title : intl.formatMessage({ id: "reportDialog.titleUserPlain", defaultMessage: "Report {name}" }, { name })} className="sm:max-w-sm">
        <ChromeDialogHeader icon={Flag} tone="destructive" title={title} description={reportAudience(destination)} />

        <div className="mt-6 space-y-3">
          <Select value={reason} onValueChange={(v) => setReason(v as ReportReason)}>
            <SelectTrigger aria-label={intl.formatMessage({ id: "reportDialog.reason", defaultMessage: "Reason" })}>
              <SelectValue placeholder={intl.formatMessage({ id: "reportDialog.chooseReason", defaultMessage: "Choose a reason" })} />
            </SelectTrigger>
            <SelectContent>
              {REPORT_REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
            placeholder={intl.formatMessage({ id: "reportDialog.detailsPlaceholder", defaultMessage: "Add details (optional)" })}
            rows={3}
            aria-label={intl.formatMessage({ id: "reportDialog.details", defaultMessage: "Details" })}
          />

          {canRemove && (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={alsoRemove} onCheckedChange={(v) => setAlsoRemove(v === true)} />
              <FormattedMessage id="reportDialog.alsoRemove" defaultMessage="Also remove it from this device" />
            </Label>
          )}

          {!alreadyMuted && (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={alsoMute}
                onCheckedChange={(v) => setAlsoMute(v === true)}
              />
              <FormattedMessage
                id="reportDialog.alsoBlock"
                defaultMessage="Also block {name}"
                values={{ name: <DisplayName pubkey={target.pubkey} name={name} /> }}
              />
            </Label>
          )}
        </div>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={busy || !reason}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Flag className="size-4" />}
            {busy ? (
              <FormattedMessage id="reportDialog.sending" defaultMessage="Sending" />
            ) : (
              <FormattedMessage id="reportDialog.report" defaultMessage="Report" />
            )}
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
