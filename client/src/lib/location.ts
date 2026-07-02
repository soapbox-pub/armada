import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Shared location-message format for the chat surfaces.
 *
 * A "Send location" message is a normal chat message whose *content* carries a
 * compact, self-describing geo string behind a zero-width marker — exactly the
 * pattern `/me` uses (`ME_ACTION_PREFIX`). Encoding the point in the content
 * (rather than in tags) is deliberate: it must survive every transport
 * uniformly, including the Bluetooth mesh (which carries only plain-text
 * `content`, no Nostr tags) and Concord's end-to-end-encrypted body. A client
 * that doesn't understand the marker still shows a readable
 * `geo:lat,lon` string.
 *
 * Content shape: `"\u200b/location <lat>,<lon>[;u=<accuracy>]"`.
 */

/** Zero-width marker prefix identifying a location message. */
export const LOCATION_PREFIX = "\u200b/location ";

/** A shared geographic point. */
export interface GeoPoint {
  lat: number;
  lon: number;
  /** Horizontal accuracy in meters, if known. */
  accuracy?: number;
}

/** Round a coordinate to ~1cm precision (7 decimals) to keep the body compact. */
function roundCoord(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

/** Build the chat-message content string for a shared location. */
export function encodeLocationContent(point: GeoPoint): string {
  const lat = roundCoord(point.lat);
  const lon = roundCoord(point.lon);
  const acc =
    point.accuracy != null && Number.isFinite(point.accuracy)
      ? `;u=${Math.round(point.accuracy)}`
      : "";
  return `${LOCATION_PREFIX}${lat},${lon}${acc}`;
}

/** True if a message body is a shared-location message. */
export function isLocationMessage(event: NostrEvent): boolean {
  return event.content.startsWith(LOCATION_PREFIX);
}

/**
 * Parse the {@link GeoPoint} out of a location-message body. Returns undefined
 * if the body isn't a location message or the coordinates don't parse / are out
 * of range.
 */
export function parseLocationContent(content: string): GeoPoint | undefined {
  if (!content.startsWith(LOCATION_PREFIX)) return undefined;
  const rest = content.slice(LOCATION_PREFIX.length).trim();
  const [coords, ...params] = rest.split(";");
  const [latStr, lonStr] = coords.split(",");
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;

  let accuracy: number | undefined;
  for (const p of params) {
    const [k, v] = p.split("=");
    if (k === "u") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) accuracy = n;
    }
  }
  return { lat, lon, accuracy };
}

/** Convenience: parse a {@link GeoPoint} directly from an event. */
export function parseLocationEvent(event: NostrEvent): GeoPoint | undefined {
  return parseLocationContent(event.content);
}

/** Human-readable coordinate label, e.g. "37.7749, -122.4194". */
export function formatCoords(point: GeoPoint): string {
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}
