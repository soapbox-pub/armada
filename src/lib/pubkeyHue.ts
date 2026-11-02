/** A hue in [0, 360) from a hex pubkey's leading bytes; undefined for anything else. */
export function pubkeyHue(pubkey: string | undefined): number | undefined {
  if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return undefined;
  return parseInt(pubkey.slice(0, 4), 16) % 360;
}

/** The foreground color for {@link pubkeyHue}: a nameless person's avatar figure. */
export function pubkeyHueColor(hue: number): string {
  return `hsl(${hue} 70% 60%)`;
}

/**
 * The `#tag`'s color: the same hue, desaturated and translucent, so it reads as
 * secondary to whatever color the name itself is drawn in.
 */
export function pubkeyHueTagColor(hue: number): string {
  return `hsl(${hue} 35% 60% / 0.7)`;
}

/** The `#1a2b` that tells two nameless people apart: the pubkey's last four hex digits. */
export function anonymousTag(pubkey: string): string {
  return `#${pubkey.slice(-4).toLowerCase()}`;
}
