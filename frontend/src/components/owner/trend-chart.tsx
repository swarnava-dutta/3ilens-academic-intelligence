"use client";

import { useMemo, useState } from "react";
import type { TrendPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, fmtDate, fmtShortDate } from "./format";
import { dayText, pctFixed, SMALL_GROUP } from "./owner-ui";
import { btnQuiet, EmptyNote, theadCls, thCls } from "./states";

/** Categorical slots in fixed order (validated default palette); a marker shape doubles the identity. */
const SERIES = ["#0490aa", "#eb6834", "#6250d6", "#eda100", "#e87ba4", "#008300", "#1baf7a", "#e34948"];
type Shape = "circle" | "square" | "triangle" | "diamond";
const SHAPES: Shape[] = ["circle", "square", "triangle", "diamond"];
const DAY = 86_400_000;

const W = 720;
const H = 300;
// No direct end labels (they sat beside other batches' points): the legend carries each batch's latest value.
const M = { top: 16, right: 24, bottom: 34, left: 40 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

function Marker({
  shape,
  x,
  y,
  color,
  r = 4.5,
  hollow = false,
}: {
  shape: Shape;
  x: number;
  y: number;
  color: string;
  r?: number;
  hollow?: boolean;
}) {
  const common = hollow
    ? { fill: "#ffffff", stroke: color, strokeWidth: 2 }
    : { fill: color, stroke: "#ffffff", strokeWidth: 2 };
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
  /** Newest whole-class sitting (else the newest sitting). */
  last: TrendPoint;
}

const isMain = (p: TrendPoint) => p.main !== false;
const dayMs = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).getTime();

function tip(p: TrendPoint): string {
  const marks = p.max_marks ? ` · out of ${fmt(p.max_marks, 0)} marks` : "";
  const main = isMain(p) ? "" : " · small group, not joined";
  return `${p.batch_name} · ${p.test_name} · ${fmtDate(p.date)}: ${pctFixed(p.average_pct)} average, ${p.students} student${p.students === 1 ? "" : "s"}${marks}${main}`;
}

/**
 * Every sitting per batch on a time axis (x proportional to the date). Lines join only main
 * (3+ student) sittings of a batch; smaller sittings are hollow markers on their own. The legend
 * names each batch with its latest whole-class value. Below md the list view is shown by default.
 */
