import { Check, FileCode, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { WizardShell } from "@/components/onboarding/WizardShell";
import { useHistoryAudit, type AuditPhase } from "@/concord/hooks/useHistoryAudit";
import type { HistoryReport } from "@/concord/lib/historyAudit";
import { EXPORT_FORMATS, exportFileName, type ExportFormat, type ExportModel } from "@/concord/lib/historyExport";
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

/** Force a save of the export via an object-URL anchor. */
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

/**
 * A relay that actually FAILED (errored or timed out) during the run, as
 * opposed to the soft "didn't reach the floor" heuristics. This is the only
 * thing worth warning about before download, and the only thing that warrants
 * offering a re-run.
 */
function hadRelayFailure(report: HistoryReport): boolean {
  return report.control.relays.some((r) => r.failed) || report.channels.some((c) => c.relays.some((r) => r.failed));
}

interface HistoryAuditViewProps {
  community: Community;
  onClose: () => void;
}

/**
 * The full-screen "verify and export history" surface: a routed wizard (like the
 * Discord import) rather than a dialog, so it outlives the settings dialog its
 * entry point sits in. Runs the exhaustive sweep, populates the local store, and
 * offers the self-contained HTML export built from those rumors.
 */
export function HistoryAuditView({ community, onClose }: HistoryAuditViewProps) {
  const { run, cancel, canRun, progress, result, error } = useHistoryAudit(community);
  const [embed, setEmbed] = useState(true);

  const busy = progress.phase !== "idle" && progress.phase !== "done" && progress.phase !== "error";
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const relayFailure = result ? hadRelayFailure(result.report) : false;

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
          Reads the control plane and every channel across all this community&apos;s relays, saves what
          it finds to your local store, and builds a self-contained export from those rumors.
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
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Check className="size-4 text-emerald-500" />
              {result.report.channels.length} channel{result.report.channels.length === 1 ? "" : "s"},{" "}
              {result.report.totalMessages} message{result.report.totalMessages === 1 ? "" : "s"} ready to export
            </div>

            {relayFailure && (
              <p className="text-center text-xs text-amber-500">
                Some relays didn&apos;t respond, so this copy may be missing recent history.
              </p>
            )}

            <div className="flex gap-2">
              <Button type="button" className="h-11 flex-1 clip-corner-lg" onClick={() => download(result.model, "html")}>
                <FileCode className="size-4" />
                Download HTML
              </Button>
              {relayFailure && (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 clip-corner-lg"
                  onClick={() => void run({ embedAssets: embed })}
                >
                  Run again
                </Button>
              )}
            </div>

            <p className="text-center text-xs text-muted-foreground">
              Opens as a self-contained mini-Armada with Chat, Text, and JSON views. Offline, with
              images embedded.
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2">
            <Checkbox id="history-embed" checked={embed} onCheckedChange={(v) => setEmbed(v === true)} />
            <Label htmlFor="history-embed" className="text-sm font-normal text-muted-foreground">
              Embed images for offline viewing (larger export)
            </Label>
          </div>
        )}

        {busy ? (
          <Button type="button" size="lg" variant="secondary" className="h-12 w-full clip-corner-lg" onClick={cancel}>
            Cancel
          </Button>
        ) : !result ? (
          <Button
            type="button"
            size="lg"
            className="h-12 w-full clip-corner-lg text-base"
            disabled={!canRun}
            onClick={() => void run({ embedAssets: embed })}
          >
            Run audit
          </Button>
        ) : null}
      </div>
    </WizardShell>
  );
}
