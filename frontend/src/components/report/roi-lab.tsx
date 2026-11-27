"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { errorMessage, errorStatus, getStudyPlan } from "@/lib/api";
import type {
  CalendarActivity,
  PlanAction,
  PlanTopic,
  Quadrant,
  Result,
  RoadmapStage,
  StrategyMode,
  StudyPlan,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice, btnSecondary } from "./dialog";
import { clampPct, fmtHours, fmtISTDate, fmtMarks, fmtNumber, fmtPctValue, fmtRoi, plannedMinutesText, safeNumber } from "./format";
import { QRefChip } from "./immediate-reading";
import { normalizePlan } from "./normalize";
import { MeterBar, Pill, SectionCard } from "./primitives";

type Order = "observed" | "roi";

const DAY_MIN = 1;
/** The slider reaches at least 150 days, and always the batch's real days to the exam. */
const DAY_MAX_MIN = 150;
const HOURS_MIN = 3;
const HOURS_MAX = 40;
const DEBOUNCE_MS = 200;
const COMPARE_DAYS = [90, 30, 7] as const;

const PRESETS: { days: number; label: string }[] = [
  { days: 120, label: "120d · Broad" },
  { days: 45, label: "45d · Focused" },
  { days: 14, label: "14d · Revision" },
  { days: 5, label: "5d · Consolidation" },
];

export const MODE_LOOK: Record<StrategyMode, { label: string; pill: string }> = {
  broad: { label: "Broad coverage", pill: "bg-slate-100 text-slate-700" },
  focused: { label: "Focused", pill: "bg-slate-100 text-slate-700" },
  revision: { label: "Revision", pill: "bg-slate-100 text-slate-700" },
  consolidation: { label: "Consolidation", pill: "bg-slate-100 text-slate-700" },
};

const QUADRANTS: { key: Quadrant; label: string; desc: string; dot: string; fill: string }[] = [
  {
    key: "priority_focus",
    label: "Priority focus",
    desc: "Weak (<70%) and high return",
    dot: "bg-rose-500",
    fill: "fill-rose-500",
  },
  {
    key: "maintain",
    label: "Maintain",
    desc: "Strong (>=70%) and high return",
    dot: "bg-brand-lime-600",
    fill: "fill-lime-600",
  },
  {
    key: "deprioritise",
    label: "Deprioritise",
    desc: "Weak but low return in the time left",
    dot: "bg-amber-500",
    fill: "fill-amber-500",
  },
  {
    key: "no_action",
    label: "No action",
    desc: "Strong and low return: light refresher",
    dot: "bg-slate-400",
    fill: "fill-slate-400",
  },
];

const QUADRANT_BY_KEY = Object.fromEntries(QUADRANTS.map((q) => [q.key, q])) as Record<Quadrant, (typeof QUADRANTS)[number]>;

// The same words as the focus list and the calendar.
const ACTION_LABEL: Record<PlanAction, string> = {
  learn: "Learn",
  drill: "Fix errors",
  fix_errors: "Fix errors",
  maintain: "Keep warm",
  none: "—",
};

const ACTIVITY_LOOK: Record<CalendarActivity, { label: string; cls: string }> = {
  learn: { label: "Learn", cls: "border-l-sky-600" },
  drill: { label: "Fix errors", cls: "border-l-brand-cyan" },
  fix_errors: { label: "Fix errors", cls: "border-l-rose-500" },
  review: { label: "Review", cls: "border-l-brand-lime-600" },
  checkpoint: { label: "Checkpoint", cls: "border-l-amber-500" },
};

const clampDays = (n: number, max: number) => Math.min(max, Math.max(DAY_MIN, Math.round(safeNumber(n, 120))));
const clampHours = (n: number) => Math.min(HOURS_MAX, Math.max(HOURS_MIN, Math.round(safeNumber(n, 18))));

/** Top-five rows: observed-gap order (qualitative_rank) or the illustrative ROI ranking. */
function topRows(plan: StudyPlan, result: Result, order: Order): { row: PlanTopic; label: string }[] {
  const qual = new Map(result.roi_recommendations.map((p) => [p.topic, p.qualitative_rank]));
  if (order === "roi") {
    const focus = plan.focus.length
      ? plan.focus
      : [...plan.topics].filter((t) => t.roi > 0).sort((a, b) => b.roi - a.roi);
    return focus.slice(0, 5).map((row, i) => ({ row, label: `#${row.rank ?? i + 1}` }));
  }
  const candidates = plan.topics.filter(
    (t) => (qual.get(t.topic) ?? null) !== null || t.rank !== null || t.mastery < t.target_mastery,
  );
  return candidates
    .sort(
      (a, b) =>
        (qual.get(a.topic) ?? 999) - (qual.get(b.topic) ?? 999) ||
        a.mastery - b.mastery ||
        b.roi - a.roi,
    )
    .slice(0, 5)
    .map((row, i) => {
      const q = qual.get(row.topic);
      return { row, label: q ? `P${q}` : `${i + 1}` };
    });
}

