import { useCallback, useEffect, useRef, useState } from "react";

import type { SettleOutcome } from "@/concord/hooks/rosterSettle";
import { emptySettleReport, type SettleReport } from "@/concord/lib/keySettle";

/** What applying a reviewed change does, in the order it does it. */
export type ApplyPhase = "save" | "private" | "rotate" | "send";

export interface ApplyStep {
  phase: ApplyPhase;
  state: "pending" | "active" | "done" | "failed";
  error?: string;
}

/** What the work reports as it goes. */
export interface ApplySink {
  at: (phase: ApplyPhase) => void;
  settled: (outcome: SettleOutcome) => void;
}

export type ApplyStatus = "review" | "working" | "unfinished";

/** Why a run ended unfinished: the write itself threw, or it landed and its keys didn't all move. */
export type ApplyFailure = "write" | "keys";

/** After this long on one step, the run can be closed: a signer that never answers must not trap the sheet. */
export const APPLY_STUCK_MS = 30_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A report's failures against the rows: a cut that didn't rotate, a key that didn't arrive. */
function judge(rows: ApplyStep[], { report, error }: SettleOutcome): void {
  const fail = (phase: ApplyPhase, why?: string) => {
    const row = rows.find((r) => r.phase === phase) ?? rows[rows.push({ phase, state: "failed" }) - 1];
    row.state = "failed";
    row.error = why || undefined;
  };
  if (error !== undefined) {
    if (rows.some((r) => r.phase === "rotate" || r.phase === "send")) fail(rows.some((r) => r.phase === "rotate") ? "rotate" : "send", error);
    return;
  }
  if (!report) return;
  if (report.rotationFailed.length || report.notRotated.length || report.unheldLost.length) fail("rotate", report.rotationFailed[0]?.error);
  if (report.sendFailed !== undefined || report.unheldGained.length) fail("send", report.sendFailed);
}

/**
 * One reviewed change as it is applied: its steps, which one is running, and
 * whether it finished. The dialog showing it stays until this settles.
 */
export function useApplyRun() {
  const [steps, setSteps] = useState<ApplyStep[]>([]);
  const [status, setStatus] = useState<ApplyStatus>("review");
  const [failure, setFailure] = useState<ApplyFailure>();
  const [report, setReport] = useState<SettleReport>();
  const [stuck, setStuck] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const active = steps.find((s) => s.state === "active")?.phase;
  useEffect(() => {
    setStuck(false);
    if (status !== "working") return;
    const timer = setTimeout(() => setStuck(true), APPLY_STUCK_MS);
    return () => clearTimeout(timer);
  }, [status, active]);

  const rows = useRef<ApplyStep[]>([]);

  const start = useCallback(
    async (plan: readonly ApplyPhase[], work: (sink: ApplySink) => Promise<void>, opts?: { keep?: boolean }): Promise<"clean" | "unfinished"> => {
      const kept = opts?.keep ? rows.current.filter((r) => !plan.includes(r.phase)) : [];
      rows.current = [...kept, ...plan.map((phase): ApplyStep => ({ phase, state: "pending" }))];
      const show = () => mounted.current && setSteps(rows.current.map((r) => ({ ...r })));
      let outcome: SettleOutcome | undefined;
      const sink: ApplySink = {
        at: (phase) => {
          const row = rows.current.find((r) => r.phase === phase);
          if (row?.state === "active") return;
          for (const r of rows.current) if (r.state === "active") r.state = "done";
          if (row) row.state = "active";
          else rows.current.push({ phase, state: "active" });
          show();
        },
        settled: (o) => {
          outcome = o;
        },
      };
      setFailure(undefined);
      setReport(undefined);
      setStatus("working");
      show();
      let thrown = false;
      try {
        await work(sink);
        for (const r of rows.current) if (r.state !== "failed") r.state = "done";
        if (outcome) judge(rows.current, outcome);
      } catch (e) {
        thrown = true;
        const row =
          rows.current.find((r) => r.state === "active") ??
          rows.current.find((r) => r.state === "pending") ??
          rows.current[rows.current.push({ phase: "save", state: "pending" }) - 1];
        row.state = "failed";
        row.error = message(e);
      }
      const unfinished = rows.current.some((r) => r.state === "failed");
      if (!mounted.current) return unfinished ? "unfinished" : "clean";
      show();
      setReport(outcome?.report);
      setFailure(thrown ? "write" : unfinished ? "keys" : undefined);
      setStatus(unfinished ? "unfinished" : "review");
      return unfinished ? "unfinished" : "clean";
    },
    [],
  );

  const reset = useCallback(() => {
    rows.current = [];
    setSteps([]);
    setStatus("review");
    setFailure(undefined);
    setReport(undefined);
  }, []);

  return { steps, status, failure, report, stuck, start, reset };
}

export type ApplyRun = ReturnType<typeof useApplyRun>;

/** Rotates the Channels a run left unrotated, as that run's rotate step. */
export function rotateAgain(run: Pick<ApplyRun, "start">, channelIds: readonly string[], rotate: (channelIdHex: string) => Promise<void>) {
  return run.start(
    ["rotate"],
    async (sink) => {
      sink.at("rotate");
      const report = emptySettleReport();
      for (const id of channelIds) {
        await rotate(id).catch((e) => void report.rotationFailed.push({ channelIdHex: id, error: message(e) }));
      }
      sink.settled({ report });
    },
    { keep: true },
  );
}
