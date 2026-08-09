import { AlertTriangle, Braces, FileCode, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { useHistoryAudit, type AuditPhase } from "@/concord/hooks/useHistoryAudit";
import {
  EXPORT_FORMATS,
  exportFileName,
  type ExportFormat,
  type ExportModel,
} from "@/concord/lib/historyExport";
import type { HistoryReport } from "@/concord/lib/historyAudit";
import type { Community } from "@/concord/lib/types";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<AuditPhase, string> = {
  idle: "",
  control: "Reading the control plane",
  channels: "Reading channels",
  profiles: "Resolving members",
  assets: "Embedding media",
  done: "Done",
  error: "Failed",
};

/** Force a save of one export format via an object-URL anchor. */
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

function ReportCard({ report }: { report: HistoryReport }) {
  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border p-4",
        report.ready ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-center gap-2.5">
        {report.ready ? (
          <ShieldCheck className="size-5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
        )}
        <div className="min-w-0">
          <p className="font-medium leading-tight">
            {report.ready ? "History complete for this client" : "History is incomplete"}
          </p>
          <p className="text-xs text-muted-foreground">
            {report.channels.length} channel{report.channels.length === 1 ? "" : "s"} ·{" "}
            {report.totalMessages} message{report.totalMessages === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {(report.blockers.length > 0 || report.warnings.length > 0) && (
        <ul className="space-y-1.5 text-sm">
          {report.blockers.map((b, i) => (
            <li key={`b${i}`} className="flex gap-2 text-destructive">
              <span aria-hidden>•</span>
              <span>{b.detail}</span>
            </li>
          ))}
          {report.warnings.map((w, i) => (
            <li key={`w${i}`} className="flex gap-2 text-amber-500">
              <span aria-hidden>•</span>
              <span>{w.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {!report.ready && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Acting on an incomplete view can drop or clobber history. Let the relays catch up and re-run
          before a rekey, a compaction, a member removal, or any list change.
        </p>
      )}
    </div>
  );
}

interface HistoryAuditViewProps {
  community: Community;
  onClose: () => void;
}

/**
 * The full-screen "ensure perfect history before acting" surface — a routed
 * wizard (like the Discord import) rather than a dialog, so it outlives the
 * settings dialog its entry point sits in. Runs the exhaustive audit, shows a
 * clean completeness verdict, and offers the self-contained HTML / JSON exports.
 */
export function HistoryAuditView({ community, onClose }: HistoryAuditViewProps) {
  const { run, cancel, canRun, progress, result, error } = useHistoryAudit(community);
  const [embed, setEmbed] = useState(true);

  const busy = progress.phase !== "idle" && progress.phase !== "done" && progress.phase !== "error";
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const close = () => {
    if (busy) cancel();
    onClose();
  };

  return (
    <WizardShell index={0} total={0} stepKey="history-audit" maxWidth="max-w-xl" zClassName="z-[250]" onClose={close}>
      <div className="w-full space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-secondary text-primary">
            <ShieldCheck className="size-7" />
          </div>
          <div className="space-y-1">
            <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
              verify &amp; export history
            </h1>
            <p className="text-sm text-muted-foreground">{community.name}</p>
          </div>
        </div>

        <p className="text-center text-sm leading-relaxed text-muted-foreground">
          Reads the control plane and every channel to its floor across all this community&apos;s
          relays, then names anything it can&apos;t prove is present. No client can prove a relay
          handed over everything — this reports the coverage it reached and every gap it can detect.
        </p>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {busy ? (
          <div className="space-y-3 rounded-xl border bg-secondary/40 p-4">
            <div className="flex items-center gap-2.5 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>
                {progress.label || PHASE_LABEL[progress.phase]}
                {progress.total > 1 ? ` (${progress.done}/${progress.total})` : ""}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${progress.total > 1 ? pct : 40}%` }}
              />
            </div>
          </div>
        ) : result ? (
          <div className="space-y-4">
            <ReportCard report={result.report} />
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Download</p>
              <div className="flex gap-2">
                <Button type="button" className="flex-1 clip-corner-lg" onClick={() => download(result.model, "html")}>
                  <FileCode className="size-4" />
                  HTML
                </Button>
                <Button type="button" variant="outline" className="flex-1 clip-corner-lg" onClick={() => download(result.model, "json")}>
                  <Braces className="size-4" />
                  JSON
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                HTML opens as a self-contained mini-Armada — a channel rail and message view, offline,
                with images embedded.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2">
            <Checkbox id="history-embed" checked={embed} onCheckedChange={(v) => setEmbed(v === true)} />
            <Label htmlFor="history-embed" className="text-sm font-normal text-muted-foreground">
              Embed images for offline viewing (larger export)
            </Label>
          </div>
        )}

        <div className="space-y-2">
          {busy ? (
            <Button type="button" size="lg" variant="outline" className="h-12 w-full clip-corner-lg" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="lg"
              className="h-12 w-full clip-corner-lg text-base"
              disabled={!canRun}
              onClick={() => void run({ embedAssets: embed })}
            >
              {result ? "Re-run audit" : "Run audit"}
            </Button>
          )}
        </div>
      </div>
    </WizardShell>
  );
}