function Block({ title, children, className, aside }: { title: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <div className={cn("min-w-0 border-t border-slate-200 pt-4 print:break-inside-avoid", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-brand-navy">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

function StrategyCard({ plan, result, touched, days }: { plan: StudyPlan; result: Result; touched: boolean; days: number }) {
  const batch = result.report_meta.batch;
  const look = MODE_LOOK[plan.strategy_mode];
  const ps = plan.projected_score;
  const scale = ps.scale_max > 0 ? ps.scale_max : 100;
  return (
    <Block title="Strategy for the time left">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill className={look.pill}>{look.label} mode</Pill>
            {plan.days_to_exam !== null ? (
              <span className="text-xs tabular-nums text-slate-500">{plan.days_to_exam} days to {plan.exam}</span>
            ) : null}
          </div>
          <p className="mt-2 text-base font-semibold text-brand-navy">{plan.strategy_title || look.label}</p>
          {plan.strategy_text ? <p className="mt-1 text-sm leading-normal text-slate-700">{plan.strategy_text}</p> : null}
          <p className="mt-2 text-xs text-slate-500">
            {batch.exam_date
              ? `Exam date ${fmtISTDate(batch.exam_date)}${
                  batch.exam_date_assumed ? " is an assumed default, not a date set for this batch" : " (set for this batch)"
                }.`
              : "No exam date is set for this batch."}
            {touched ? ` What-if: ${days} days; the batch's actual figure is ${batch.days_to_exam ?? "unknown"} days.` : ""}
          </p>
        </div>
        <div className="self-start rounded-md border border-slate-200 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="text-slate-600">Projected score (illustrative)</span>
            <span className="font-semibold tabular-nums text-brand-navy">
              {fmtPctValue(ps.current)} → {fmtPctValue(ps.expected)}
            </span>
          </div>
          <p className="text-right text-xs tabular-nums text-slate-500">
            range {fmtPctValue(ps.low)}–{fmtPctValue(ps.high)}
          </p>
          <div className="relative mt-2 h-2 w-full rounded-sm bg-slate-100 [print-color-adjust:exact]" aria-hidden>
            <div className="absolute inset-y-0 left-0 rounded-sm bg-brand-navy" style={{ width: `${clampPct((ps.current / scale) * 100)}%` }} />
            <div
              className="absolute inset-y-0 rounded-sm bg-brand-cyan/50"
              style={{
                left: `${clampPct((ps.low / scale) * 100)}%`,
                width: `${Math.max(0.8, clampPct((ps.high / scale) * 100) - clampPct((ps.low / scale) * 100))}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-brand-navy align-middle" aria-hidden /> current
            <span className="ml-2 mr-1 inline-block h-2 w-3 rounded-sm bg-brand-cyan/50 align-middle" aria-hidden /> range ·{" "}
            {ps.label || "Illustrative - not a calibrated forecast"}
          </p>
        </div>
      </div>
    </Block>
  );
}

function TopFiveTable({ plan, result, order, showRoi }: { plan: StudyPlan; result: Result; order: Order; showRoi: boolean }) {
  const rows = topRows(plan, result, order);
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No topic with a recoverable gap.</p>;
  }
  return (
    <div className="relative overflow-x-auto print:overflow-visible">
      <table className={cn("w-full border-collapse text-sm print:min-w-0", showRoi ? "min-w-[52rem]" : "min-w-[36rem]")}>
        <caption className="sr-only">Next five topics</caption>
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs text-slate-500">
            <th scope="col" className="px-2 py-2 font-medium">{order === "roi" ? "Rank" : "Order"}</th>
            <th scope="col" className="px-2 py-2 font-medium">Topic</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Mastery</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Exam marks</th>
            {showRoi ? <th scope="col" className="px-2 py-2 text-right font-medium">Base h</th> : null}
            {showRoi ? <th scope="col" className="px-2 py-2 text-right font-medium">Allocated h</th> : null}
            {showRoi ? <th scope="col" className="px-2 py-2 text-right font-medium">ROI</th> : null}
            <th scope="col" className="px-2 py-2 font-medium">Action</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Current → target</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">+marks (range)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, label }) => (
            <tr key={row.topic} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-2 py-2 tabular-nums text-slate-500">{label}</td>
              <th scope="row" className="px-2 py-2 text-left font-normal">
                <span className="font-medium text-slate-800">{row.topic}</span>
                <span className="block text-xs text-slate-500">
                  {row.subject}
                  {row.chapter && row.chapter !== row.topic ? ` · ${row.chapter}` : ""}
                </span>
              </th>
              <td className="px-2 py-2 text-right tabular-nums">{fmtPctValue(row.mastery)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{fmtMarks(row.exam_marks)}</td>
              {showRoi ? <td className="px-2 py-2 text-right tabular-nums">{fmtHours(row.effort_hours)}</td> : null}
              {showRoi ? (
                <td className="px-2 py-2 text-right font-medium tabular-nums text-brand-navy">{fmtHours(row.allocated_hours)}</td>
              ) : null}
              {showRoi ? <td className="px-2 py-2 text-right tabular-nums">{fmtRoi(row.roi)}</td> : null}
              <td className="px-2 py-2 text-slate-700">{ACTION_LABEL[row.action] ?? row.action}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                {fmtPctValue(row.mastery)} → {fmtPctValue(row.target_mastery)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                +{fmtMarks(row.gain_marks)}{" "}
                <span className="text-xs tabular-nums text-slate-500">
                  ({fmtMarks(row.gain_low)}–{fmtMarks(row.gain_high)})
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SW = 360;
const SH = 240;
const PL = 36;
const PR = 12;
const PT = 14;
const PB = 30;

function QuadrantScatter({ topics, showRoi }: { topics: PlanTopic[]; showRoi: boolean }) {
  // With placeholder effort hours (1 h each) ROI per hour is just the gain: plot and name the gain instead.
  const yOf = (t: PlanTopic) => (showRoi ? t.roi : t.gain_marks);
  const yName = showRoi ? "ROI" : "gain";
  const top = topics.reduce((m, t) => Math.max(m, yOf(t)), 0);
  const yMax = top > 0 ? top * 1.15 : 1;
  const x = (mastery: number) => PL + (clampPct(mastery) / 100) * (SW - PL - PR);
  const y = (roi: number) => PT + (1 - Math.min(Math.max(roi, 0), yMax) / yMax) * (SH - PT - PB);
  const splitY = top > 0 ? y(top / 2) : SH - PB - 16;
  // Dodge markers that would sit on top of each other (e.g. several mastered topics at ROI 0).
  const taken: { cx: number; cy: number }[] = [];
  const placed = numbered(topics).map(({ t, n }) => {
    let cx = x(t.mastery);
    const cy = Math.min(y(yOf(t)), SH - PB - 7);
    let guard = 0;
    while (taken.some((p) => Math.abs(p.cx - cx) < 13 && Math.abs(p.cy - cy) < 13) && guard < 12) {
      cx += cx > (PL + SW - PR) / 2 ? -14 : 14;
      guard += 1;
    }
    taken.push({ cx, cy });
    return { t, n, cx, cy };
  });
  return (
    <svg
      viewBox={`0 0 ${SW} ${SH}`}
      className="h-auto w-full [print-color-adjust:exact]"
      role="img"
      aria-label={`Mastery versus ${showRoi ? "ROI" : "expected gain"}: ${topics.map((t) => `${t.topic} ${fmtPctValue(t.mastery)} ${yName} ${showRoi ? fmtRoi(t.roi) : fmtMarks(t.gain_marks)}`).join("; ")}`}
    >
      <rect x={PL} y={PT} width={SW - PL - PR} height={SH - PT - PB} className="fill-white stroke-slate-200" />
      <line x1={x(70)} x2={x(70)} y1={PT} y2={SH - PB} className="stroke-slate-400" strokeDasharray="4 3" />
      {top > 0 ? (
        <line x1={PL} x2={SW - PR} y1={y(top / 2)} y2={y(top / 2)} className="stroke-slate-400" strokeDasharray="4 3" />
      ) : null}
      {[0, 25, 50, 70, 100].map((m) => (
        <text key={m} x={x(m)} y={SH - PB + 12} textAnchor="middle" className="fill-slate-500 text-[9px] tabular-nums">
          {m}
        </text>
      ))}
      <text x={(PL + SW - PR) / 2} y={SH - 4} textAnchor="middle" className="fill-slate-500 text-[9px]">
        Mastery % (threshold 70)
      </text>
      <text x={10} y={(PT + SH - PB) / 2} textAnchor="middle" transform={`rotate(-90 10 ${(PT + SH - PB) / 2})`} className="fill-slate-500 text-[9px]">
        {showRoi ? "ROI (½ of top = high)" : "Expected gain, marks"}
      </text>
      <text x={PL + 4} y={PT + 10} className="fill-rose-700 text-[8px] font-medium">Priority focus</text>
      <text x={SW - PR - 4} y={PT + 10} textAnchor="end" className="fill-lime-800 text-[8px] font-medium">Maintain</text>
      <text x={PL + 4} y={splitY + 11} className="fill-amber-800 text-[8px] font-medium">Deprioritise</text>
      <text x={SW - PR - 4} y={splitY + 11} textAnchor="end" className="fill-slate-500 text-[8px] font-medium">No action</text>
      {placed.map(({ t, n, cx, cy }) => (
        <g key={t.topic}>
          <circle cx={cx} cy={cy} r={6.5} className={cn(QUADRANT_BY_KEY[t.quadrant]?.fill ?? "fill-slate-400", "stroke-white")} strokeWidth={1.5}>
            <title>{`${n}. ${t.topic}: mastery ${fmtPctValue(t.mastery)}, ${yName} ${showRoi ? fmtRoi(t.roi) : fmtMarks(t.gain_marks)} (${QUADRANT_BY_KEY[t.quadrant]?.label ?? t.quadrant})`}</title>
          </circle>
          <text x={cx} y={cy + 2.8} textAnchor="middle" className="pointer-events-none fill-white text-[7.5px] font-semibold">
            {n}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Topics numbered by ROI (highest first): the scatter markers and their legend share these numbers. */
function numbered(topics: PlanTopic[]): { t: PlanTopic; n: number }[] {
  return [...topics]
    .sort((a, b) => b.roi - a.roi || a.mastery - b.mastery || a.topic.localeCompare(b.topic))
    .map((t, i) => ({ t, n: i + 1 }));
}

function ScatterLegend({ topics, showRoi }: { topics: PlanTopic[]; showRoi: boolean }) {
  return (
    <ol className="mt-2 grid gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-600 sm:grid-cols-2">
      {numbered(topics).map(({ t, n }) => (
        <li key={t.topic} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "grid h-4 w-4 shrink-0 place-items-center rounded-sm text-[9px] font-semibold text-white [print-color-adjust:exact]",
              QUADRANT_BY_KEY[t.quadrant]?.dot ?? "bg-slate-400",
            )}
          >
            {n}
          </span>
          <span className="truncate" title={t.quadrant_reason || t.topic}>
            {t.topic} · {fmtPctValue(t.mastery)} · {showRoi ? `ROI ${fmtRoi(t.roi)}` : `+${fmtMarks(t.gain_marks)} marks`}
          </span>
        </li>
      ))}
    </ol>
  );
}

function QuadrantGrid({ topics }: { topics: PlanTopic[] }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200">
      {QUADRANTS.map((q) => {
        const items = topics.filter((t) => t.quadrant === q.key);
        return (
          <div key={q.key} className="min-w-0 bg-white p-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-sm [print-color-adjust:exact]", q.dot)} />
              {q.label}
              <span className="ml-auto tabular-nums text-slate-500">{items.length}</span>
            </p>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">{q.desc}</p>
            {items.length ? (
              <ul className="mt-1.5 space-y-0.5 text-xs text-slate-700">
                {items.map((t) => (
                  <li key={t.topic} className="truncate" title={t.quadrant_reason || t.topic}>
                    {t.topic}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RoiBars({ topics }: { topics: PlanTopic[] }) {
  const sorted = [...topics].sort((a, b) => b.roi - a.roi);
  const top = sorted[0]?.roi ?? 0;
  return (
    <ul className="space-y-2">
      {sorted.map((t) => (
        <li key={t.topic} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-2 text-xs sm:grid-cols-[minmax(0,13rem)_1fr_3rem]">
          <span className="truncate text-slate-700" title={t.topic}>
            {t.topic}
          </span>
          <MeterBar
            size="sm"
            percent={top > 0 ? (t.roi / top) * 100 : 0}
            label={`${t.topic} ROI relative to the top topic`}
            valueText={`ROI ${fmtRoi(t.roi)}`}
            fillClass={QUADRANT_BY_KEY[t.quadrant]?.dot ?? "bg-sky-600"}
            trackClass="bg-slate-100"
          />
          <span className="text-right tabular-nums text-slate-600">{fmtRoi(t.roi)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The engine's formula and arithmetic for #1. With placeholder effort hours (1 h each) the "÷ effort
 * hours" step changes nothing, so it is dropped and the figure is named the expected gain.
 */
function gainOnly(text: string): string {
  return text
    .replace(/\bROI\b/g, "Expected gain")
    .replace(/\s*[/÷]\s*effort hours/gi, "")
    .replace(/\s*[/÷]\s*1(?:\.0+)?\s*h\b/g, "");
}

function Explain({ plan, showRoi }: { plan: StudyPlan; showRoi: boolean }) {
  const ex = plan.explanation;
  const formula = ex ? (showRoi ? ex.formula : gainOnly(ex.formula)) : "";
  const arithmetic = ex ? (showRoi ? ex.arithmetic : gainOnly(ex.arithmetic)) : "";
  return (
    <div className="space-y-3">
      {ex ? (
        <>
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-brand-navy">#1 {ex.topic}.</span> {formula}
          </p>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed text-slate-800">
            {arithmetic}
          </pre>
          <dl className="grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200 text-xs sm:grid-cols-6">
            {[
              ["Exam marks", fmtMarks(ex.inputs.exam_marks)],
              ["Mastery", fmtPctValue(ex.inputs.mastery)],
              ["Target", `${fmtNumber(ex.inputs.target_mastery)}%`],
              ["Time factor", fmtNumber(ex.inputs.time_factor, 3)],
              ...(showRoi
                ? [
                    ["Effort", fmtHours(ex.inputs.effort_hours)],
                    ["ROI", fmtRoi(ex.inputs.roi)],
                  ]
                : []),
            ].map(([k, v]) => (
              <div key={k} className="px-2 py-1.5">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-semibold tabular-nums text-brand-navy">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="text-sm text-slate-500">No ranked topic to explain for these inputs.</p>
      )}
      {showRoi ? null : (
        <p className="text-xs leading-relaxed text-slate-600">
          Effort hours for these topics are a placeholder (1 h each), so no per-hour figure is shown: the order follows the
          marks each topic can still add.
        </p>
      )}
    </div>
  );
}

/** "Fri, 27 Nov" (the report's date format, without the year inside one week). */
function dayLabel(date: string | null): string {
  if (!date) return "";
  const t = Date.parse(`${date}T12:00:00+05:30`);
  return Number.isNaN(t)
    ? ""
    : new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
        .format(t)
        .replace(/^(\w+)\s/, "$1, ");
}

/** The week's study blocks; `notes` (the student's plan) prints each block's note under it. */
export function WeeklyCalendar({ plan, notes = false }: { plan: StudyPlan; notes?: boolean }) {
  const days = plan.weekly_calendar.slice(0, 7);
  if (days.length === 0) return <p className="text-sm text-slate-500">No calendar for these inputs.</p>;
  const plannedMinutes = safeNumber(plan.planned_minutes_total);
  // Same window as the engine: the weekly budget, pro-rated when the exam is under 7 days away.
  const daysLeft = plan.days_to_exam;
  const windowHours =
    daysLeft !== null && daysLeft >= 0 && daysLeft < 7
      ? (safeNumber(plan.study_hours) * Math.max(1, daysLeft)) / 7
      : safeNumber(plan.study_hours);
  const unplacedHours = Math.floor(Math.max(0, windowHours * 60 - plannedMinutes) / 30) / 2;
  return (
    <>
    {unplacedHours > 0 ? (
      <p className="mb-2 text-xs text-slate-500">
        {notes
          ? `These blocks take ${plannedMinutesText(plannedMinutes)} of your ${fmtNumber(windowHours)} h a week; spend the rest on timed mixed practice.`
          : `The blocks below total ${plannedMinutesText(plannedMinutes)} of the ${fmtNumber(windowHours)} h weekly budget (at most 2 topics a day, heavy topics on alternate days); spend the rest on mixed timed practice across all topics.`}
      </p>
    ) : null}
    <ol className={cn("grid grid-cols-1 gap-2", notes ? "sm:grid-cols-2 lg:grid-cols-4 print:grid-cols-4" : "md:grid-cols-7 print:grid-cols-7")}>
      {days.map((d) => {
        const minutes = d.blocks.reduce((m, b) => m + safeNumber(b.minutes), 0);
        return (
          <li key={d.day} className="min-w-0 rounded-md border border-slate-200 bg-white p-2 print:break-inside-avoid">
            <p className="flex items-baseline justify-between gap-1 text-xs">
              <span className="font-semibold tabular-nums text-brand-navy">{dayLabel(d.date) || `Day ${d.day}`}</span>
              <span className="tabular-nums text-slate-500">{minutes} min</span>
            </p>
            {d.blocks.length ? (
              <ul className="mt-1.5 space-y-1">
                {d.blocks.map((b, i) => {
                  const look = ACTIVITY_LOOK[b.activity] ?? ACTIVITY_LOOK.review;
                  return (
                    <li key={i} className={cn("border-l-2 bg-slate-50 px-1.5 py-1 text-xs leading-snug [print-color-adjust:exact]", look.cls)} title={notes ? undefined : b.note}>
                      <span className="font-medium text-slate-800">{look.label}</span> · <span className="tabular-nums">{b.minutes} min</span>
                      <span className={cn("block text-slate-600", !notes && "truncate")}>{b.topic}</span>
                      {notes && b.note ? <span className="mt-0.5 block text-slate-700">{b.note}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1.5 text-xs text-slate-500">Rest / mixed revision</p>
            )}
          </li>
        );
      })}
    </ol>
    </>
  );
}

const STAGE_SPAN: Record<RoadmapStage["horizon"], [number, number]> = {
  "7": [0, 7],
  "30": [7, 30],
  "60": [30, 60],
  "90": [60, 90],
};

/** 7/30/60/90-day roadmap: CSS Gantt on a 0-90 day axis plus one card per stage. */
export function Roadmap({ plan, days }: { plan: StudyPlan; days: number | null }) {
  const stages = plan.roadmap;
  if (stages.length === 0) return <p className="text-sm text-slate-500">No roadmap for these inputs.</p>;
  const examAt = days !== null && days >= 0 && days <= 90 ? (days / 90) * 100 : null;
  return (
    <div>
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <div className="space-y-2">
          {stages.map((s) => {
            const [a, b] = STAGE_SPAN[s.horizon] ?? [0, 7];
            return (
              <div key={s.horizon} className="grid grid-cols-[4.5rem_1fr] items-center gap-2 text-xs">
                <span className={cn("font-medium", s.applicable ? "text-brand-navy" : "text-slate-500")}>{s.days_label}</span>
                <div className="relative h-5 rounded-sm bg-slate-100 [print-color-adjust:exact]">
                  <div
                    className={cn(
                      "absolute inset-y-0 rounded-sm px-1.5 text-[11px] font-medium leading-5 tabular-nums",
                      s.applicable ? "bg-brand-cyan-600 text-white" : "bg-slate-300 text-slate-700",
                    )}
                    style={{ left: `${(a / 90) * 100}%`, width: `${((b - a) / 90) * 100}%` }}
                    title={s.title}
                  >
                    <span className="block truncate">{s.horizon}d</span>
                  </div>
                  {examAt !== null ? (
                    <span aria-hidden className="absolute -inset-y-1 w-0.5 bg-rose-500" style={{ left: `${examAt}%` }} />
                  ) : null}
                </div>
              </div>
            );
          })}
          <div className="grid grid-cols-[4.5rem_1fr] gap-2 text-[11px] tabular-nums text-slate-500" aria-hidden>
            <span>Day</span>
            <div className="relative h-4">
              {[0, 7, 30, 60, 90].map((t) => (
                <span key={t} className={cn("absolute", t === 0 ? "" : t === 90 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${(t / 90) * 100}%` }}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
        {examAt !== null ? (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-rose-700">
            <span aria-hidden className="inline-block h-3 w-0.5 bg-rose-500" /> Exam in {days} days: later stages are greyed out.
          </p>
        ) : null}
      </div>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((s) => (
          <li
            key={s.horizon}
            className={cn(
              "rounded-md border border-slate-200 p-3 text-sm print:break-inside-avoid",
              s.applicable ? "bg-white" : "bg-slate-50 text-slate-500",
            )}
          >
            <p className="text-xs tabular-nums text-slate-500">
              {s.horizon}-day · {s.days_label}
            </p>
            <p className={cn("mt-0.5 font-semibold", s.applicable ? "text-brand-navy" : "text-slate-500")}>{s.title}</p>
            <ul className={cn("mt-1.5 list-disc space-y-0.5 pl-4 text-xs", s.applicable ? "text-slate-700" : "text-slate-500")}>
              {s.tasks.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
            {s.checkpoint ? <p className="mt-2 text-xs"><span className="font-medium">Checkpoint:</span> {s.checkpoint}</p> : null}
            <p className="mt-1 text-xs text-slate-500">{s.applicable ? s.condition : `Not applicable: ${s.condition}`}</p>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-slate-500">Sequential milestones, not an exam countdown; not a score prediction.</p>
    </div>
  );
}

type CompareState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; hours: number; plans: StudyPlan[] }
  | { kind: "error"; message: string };

function Compare({ state, onRun, hours }: { state: CompareState; onRun: () => void; hours: number }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnSecondary} onClick={onRun} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {state.kind === "ready" ? "Refresh comparison" : "Compare 90 / 30 / 7 days"}
        </button>
        <span className="text-xs text-slate-500">Three plans for the same marks at {hours} h/week, fetched in parallel.</span>
      </div>
      {state.kind === "error" ? <Notice tone="warn" className="mt-3">{state.message}</Notice> : null}
      {state.kind === "ready" ? (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {state.plans.map((p, i) => (
            <div key={COMPARE_DAYS[i]} className="rounded-md border border-slate-200 p-3 print:break-inside-avoid">
              <p className="text-base font-semibold tabular-nums text-brand-navy">{COMPARE_DAYS[i]} days</p>
              <Pill className={cn("mt-1", MODE_LOOK[p.strategy_mode].pill)}>{MODE_LOOK[p.strategy_mode].label}</Pill>
              <ol className="mt-2 space-y-1 text-xs text-slate-700">
                {p.focus.slice(0, 3).map((t, j) => (
                  <li key={t.topic} className="flex justify-between gap-2">
                    <span className="truncate">
                      {j + 1}. {t.topic}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {ACTION_LABEL[t.action]} · {fmtHours(t.allocated_hours)}
                    </span>
                  </li>
                ))}
                {p.focus.length === 0 ? <li className="text-slate-500">No focus topics</li> : null}
              </ol>
              <p className="mt-2 text-xs tabular-nums text-slate-500">
                Illustrative {fmtNumber(p.projected_score.current)} → {fmtNumber(p.projected_score.expected)} (
                {fmtNumber(p.projected_score.low)}-{fmtNumber(p.projected_score.high)})
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Preparation ROI Lab (FR-4.3/4.5/4.6/4.7/4.12): an illustrative, deterministic what-if over the
 * study plan. Moving the sliders re-requests GET /api/results/{id}/plan (debounced); the stored plan
 * is the initial data. Nothing here is a calibrated NEET forecast.
 */
export function RoiLab({ result }: { result: Result }) {
  const id = result.submission.id;
  const initial = result.study_plan;
  const batch = result.report_meta.batch;
  const pct = result.percentage;
  const dayMax = Math.max(DAY_MAX_MIN, initial.days_to_exam ?? 0, batch.days_to_exam ?? 0);
  const [days, setDays] = useState(() => clampDays(initial.days_to_exam ?? batch.days_to_exam ?? 120, dayMax));
  const [hours, setHours] = useState(() => clampHours(initial.study_hours || 18));
  const [touched, setTouched] = useState(false);
  const [plans, setPlans] = useState<Record<string, StudyPlan>>({});
  const [last, setLast] = useState<StudyPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order>("observed");
  const [compare, setCompare] = useState<CompareState>({ kind: "idle" });
  const key = `${days}|${hours}`;
  const cached = plans[key];

  useEffect(() => {
    if (!touched || cached) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const raw = await getStudyPlan(id, { daysToExam: days, studyHours: hours });
        if (cancelled) return;
        const plan = normalizePlan(raw, batch, pct);
        setPlans((prev) => ({ ...prev, [key]: plan }));
        setLast(plan);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          errorStatus(err) === 404
            ? "The what-if endpoint (GET /api/results/{id}/plan) is not available on this backend yet; showing the stored plan."
            : `What-if unavailable: ${errorMessage(err)} Showing the last plan.`,
        );
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [touched, cached, id, days, hours, key, batch, pct]);

  const plan = !touched ? initial : (cached ?? last ?? initial);
  const pending = touched && !cached && !error;
  const topics = plan.topics;
  const basis = result.roi_basis;
  const showRoi = basis.effort_source_kind !== "placeholder";
  const shownOrder: Order = showRoi ? order : "observed";

  const moveDays = (n: number) => {
    setTouched(true);
    setDays(clampDays(n, dayMax));
  };
  const moveHours = (n: number) => {
    setTouched(true);
    setHours(clampHours(n));
  };

  async function runCompare() {
    setCompare({ kind: "loading" });
    try {
      const raws = await Promise.all(COMPARE_DAYS.map((d) => getStudyPlan(id, { daysToExam: d, studyHours: hours })));
      setCompare({ kind: "ready", hours, plans: raws.map((r) => normalizePlan(r, batch, pct)) });
    } catch (err) {
      setCompare({
        kind: "error",
        message:
          errorStatus(err) === 404
            ? "Comparison needs GET /api/results/{id}/plan, which this backend does not serve yet."
            : errorMessage(err),
      });
    }
  }

  return (
    <SectionCard
      id="roi-lab"
      title="Study plan lab"
      description="Change the days or weekly hours to recalculate the top five, the quadrants and the plan."
      action={<IllustrativePill />}
    >
      <div className="space-y-4">
        <div className="text-sm">
          <p className="font-medium text-slate-800">Illustrative deterministic prototype - not a calibrated NEET forecast</p>
          <p className="mt-1 text-xs leading-normal text-slate-600">
            Chapter weightage and effort hours are sample values, not from licensed past papers.{" "}
            {result.question_evaluations.some((q) => q.question_type === "mcq")
              ? "MCQ negative marking is already netted into the observed mastery (floored at 0%)."
              : "No negative marking in this rubric."}
          </p>
        </div>

        <div className="border-l-2 border-amber-400 pl-3">
          <p className="text-sm font-medium text-amber-900">Not a forecast</p>
          <p className="mt-0.5 text-sm text-slate-700">There is no calibrated data on how study time turns into marks yet.</p>
          <div className="mt-2 space-y-1 font-mono text-xs leading-relaxed text-slate-600">
            <p>Expected gain = exam marks × (target − mastery) / 100 × time factor</p>
            {showRoi ? <p>Return per hour = expected gain ÷ effort hours</p> : null}
          </div>
        </div>

        <div className="grid gap-4 rounded-md border border-slate-200 p-4 md:grid-cols-2 print:hidden">
          <div>
            <label htmlFor="roi-days" className="flex items-baseline justify-between text-sm font-medium text-slate-700">
              Days to exam
              <span className="text-lg font-semibold tabular-nums text-brand-navy">{days}</span>
            </label>
            <input
              id="roi-days"
              type="range"
              min={DAY_MIN}
              max={dayMax}
              value={days}
              onChange={(e) => moveDays(Number(e.target.value))}
              className="mt-2 w-full accent-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  aria-pressed={days === p.days}
                  onClick={() => moveDays(p.days)}
                  className={cn(
                    "min-h-8 cursor-pointer rounded-sm border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                    days === p.days ? "border-brand-navy bg-brand-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="roi-hours" className="flex items-baseline justify-between text-sm font-medium text-slate-700">
              Study budget (hours / week)
              <span className="text-lg font-semibold tabular-nums text-brand-navy">{hours}</span>
            </label>
            <input
              id="roi-hours"
              type="range"
              min={HOURS_MIN}
              max={HOURS_MAX}
              value={hours}
              onChange={(e) => moveHours(Number(e.target.value))}
              className="mt-2 w-full accent-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
            />
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500" aria-live="polite">
              {pending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Recalculating…
                </>
              ) : touched ? (
                `Plan for ${plan.days_to_exam ?? days} days at ${fmtNumber(plan.study_hours)} h/week`
              ) : (
                `Stored plan for ${plan.days_to_exam ?? days} days at ${fmtNumber(plan.study_hours)} h/week`
              )}
            </p>
          </div>
        </div>
        {error ? <Notice tone="warn">{error}</Notice> : null}

        <div className={cn("space-y-4 transition-opacity duration-150", pending && "opacity-60")}>
          <StrategyCard plan={plan} result={result} touched={touched} days={days} />
          <div>
            <Block
              title="Next five topics"
              aside={
                showRoi ? (
                <div role="group" aria-label="Order" className="flex rounded-md border border-slate-300 text-xs print:hidden">
                  {(
                    [
                      ["observed", "Observed-gap order (qualitative)"],
                      ["roi", "Illustrative ROI"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={order === k}
                      onClick={() => setOrder(k)}
                      className={cn(
"min-h-8 cursor-pointer px-2.5 py-1 font-medium transition-colors duration-150 first:rounded-l-md last:rounded-r-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                        order === k ? "bg-brand-navy text-white" : "bg-white text-slate-600 hover:bg-slate-50",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                ) : null
              }
            >
              <TopFiveTable plan={plan} result={result} order={shownOrder} showRoi={showRoi} />
              {plan.allocation_note ? (
                <p className="mt-2 text-xs text-slate-600">
                  <span className="font-medium text-slate-800">Allocation:</span> {plan.allocation_note}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-slate-500">
                {shownOrder === "observed"
                  ? "Ordered by the marks lost on this paper (P1 = most marks lost)."
                  : "Ordered by the illustrative return per study hour."}
              </p>
            </Block>
          </div>

          {topics.length === 0 ? (
            <Notice tone="info">No topic rows in this plan (the study-plan engine returned none for this record).</Notice>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 print:grid-cols-2">
              <Block title="Four action quadrants">
                <QuadrantGrid topics={topics} />
                <div className="mt-3">
                  <QuadrantScatter topics={topics} showRoi={showRoi} />
                  <ScatterLegend topics={topics} showRoi={showRoi} />
                </div>
              </Block>
              <div className="space-y-4">
                <Block title="Wasted-effort watch">
                  {plan.effort_flags.length === 0 && plan.deprioritised.length === 0 ? (
                    <p className="text-sm text-slate-500">No effort flags for these inputs.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {plan.effort_flags.map((f, i) => (
                        <li key={`f-${i}`} className="border-l-2 border-amber-400 pl-3 text-slate-800">
                          <span className="font-medium">
                            {f.topic} · {f.kind === "over_investing" ? "Over-investing" : "Low marginal return"}
                          </span>
                          <span className="block text-xs leading-normal text-slate-600">{f.message}</span>
                        </li>
                      ))}
                      {plan.deprioritised.map((d, i) => (
                        <li key={`d-${i}`} className="border-l-2 border-slate-300 pl-3 text-slate-800">
                          <span className="font-medium">{d.topic} · Deprioritised</span>
                          <span className="block text-xs leading-normal text-slate-600">{d.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Block>
                {showRoi ? (
                  <Block title="Relative ROI by topic">
                    <RoiBars topics={topics} />
                  </Block>
                ) : null}
              </div>
            </div>
          )}

          <Block title="How #1 was calculated">
            <Explain plan={plan} showRoi={showRoi} />
            {plan.focus[0]?.question_refs.length ? (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                Evidence:
                {plan.focus[0].question_refs.map((q) => (
                  <QRefChip key={q} q={q} />
                ))}
              </p>
            ) : null}
          </Block>

          <Block
            title="This week's calendar"
            aside={<span className="text-xs tabular-nums text-slate-500">{plannedMinutesText(safeNumber(plan.planned_minutes_total))} planned</span>}
          >
            <WeeklyCalendar plan={plan} />
          </Block>

          <Block title="7 / 30 / 60 / 90-day teaching roadmap">
            <Roadmap plan={plan} days={plan.days_to_exam} />
          </Block>

          <Block title="Compare time horizons" className="print:hidden">
            <Compare state={compare} onRun={runCompare} hours={hours} />
          </Block>
        </div>
      </div>
    </SectionCard>
  );
}
