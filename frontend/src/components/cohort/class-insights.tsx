import { GitCompareArrows, Lightbulb, SearchX } from "lucide-react";
import type { ClassIntervention, CommonError, ConfusionCluster } from "@/lib/types";
import { Card, CardHeader } from "./card";
import { clampPct, plural, shareOf } from "./format";

function StudentNames({ names, max = 4 }: { names: string[]; max?: number }) {
  const list = names ?? [];
  if (list.length === 0) return null;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <p className="mt-1 text-xs text-slate-500" title={list.join(", ")}>
      {shown.join(", ")}
      {rest > 0 ? ` +${rest} more` : ""}
    </p>
  );
}

function CountBar({ count, denominator, tone }: { count: number; denominator: number; tone: string }) {
  const pct = shareOf(count, denominator) ?? 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 min-w-16 flex-1 rounded-full bg-slate-100" aria-hidden>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(clampPct(pct), count > 0 ? 3 : 0)}%` }} />
      </div>
      <span className="w-14 text-right text-xs font-semibold tabular-nums text-slate-700">
        {count}/{denominator}
      </span>
    </div>
  );
}

/** Errors repeated across students, per question (count over the completed denominator). */
export function CommonErrorsCard({ errors, denominator }: { errors: CommonError[]; denominator: number }) {
  const list = (errors ?? []).filter((e) => e && typeof e.topic === "string");
  return (
    <Card aria-labelledby="cohort-errors-title">
      <CardHeader
        id="cohort-errors-title"
        icon={SearchX}
        title="Common errors"
        subtitle="Mistakes repeated across students, by question"
      />
      {list.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">No error is shared by two or more students in this view.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {list.map((e, i) => (
            <li key={`${e.question}-${i}`} className="rounded-xl border border-slate-200 px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-semibold text-brand-navy">
                  Q{e.question} <span className="font-normal text-slate-500">· {e.topic}</span>
                </p>
                <span className="text-xs text-slate-500">
                  {plural(e.count, "student")} of {e.denominator || denominator}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-700">{e.error}</p>
              <div className="mt-2">
                <CountBar count={e.count} denominator={e.denominator || denominator} tone="bg-rose-400" />
              </div>
              <StudentNames names={e.students} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Whole-class teaching actions derived from the shared weak topics. */
export function InterventionsCard({ interventions }: { interventions: ClassIntervention[] }) {
  const list = (interventions ?? []).filter((x) => x && typeof x.topic === "string");
  return (
    <Card aria-labelledby="cohort-interventions-title">
      <CardHeader
        id="cohort-interventions-title"
        icon={Lightbulb}
        title="Class interventions"
        subtitle="What to teach the group next, and why"
      />
      {list.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">No class-wide intervention needed in this view.</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {list.map((x, i) => (
            <li key={`${x.topic}-${i}`} className="flex gap-3">
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-cyan-50 text-xs font-bold text-brand-cyan-600">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brand-navy">
                  {x.topic}{" "}
                  <span className="font-normal text-slate-500">· {plural(x.students_count, "student")}</span>
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

/** Concept pairs students mix up ("Incomplete dominance ↔ Codominance: 4/12 students"). */
export function ConfusionsCard({ clusters, denominator }: { clusters: ConfusionCluster[]; denominator: number }) {
  const list = (clusters ?? []).filter((c) => c && typeof c.concept_a === "string");
  return (
    <Card aria-labelledby="cohort-confusions-title">
      <CardHeader
        id="cohort-confusions-title"
        icon={GitCompareArrows}
        title="Concept confusions"
        subtitle="Concepts students mix up with each other"
      />
      {list.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">No repeated concept confusion detected in this view.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {list.map((c, i) => (
            <li key={`${c.concept_a}-${c.concept_b}-${i}`}>
              <p className="text-sm text-slate-800">
                <span className="font-semibold">{c.concept_a}</span>
                <span className="mx-1.5 text-violet-500" aria-label="confused with">
                  ↔
                </span>
                <span className="font-semibold">{c.concept_b}</span>
                <span className="text-slate-500">
                  : {c.count}/{denominator} students
                </span>
              </p>
              <div className="mt-1.5">
                <CountBar count={c.count} denominator={denominator} tone="bg-violet-400" />
              </div>
              <StudentNames names={c.students} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
