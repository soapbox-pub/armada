import { AlertTriangle, FileDown, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useHistoryAudit, type AuditPhase } from "@/concord/hooks/useHistoryAudit";
import {
  EXPORT_FORMATS,
  exportFileName,
  type ExportFormat,
  type ExportModel,
} from "@/concord/lib/historyExport";
import type { HistoryReport } from "@/concord/lib/historyAudit";
import type { Community } from "@/concord/lib/types";

const PHASE_LABEL: Record<AuditPhase, string> = {
  idle: "",
  control: "Reading the control plane",
  channels: "Reading channels",
  profiles: "Resolving members",
  assets: "Embedding media",
  done: "Done",
  error: "Failed",
};

/** The download order, most useful first (self-contained HTML leads). */
const FORMATS: ExportFormat[] = ["html", "json", "txt", "csv"];

/** Force a save of one export format via an object-URL anchor (the FileAttachment idiom). */
function download(model: ExportModel, format: ExportFormat): void {
  const fmt = EXPORT_FORMATS[format];
  const blob = new Blob([fmt.write(model)], { type: `${fmt.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(model, format);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function ReportView({ report }: { report: HistoryReport }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {report.ready ? (
          <ShieldCheck className="size-5 shrink-0 text-green-500" />
        ) : (
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
        )}
        <span className="font-medium">
          {report.ready ? "History complete for this client" : "History is incomplete"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {report.channels.length} channel{report.channels.length === 1 ? "" : "s"},{" "}
        {report.totalMessages} message{report.totalMessages === 1 ? "" : "s"}
      </p>
      {report.blockers.length > 0 && (
        <ul className="space-y-1 text-sm text-destructive">
          {report.blockers.map((b, i) => (
            <li key={i}>• {b.detail}</li>
          ))}
        </ul>
      )}
      {report.warnings.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-500">
          {report.warnings.map((w, i) => (
            <li key={i}>• {w.detail}</li>
          ))}
        </ul>
      )}
      {!report.ready && (
        <p className="text-xs text-muted-foreground">
          Acting on an incomplete view can drop or clobber history. Let the relays catch up and re-run
          before a rekey, a compaction, a member removal, or any list change.
        </p>
      )}
    </div>
  );
}

interface HistoryAuditDialogProps {
  community: Community;
  open: boolean;
  onClose: () => void;
}

/**
 * The in-app "ensure perfect history before acting" surface: run the exhaustive
 * audit, read the completeness verdict, and export a copy in any format. Stays
 * mounted for the duration like the rotation dialog — the sweep is a
 * seconds-to-minutes operation the user watches.
 */
export function HistoryAuditDialog({ community, open, onClose }: HistoryAuditDialogProps) {
  const { run, cancel, canRun, progress, result, error } = useHistoryAudit(community);
  const [embed, setEmbed] = useState(true);

  // Closing (or reopening) abandons any in-flight run.
  useEffect(() => {
    if (!open) cancel();
  }, [open, cancel]);

  const busy = progress.phase !== "idle" && progress.phase !== "done" && progress.phase !== "error";

  const close = () => {
    if (busy) cancel();
    onClose();
  };

  const progressText = () => {
    const label = progress.label || PHASE_LABEL[progress.phase];
    if (progress.total > 1) return `${label} (${progress.done}/${progress.total})`;
    return label;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Verify &amp; export history</DialogTitle>
          <DialogDescription>
            Reads the control plane and every channel to its floor across all this community's relays,
            then names what it can&apos;t prove is present. No client can prove a relay handed over
            everything — this reports the coverage it reached and every gap it can detect.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {busy ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {progressText()}
          </div>
        ) : result ? (
          <ScrollArea className="max-h-[50vh] pr-3">
            <ReportView report={result.report} />
          </ScrollArea>
        ) : (
          <div className="flex items-center gap-2 py-1">
            <Checkbox
              id="history-embed"
              checked={embed}
              onCheckedChange={(v) => setEmbed(v === true)}
            />
            <Label htmlFor="history-embed" className="text-sm font-normal">
              Embed images for offline viewing (larger export)
            </Label>
          </div>
        )}

        {result && (
          <div className="flex flex-wrap gap-2 pt-1">
            {FORMATS.map((f) => (
              <Button key={f} type="button" variant="outline" size="sm" onClick={() => download(result.model, f)}>
                <FileDown className="size-4" />
                {f.toUpperCase()}
              </Button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {busy ? "Cancel" : "Close"}
          </Button>
          {!busy && (
            <Button type="button" onClick={() => void run({ embedAssets: embed })} disabled={!canRun}>
              {result ? "Re-run" : "Run audit"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
