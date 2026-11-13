/** Synthesized (Web Audio) UI sounds for voice calls; no assets to ship. */

import { Capacitor } from "@capacitor/core";

let ctx: AudioContext | null = null;

/**
 * Android WebView contexts with the same output settings share one platform
 * stream whose usage is fixed when it opens. An interactive ring opened before
 * the call's mic would pin the call's audio to USAGE_MEDIA (callMicHold.ts), so
 * UI sounds take the high-latency stream instead and the call opens its own.
 */
const LATENCY_HINT: AudioContextLatencyCategory | undefined =
  Capacitor.getPlatform() === "android" ? "playback" : undefined;

function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx(LATENCY_HINT ? { latencyHint: LATENCY_HINT } : undefined);
    }
    // Browsers may suspend the context until a user gesture; resume best-effort.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Play a short note sequence, each a softly enveloped sine. Returns the oscillators. */
function playNotes(
  notes: { freq: number; start: number; dur: number }[],
  gainPeak: number,
): OscillatorNode[] {
  const ac = audioContext();
  if (!ac) return [];
  const oscs: OscillatorNode[] = [];
  const now = ac.currentTime;
  for (const { freq, start, dur } of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t0 = now + start;
    // Quick attack and ramp down to avoid clicks.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    oscs.push(osc);
  }
  return oscs;
}

/** Rising chirp: someone joined. (C6 → E6) */
export function playJoinSound(): void {
  playNotes(
    [
      { freq: 1046.5, start: 0, dur: 0.12 },
      { freq: 1318.5, start: 0.1, dur: 0.16 },
    ],
    0.12,
  );
}

/** Falling chirp: someone left. (E6 → C6) */
export function playLeaveSound(): void {
  playNotes(
    [
      { freq: 1318.5, start: 0, dur: 0.12 },
      { freq: 987.77, start: 0.1, dur: 0.18 },
    ],
    0.1,
  );
}

/** Self-only mute/unmute blips, lower and shorter than join/leave so they read as a personal toggle. */

/** Muted yourself: a low, soft downward blip. (A4 → F4) */
export function playMuteSound(): void {
  playNotes(
    [
      { freq: 440, start: 0, dur: 0.07 },
      { freq: 349.23, start: 0.06, dur: 0.1 },
    ],
    0.09,
  );
}

/** Unmuted yourself: a low, soft upward blip. (F4 → A4) */
export function playUnmuteSound(): void {
  playNotes(
    [
      { freq: 349.23, start: 0, dur: 0.07 },
      { freq: 440, start: 0.06, dur: 0.1 },
    ],
    0.09,
  );
}

/** Looping call tones: incoming ring every 2s, outgoing ringback every 3s. Singleton loops. */

let ringTimer: ReturnType<typeof setInterval> | null = null;
let ringbackTimer: ReturnType<typeof setInterval> | null = null;

/** The ring phrase still sounding, so a stop cuts it rather than letting it finish. */
let ringNotes: OscillatorNode[] = [];

function ringPhrase(): void {
  ringNotes = playNotes(
    [
      { freq: 1046.5, start: 0, dur: 0.15 },
      { freq: 1318.5, start: 0.16, dur: 0.15 },
      { freq: 1046.5, start: 0.32, dur: 0.15 },
      { freq: 1318.5, start: 0.48, dur: 0.22 },
    ],
    0.14,
  );
}

/** Start the incoming-call ring loop (no-op if already ringing). */
export function startIncomingRing(): void {
  if (ringTimer !== null) return;
  ringPhrase();
  ringTimer = setInterval(ringPhrase, 2000);
}

export function stopIncomingRing(): void {
  if (ringTimer !== null) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  for (const osc of ringNotes) {
    try {
      osc.stop();
    } catch { /* ignore */ }
  }
  ringNotes = [];
}

function ringbackBurst(): void {
  // Two simultaneous soft tones (~North American ringback: 440+480 Hz), 1.4s.
  playNotes(
    [
      { freq: 440, start: 0, dur: 1.4 },
      { freq: 480, start: 0, dur: 1.4 },
    ],
    0.05,
  );
}

/** Start the outgoing ringback loop (no-op if already playing). */
export function startRingback(): void {
  if (ringbackTimer !== null) return;
  ringbackBurst();
  ringbackTimer = setInterval(ringbackBurst, 3000);
}

export function stopRingback(): void {
  if (ringbackTimer !== null) {
    clearInterval(ringbackTimer);
    ringbackTimer = null;
  }
}

/** Screenshare started: rising three-note arpeggio (C6 → E6 → G6). */
export function playScreenShareSound(): void {
  playNotes(
    [
      { freq: 1046.5, start: 0, dur: 0.1 },
      { freq: 1318.5, start: 0.09, dur: 0.1 },
      { freq: 1568, start: 0.18, dur: 0.18 },
    ],
    0.11,
  );
}

/** Screenshare ended: falling three-note arpeggio (G6 → E6 → C6), the reverse of the start chirp. */
export function playScreenShareEndSound(): void {
  playNotes(
    [
      { freq: 1568, start: 0, dur: 0.1 },
      { freq: 1318.5, start: 0.09, dur: 0.1 },
      { freq: 1046.5, start: 0.18, dur: 0.18 },
    ],
    0.11,
  );
}
