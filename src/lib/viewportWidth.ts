/**
 * `window.innerWidth`, cached and refreshed on `resize`. Reading it live brings
 * layout up to date, so a component reading it on every render forces a full
 * layout per render whenever the DOM has changed since: ~0.25 s on a phone.
 */
let width: number | undefined;

export function viewportWidth(): number {
  if (typeof window === "undefined") return 1;
  if (width === undefined) {
    width = window.innerWidth;
    window.addEventListener("resize", () => {
      width = window.innerWidth;
    }, { passive: true });
  }
  return width;
}
