import { IllustrativePill } from "@/components/shared/illustrative-pill";
import type { Priority } from "@/lib/types";
import { cn, formatWeight } from "@/lib/utils";
import { Card, CardHeader, TD, TH } from "./card";
import { clampPct, formatHours, formatPct, formatRoi, num, toneFor } from "./format";

function RoiBar({ roi, max }: { roi: number | null; max: number }) {
  const width = roi !== null && max > 0 ? clampPct((roi / max) * 100) : 0;
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 min-w-16 flex-1 bg-slate-100" aria-hidden>
        <span
          className="block h-full bg-brand-cyan-600"
          style={{ width: `${Math.max(width, roi !== null && roi > 0 ? 4 : 0)}%` }}
        />
      </span>
      <span className="w-11 text-right font-semibold text-brand-navy">{formatRoi(roi)}</span>
    </span>
  );
}

function MasteryCell({ mastery }: { mastery: number | null }) {
  const tone = toneFor(mastery);
  return (
    <span className="inline-flex items-center gap-1.5" title={tone.label}>
      <span className={cn("h-2 w-2 rounded-sm", tone.dot)} aria-hidden />
      {formatPct(mastery)}
    </span>
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
        title="Cohort preparation priorities"
        subtitle={`Where focused revision returns the most marks for this batch, highest ROI first${
          rows.length ? ` · top ${rows.length} ${rows.length === 1 ? "topic" : "topics"}` : ""
        }`}
        action={<IllustrativePill />}
      />

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No open priorities: every assessed topic is already mastered by this cohort.</p>
      ) : (
        <div className="-mx-3 mt-2 overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse">
            <caption className="sr-only">
              Cohort preparation priorities ranked by ROI, with mastery, gain potential, weightage, effort hours and
              rationale
            </caption>
            <thead className="border-b border-slate-200">
              <tr>
                <th scope="col" className={cn(TH, "text-right")}>#</th>
                <th scope="col" className={TH}>Topic</th>
                <th scope="col" className={TH}>Subject</th>
                <th scope="col" className={cn(TH, "text-right")}>Avg mastery</th>
                <th scope="col" className={cn(TH, "text-right")}>Gain</th>
                <th scope="col" className={cn(TH, "text-right")}>Weight</th>
                <th scope="col" className={cn(TH, "text-right")}>Effort</th>
                <th scope="col" className={cn(TH, "w-44")}>ROI</th>
                <th scope="col" className={TH}>Rationale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p, i) => (
                <tr key={`${i}-${p.topic}`}>
                  <td className={cn(TD, "text-right text-slate-500")}>{i + 1}</td>
                  <th scope="row" className={cn(TD, "text-left font-semibold text-brand-navy")}>{p.topic}</th>
                  <td className={cn(TD, "text-slate-600")}>{p.subject}</td>
                  <td className={cn(TD, "text-right")}>
                    <MasteryCell mastery={num(p.mastery)} />
                  </td>
                  <td className={cn(TD, "text-right")}>+{formatPct(p.gain_potential)}</td>
                  <td className={cn(TD, "text-right")}>{num(p.weightage) === null ? "—" : formatWeight(p.weightage)}</td>
                  <td className={cn(TD, "text-right whitespace-nowrap")}>{formatHours(p.effort_hours)}</td>
                  <td className={TD}>
                    <RoiBar roi={p.roiValue} max={maxRoi} />
                  </td>
                  <td className={cn(TD, "max-w-sm text-xs leading-relaxed text-slate-600")}>{p.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500">
        <span className="font-mono text-[11px] text-slate-700">ROI = (weightage × gain potential) ÷ effort hours</span>.
        Gain potential = 100 − cohort mastery. Weightage and effort hours come from a sample chapter matrix, not licensed
        past-paper data, so the ranking is a teaching aid rather than a score forecast.
      </p>
    </Card>
  );
}
