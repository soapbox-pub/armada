/**
 * Whether pixels drawn on a canvas read back as drawn. Fingerprint blockers
 * (Firefox `resistFingerprinting`, Tor, LibreWolf, some extensions) hand back
 * noise or a blank from `getImageData`/`toBlob`, so anything re-encoded through
 * a canvas there is garbage. Brave's farbling only nudges low bits, which the
 * tolerance absorbs: its re-encodes are fine.
 */

const PROBE: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [200, 120, 40],
];
const TOLERANCE = 3;

let verdict: boolean | undefined;

type Ctx2D = Pick<CanvasRenderingContext2D, "fillRect" | "getImageData"> & { fillStyle: unknown };

function probeContext(): Ctx2D | null {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = PROBE.length;
    canvas.height = 1;
    return (canvas.getContext?.("2d", { willReadFrequently: true }) as Ctx2D | null) ?? null;
  }
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(PROBE.length, 1).getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  }
  return null;
}

export function canvasReadbackIntact(): boolean {
  if (verdict !== undefined) return verdict;
  let ctx: Ctx2D | null;
  try {
    ctx = probeContext();
  } catch {
    return true;
  }
  // Nothing to probe with (a test double, a headless DOM): assume an honest canvas.
  if (!ctx || typeof ctx.fillRect !== "function" || typeof ctx.getImageData !== "function") return true;
  try {
    PROBE.forEach(([r, g, b], i) => {
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(i, 0, 1, 1);
    });
    const { data } = ctx.getImageData(0, 0, PROBE.length, 1);
    const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
    verdict = PROBE.every(([r, g, b], i) =>
      near(data[i * 4], r) && near(data[i * 4 + 1], g) && near(data[i * 4 + 2], b) && near(data[i * 4 + 3], 255),
    );
  } catch {
    // A blocker that refuses readback outright (SecurityError) refuses `toBlob` too.
    verdict = false;
  }
  return verdict;
}

/** Tests only. */
export function resetCanvasProbe(): void {
  verdict = undefined;
}
