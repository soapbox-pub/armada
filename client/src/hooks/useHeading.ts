import { useEffect, useRef, useState } from "react";

const SMOOTHING_ALPHA = 0.3;

/** Shortest-path circular low-pass filter for a noisy heading signal. */
function smoothHeading(prev: number, next: number): number {
  let delta = next - prev;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return (prev + SMOOTHING_ALPHA * delta + 360) % 360;
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
 */
export function useHeading(): { heading: number | null; requestPermission: () => void } {
  const [heading, setHeading] = useState<number | null>(null);
  const smoothed = useRef<number | null>(null);

  useEffect(() => {
    function onOrientation(e: DeviceOrientationEvent) {
      const ev = e as DeviceOrientationEventWithHeading;
      let raw: number | null = null;
      if (typeof ev.webkitCompassHeading === "number") {
        raw = ev.webkitCompassHeading; // iOS: already true heading
      } else if (typeof ev.alpha === "number") {
        raw = (360 - ev.alpha) % 360; // others: alpha is counter-clockwise
      }
      if (raw == null || Number.isNaN(raw)) return;

      smoothed.current = smoothed.current == null ? raw : smoothHeading(smoothed.current, raw);
      setHeading(smoothed.current);
    }

    window.addEventListener("deviceorientationabsolute", onOrientation as EventListener);
    window.addEventListener("deviceorientation", onOrientation as EventListener);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation as EventListener);
      window.removeEventListener("deviceorientation", onOrientation as EventListener);
    };
  }, []);

  const requestPermission = () => {
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof DOE?.requestPermission === "function") {
      void DOE.requestPermission().catch(() => {});
    }
  };

  return { heading, requestPermission };
}
