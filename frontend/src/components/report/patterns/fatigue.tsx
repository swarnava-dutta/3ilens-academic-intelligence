"use client";

import { BatteryLow, Table2 } from "lucide-react";
import { useId, useState } from "react";
import { RiskBadge } from "@/components/shared/risk-badge";
import type { FatigueProfile } from "@/lib/types";
import { fmtNumber } from "../format";
import { SectionCard } from "../primitives";
import { NullProfile, Recommendation, Stat, pct } from "./shared";

const W = 300;
const H = 90;
const TOP = 12;

/** One bar per question (height = accuracy), final third shaded, cohort dots, blanks hatched. */
function FatigueStrip({ profile }: { profile: FatigueProfile }) {
  const ids = useId().replace(/:/g, "");
  const series = [...profile.series].sort((a, b) => a.question - b.question);
  const n = Math.max(series.length, 1);
  const slot = W / n;
  const bar = Math.max(slot * 0.7, 1);
  const firstLate = series.findIndex((q) => q.final_third);
  const plotH = H - TOP;
  const showLabels = n <= 30;

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H + (showLabels ? 10 : 0)}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Accuracy per question in paper order: early ${pct(profile.early_accuracy)}, final third ${pct(
          profile.late_accuracy,
        )}. Use the data table toggle for the values.`}
      >
        <defs>
          <pattern id={`${ids}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="#94a3b8" strokeWidth="1.5" />
          </pattern>
        </defs>
        {firstLate >= 0 ? (
          <>
            <rect x={firstLate * slot} y={0} width={W - firstLate * slot} height={H} className="fill-amber-100" />
            <text x={W - 2} y={8} textAnchor="end" className="fill-amber-900 text-[7px] font-semibold">
              Final third
            </text>
          </>
        ) : null}
        <line x1={0} y1={H} x2={W} y2={H} className="stroke-slate-300" strokeWidth={0.5} />
        {series.map((q, i) => {
          const x = i * slot + (slot - bar) / 2;
          const h = q.blank ? plotH : Math.max(q.accuracy * plotH, 1.5); // a 1.5-unit stub keeps a 0% bar visible
          return (
            <g key={q.question}>
              <rect
                x={x}
                y={H - h}
                width={bar}
                height={h}
                fill={q.blank ? `url(#${ids}-hatch)` : undefined}
                className={q.blank ? "stroke-slate-400" : q.final_third ? "fill-amber-500" : "fill-brand-cyan"}
                strokeWidth={q.blank ? 0.4 : 0}
              >
                <title>
                  {`Q${q.question}: ${q.blank ? "blank" : pct(q.accuracy)}${
                    q.cohort_accuracy !== null ? ` · cohort ${pct(q.cohort_accuracy)}` : ""
                  }`}
                </title>
              </rect>
              {q.cohort_accuracy !== null ? (
                <circle
                  cx={i * slot + slot / 2}
                  cy={H - q.cohort_accuracy * plotH}
                  r={Math.min(2.2, slot / 3)}
                  className="fill-brand-navy"
                />
              ) : null}
              {showLabels ? (
                <text x={i * slot + slot / 2} y={H + 8} textAnchor="middle" className="fill-slate-500 text-[6px]">
                  {q.question}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-brand-cyan" aria-hidden /> accuracy, first two thirds
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" aria-hidden /> final third (shaded)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-slate-400 bg-[repeating-linear-gradient(45deg,#94a3b8_0_1px,transparent_1px_4px)]" aria-hidden />{" "}
          blank
        </span>
        {series.some((q) => q.cohort_accuracy !== null) ? (
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-brand-navy" aria-hidden /> cohort accuracy
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** FR-4.10: accuracy in the final third of the paper vs the rest (cohort-adjusted when possible). */
export function FatigueCard({ profile, note, className }: { profile: FatigueProfile | null; note: string; className?: string }) {
  const [table, setTable] = useState(false);
  const series = [...(profile?.series ?? [])].sort((a, b) => a.question - b.question);
  return (
    <SectionCard
      id="pattern-fatigue"
      title="Fatigue"
      description="Accuracy across the paper, in question order."
      icon={BatteryLow}
      action={
        profile ? (
          <RiskBadge
            risk={profile.severity}
            label={profile.flagged ? `Fatigue: ${profile.severity}` : "No fatigue flag"}
          />
        ) : null
      }
      className={className}
    >
      {!profile ? (
        <NullProfile text={note} />
      ) : (
        <div className="space-y-4">
          <FatigueStrip profile={profile} />
          <dl className="grid grid-cols-2 gap-2">
            <Stat
              label="Early vs late"
              value={`${pct(profile.early_accuracy)} → ${pct(profile.late_accuracy)}`}
              sub={`final third from Q${profile.final_third_from}`}
            />
            <Stat
              label="Drop"
              value={`${fmtNumber(profile.drop_pts)} pts`}
              sub={
                profile.adjusted_drop_pts !== null
                  ? `${fmtNumber(profile.adjusted_drop_pts)} pts cohort-adjusted (n=${profile.cohort_size})`
                  : `raw - cohort adjustment needs ≥ 5 results (n=${profile.cohort_size})`
              }
            />
          </dl>
          <p className="text-xs text-slate-600">
            Blank rate {pct(profile.early_blank_rate)} early vs {pct(profile.late_blank_rate)} in the final third.
          </p>
          {profile.reasons.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
              {profile.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
          <Recommendation>{profile.recommendation}</Recommendation>

          <div>
            <button
              type="button"
              onClick={() => setTable((v) => !v)}
              aria-expanded={table}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-brand-navy ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
            >
              <Table2 className="h-3.5 w-3.5" aria-hidden />
              {table ? "Hide data table" : "Show data table"}
            </button>
            {table ? (
              <div className="relative mt-2 max-h-64 overflow-auto rounded-lg ring-1 ring-inset ring-slate-200">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Accuracy per question</caption>
                  <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-2.5 py-1.5">Q</th>
                      <th scope="col" className="px-2.5 py-1.5 text-right">Accuracy</th>
                      <th scope="col" className="px-2.5 py-1.5 text-right">Cohort</th>
                      <th scope="col" className="px-2.5 py-1.5">Part</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((q) => (
                      <tr key={q.question} className="border-t border-slate-100">
                        <th scope="row" className="px-2.5 py-1 font-medium">Q{q.question}</th>
                        <td className="px-2.5 py-1 text-right tabular-nums">{q.blank ? "blank" : pct(q.accuracy)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums">{pct(q.cohort_accuracy)}</td>
                        <td className="px-2.5 py-1">{q.final_third ? "final third" : "early"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
