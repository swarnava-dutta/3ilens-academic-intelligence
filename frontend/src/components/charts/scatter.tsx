"use client";

import {
  AXIS,
  axisWidth,
  type Domain,
  Empty,
  fmt,
  HGrid,
  INK,
  MUTED,
  Plot,
  scale,
  Text,
  textWidth,
  tickCount,
  tipBody,
  toneColor,
  useChart,
  VGrid,
  wrap,
  type Tone,
} from "./core";

type Point = { id: string; label: string; x: number; y: number; size?: number; tone?: Tone };

/** Points to name on the chart: the biggest bubbles, or the highest points when there are no sizes. */
const LABELLED = 3;

export function Scatter({
  points,
  xLabel,
  yLabel,
  xDomain,
  yDomain,
  quadrants,
}: {
  points: Point[];
  xLabel: string;
  yLabel: string;
  xDomain: Domain;
  yDomain: Domain;
  quadrants?: { x: number; y: number; labels: [string, string, string, string] };
}) {
  const c = useChart();
  if (!points.length) return <Empty />;

  const h = Math.round(Math.min(400, Math.max(260, c.w * 0.6)));
  const top = 24;
  const base = h - 38;
  const n = tickCount(c.w);
  const left = axisWidth(yDomain, "", 5);
  const right = c.w - 12;
  const x = scale(xDomain, [left, right]);
  const y = scale(yDomain, [base, top]);
  const maxSize = Math.max(0, ...points.map((p) => p.size ?? 0));
  const r = (p: Point) => (maxSize > 0 && p.size !== undefined ? Math.max(5, 16 * Math.sqrt(p.size / maxSize)) : 6);
  const rank = (p: Point) => (maxSize > 0 ? (p.size ?? 0) : p.y);
  const drawn = [...points].sort((a, b) => r(b) - r(a));

  // Greedy direct labels: skip any that would collide with one already placed.
  const boxes: [number, number, number, number][] = [];
  const labels = [...points]
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, LABELLED)
    .flatMap((p) => {
      const cx = x(p.x);
      // Long names (chapter titles) are cut so more of them fit; the tooltip has the full name.
      const text = wrap(p.label, 160, 1)[0];
      const w = textWidth(text);
      const flip = cx + r(p) + 4 + w > right;
      const lx = flip ? cx - r(p) - 4 - w : cx + r(p) + 4;
      const box: [number, number, number, number] = [lx, y(p.y) - 7, lx + w, y(p.y) + 7];
      if (lx < 0 || boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return [];
      boxes.push(box);
      return [{ p, text, x: flip ? cx - r(p) - 4 : cx + r(p) + 4, anchor: flip ? ("end" as const) : ("start" as const) }];
    });

  let summary = `Scatter of ${points.length} points, ${yLabel} against ${xLabel}.`;
  if (quadrants) {
    const counts = [0, 0, 0, 0];
    for (const p of points) counts[(p.y >= quadrants.y ? 0 : 2) + (p.x >= quadrants.x ? 1 : 0)]++;
    summary += ` ${quadrants.labels.map((l, q) => `${l}: ${counts[q]}`).join(", ")}.`;
  }

  const qx = quadrants && x(quadrants.x);
  const qy = quadrants && y(quadrants.y);
  const halfW = (right - left) / 2 - 12;

  return (
    <Plot chart={c} h={h} label={summary}>
      <HGrid y={y} domain={yDomain} x0={left} x1={right} n={5} />
      <VGrid x={x} domain={xDomain} y0={top} y1={base} n={n} />
      <text x={0} y={10} fill={MUTED} fontWeight={500}>
        {yLabel}
      </text>
      <text x={right} y={h - 4} textAnchor="end" fill={MUTED} fontWeight={500}>
        {xLabel}
      </text>
      {quadrants && qx !== undefined && qy !== undefined && (
        <g fill={MUTED}>
          <line x1={qx} x2={qx} y1={top} y2={base} stroke={AXIS} strokeDasharray="4 4" />
          <line x1={left} x2={right} y1={qy} y2={qy} stroke={AXIS} strokeDasharray="4 4" />
          <Text x={left + 6} y={top + 12} width={halfW} text={quadrants.labels[0]} anchor="start" max={1} />
          <Text x={right - 6} y={top + 12} width={halfW} text={quadrants.labels[1]} anchor="end" max={1} />
          <Text x={left + 6} y={base - 8} width={halfW} text={quadrants.labels[2]} anchor="start" max={1} />
          <Text x={right - 6} y={base - 8} width={halfW} text={quadrants.labels[3]} anchor="end" max={1} />
        </g>
      )}
      {drawn.map((p) => (
        <g key={p.id} {...c.mark(tipBody(p.label, [[xLabel, fmt(p.x)], [yLabel, fmt(p.y)]]))}>
          <circle cx={x(p.x)} cy={y(p.y)} r={r(p) + 6} fill="transparent" />
          <circle cx={x(p.x)} cy={y(p.y)} r={r(p)} fill={toneColor(p.tone)} stroke="#fff" strokeWidth={2} />
        </g>
      ))}
      {labels.map((l) => (
        <text
          key={l.p.id}
          x={l.x}
          y={y(l.p.y)}
          dy="0.32em"
          textAnchor={l.anchor}
          fill={INK}
          stroke="#fff"
          strokeWidth={3}
          paintOrder="stroke"
          className="pointer-events-none"
        >
          {l.text}
        </text>
      ))}
    </Plot>
  );
}
