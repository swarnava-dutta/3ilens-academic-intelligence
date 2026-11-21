import { Compass, Sparkles } from "lucide-react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Priority } from "@/lib/types";
import { cn, formatWeight } from "@/lib/utils";
import { Card, CardHeader } from "./card";
import { clampPct, formatHours, formatPct, formatRoi, num, toneFor } from "./format";

function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
        rank === 1 ? "bg-brand-navy text-white" : "bg-slate-100 text-slate-600",
      )}
      aria-label={`Rank ${rank}`}
    >
      {rank}
    </span>
  );
}

function RoiBar({ roi, max, className }: { roi: number | null; max: number; className?: string }) {
  const width = roi !== null && max > 0 ? clampPct((roi / max) * 100) : 0;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-2 min-w-16 flex-1 rounded-full bg-brand-cyan-50" aria-hidden>
        <div
          className="h-full rounded-full bg-linear-to-r from-brand-cyan to-brand-lime transition-[width] duration-700"
          style={{ width: `${Math.max(width, roi !== null && roi > 0 ? 4 : 0)}%` }}
        />
      </div>
      <span className="w-11 text-right text-sm font-bold tabular-nums text-brand-navy">{formatRoi(roi)}</span>
    </div>
  );
}

function MasteryCell({ mastery }: { mastery: number | null }) {
  const tone = toneFor(mastery);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className={cn("h-2 w-2 rounded-full", tone.dot)} aria-hidden />
      {formatPct(mastery)}
    </span>
  );
}

function FormulaCaption() {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
      <span className="rounded-md bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200">
        ROI = (weightage × gain potential) ÷ effort hours
      </span>
      <span>
        Gain potential = 100 − cohort mastery · weightage and effort hours come from a sample chapter matrix, not
        licensed past-paper data, so the ranking is a teaching aid rather than a score forecast.
      </span>
    </p>
  );
}

export function Priorities({ priorities }: { priorities: Priority[] }) {
  const rows = (priorities ?? [])
    .filter((p) => p && typeof p.topic === "string")
    .map((p) => ({ ...p, roiValue: num(p.roi) }));
  const maxRoi = rows.reduce((m, p) => Math.max(m, p.roiValue ?? 0), 0);

  return (
    <Card aria-labelledby="cohort-priorities-title">
      <CardHeader
        id="cohort-priorities-title"
        icon={Compass}
        title="Cohort Preparation Priorities"
        subtitle="Where focused revision returns the most marks for this batch, highest ROI first"
        action={
          <span className="flex flex-wrap items-center gap-2">
            <IllustrativePill />
            {rows.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-lime-50 px-3 py-1 text-xs font-medium text-lime-800 ring-1 ring-inset ring-brand-lime/50">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Top {rows.length} {rows.length === 1 ? "topic" : "topics"}
              </span>
            ) : null}
          </span>
        }
      />

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl bg-brand-lime-50 px-4 py-6 text-center text-sm text-lime-800">
          No open priorities: every assessed topic is already mastered by this cohort.
        </p>
      ) : (
        <>
          {/* Desktop: full table */}
          <div className="mt-5 hidden overflow-x-auto lg:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Cohort preparation priorities ranked by ROI, with mastery, gain potential, weightage,
                effort hours and rationale
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-500">
                  <th scope="col" className="py-2 pr-3 font-medium">#</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Topic</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Subject</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Avg mastery</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Gain</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Weight</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Effort</th>
                  <th scope="col" className="w-48 py-2 pr-3 font-medium">ROI</th>
                  <th scope="col" className="py-2 font-medium">Rationale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((p, i) => (
                  <tr key={`${i}-${p.topic}`} className="align-top transition-colors hover:bg-slate-50/80">
                    <td className="py-3 pr-3">
                      <RankBadge rank={i + 1} />
                    </td>
                    <td className="py-3 pr-3 font-semibold text-brand-navy">{p.topic}</td>
                    <td className="py-3 pr-3 text-slate-600">{p.subject}</td>
                    <td className="py-3 pr-3 text-right text-slate-700">
                      <MasteryCell mastery={num(p.mastery)} />
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-slate-700">
                      +{formatPct(p.gain_potential)}
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-slate-700">
                      {num(p.weightage) === null ? "—" : formatWeight(p.weightage)}
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-slate-700">
                      {formatHours(p.effort_hours)}
                    </td>
                    <td className="py-3 pr-3">
                      <RoiBar roi={p.roiValue} max={maxRoi} />
                    </td>
                    <td className="max-w-sm py-3 text-xs leading-relaxed text-slate-600">{p.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile / tablet: stacked cards */}
          <ol className="mt-5 space-y-3 lg:hidden">
            {rows.map((p, i) => (
              <li key={`${i}-${p.topic}`} className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-start gap-3">
                  <RankBadge rank={i + 1} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-brand-navy">{p.topic}</p>
                    <p className="text-xs text-slate-500">{p.subject}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">ROI</p>
                  <RoiBar roi={p.roiValue} max={maxRoi} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                  {[
                    ["Avg mastery", <MasteryCell key="m" mastery={num(p.mastery)} />],
                    ["Gain", `+${formatPct(p.gain_potential)}`],
                    ["Weight", num(p.weightage) === null ? "—" : formatWeight(p.weightage)],
                    ["Effort", formatHours(p.effort_hours)],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-lg bg-slate-50 px-2 py-2">
                      <dt className="text-[11px] text-slate-500">{label}</dt>
                      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{value}</dd>
                    </div>
                  ))}
                </dl>
                {p.rationale ? <p className="mt-3 text-sm leading-relaxed text-slate-600">{p.rationale}</p> : null}
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4">
        <FormulaCaption />
      </div>
    </Card>
  );
}