export function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const [view, setView] = useState<"auto" | "chart" | "table">("auto");

  const { series, t0, t1 } = useMemo(() => {
    const valid = (trend ?? []).filter((p) => p && typeof p.average_pct === "number" && p.date);
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
      const mains = points.filter(isMain);
      return {
        batchId: id,
        name: points[0]?.batch_name ?? `Batch ${id}`,
        color: SERIES[i % SERIES.length],
        shape: SHAPES[i % SHAPES.length],
        points,
        last: mains[mains.length - 1] ?? points[points.length - 1],
      };
    });
    const times = valid.map((p) => dayMs(p.date));
    return { series, t0: Math.min(...times), t1: Math.max(...times) };
  }, [trend]);

  const span = t1 - t0;
  const x = (iso: string) => M.left + (span <= 0 ? PW / 2 : ((dayMs(iso) - t0) / span) * PW);
  const y = (v: number) => M.top + PH - (Math.min(100, Math.max(0, v)) / 100) * PH;

  // Date ticks at a step that fits the span (proportional, so equal gaps mean equal time).
  const spanDays = span / DAY;
  const step = spanDays <= 14 ? 2 : spanDays <= 60 ? 7 : spanDays <= 150 ? 14 : 30;
  const ticks: number[] = [];
  if (span > 0) for (let t = t0; t <= t1 + DAY / 2; t += step * DAY) ticks.push(t);
  else if (Number.isFinite(t0)) ticks.push(t0);

  const rows = (trend ?? [])
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || a.batch_name.localeCompare(b.batch_name));
  const hasSmall = (trend ?? []).some((p) => !isMain(p));

  if (series.length === 0) {
    return <EmptyNote>Sittings appear once a batch has graded sheets on at least one test.</EmptyNote>;
  }

  const table = (
    <div className="relative max-h-96 overflow-auto rounded-md border border-slate-200">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Average % per sitting: batch, test, date, students</caption>
        <thead className={cn(theadCls, "sticky top-0")}>
          <tr>
            <th scope="col" className={thCls}>Date</th>
            <th scope="col" className={thCls}>Batch</th>
            <th scope="col" className={thCls}>Test</th>
            <th scope="col" className={cn(thCls, "text-right")}>Avg %</th>
            <th scope="col" className={cn(thCls, "text-right")}>Students</th>
            <th scope="col" className={cn(thCls, "text-right")}>Max marks</th>
            <th scope="col" className={thCls}>Whole class</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p, i) => (
            <tr key={`${p.batch_id}-${p.date}-${p.test_name}-${i}`}>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">{dayText(p.date)}</td>
              <td className="px-3 py-1.5 text-slate-800">{p.batch_name}</td>
              <td className="px-3 py-1.5 text-slate-700">{p.test_name}</td>
              <td className="px-3 py-1.5 text-right font-medium tabular-nums text-slate-900">{pctFixed(p.average_pct)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{p.students}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{p.max_marks ? fmt(p.max_marks, 0) : "—"}</td>
              <td className="px-3 py-1.5 text-slate-700">{isMain(p) ? "yes" : "no (small group)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Below md: one stacked card per sitting (no nested two-way scrolling box).
  const list = (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200" aria-label="Average % per sitting">
      {rows.map((p, i) => (
        <li key={`${p.batch_id}-${p.date}-${p.test_name}-${i}`} className="px-3 py-2 text-sm">
          <p className="font-medium text-slate-900">
            {dayText(p.date)} · {p.batch_name}
          </p>
          <p className="text-xs text-slate-600">{p.test_name}</p>
          <p className="mt-0.5 text-xs tabular-nums text-slate-700">
            <span className="text-sm font-medium text-slate-900">{pctFixed(p.average_pct)}</span> · {p.students} student
            {p.students === 1 ? "" : "s"}
            {p.max_marks ? ` · out of ${fmt(p.max_marks, 0)}` : ""} · {isMain(p) ? "whole class" : "small group"}
          </p>
        </li>
      ))}
    </ul>
  );

  const chart = (
    // Capped near the viewBox width so the 11px SVG text stays about 11px.
    <div className="max-w-[780px]">
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-slate-700" aria-label="Legend">
        {series.map((s) => (
          <li key={s.batchId} className="inline-flex items-center gap-1.5">
            <svg width="22" height="12" aria-hidden>
              <line x1="1" y1="6" x2="21" y2="6" stroke={s.color} strokeWidth="2" />
              <Marker shape={s.shape} x={11} y={6} color={s.color} r={3.5} />
            </svg>
            <span className="font-medium text-slate-900">{s.name}</span>
            <span className="tabular-nums text-slate-600" title={tip(s.last)}>
              latest {pctFixed(s.last.average_pct)} ({dayText(s.last.date)}
              {isMain(s.last) ? "" : `, ${s.last.students} student${s.last.students === 1 ? "" : "s"}`})
            </span>
          </li>
        ))}
        {hasSmall ? (
          <li className="inline-flex items-center gap-1.5 text-slate-600">
            <svg width="12" height="12" aria-hidden>
              <circle cx={6} cy={6} r={3.5} fill="#ffffff" stroke="#64748b" strokeWidth={2} />
            </svg>
            hollow = fewer than {SMALL_GROUP} students (not joined)
          </li>
        ) : null}
      </ul>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 h-auto w-full"
        role="img"
        aria-label={`Average percentage per sitting for ${series.length} batches from ${fmtDate(new Date(t0).toISOString())} to ${fmtDate(new Date(t1).toISOString())}. ${series
          .map((s) => `${s.name}: latest ${pctFixed(s.last.average_pct)} on ${dayText(s.last.date)}`)
          .join("; ")}. The table view lists every value.`}
      >
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + PW} y1={y(v)} y2={y(v)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={M.left - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#475569">
              {v}%
            </text>
          </g>
        ))}
        {ticks.map((t) => {
          const iso = new Date(t).toISOString().slice(0, 10);
          const tx = M.left + (span <= 0 ? PW / 2 : ((t - t0) / span) * PW);
          return (
            <g key={t}>
              <line x1={tx} x2={tx} y1={M.top + PH} y2={M.top + PH + 4} stroke="#94a3b8" />
              <text x={tx} y={H - 12} textAnchor="middle" fontSize="11" fill="#475569">
                {fmtShortDate(iso)}
              </text>
            </g>
          );
        })}
        {series.map((s) => {
          const mains = s.points.filter(isMain);
          return (
            <g key={s.batchId}>
              {mains.length > 1 ? (
                <polyline
                  points={mains.map((p) => `${x(p.date)},${y(p.average_pct)}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              {s.points.map((p, i) => (
                <g key={`${p.date}-${p.test_name}-${i}`}>
                  <title>{tip(p)}</title>
                  <circle cx={x(p.date)} cy={y(p.average_pct)} r={11} fill="transparent" />
                  <Marker shape={s.shape} x={x(p.date)} y={y(p.average_pct)} color={s.color} hollow={!isMain(p)} />
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      <p className="mt-1 text-xs text-slate-500">
        Each line joins one batch&apos;s whole-class sittings ({SMALL_GROUP}+ students) in time order. The sittings can be
        different papers sat by different students, so read a line as indicative, not as one group&apos;s trajectory.
        Hover a point for the test, date and group size.
      </p>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-slate-600">
          Average % of max marks per sitting (one test in one batch). x axis is proportional to the date.
        </p>
        {view === "auto" ? (
          <>
            <button type="button" onClick={() => setView("table")} className={cn(btnQuiet, "hidden md:inline-flex")}>
              View as table
            </button>
            <button type="button" onClick={() => setView("chart")} className={cn(btnQuiet, "h-10 md:hidden")}>
              View as chart
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setView(view === "table" ? "chart" : "table")}
            className={cn(btnQuiet, "h-10 md:h-8")}
          >
            {view === "table" ? "View as chart" : "View as table"}
          </button>
        )}
      </div>
      {view === "auto" ? (
        <>
          <div className="hidden md:block">{chart}</div>
          <div className="md:hidden">{list}</div>
        </>
      ) : view === "table" ? (
        <>
          <div className="hidden md:block">{table}</div>
          <div className="md:hidden">{list}</div>
        </>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">{chart}</div>
        </div>
      )}
    </div>
  );
}
