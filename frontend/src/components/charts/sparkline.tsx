import { cn } from "@/lib/utils";

const LINE = "#64748b"; // slate-500: the series ink stays neutral, the last dot carries the state

/**
 * Tiny score trend for a table row: a 2px polyline over up to ~6 values (oldest first) with the
 * last point as a dot in `lastColor`. Decorative (aria-hidden): the caller must render the same
 * information as text (the delta chip and an sr-only sentence). The y range is the series' own
 * span padded to at least `minSpan` points, so a 5-point move is visible without exaggerating a
 * 1-point wobble.
 */
export function Sparkline({
  values,
  lastColor = LINE,
  width = 72,
  height = 24,
  minSpan = 20,
  className,
}: {
  values: number[];
  lastColor?: string;
  width?: number;
  height?: number;
  minSpan?: number;
  className?: string;
}) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length === 0) return null;
  const pad = 4; // room for the dot and its ring
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const x = (i: number) => (pts.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (pts.length - 1));
  const y = (v: number) => pad + ((hi - v) / (hi - lo)) * (height - 2 * pad);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = pts.length - 1;
  return (
    <svg
      aria-hidden
      focusable="false"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible [print-color-adjust:exact]", className)}
    >
      {pts.length > 1 ? (
        <path d={d} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      <circle cx={x(last)} cy={y(pts[last])} r={3.5} fill={lastColor} stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
}

/** Thin share bar (value / max) with a rounded data end; decorative, pair it with the number. */
export function ShareBar({
  value,
  max,
  color = "#d03b3b",
  className,
}: {
  value: number;
  max: number;
  color?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <span aria-hidden className={cn("relative block h-1.5 overflow-hidden rounded-sm bg-slate-100", className)}>
      <span
        className="absolute inset-y-0 left-0 rounded-r-[3px] [print-color-adjust:exact]"
        style={{ width: `${pct}%`, background: color }}
      />
    </span>
  );
}
