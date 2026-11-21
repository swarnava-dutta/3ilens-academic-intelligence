"use client";

import type { ReactNode } from "react";
import {
  AXIS,
  axisWidth,
  bar,
  CONTEXT,
  type Domain,
  Empty,
  extremes,
  fmt,
  HGrid,
  INK,
  nice,
  Plot,
  scale,
  SERIES,
  Text,
  textWidth,
  tipBody,
  toneColor,
  useChart,
  type Tone,
} from "./core";

type Col = { label: string; value: number; color: string; tip: ReactNode; note?: string };

const H = 220;
const TOP = 22;
const BASE = H - 36;

/** Vertical bars on one baseline. `flush` packs them 2px apart, histogram style. */
function ColumnPlot({ cols, domain, unit, label, flush, int }: {
  cols: Col[];
  domain: Domain;
  unit?: string;
  label: string;
  flush?: boolean;
  int?: boolean;
}) {
  const c = useChart();
  const left = axisWidth(domain, unit, 4);
  const y = scale(domain, [BASE, TOP]);
  const band = (c.w - left - 4) / cols.length;
  const bw = flush ? band - 2 : Math.min(band * 0.6, 36);
  const zero = y(Math.min(Math.max(0, domain[0]), domain[1]));
  return (
    <Plot chart={c} h={H} label={label}>
      <HGrid y={y} domain={domain} x0={left} x1={c.w} unit={unit} n={4} int={int} />
      {cols.map((d, i) => {
        const cx = left + band * (i + 0.5);
        const top = y(d.value);
        const half = textWidth(d.note ?? "") / 2;
        return (
          <g key={i} {...c.mark(d.tip)}>
            <rect x={cx - band / 2} width={band} height={H} fill="transparent" />
            <path
              d={bar(cx - bw / 2, Math.min(zero, top), bw, Math.abs(zero - top), d.value < 0 ? "bottom" : "top")}
              fill={d.color}
            />
            {d.note && (
              <text
                x={Math.min(Math.max(cx, left + half), c.w - half)}
                y={Math.min(zero, top) - 6}
                textAnchor="middle"
                fill={INK}
                fontWeight={500}
              >
                {d.note}
              </text>
            )}
            <Text x={cx} y={BASE + 15} width={band - 4} text={d.label} />
          </g>
        );
      })}
      <line x1={left} x2={c.w} y1={zero} y2={zero} stroke={AXIS} shapeRendering="crispEdges" />
    </Plot>
  );
}

export function Columns({
  items,
  domain,
  unit,
}: {
  items: { label: string; value: number; tone?: Tone }[];
  domain?: Domain;
  unit?: string;
}) {
  if (!items.length) return <Empty />;
  const values = items.map((d) => d.value);
  return (
    <ColumnPlot
      cols={items.map((d) => ({
        label: d.label,
        value: d.value,
        color: toneColor(d.tone),
        tip: tipBody(d.label, [["Value", fmt(d.value, unit)]]),
      }))}
      domain={domain ?? nice(Math.min(0, ...values), Math.max(0, ...values))}
      unit={unit}
      label={`Column chart of ${items.length} items. ${extremes(items, (v) => fmt(v, unit))}`}
    />
  );
}

export function Histogram({
  bins,
  markerIndex,
  markerLabel,
}: {
  bins: { label: string; count: number }[];
  markerIndex?: number;
  markerLabel?: string;
}) {
  if (!bins.length) return <Empty />;
  const total = bins.reduce((s, b) => s + b.count, 0);
  const marked = markerIndex === undefined ? undefined : bins[markerIndex];
  return (
    <ColumnPlot
      cols={bins.map((b, i) => ({
        label: b.label,
        value: b.count,
        color: i === markerIndex ? SERIES[0] : CONTEXT,
        tip: tipBody(b.label, [["Count", String(b.count)]]),
        note: i === markerIndex ? markerLabel : undefined,
      }))}
      domain={nice(0, Math.max(...bins.map((b) => b.count)))}
      label={
        `Histogram of ${total} across ${bins.length} bins.` +
        (marked ? ` ${markerLabel ?? "Marked bin"}: ${marked.label}.` : "")
      }
      flush
      int
    />
  );
}
