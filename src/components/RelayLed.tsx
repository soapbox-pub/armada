import { useBlossomReachable } from "@/hooks/useBlossomReachable";
import { useRelayReachable, type Reachability } from "@/hooks/useRelayReachable";
import { useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** An answer slower than this turns the light amber. */
export const SLOW_MS = 1000;

type LedState = "checking" | "up" | "slow" | "down";

function ledState({ alive, ms }: Reachability): LedState {
  if (alive === undefined) return "checking";
  if (!alive) return "down";
  return ms !== undefined && ms >= SLOW_MS ? "slow" : "up";
}

export function RelayLed({ url, phase, className }: { url: string; phase?: number; className?: string }) {
  return <StatusLed {...useRelayReachable(url)} phase={phase} noun="relay" className={className} />;
}

export function BlossomLed({ url, className }: { url: string; className?: string }) {
  return <StatusLed {...useBlossomReachable(url)} noun="server" className={className} />;
}

/** The last measured response time, e.g. "142 ms"; nothing until there is one. */
export function RelayPing({ url, className }: { url: string; className?: string }) {
  return <Ping {...useRelayReachable(url)} className={className} />;
}

export function BlossomPing({ url, className }: { url: string; className?: string }) {
  return <Ping {...useBlossomReachable(url)} className={className} />;
}

function Ping({ alive, ms, className }: Reachability & { className?: string }) {
  const intl = useIntl();
  if (!alive || ms === undefined) return null;
  return (
    <span className={cn("shrink-0 tabular-nums", ms >= SLOW_MS && "text-amber-400", className)}>
      {intl.formatNumber(ms, { style: "unit", unit: "millisecond", unitDisplay: "short" })}
    </span>
  );
}

const LED_CLASS: Record<LedState, string> = {
  checking: "animate-pulse bg-muted-foreground/40 ring-transparent",
  up: "animate-[armada-led-up_2s_steps(1,end)_infinite] bg-emerald-400 text-emerald-400/60 ring-emerald-400/20 shadow-[0_0_5px_1px_currentColor]",
  slow: "animate-[armada-led-up_2s_steps(1,end)_infinite] bg-amber-400 text-amber-400/60 ring-amber-400/20 shadow-[0_0_5px_1px_currentColor]",
  down: "animate-[armada-led-fault_1.9s_steps(1,end)_infinite] bg-red-400 text-red-400/50 ring-red-400/15 shadow-[0_0_4px_0_currentColor]",
};

/** Blink period for a live light: the quicker the answer, the quicker the beat (0.8 s to 4 s). */
export function blinkSeconds(ms: number | undefined): number {
  if (ms === undefined) return 2;
  return Math.min(4, Math.max(0.8, 0.8 + ms / 625));
}

/**
 * Status light (keyframes in index.css): grey while checking, green when up, amber when slow,
 * red when down. A live light blinks at a rate set by its response time, and by nothing else.
 */
export function StatusLed({ alive, ms, phase, noun, decorative, className }: Reachability & {
  /** Offsets the blink (not its rate), for a decorative list that shouldn't flash in step. */
  phase?: number;
  noun: "relay" | "server";
  /** Hidden from assistive tech, for a legend whose text already says what it is. */
  decorative?: boolean;
  className?: string;
}) {
  const intl = useIntl();
  const state = ledState({ alive, ms });
  const status = intl.formatMessage(
    {
      id: "relayLed.status",
      defaultMessage:
        "{state, select, checking {Checking {noun, select, relay {relay} other {server}}} up {{noun, select, relay {Relay} other {Server}} reachable} slow {{noun, select, relay {Relay} other {Server}} slow to answer} other {{noun, select, relay {Relay} other {Server}} unreachable}}",
    },
    { state, noun },
  );
  const label = alive && ms !== undefined
    ? intl.formatMessage(
      { id: "relayLed.statusLatency", defaultMessage: "{status} ({latency})" },
      { status, latency: intl.formatNumber(ms, { style: "unit", unit: "millisecond", unitDisplay: "short" }) },
    )
    : status;

  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label })}
      style={{
        ...(alive && { animationDuration: `${blinkSeconds(ms).toFixed(2)}s` }),
        ...(phase !== undefined && state !== "checking" && { animationDelay: `${phase * 0.29}s` }),
      }}
      className={cn("size-1.5 shrink-0 rounded-full ring-2 motion-reduce:animate-none", LED_CLASS[state], className)}
    />
  );
}
