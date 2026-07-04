import { useCallback, useEffect, useRef, useState } from "react";

const SMOOTHING_ALPHA = 0.3;

/**
 * Minimum smoothed-heading change (degrees) before publishing a new value to
 * React. Orientation sensors fire at up to ~60Hz with sub-degree jitter;
 * without a deadband every event re-renders the whole compass screen.
 */
const PUBLISH_DEADBAND_DEG = 0.5;

/** Shortest-path circular low-pass filter for a noisy heading signal. */
function smoothHeading(prev: number, next: number): number {
  let delta = next - prev;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return (prev + SMOOTHING_ALPHA * delta + 360) % 360;
}

/** Shortest-path absolute angular difference between two headings, 0..180. */
function circularDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

interface DeviceOrientationEventWithHeading extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

/**
 * Device compass heading (0..360°, 0 = north) from the magnetometer /
 * orientation sensor, low-pass smoothed. Returns `null` until a reading arrives
 * or when the sensor is unavailable (e.g. desktop). `requestPermission` triggers
 * the iOS `DeviceOrientationEvent.requestPermission()` prompt (a no-op where the
 * API doesn't require it). Ported from yonder/Outpost.
 *
 * Only *absolute* (north-referenced) readings are used: iOS's
 * `webkitCompassHeading`, `deviceorientationabsolute` events, or
 * `deviceorientation` events flagged `absolute: true`. A relative
 * `deviceorientation` alpha has an arbitrary zero (whatever direction the
 * device faced at sensor start) — treating it as a heading makes the dial
 * wander between true north and a random offset, which is worse than the
 * null → north-up fallback.
 */
export function useHeading(): { heading: number | null; requestPermission: () => void } {
  const [heading, setHeading] = useState<number | null>(null);
  const smoothed = useRef<number | null>(null);
  const published = useRef<number | null>(null);

  useEffect(() => {
    function onOrientation(e: DeviceOrientationEvent) {
      const ev = e as DeviceOrientationEventWithHeading;
      let raw: number | null = null;
      if (typeof ev.webkitCompassHeading === "number" && !Number.isNaN(ev.webkitCompassHeading)) {
        raw = ev.webkitCompassHeading; // iOS: already a true heading
      } else if (
        typeof ev.alpha === "number" &&
        (e.type === "deviceorientationabsolute" || e.absolute === true)
      ) {
        raw = (360 - ev.alpha) % 360; // absolute alpha is counter-clockwise from north
      }
      if (raw == null || Number.isNaN(raw)) return;

      smoothed.current = smoothed.current == null ? raw : smoothHeading(smoothed.current, raw);

      // Deadband: skip the React update for sub-degree jitter.
      if (
        published.current != null &&
        circularDelta(published.current, smoothed.current) < PUBLISH_DEADBAND_DEG
      ) {
        return;
      }
      published.current = smoothed.current;
      setHeading(smoothed.current);
    }

    window.addEventListener("deviceorientationabsolute", onOrientation as EventListener);
    window.addEventListener("deviceorientation", onOrientation as EventListener);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation as EventListener);
      window.removeEventListener("deviceorientation", onOrientation as EventListener);
    };
  }, []);

  const requestPermission = useCallback(() => {
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof DOE?.requestPermission === "function") {
      void DOE.requestPermission().catch(() => {});
    }
  }, []);

  return { heading, requestPermission };
}
