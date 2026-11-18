/**
 * Boot/runtime profiler. {@link perfMark} records one-shot milestones as a
 * timeline; {@link perfTime}/{@link perfCount} aggregate repeated operations by
 * label (count / total / max / work units). Always on (it's a Map lookup);
 * only the report is opt-in: `__armadaPerf()` / `__armadaPerf(true)` to reset.
 */

/** Page-load origin, so every mark reads as an offset a pasted log can be diffed on. */
const t0 = now();

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** One-shot boot milestones, in the order they were reached. */
const marks: { label: string; at: number; detail?: string }[] = [];
/**
 * Always on, and some milestones repeat per conversation opened: keep the boot
 * timeline at the front and count the rest rather than grow for the session.
 */
const MAX_MARKS = 300;
let droppedMarks = 0;

/** Aggregate per label. `unit` is a caller-defined work count (rows, wraps, …). */
interface Bucket {
  count: number;
  total: number;
  max: number;
  units: number;
  unitName?: string;
}

const buckets = new Map<string, Bucket>();

function bucket(label: string): Bucket {
  let b = buckets.get(label);
  if (!b) {
    b = { count: 0, total: 0, max: 0, units: 0 };
    buckets.set(label, b);
  }
  return b;
}

/** Record a one-shot milestone. Repeats are kept (a repeat is itself a finding). */
export function perfMark(label: string, detail?: string): void {
  if (marks.length >= MAX_MARKS) {
    droppedMarks += 1;
    return;
  }
  marks.push({ label, at: now() - t0, detail });
}

/** Add `ms` (and optional work count) to `label`, for callers that already measured. */
export function perfCount(label: string, ms: number, units?: number, unitName?: string): void {
  const b = bucket(label);
  b.count += 1;
  b.total += ms;
  if (ms > b.max) b.max = ms;
  if (units !== undefined) {
    b.units += units;
    b.unitName ??= unitName;
  }
}

/**
 * Time an async operation into `label`, including rejections. `units` derives a
 * work count from the result, so many small calls differ from one big one.
 */
export async function perfTime<T>(
  label: string,
  fn: () => Promise<T>,
  units?: (result: T) => number,
  unitName = "rows",
): Promise<T> {
  const start = now();
  try {
    const result = await fn();
    perfCount(label, now() - start, units?.(result), unitName);
    return result;
  } catch (error) {
    perfCount(label, now() - start);
    throw error;
  }
}

/**
 * Profiling builds only: count a KV write by key family (up to the second `:`,
 * hex collapsed) with its size.
 */
export function perfKvWrite(key: string, value: unknown): void {
  let size = 0;
  try {
    size = typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
  } catch { /* ignore */ }
  perfCount(`kv.set ${kvFamily(key)}`, 0, size, "chars");
}

/** Profiling builds only: count a KV read or list by key family, with what it returned. */
export function perfKvRead(op: "get" | "list", key: string, units: number, unitName: string): void {
  perfCount(`kv.${op} ${kvFamily(key)}`, 0, units, unitName);
}

function kvFamily(key: string): string {
  return key.split(":").slice(0, 2).join(":").replace(/[0-9a-f]{16,}/g, "…");
}

/** The collected profile, for a report or a test. */
export interface PerfReport {
  elapsed: number;
  timeline: { label: string; at: number; detail?: string }[];
  /** Milestones past the timeline's cap, not recorded. */
  droppedMarks: number;
  aggregates: {
    label: string;
    count: number;
    total: number;
    mean: number;
    max: number;
    units?: number;
    unitName?: string;
  }[];
}

/** Snapshot the profile, sorted by total cost descending. */
export function perfReport(): PerfReport {
  return {
    elapsed: now() - t0,
    timeline: marks.map((m) => ({ ...m })),
    droppedMarks,
    aggregates: [...buckets.entries()]
      .map(([label, b]) => ({
        label,
        count: b.count,
        total: b.total,
        mean: b.count > 0 ? b.total / b.count : 0,
        max: b.max,
        ...(b.unitName ? { units: b.units, unitName: b.unitName } : {}),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Drop the aggregates (keeps the boot timeline, which is not repeatable). */
export function perfReset(): void {
  buckets.clear();
}

/**
 * Sample event-loop lag (a 0ms timer every `intervalMs`). Separates slow storage
 * from a busy main thread: large lag makes every storage figure an upper bound.
 * Returns a stop function.
 */
export function startLoopLagSampler(intervalMs = 250): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const scheduled = now();
    setTimeout(() => {
      if (stopped) return;
      perfCount("loop lag", Math.max(0, now() - scheduled - intervalMs));
      tick();
    }, intervalMs);
  };
  tick();
  return () => {
    stopped = true;
  };
}

/** Test seam: drop everything, including the timeline. */
export function __resetPerfForTests(): void {
  buckets.clear();
  marks.length = 0;
  droppedMarks = 0;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Print the profile. Installed on `window` as `__armadaPerf`. */
function printReport(reset = false): PerfReport {
  const report = perfReport();
  console.log(
    `%c[armada perf]%c ${round(report.elapsed)}ms since page load`,
    "color:#c586ff;font-weight:bold",
    "color:inherit",
  );
  console.log("— boot timeline —");
  console.table(
    report.timeline.map((m) => ({ "+ms": round(m.at), milestone: m.label, detail: m.detail ?? "" })),
  );
  console.log("— cost by label (sorted by total) —");
  console.table(
    report.aggregates.map((a) => ({
      label: a.label,
      calls: a.count,
      "total ms": round(a.total),
      "mean ms": round(a.mean),
      "max ms": round(a.max),
      [a.unitName ?? "units"]: a.units ?? "",
    })),
  );
  if (reset) perfReset();
  return report;
}

// Installed by the first importer, so this isn't a side-effect-only module.
if (typeof window !== "undefined") {
  (window as unknown as { __armadaPerf?: (reset?: boolean) => PerfReport }).__armadaPerf = printReport;
}
