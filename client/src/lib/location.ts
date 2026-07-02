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

// ─── Navigation geo math (ported from Outpost/yonder compass) ─────────

/** Earth radius in meters. */
const EARTH_RADIUS_M = 6_371_000;

/** Great-circle (haversine) distance between two points, in meters. */
export function haversine(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle initial bearing (forward azimuth) from `from` to `to`, 0..360°. */
export function bearing(from: GeoPoint, to: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dLambda = toRad(to.lon - from.lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Human distance string, e.g. "820 m" / "3.40 km" / "12.1 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}

/** Cardinal direction word (N/NE/E/…) from a bearing in degrees. */
export function cardinalDirection(bearingDeg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}
