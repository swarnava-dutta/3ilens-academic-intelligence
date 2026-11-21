import type { ClassIntervention, CommonError, ConfusionCluster } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardHeader, TD, TH } from "./card";
import { clampPct, formatPct, shareOf } from "./format";

function StudentNames({ names, max = 4 }: { names: string[]; max?: number }) {
  const list = names ?? [];
  if (list.length === 0) return null;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <p className="mt-0.5 text-xs text-slate-500" title={list.join(", ")}>
      {shown.join(", ")}
      {rest > 0 ? ` +${rest} more` : ""}
    </p>
  );
}

/** "4/12" with a small flat bar of the same share. */
function CountCell({ count, denominator }: { count: number; denominator: number }) {
  const pct = shareOf(count, denominator);
  return (
    <td className={cn(TD, "whitespace-nowrap text-right")} title={formatPct(pct)}>
      <span className="font-semibold text-slate-800">{count}</span>
      <span className="text-slate-500">/{denominator}</span>
      <span className="ml-auto mt-1 block h-1 w-14 bg-slate-100" aria-hidden>
        <span className="block h-full bg-slate-500" style={{ width: `${clampPct(pct)}%` }} />
      </span>
    </td>
  );
}

/** Errors repeated across students, per question (count over the completed denominator). */
export function CommonErrorsCard({ errors, denominator }: { errors: CommonError[]; denominator: number }) {
  const list = (errors ?? []).filter((e) => e && typeof e.topic === "string");
  return (
    <Card aria-labelledby="cohort-errors-title">
      <CardHeader id="cohort-errors-title" title="Common errors" subtitle="Mistakes repeated across students, by question" />
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No error is shared by two or more students in this view.</p>
      ) : (
        <div className="-mx-3 mt-2 overflow-x-auto">
          <table className="w-full min-w-[440px] border-collapse">
            <caption className="sr-only">Common errors by question</caption>
            <thead className="border-b border-slate-200">
              <tr>
                <th scope="col" className={TH}>
                  Q
                </th>
                <th scope="col" className={TH}>
                  Error
                </th>
                <th scope="col" className={cn(TH, "text-right")}>
                  Students
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((e, i) => (
                <tr key={`${e.question}-${i}`}>
                  <th scope="row" className={cn(TD, "text-left font-semibold whitespace-nowrap text-brand-navy")}>
                    Q{e.question}
                  </th>
                  <td className={TD}>
                    <p className="text-xs text-slate-500">{e.topic}</p>
                    <p className="text-slate-800">{e.error}</p>
                    <StudentNames names={e.students} />
                  </td>
                  <CountCell count={e.count} denominator={e.denominator || denominator} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Whole-class teaching actions derived from the shared weak topics. */
export function InterventionsCard({ interventions }: { interventions: ClassIntervention[] }) {
  const list = (interventions ?? []).filter((x) => x && typeof x.topic === "string");
  return (
    <Card aria-labelledby="cohort-interventions-title">
      <CardHeader id="cohort-interventions-title" title="Class interventions" subtitle="What to teach the group next, and why" />
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No class-wide intervention needed in this view.</p>
      ) : (
        <ol className="mt-1 divide-y divide-slate-100">
          {list.map((x, i) => (
            <li key={`${x.topic}-${i}`} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 py-2.5">
              <span className="text-sm tabular-nums text-slate-500">{i + 1}.</span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm font-semibold text-brand-navy">{x.topic}</span>
                  <span className="text-xs tabular-nums text-slate-500">
                    {x.students_count} {x.students_count === 1 ? "student" : "students"}
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-slate-700">{x.action}</p>
                {x.rationale ? <p className="mt-0.5 text-xs text-slate-500">{x.rationale}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Concept pairs students mix up ("Incomplete dominance / Codominance: 4/12 students"). */
export function ConfusionsCard({ clusters, denominator }: { clusters: ConfusionCluster[]; denominator: number }) {
  const list = (clusters ?? []).filter((c) => c && typeof c.concept_a === "string");
  return (
    <Card aria-labelledby="cohort-confusions-title">
      <CardHeader id="cohort-confusions-title" title="Concept confusions" subtitle="Concepts students mix up with each other" />
      {list.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No repeated concept confusion detected in this view.</p>
      ) : (
        <div className="-mx-3 mt-2 overflow-x-auto">
          <table className="w-full min-w-[360px] border-collapse">
            <caption className="sr-only">Concept confusions</caption>
            <thead className="border-b border-slate-200">
              <tr>
                <th scope="col" className={TH}>
                  Concept pair
                </th>
                <th scope="col" className={cn(TH, "text-right")}>
                  Students
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((c, i) => (
                <tr key={`${c.concept_a}-${c.concept_b}-${i}`}>
                  <th scope="row" className={cn(TD, "text-left font-normal")}>
                    <p className="text-slate-800">
                      <span className="font-medium">{c.concept_a}</span>
                      <span className="mx-1.5 text-slate-400" aria-label="confused with">
                        ↔
                      </span>
                      <span className="font-medium">{c.concept_b}</span>
                    </p>
                    <StudentNames names={c.students} />
                  </th>
                  <CountCell count={c.count} denominator={denominator} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
