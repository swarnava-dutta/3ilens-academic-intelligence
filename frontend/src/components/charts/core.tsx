"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Domain = [number, number];
export type Series = 1 | 2 | 3 | "context";
export type Tone = "default" | "good" | "warning" | "critical" | "context";

// Series hues are assigned in this order and never cycled.
export const SERIES = ["#0490aa", "#eb6834", "#6250d6"];
export const CONTEXT = "#cbd5e1";
export const CRITICAL = "#d03b3b";
const STATUS = { good: "#0ca30c", warning: "#d97706", critical: CRITICAL };
export const INK = "#334155"; // slate-700
export const MUTED = "#64748b"; // slate-500
export const AXIS = "#94a3b8"; // slate-400
const GRID = "#e2e8f0";

export const seriesColor = (s: Series) => (s === "context" ? CONTEXT : SERIES[s - 1]);
export const toneColor = (t: Tone = "default") =>
  t === "default" ? SERIES[0] : t === "context" ? CONTEXT : STATUS[t];

export const fmt = (v: number, unit = "") => `${Number(v.toFixed(1))}${unit}`;
export const signed = (v: number, unit = "") =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), unit)}`;

export const scale =
  ([d0, d1]: Domain, [r0, r1]: Domain) =>
  (v: number) =>
    r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function step(lo: number, hi: number, n: number) {
  const raw = (hi - lo) / n || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const e = raw / p;
  return (e < 1.5 ? 1 : e < 3 ? 2 : e < 7 ? 5 : 10) * p;
}

/** Rounds an extent outwards to tick boundaries. */
export function nice(lo: number, hi: number): Domain {
  const top = hi > lo ? hi : lo + 1;
  const s = step(lo, top, 5);
  return [Math.floor(lo / s) * s, Math.ceil(top / s) * s];
}

export function ticks([lo, hi]: Domain, n = 5) {
  const s = step(lo, hi, n);
  const out: number[] = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + s / 1e6; v += s) out.push(Number(v.toPrecision(10)));
  return out;
}

/** About how many ticks fit along `px` without labels touching. */
export const tickCount = (px: number) => Math.max(2, Math.min(6, Math.floor(px / 70)));

// Fira Sans at 11px averages a little over 6px per character.
export const textWidth = (s: string) => s.length * 6.2;

/** Greedy word wrap into at most `max` lines; the last line gets an ellipsis if text is cut. */
export function wrap(text: string, px: number, max = 2) {
  const n = Math.max(2, Math.floor(px / 6.2));
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= n) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines
    .slice(0, max)
    .map((l, i) =>
      l.length > n || (i === max - 1 && lines.length > max) ? `${l.slice(0, n - 1).trimEnd()}…` : l,
    );
}

/** Rectangle path with only the corners on the `end` side rounded. */
export function bar(x: number, y: number, w: number, h: number, end?: "top" | "right" | "bottom" | "left") {
  const ww = Math.max(w, 0);
  const r = end ? Math.min(4, ww / 2, h / 2) : 0;
  const [tl, tr, br, bl] = {
    top: [r, r, 0, 0],
    right: [0, r, r, 0],
    bottom: [0, 0, r, r],
    left: [r, 0, 0, r],
    none: [0, 0, 0, 0],
  }[end ?? "none"];
  return (
    `M${x + tl},${y}H${x + ww - tr}a${tr},${tr} 0 0 1 ${tr},${tr}V${y + h - br}` +
    `a${br},${br} 0 0 1 ${-br},${br}H${x + bl}a${bl},${bl} 0 0 1 ${-bl},${-bl}V${y + tl}` +
    `a${tl},${tl} 0 0 1 ${tl},${-tl}Z`
  );
}

export function extremes(items: { label: string; value: number }[], f: (v: number) => string) {
  const s = [...items].sort((a, b) => b.value - a.value);
  const lo = s[s.length - 1];
  return `Highest ${s[0].label} (${f(s[0].value)}), lowest ${lo.label} (${f(lo.value)}).`;
}

type Tip = { x: number; y: number; body: ReactNode; key?: number | string };

/** Container width (fed by `Frame`) plus a shared tooltip; `mark()` returns the props that show it. */
export function useChart() {
  const [w, setW] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);

  const mark = (body: ReactNode, key?: number | string) => {
    const show = (e: { currentTarget: Element }) => {
      const a = e.currentTarget.closest("[data-chart]")?.getBoundingClientRect();
      const b = e.currentTarget.getBoundingClientRect();
      if (a) setTip({ x: b.left + b.width / 2 - a.left, y: b.top - a.top, body, key });
    };
    const hide = () => setTip(null);
    return { tabIndex: 0, onMouseEnter: show, onFocus: show, onMouseLeave: hide, onBlur: hide };
  };

  return { w, setW, tip, mark };
}

export type Chart = ReturnType<typeof useChart>;

export function Tooltip({ chart: { tip, w } }: { chart: Chart }) {
  if (!tip) return null;
  const tx = tip.x < 90 ? "0" : tip.x > w - 90 ? "-100%" : "-50%";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs leading-5 whitespace-nowrap text-slate-700"
      style={{ left: tip.x, top: tip.y - 6, transform: `translate(${tx}, -100%)` }}
    >
      {tip.body}
    </div>
  );
}

export function tipBody(title: string, rows: [label: string, value: string, color?: string][]) {
  return (
    <>
      <div className="font-medium text-slate-900">{title}</div>
      {rows.map(([label, value, color]) => (
        <div key={label} className="flex items-center gap-1.5">
          {color && <span className="size-2 rounded-[2px]" style={{ background: color }} />}
          <span className="text-slate-500">{label}</span>
          <span className="ml-auto pl-4 tabular-nums">{value}</span>
        </div>
      ))}
    </>
  );
}

/** Measures its width into the chart and hosts the tooltip. */
export function Frame({ chart, className, style, children }: {
  chart: Chart;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { setW } = chart;
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [setW]);
  return (
    <div ref={ref} data-chart className={cn("relative", className)} style={style}>
      {children}
      <Tooltip chart={chart} />
    </div>
  );
}

/** SVG drawn at true pixel size, so text never scales with the container. */
export function Plot({ chart, h, label, children }: { chart: Chart; h: number; label: string; children: ReactNode }) {
  return (
    <Frame chart={chart} style={{ height: h }}>
      {chart.w > 0 && (
        <svg
          role="img"
          aria-label={label}
          width="100%"
          height={h}
          viewBox={`0 0 ${chart.w} ${h}`}
          className="block text-[11px] tabular-nums"
        >
          {children}
        </svg>
      )}
    </Frame>
  );
}

export function Empty() {
  return <p className="text-sm text-slate-500">No data to show yet.</p>;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {items.map((d) => (
        <li key={d.label} className="flex items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: d.color }} />
          {d.label}
        </li>
      ))}
    </ul>
  );
}

export function Text({
  x,
  y,
  text,
  width,
  anchor = "middle",
  max = 2,
  fill = MUTED,
  dy = "0",
}: {
  x: number;
  y: number;
  text: string;
  width: number;
  anchor?: "start" | "middle" | "end";
  max?: number;
  fill?: string;
  dy?: string;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill={fill}>
      {wrap(text, width, max).map((l, i) => (
        <tspan key={i} x={x} dy={i ? 13 : dy}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

export const axisWidth = (domain: Domain, unit?: string, n?: number) =>
  Math.max(...ticks(domain, n).map((t) => textWidth(fmt(t, unit)))) + 10;

/** Horizontal grid lines with value labels on the left. */
export function HGrid(p: {
  y: (v: number) => number;
  domain: Domain;
  x0: number;
  x1: number;
  unit?: string;
  n?: number;
  int?: boolean;
}) {
  return (
    <>
      {ticks(p.domain, p.n)
        .filter((t) => !p.int || Number.isInteger(t))
        .map((t) => (
          <g key={t}>
            <line x1={p.x0} x2={p.x1} y1={p.y(t)} y2={p.y(t)} stroke={GRID} shapeRendering="crispEdges" />
            <text x={p.x0 - 6} y={p.y(t)} dy="0.32em" textAnchor="end" fill={MUTED}>
              {fmt(t, p.unit)}
            </text>
          </g>
        ))}
    </>
  );
}

/** Vertical grid lines with value labels underneath. */
export function VGrid(p: { x: (v: number) => number; domain: Domain; y0: number; y1: number; unit?: string; n?: number }) {
  return (
    <>
      {ticks(p.domain, p.n).map((t) => (
        <g key={t}>
          <line x1={p.x(t)} x2={p.x(t)} y1={p.y0} y2={p.y1} stroke={GRID} shapeRendering="crispEdges" />
          <text x={p.x(t)} y={p.y1 + 14} textAnchor="middle" fill={MUTED}>
            {fmt(t, p.unit)}
          </text>
        </g>
      ))}
    </>
  );
}
