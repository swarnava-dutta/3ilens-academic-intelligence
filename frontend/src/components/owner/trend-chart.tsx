"use client";

import { useMemo, useState } from "react";
import { ChartLine, Table2 } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import type { TrendPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtDate, fmtShortDate, pct } from "./format";

/** Categorical slots in fixed order (validated default palette); a marker shape doubles the identity. */
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
type Shape = "circle" | "square" | "triangle" | "diamond";
const SHAPES: Shape[] = ["circle", "square", "triangle", "diamond"];

const W = 720;
const H = 300;
const M = { top: 16, right: 130, bottom: 34, left: 40 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

function Marker({ shape, x, y, color, r = 4.5 }: { shape: Shape; x: number; y: number; color: string; r?: number }) {
  const common = { fill: color, stroke: "#ffffff", strokeWidth: 2 };
  if (shape === "square") return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1} {...common} />;
  if (shape === "triangle")
    return <polygon points={`${x},${y - r - 1} ${x + r + 1},${y + r} ${x - r - 1},${y + r}`} {...common} />;
  if (shape === "diamond")
    return <polygon points={`${x},${y - r - 1} ${x + r + 1},${y} ${x},${y + r + 1} ${x - r - 1},${y}`} {...common} />;
  return <circle cx={x} cy={y} r={r} {...common} />;
}

interface Series {
  batchId: number;
  name: string;
  color: string;
  shape: Shape;
  points: TrendPoint[];
}

/** Average % per batch over test dates (one line per batch); "View as table" shows the same data. */
export function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const [asTable, setAsTable] = useState(false);

  const { dates, series } = useMemo(() => {
    const valid = (trend ?? []).filter((p) => p && typeof p.average_pct === "number" && p.date);
    const dates = [...new Set(valid.map((p) => p.date.slice(0, 10)))].sort();
    const byBatch = new Map<number, TrendPoint[]>();
    for (const p of valid) {
      const list = byBatch.get(p.batch_id) ?? [];
      list.push(p);
      byBatch.set(p.batch_id, list);
    }
    // Colour follows the batch id (stable), never the rank.
    const ids = [...byBatch.keys()].sort((a, b) => a - b);
    const series: Series[] = ids.map((id, i) => {
      const points = (byBatch.get(id) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
      return {
        batchId: id,
        name: points[0]?.batch_name ?? `Batch ${id}`,
        color: SERIES[i % SERIES.length],
        shape: SHAPES[i % SHAPES.length],
        points,
      };
    });
    return { dates, series };
  }, [trend]);

  const x = (date: string) => {
    const i = dates.indexOf(date.slice(0, 10));
    return M.left + (dates.length <= 1 ? PW / 2 : (i / (dates.length - 1)) * PW);
  };
  const y = (v: number) => M.top + PH - (Math.min(100, Math.max(0, v)) / 100) * PH;

  // Direct end labels, nudged apart so they never overlap.
  const labels = series
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return { s, y: y(last.average_pct), last };
    })
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  }
  const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
  const rows = (trend ?? []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.batch_name.localeCompare(b.batch_name));

  return (
    <Card aria-labelledby="owner-trend-title" className="flex flex-col">
      <CardHeader
        id="owner-trend-title"
        icon={ChartLine}
        title="Batch trend"
        subtitle="Average % per test date (y: 0-100% of max marks). Different papers - indicative only."
        action={
          series.length ? (
            <button
              type="button"
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
            >
              {asTable ? <ChartLine className="h-3.5 w-3.5" aria-hidden /> : <Table2 className="h-3.5 w-3.5" aria-hidden />}
              {asTable ? "View as chart" : "View as table"}
            </button>
          ) : null
        }
      />
      {series.length === 0 ? (
        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
          The trend appears once a batch has completed results on at least one dated test.
        </p>
      ) : asTable ? (
        <div className="relative mt-4 max-h-80 overflow-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <caption className="sr-only">Average % per batch and test date</caption>
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                <th scope="col" className="px-3 py-2">Date</th>
                <th scope="col" className="px-3 py-2">Batch</th>
                <th scope="col" className="px-3 py-2">Test</th>
                <th scope="col" className="px-3 py-2 text-right">Avg %</th>
                <th scope="col" className="px-3 py-2 text-right">Students</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p, i) => (
                <tr key={`${p.batch_id}-${p.date}-${p.test_name}-${i}`}>
                  <td className="px-3 py-1.5 whitespace-nowrap text-slate-700">{fmtDate(p.date)}</td>
                  <td className="px-3 py-1.5 text-slate-800">{p.batch_name}</td>
                  <td className="px-3 py-1.5 text-slate-700">{p.test_name}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-brand-navy">{pct(p.average_pct, 1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{p.students}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-700" aria-label="Legend">
            {series.map((s) => (
              <li key={s.batchId} className="inline-flex items-center gap-1.5">
                <svg width="22" height="12" aria-hidden>
                  <line x1="1" y1="6" x2="21" y2="6" stroke={s.color} strokeWidth="2" />
                  <Marker shape={s.shape} x={11} y={6} color={s.color} r={3.5} />
                </svg>
                {s.name}
              </li>
            ))}
          </ul>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mt-2 h-auto w-full"
            role="img"
            aria-label={`Average percentage per batch over ${dates.length} test dates. Use View as table for the values.`}
          >
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={M.left} x2={M.left + PW} y1={y(v)} y2={y(v)} stroke="#e2e8f0" strokeWidth={1} />
                <text x={M.left - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#475569">
                  {v}%
                </text>
              </g>
            ))}
            {dates.map((d, i) =>
              i % labelEvery === 0 || i === dates.length - 1 ? (
                <text key={d} x={x(d)} y={H - 12} textAnchor="middle" fontSize="11" fill="#475569">
                  {fmtShortDate(d)}
                </text>
              ) : null,
            )}
            {series.map((s) => (
              <g key={s.batchId}>
                {s.points.length > 1 ? (
                  <polyline
                    points={s.points.map((p) => `${x(p.date)},${y(p.average_pct)}`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ) : null}
                {s.points.map((p, i) => (
                  <g key={`${p.date}-${i}`}>
                    <title>{`${s.name} · ${p.test_name} · ${fmtDate(p.date)}: ${pct(p.average_pct, 1)} average (${p.students} students)`}</title>
                    <circle cx={x(p.date)} cy={y(p.average_pct)} r={11} fill="transparent" />
                    <Marker shape={s.shape} x={x(p.date)} y={y(p.average_pct)} color={s.color} />
                  </g>
                ))}
              </g>
            ))}
            {series.length <= 4
              ? labels.map(({ s, y: ly, last }) => (
                  <text key={s.batchId} x={M.left + PW + 10} y={ly + 4} fontSize="11" fill="#0f172a">
                    <tspan fontWeight="600">{s.name.length > 16 ? `${s.name.slice(0, 15)}…` : s.name}</tspan>
                    <tspan fill="#475569"> {pct(last.average_pct)}</tspan>
                  </text>
                ))
              : null}
          </svg>
          <p className={cn("mt-1 text-xs text-slate-600")}>
            Hover a point for the test name. Each line is one batch; the shape and the legend identify it.
          </p>
        </>
      )}
    </Card>
  );
}
