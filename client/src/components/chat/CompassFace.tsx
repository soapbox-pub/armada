/**
 * A compass dial: concentric rings, N/S/E/W cardinals, 15° tick marks (major
 * every 45°), and numeric degree labels every 30°. Pure SVG, themed via
 * Armada's CSS variables (`--primary`, `--foreground`). Ported from yonder's
 * `CompassFace` (itself from Outpost's `GeohashCompassScreen`).
 *
 * When `heading` (device compass, 0..360°, 0 = north) is provided, the whole
 * dial counter-rotates by `-heading` so the N label always points at true north
 * in the room — i.e. it behaves like a real compass. When `heading` is null
 * (no magnetometer / desktop), the dial stays north-up (N at top of screen) as
 * a static reference. The caller overlays the rotating target arrow on top in
 * the same frame.
 */
export function CompassFace({ className, heading }: { className?: string; heading?: number | null }) {
  const size = 200;
  const c = size / 2;
  const r = size / 2;

  const ticks: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
  for (let deg = 0; deg < 360; deg += 15) {
    if (deg % 90 === 0) continue; // cardinals drawn as letters
    const major = deg % 45 === 0;
    const rad = ((deg - 90) * Math.PI) / 180;
    const inner = r * (major ? 0.8 : 0.84);
    const outer = r * 0.92;
    ticks.push({
      x1: c + Math.cos(rad) * inner,
      y1: c + Math.sin(rad) * inner,
      x2: c + Math.cos(rad) * outer,
      y2: c + Math.sin(rad) * outer,
      major,
    });
  }

  const labels: { x: number; y: number; text: string }[] = [];
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = ((deg - 90) * Math.PI) / 180;
    const lr = r * 0.64;
    labels.push({ x: c + Math.cos(rad) * lr, y: c + Math.sin(rad) * lr, text: String(deg) });
  }

  // Counter-rotate the dial so N tracks true north when we have a heading;
  // otherwise leave it north-up. The two outermost rings stay fixed (they're
  // just a bezel and don't carry direction), only the marked ring rotates.
  const rot = typeof heading === "number" ? -heading : 0;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} fill="none" aria-hidden="true">
      {/* Fixed bezel rings */}
      <circle cx={c} cy={c} r={r * 0.97} stroke="hsl(var(--primary) / 0.38)" strokeWidth={1.5} />
      <circle cx={c} cy={c} r={r * 0.92} stroke="hsl(var(--primary) / 0.12)" strokeWidth={1} />

      {/* Rotating marked dial (ticks, degree labels, cardinals) */}
      <g
        transform={`rotate(${rot} ${c} ${c})`}
        style={{ transition: "transform 300ms ease-out" }}
      >
        <circle cx={c} cy={c} r={r * 0.7} stroke="hsl(var(--foreground) / 0.1)" strokeWidth={1} />
        <circle cx={c} cy={c} r={r * 0.46} stroke="hsl(var(--foreground) / 0.07)" strokeWidth={1} />

        {/* Degree ticks */}
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={t.major ? "hsl(var(--primary) / 0.55)" : "hsl(var(--foreground) / 0.16)"}
            strokeWidth={t.major ? 1.6 : 1}
          />
        ))}

        {/* Numeric degree labels — counter-rotated so text stays upright */}
        {labels.map((l) => (
          <text
            key={l.text}
            x={l.x}
            y={l.y}
            transform={`rotate(${-rot} ${l.x} ${l.y})`}
            dominantBaseline="central"
            textAnchor="middle"
            className="font-mono"
            fontSize={8}
            fontWeight={700}
            fill="hsl(var(--foreground) / 0.46)"
          >
            {l.text}
          </text>
        ))}

        {/* Cardinal letters — N accented, the rest muted. Counter-rotated so
            they stay upright while sitting at their true compass positions. */}
        <text x={c} y={r * 0.13} transform={`rotate(${-rot} ${c} ${r * 0.13})`} textAnchor="middle" dominantBaseline="central" className="font-mono" fontSize={16} fontWeight={900} fill="hsl(var(--primary))">N</text>
        <text x={c} y={size - r * 0.13} transform={`rotate(${-rot} ${c} ${size - r * 0.13})`} textAnchor="middle" dominantBaseline="central" className="font-mono" fontSize={14} fontWeight={900} fill="hsl(var(--foreground) / 0.58)">S</text>
        <text x={r * 0.13} y={c} transform={`rotate(${-rot} ${r * 0.13} ${c})`} textAnchor="middle" dominantBaseline="central" className="font-mono" fontSize={14} fontWeight={900} fill="hsl(var(--foreground) / 0.58)">W</text>
        <text x={size - r * 0.13} y={c} transform={`rotate(${-rot} ${size - r * 0.13} ${c})`} textAnchor="middle" dominantBaseline="central" className="font-mono" fontSize={14} fontWeight={900} fill="hsl(var(--foreground) / 0.58)">E</text>
      </g>
    </svg>
  );
}
