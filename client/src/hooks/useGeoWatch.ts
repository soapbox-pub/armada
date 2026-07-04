import { useEffect, useRef, useState } from "react";

import type { GeoPoint } from "@/lib/location";

/**
 * Live device position via `navigator.geolocation.watchPosition`. Returns the
 * latest {@link GeoPoint} (or null before the first fix) plus its accuracy in
 * meters and any error. Used by the compass navigation screen, which needs a
 * continuously-updating position (not the one-shot `getCurrentLocation`).
 *
 * Primes with a fast low-accuracy fix, then keeps a high-accuracy watch running
 * while `enabled`. Cleans up the watch on unmount / disable.
 */
export function useGeoWatch(enabled: boolean): {
  position: GeoPoint | null;
  accuracy: number | null;
  error: string | null;
} {
  const [position, setPosition] = useState<GeoPoint | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bestAccuracy = useRef<number>(Infinity);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Location isn't available on this device.");
      return;
    }

    bestAccuracy.current = Infinity;

    const accept = (pos: GeolocationPosition) => {
      const acc = pos.coords.accuracy;
      // Accuracy gate: reject fixes much worse than the best seen recently, so
      // a stray low-accuracy reading doesn't yank the arrow around. Each
      // rejection *relaxes* the gate, so a genuine, persistent accuracy drop
      // (e.g. walking indoors) is accepted after a few readings instead of
      // freezing the position on a stale fix forever.
      if (Number.isFinite(acc)) {
        if (bestAccuracy.current !== Infinity && acc > bestAccuracy.current * 2) {
          bestAccuracy.current *= 1.5;
          return;
        }
        bestAccuracy.current = Math.min(bestAccuracy.current, acc);
        setAccuracy(acc);
      }
      setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: acc });
      setError(null);
    };

    const onError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setError("Location permission was denied. Enable it to navigate.");
      }
    };

    // Fast prime.
    navigator.geolocation.getCurrentPosition(accept, onError, {
      enableHighAccuracy: false,
      timeout: 8_000,
      maximumAge: 60_000,
    });

    // High-accuracy watch.
    const watchId = navigator.geolocation.watchPosition(accept, onError, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 1_000,
    });

    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled]);

  return { position, accuracy, error };
}
