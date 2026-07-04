import type { GeoPoint } from "@/lib/location";

/**
 * Reverse-geocode a point to a short human place name for a default region
 * label ("San Francisco, California"). Uses OpenStreetMap Nominatim, mirroring
 * the reference in bitchat-android: a single best-effort request with a proper
 * User-Agent. Returns null on any failure (offline, rate-limited, no match) —
 * the caller falls back to coordinates, so a name is a nicety, never required.
 *
 * Nominatim asks for ≤1 request/sec and a descriptive UA; this fires only once
 * per download, so we're well within bounds.
 */
export async function reverseGeocodeName(
  point: GeoPoint,
  signal?: AbortSignal,
): Promise<string | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${point.lat}&lon=${point.lon}&zoom=12&addressdetails=1`;
  try {
    const res = await fetch(url, {
      signal,
      headers: { Accept: "application/json", "User-Agent": "Armada/1.0 (offline maps)" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      address?: {
        city?: string;
        town?: string;
        village?: string;
        hamlet?: string;
        suburb?: string;
        county?: string;
        state?: string;
        country?: string;
      };
      name?: string;
    };
    const a = body.address;
    if (!a) return body.name || null;
    const locality = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.county;
    const region = a.state ?? a.country;
    if (locality && region && locality !== region) return `${locality}, ${region}`;
    return locality ?? region ?? body.name ?? null;
  } catch {
    return null;
  }
}
