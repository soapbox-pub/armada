/**
 * Polyhedral dice for the `/roll` renderer: unit-radius, origin-centred, each
 * face a planar convex polygon with an outward normal and the number it shows.
 */

export type V3 = [number, number, number];

export interface DieFace {
  vertices: number[];
  normal: V3;
  label: number;
}

export interface Polyhedron {
  vertices: V3[];
  faces: DieFace[];
}

export const POLYHEDRAL_SIDES = [4, 6, 8, 10, 12, 20] as const;

const PHI = (1 + Math.sqrt(5)) / 2;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

function build(raw: V3[], polygons: number[][], labels: number[]): Polyhedron {
  const r = Math.max(...raw.map((v) => Math.hypot(v[0], v[1], v[2])));
  const vertices = raw.map(([x, y, z]): V3 => [x / r, y / r, z / r]);
  const faces = polygons.map((indices, i) => {
    const [a, b, c] = indices.map((j) => vertices[j]);
    const n = norm(cross(sub(b, a), sub(c, a)));
    const centroid = indices.reduce<V3>((s, j) => [s[0] + vertices[j][0], s[1] + vertices[j][1], s[2] + vertices[j][2]], [0, 0, 0]);
    // Convex and origin-centred, so outward means away from the centre.
    const normal: V3 = dot(n, centroid) < 0 ? [-n[0], -n[1], -n[2]] : n;
    return { vertices: indices, normal, label: labels[i] };
  });
  return { vertices, faces };
}

function d4(): Polyhedron {
  return build(
    [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
    [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]],
    [1, 2, 3, 4],
  );
}

function d6(): Polyhedron {
  return build(
    [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[4, 5, 6, 7], [1, 0, 3, 2], [0, 4, 7, 3], [5, 1, 2, 6], [0, 1, 5, 4], [7, 6, 2, 3]],
    // Opposite faces sum to 7.
    [1, 6, 2, 5, 3, 4],
  );
}

function d8(): Polyhedron {
  return build(
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    [[4, 0, 2], [4, 2, 1], [4, 1, 3], [4, 3, 0], [5, 1, 3], [5, 0, 3], [5, 0, 2], [5, 2, 1]],
    // Opposite faces sum to 9.
    [1, 2, 3, 4, 8, 7, 6, 5],
  );
}

/** Pentagonal trapezohedron: ten kites, like a real d10. */
function d10(): Polyhedron {
  const apex = 1.2;
  const c = Math.cos(Math.PI / 5);
  // The ring height that makes each kite planar.
  const ring = (apex * (1 - c)) / (1 + c);
  const v: V3[] = [[0, apex, 0], [0, -apex, 0]];
  for (let i = 0; i < 5; i++) {
    const up = (2 * Math.PI * i) / 5;
    const down = up + Math.PI / 5;
    v.push([Math.cos(up), ring, Math.sin(up)]);
    v.push([Math.cos(down), -ring, Math.sin(down)]);
  }
  const upper = (i: number) => 2 + 2 * (i % 5);
  const lower = (i: number) => 3 + 2 * (i % 5);
  const polys: number[][] = [];
  const labels: number[] = [];
  for (let i = 0; i < 5; i++) {
    polys.push([0, upper(i), lower(i), upper(i + 1)]);
    labels.push(2 * i + 1);
    polys.push([1, lower(i), upper(i + 1), lower(i + 1)]);
    labels.push(2 * i + 2);
  }
  return build(v, polys, labels);
}

function d12(): Polyhedron {
  const b = 1 / PHI;
  return build(
    [
      [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
      [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
      [0, PHI, b], [0, PHI, -b], [0, -PHI, b], [0, -PHI, -b],
      [b, 0, PHI], [-b, 0, PHI], [b, 0, -PHI], [-b, 0, -PHI],
      [PHI, b, 0], [PHI, -b, 0], [-PHI, b, 0], [-PHI, -b, 0],
    ],
    [
      [0, 12, 2, 17, 16], [0, 16, 1, 9, 8], [0, 8, 4, 13, 12],
      [3, 17, 2, 10, 11], [1, 16, 17, 3, 14], [1, 14, 15, 5, 9],
      [4, 8, 9, 5, 18], [4, 18, 19, 6, 13], [2, 12, 13, 6, 10],
      [7, 15, 14, 3, 11], [7, 11, 10, 6, 19], [7, 19, 18, 5, 15],
    ],
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
}

function d20(): Polyhedron {
  return build(
    [
      [0, 1, PHI], [0, 1, -PHI], [0, -1, PHI], [0, -1, -PHI],
      [1, PHI, 0], [1, -PHI, 0], [-1, PHI, 0], [-1, -PHI, 0],
      [PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, 1], [-PHI, 0, -1],
    ],
    [
      [0, 2, 8], [0, 8, 4], [0, 4, 6], [0, 6, 10], [0, 10, 2],
      [2, 5, 8], [8, 5, 9], [8, 9, 4], [4, 9, 1], [4, 1, 6],
      [6, 1, 11], [6, 11, 10], [10, 11, 7], [10, 7, 2], [2, 7, 5],
      [3, 9, 5], [3, 1, 9], [3, 11, 1], [3, 7, 11], [3, 5, 7],
    ],
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
}

const MAKERS: Record<number, () => Polyhedron> = { 4: d4, 6: d6, 8: d8, 10: d10, 12: d12, 20: d20 };
const CACHE = new Map<number, Polyhedron>();

/** The solid for a die with `sides` faces, or undefined when there is none. */
export function getPolyhedron(sides: number): Polyhedron | undefined {
  const make = MAKERS[sides];
  if (!make) return undefined;
  let poly = CACHE.get(sides);
  if (!poly) CACHE.set(sides, (poly = make()));
  return poly;
}
