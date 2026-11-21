"use client";

import Link from "next/link";
import { ArrowUpRight, Lightbulb, Users } from "lucide-react";
import { URGENCY_ORDER, UrgencyBadge } from "@/components/shared/urgency-badge";
import type { ClassIntervention, NudgePriority, StudentCard, TeachingNudge } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NUDGE_LOOK, SOURCE_LABEL } from "@/components/report/format";

const PRIORITY_ORDER: Record<NudgePriority, number> = { high: 0, medium: 1, low: 2 };

type Row = { card: StudentCard; nudge: TeachingNudge };

/** Every nudge of the completed students, most urgent student first, then nudge priority. */
export function nudgeRows(cards: StudentCard[]): Row[] {
  return cards
    .filter((c) => c.status === "COMPLETED")
    .flatMap((card) => card.nudges.map((nudge) => ({ card, nudge })))
    .sort(
      (a, b) =>
        (a.card.urgency ? URGENCY_ORDER[a.card.urgency] : 3) - (b.card.urgency ? URGENCY_ORDER[b.card.urgency] : 3) ||
        (a.card.percentage ?? 0) - (b.card.percentage ?? 0) ||
        PRIORITY_ORDER[a.nudge.priority] - PRIORITY_ORDER[b.nudge.priority] ||
        a.card.student_name.localeCompare(b.card.student_name),
    );
}

export function NudgesView({
  cards,
  interventions,
  interventionsNote,
}: {
  cards: StudentCard[];
  interventions: ClassIntervention[] | null;
  /** Shown when the cohort interventions could not be loaded. */
  interventionsNote?: string | null;
}) {
  const rows = nudgeRows(cards);
  return (
    <div className="space-y-6">
      <section aria-labelledby="class-interventions" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 id="class-interventions" className="flex items-center gap-2 text-lg font-semibold text-brand-navy">
          <Users className="h-5 w-5 text-brand-cyan-600" aria-hidden />
          Class interventions
        </h2>
        <p className="mt-0.5 text-sm text-slate-500">Topics where several students in the current filter need the same teaching move.</p>
        {interventions === null ? (
          <p className="mt-3 text-sm text-slate-500">{interventionsNote ?? "Loading…"}</p>
        ) : interventions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No shared intervention: gaps are individual in this group.</p>
        ) : (
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {interventions.map((iv, i) => (
              <li key={`${iv.topic}-${i}`} className="rounded-xl border border-brand-cyan/30 bg-brand-cyan-50/60 p-3">
                <p className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold text-brand-navy">{iv.topic}</span>
                  <span className="text-xs font-medium text-cyan-800">
                    {iv.students_count} {iv.students_count === 1 ? "student" : "students"}
                  </span>
                </p>
                <p className="mt-1 text-sm text-slate-700">{iv.action}</p>
                {iv.rationale ? <p className="mt-1 text-xs text-slate-500">{iv.rationale}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="student-nudges" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 id="student-nudges" className="flex items-center gap-2 text-lg font-semibold text-brand-navy">
          <Lightbulb className="h-5 w-5 text-brand-cyan-600" aria-hidden />
          Teaching nudges
        </h2>
        <p className="mt-0.5 text-sm text-slate-500">At risk first, then needs attention, then on track. Each nudge cites its question.</p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No nudges for the students in this filter.</p>
        ) : (
          <ol className="mt-3 divide-y divide-slate-100">
            {rows.map(({ card, nudge }, i) => (
              <li key={`${card.submission_id}-${i}`} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="w-full shrink-0 sm:w-52">
                  <Link href={`/report/${card.submission_id}`} className="font-medium text-brand-navy hover:text-brand-cyan-600">
                    {card.student_name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <UrgencyBadge urgency={card.urgency} size="sm" />
                    {card.is_demo ? <span className="text-[10px] font-medium uppercase text-lime-700">synthetic</span> : null}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", NUDGE_LOOK[nudge.priority].pill)}>
                      {NUDGE_LOOK[nudge.priority].label}
                    </span>
                    <span className="font-semibold text-slate-800">{nudge.label || "Teaching nudge"}</span>
                    <span className="text-[11px] text-slate-400">{SOURCE_LABEL[nudge.source]}</span>
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-700">{nudge.text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {nudge.topic ? <span>{nudge.topic}</span> : null}
                    {nudge.question_refs.length ? <span className="font-mono">Q{nudge.question_refs.join(", Q")}</span> : null}
                    <Link
                      href={`/report/${card.submission_id}${nudge.question_refs[0] ? `#q-${nudge.question_refs[0]}` : ""}`}
                      className="inline-flex items-center gap-0.5 font-medium text-brand-cyan-600 hover:text-brand-navy"
                    >
                      Report <ArrowUpRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
