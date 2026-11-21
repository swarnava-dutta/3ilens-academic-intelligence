"use client";

import {
  AXIS,
  axisWidth,
  CONTEXT,
  type Domain,
  Empty,
  fmt,
  HGrid,
  INK,
  Legend,
  nice,
  Plot,
  scale,
  seriesColor,
  type Series,
  Text,
  textWidth,
  tipBody,
  useChart,
} from "./core";

const H = 240;
const TOP = 12;
const BASE = H - 28;

export function LineChart({
  series,
  yDomain,
  unit,
  band,
}: {
  series: { name: string; series: Series; points: { x: string; y: number }[] }[];
  yDomain?: Domain;
  unit?: string;
  band?: { x: string; lo: number; hi: number }[];
}) {
  const c = useChart();
  const xs = [...new Set([...series.flatMap((s) => s.points.map((p) => p.x)), ...(band ?? []).map((b) => b.x)])];
  if (!xs.length) return <Empty />;

  const ys = [...series.flatMap((s) => s.points.map((p) => p.y)), ...(band ?? []).flatMap((b) => [b.lo, b.hi])];
  const domain = yDomain ?? nice(Math.min(...ys), Math.max(...ys));
  const left = axisWidth(domain, unit, 5);
  const ends = c.w >= 640 && series.length > 1;
  const endW = Math.min(120, Math.max(...series.map((s) => textWidth(s.name))) + 8);
  const x1 = c.w - (ends ? endW + 20 : 12);
  const x0 = left + 12;
  const stepX = xs.length > 1 ? (x1 - x0) / (xs.length - 1) : 0;
  const x = (label: string) => (xs.length > 1 ? x0 + xs.indexOf(label) * stepX : (x0 + x1) / 2);
  const y = scale(domain, [BASE, TOP]);
  const labelW = Math.max(...xs.map(textWidth)) + 12;
  const every = Math.ceil(xs.length / Math.max(1, Math.floor((x1 - x0 + stepX) / labelW)));
  const dots = xs.length <= 12;
  const active = c.tip?.key;
  // Context below, then S3, S2, S1 so the primary series sits on top.
  const order = [...series].sort((a, b) => rankOf(b.series) - rankOf(a.series));

  const path = (pts: { x: string; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.y)}`).join("");
  const labelled = series
    .filter((s) => s.points.length)
    .map((s) => ({ name: s.name, y: y(s.points[s.points.length - 1].y) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labelled.length; i++) labelled[i].y = Math.max(labelled[i].y, labelled[i - 1].y + 13);

  const summary = series
    .filter((s) => s.points.length)
    .map((s) => {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      return `${s.name}: ${fmt(a.y, unit)} at ${a.x}, ${fmt(b.y, unit)} at ${b.x}`;
    })
    .join("; ");

  return (
    <div className="space-y-2">
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: seriesColor(s.series) }))} />}
      <Plot chart={c} h={H} label={`Line chart. ${summary}.`}>
        <HGrid y={y} domain={domain} x0={left} x1={x1 + 12} unit={unit} n={5} />
        {band && band.length > 1 && (
          <path
            d={`${path(band.map((b) => ({ x: b.x, y: b.hi })))}${path([...band].reverse().map((b) => ({ x: b.x, y: b.lo }))).replace("M", "L")}Z`}
            fill={CONTEXT}
            fillOpacity={0.45}
          />
        )}
        {xs.map((label, i) =>
          i % every ? null : (
            <Text
              key={label}
              x={Math.min(Math.max(x(label), labelW / 2), c.w - labelW / 2)}
              y={BASE + 16}
              width={labelW}
              text={label}
              max={1}
            />
          ),
        )}
        {active !== undefined && (
          <line x1={x(xs[+active])} x2={x(xs[+active])} y1={TOP} y2={BASE} stroke={AXIS} shapeRendering="crispEdges" />
        )}
        {order.map((s) => (
          <g key={s.name} fill={seriesColor(s.series)}>
            <path d={path(s.points)} fill="none" stroke={seriesColor(s.series)} strokeWidth={2} strokeLinejoin="round" />
            {s.points.map((p) =>
              dots || xs.indexOf(p.x) === active ? (
                <circle key={p.x} cx={x(p.x)} cy={y(p.y)} r={xs.indexOf(p.x) === active ? 6 : 5} stroke="#fff" strokeWidth={2} />
              ) : null,
            )}
          </g>
        ))}
        {ends &&
          labelled.map((l) => (
            <Text key={l.name} x={x1 + 12} y={l.y} dy="0.32em" width={endW} text={l.name} anchor="start" max={1} fill={INK} />
          ))}
        {xs.map((label, i) => {
          const rows: [string, string, string?][] = series.flatMap((s) => {
            const p = s.points.find((q) => q.x === label);
            return p ? [[s.name, fmt(p.y, unit), seriesColor(s.series)] as [string, string, string]] : [];
          });
          const b = band?.find((q) => q.x === label);
          if (b) rows.push(["Range", `${fmt(b.lo, unit)}–${fmt(b.hi, unit)}`]);
          return (
            <g key={label} {...c.mark(tipBody(label, rows), i)}>
              <rect x={x(label) - Math.max(stepX, 24) / 2} y={TOP} width={Math.max(stepX, 24)} height={BASE - TOP} fill="transparent" />
            </g>
          );
        })}
      </Plot>
    </div>
  );
}

const rankOf = (s: Series) => (s === "context" ? 4 : s);
