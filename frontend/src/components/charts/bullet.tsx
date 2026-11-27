"use client";

import { cn } from "@/lib/utils";

/** Background bands in neutral greys of increasing darkness (the band text carries the meaning). */
const SHADES = ["#F1F5F9", "#E2E8F0", "#CBD5E1", "#94A3B8"];
const MEASURE = "#1E40AF";
const TARGET = "#D97706";
const TARGET_TEXT = "#B45309";

const pct = (v: number, max: number) => Math.min(100, Math.max(0, max > 0 ? (v / max) * 100 : 0));

/** Keeps an edge label inside the chart: start-aligned near 0, end-aligned near the max. */
function edgeAlign(p: number): string {
  if (p < 12) return "translate-x-0";
  if (p > 88) return "-translate-x-full";
  return "-translate-x-1/2";
}

const fmt = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return `${r < 0 ? "−" : ""}${Number.isInteger(r) ? Math.abs(r) : Math.abs(r).toFixed(1)}`;
};

/**
 * Bullet chart (score vs target): labelled grey bands from 0 to `max`, a navy measure bar a third of
 * the band height with its value at the end, a 3px amber target line with its label, and an optional
 * batch-median tick. Drawn in HTML so it reflows to any width; wrap it in ChartFrame for the title
 * and the "Show data" table.
 */
export function Bullet({
  max,
  value,
  bands,
  target,
  median,
  label,
  className,
}: {
  max: number;
  value: number;
  bands: { label: string; from: number; to: number }[];
  target?: { value: number; label: string } | null;
  median?: { value: number; label: string } | null;
  /** Spoken summary, e.g. "Score 402 of 720, 55.8%, Needs attention; target 504". */
  label: string;
  className?: string;
}) {
  const v = pct(value, max);
  const t = target ? pct(target.value, max) : null;
  const m = median ? pct(median.value, max) : null;
  const ticks = [...new Set([0, ...bands.map((b) => b.to)].map((n) => Math.round(n * 10) / 10))].sort((a, b) => a - b);
  const valueInside = v > 86;
  return (
    <div role="img" aria-label={label} className={cn("w-full select-none text-[11px] [print-color-adjust:exact]", className)}>
      <div className="relative h-5" aria-hidden>
        {target && t !== null ? (
          <span
            className={cn("absolute top-0 whitespace-nowrap font-medium leading-5", edgeAlign(t))}
            style={{ left: `${t}%`, color: TARGET_TEXT }}
          >
            {target.label}
          </span>
        ) : null}
      </div>
      <div className="relative h-10 overflow-visible" aria-hidden>
        {bands.map((b, i) => (
          <div
            key={`${b.label}-${i}`}
            className="absolute inset-y-0"
            style={{
              left: `${pct(b.from, max)}%`,
              width: `${pct(b.to, max) - pct(b.from, max)}%`,
              background: SHADES[Math.min(i, SHADES.length - 1)],
            }}
          />
        ))}
        <div
          className="absolute left-0 top-1/3 h-1/3 rounded-r-[2px] motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out"
          style={{ width: `${v}%`, background: MEASURE }}
        />
        <span
          className={cn(
            "absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-xs font-semibold tabular-nums",
            valueInside ? "-translate-x-full pr-1 text-white" : "pl-1.5 text-slate-900",
          )}
          style={{ left: `${v}%` }}
        >
          {fmt(value)}
        </span>
        {m !== null ? (
          <div
            className="absolute -inset-y-0.5 w-0 border-l-2 border-dashed border-slate-700"
            style={{ left: `${m}%` }}
            title={median?.label}
          />
        ) : null}
        {t !== null ? (
          <div className="absolute -inset-y-1 w-[3px] -translate-x-1/2" style={{ left: `${t}%`, background: TARGET }} />
        ) : null}
      </div>
      <div className="relative mt-1 h-4 font-mono tabular-nums text-slate-500" aria-hidden>
        {ticks.map((n) => (
          <span key={n} className={cn("absolute top-0 whitespace-nowrap", edgeAlign(pct(n, max)))} style={{ left: `${pct(n, max)}%` }}>
            {fmt(n)}
          </span>
        ))}
      </div>
      <div className="relative mt-0.5 h-7 text-slate-700" aria-hidden>
        {bands.map((b, i) => (
          <span
            key={`${b.label}-${i}`}
            className="absolute top-0 px-0.5 text-center leading-tight"
            style={{ left: `${pct(b.from, max)}%`, width: `${pct(b.to, max) - pct(b.from, max)}%` }}
          >
            {b.label}
          </span>
        ))}
      </div>
      {median && m !== null ? (
        <p className="mt-1 flex items-center gap-1.5 text-slate-600" aria-hidden>
          <span className="inline-block h-3 w-0 border-l-2 border-dashed border-slate-700" />
          {median.label}
        </p>
      ) : null}
    </div>
  );
}
