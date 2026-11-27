import type { Result, TeachingNudge } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActionPlanTable, ConfusionsCard, InterventionChooser } from "../action-plan";
import { ExecutiveSummaryCard } from "../executive-summary";
import { NUDGE_LOOK, SOURCE_LABEL } from "../format";
import { QRefChip, observedPriorities } from "../immediate-reading";
import { InterventionsPanel } from "../interventions-panel";
import { Pill, SectionCard } from "../primitives";

function Nudge({ nudge }: { nudge: TeachingNudge }) {
  const look = NUDGE_LOOK[nudge.priority];
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className={cn("text-[11px]", look.pill)}>{look.label}</Pill>
        <span className="font-semibold text-[#1E3A8A]">{nudge.label || "Teaching nudge"}</span>
        <span className="ml-auto text-xs text-slate-500">{SOURCE_LABEL[nudge.source]}</span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-700">{nudge.text}</p>
      {nudge.question_refs.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {nudge.question_refs.map((q) => (
            <QRefChip key={q} q={q} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** "2 priorities · 3 nudges" for the fold teaser. */
export function teachingTeaser(result: Result): string {
  const p = observedPriorities(result).length;
  const n = result.teaching_nudges.length;
  const i = result.interventions.length;
  return [
    `${p} ${p === 1 ? "priority" : "priorities"}`,
    `${n} ${n === 1 ? "nudge" : "nudges"}`,
    i ? `${i} recorded ${i === 1 ? "intervention" : "interventions"}` : "record an intervention",
  ].join(" · ");
}

/**
 * F7 "Teaching actions" (faculty): the intervention chooser and the evidence-linked action table
 * (each priority's questions listed once, in the table), teaching nudges, concept confusions when
 * there are any, the intervention log and the faculty summary.
 */
export function TeachingActions({ result }: { result: Result }) {
  return (
    <div className="space-y-4">
      <InterventionChooser result={result} showTriggers={false} />
      <ActionPlanTable result={result} />
      {result.teaching_nudges.length ? (
        <SectionCard id="teaching-nudges" title="Teaching nudges" description="Short prompts for the next class.">
          <ul className="divide-y divide-slate-200">
            {result.teaching_nudges.map((n, i) => (
              <Nudge key={`${n.label}-${i}`} nudge={n} />
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {result.confusions.length ? <ConfusionsCard result={result} /> : null}
      <InterventionsPanel result={result} />
      <ExecutiveSummaryCard result={result} />
    </div>
  );
}
