import { cn } from "@/lib/utils";

/**
 * A long operation's status: a line saying what it is doing now, over a bar. With a
 * `total` the bar fills by `done`; without one (a step whose length isn't known, like
 * waiting on a signer) it sweeps, so it never reads as stalled at a percentage.
 */
export function OperationProgress({
  label,
  done,
  total,
  className,
}: {
  label: string;
  done?: number;
  total?: number;
  className?: string;
}) {
  const determinate = total !== undefined && total > 0 && done !== undefined;
  const pct = determinate ? Math.min(100, Math.round((done / total) * 100)) : undefined;
  return (
    <div role="status" aria-live="polite" className={cn("w-full space-y-1.5", className)}>
      <p className="text-center text-xs text-muted-foreground">{label}</p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct !== undefined ? { "aria-valuenow": pct } : {})}
        className="relative h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        {pct !== undefined ? (
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
        ) : (
          <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary motion-safe:animate-progress-sweep" />
        )}
      </div>
    </div>
  );
}
