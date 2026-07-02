import type { GeoPoint } from "@/lib/location";

/**
 * One-shot device geolocation for the "Send location" feature.
 *
 * Uses the standard `navigator.geolocation` API, which Capacitor's WebView
 * bridges to native Core Location / FusedLocationProvider (with the app's
 * location permission), so this works on web, Android and iOS without a
 * dedicated plugin. Returns a plain {@link GeoPoint}.
 */

export type GeolocationErrorKind = "unsupported" | "denied" | "unavailable" | "timeout";

export class GeolocationError extends Error {
  kind: GeolocationErrorKind;
  constructor(kind: GeolocationErrorKind, message: string) {
    super(message);
    this.name = "GeolocationError";
    this.kind = kind;
  }
}

/** A user-facing message for each failure mode. */
export function geolocationErrorMessage(kind: GeolocationErrorKind): string {
  switch (kind) {
    case "unsupported":
      return "Location isn't available on this device.";
    case "denied":
      return "Location permission was denied. Enable it in settings to share your location.";
    case "timeout":
      return "Couldn't get a location fix in time. Try again with a clear view of the sky.";
    case "unavailable":
    default:
      return "Couldn't determine your location. Try again.";
  }
}

/**
 * Acquire the device's current position once. Resolves to a {@link GeoPoint}
 * or rejects with a {@link GeolocationError}.
 */
export function getCurrentLocation(
  options: PositionOptions = { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new GeolocationError("unsupported", "Geolocation is not supported."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
        });
      },
      (err) => {
        const kind: GeolocationErrorKind =
          err.code === err.PERMISSION_DENIED
            ? "denied"
            : err.code === err.TIMEOUT
              ? "timeout"
              : "unavailable";
        reject(new GeolocationError(kind, err.message || geolocationErrorMessage(kind)));
      },
      options,
    );
  });
}
