"use client";

import Link from "next/link";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import type { FocusItem, StudentCard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtNumber } from "@/components/report/format";

/** Rank 1 (darkest) to 5 (lightest). */
const RANK_CELL: Record<number, string> = {
  1: "bg-brand-navy text-white",
  2: "bg-brand-navy-700/85 text-white",
  3: "bg-brand-cyan-600 text-white",
  4: "bg-brand-cyan/60 text-brand-navy",
  5: "bg-brand-cyan-50 text-brand-navy",
};

function cellClass(rank: number): string {
  return RANK_CELL[Math.min(5, Math.max(1, Math.round(rank)))] ?? RANK_CELL[5];
}

/** Topics in anyone's top five, most common first (ties: better mean rank, then name). */
export function focusTopics(cards: StudentCard[]): { topic: string; count: number; meanRank: number }[] {
  const by = new Map<string, number[]>();
  for (const c of cards) for (const f of c.top_focus) by.set(f.topic, [...(by.get(f.topic) ?? []), f.rank]);
  return [...by.entries()]
    .map(([topic, ranks]) => ({ topic, count: ranks.length, meanRank: ranks.reduce((a, b) => a + b, 0) / ranks.length }))
    .sort((a, b) => b.count - a.count || a.meanRank - b.meanRank || a.topic.localeCompare(b.topic));
}

/**
 * Preparation focus: a student x topic matrix shaded by each student's illustrative ROI rank
 * (1-5, from StudentCard.top_focus). Clicking a topic header filters the page to that topic.
 */
export function FocusMatrix({
  cards,
  activeTopic,
  onTopic,
}: {
  cards: StudentCard[];
  activeTopic: string | null;
  onTopic: (topic: string | null) => void;
}) {
  const students = cards.filter((c) => c.status === "COMPLETED");
  const topics = focusTopics(students);

  return (
    <section aria-labelledby="focus-matrix" className="rounded-md border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <h2 id="focus-matrix" className="text-[15px] font-semibold text-brand-navy">
            Preparation focus
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Each student&apos;s top five study topics; darker = higher rank. Click a topic to filter.
          </p>
        </div>
        <IllustrativePill />
      </div>

      {students.length === 0 || topics.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No completed student has a ranked focus topic in this filter.
        </p>
      ) : (
        <div className="mt-4 relative overflow-x-auto print:overflow-visible">
          <table className="min-w-full border-collapse text-xs">
            <caption className="sr-only">Preparation focus by student and topic</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5 text-left align-bottom font-medium text-slate-500">
                  Student
                </th>
                {topics.map((t) => (
                  <th key={t.topic} scope="col" className="min-w-[5.5rem] max-w-[8rem] border-b border-slate-200 px-0.5 py-1 align-bottom">
                    <button
                      type="button"
                      onClick={() => onTopic(activeTopic === t.topic ? null : t.topic)}
                      aria-pressed={activeTopic === t.topic}
                      title={activeTopic === t.topic ? "Clear the topic filter" : `Filter to ${t.topic}`}
                      className={cn(
                        "min-h-8 w-full rounded-sm px-1.5 py-1 text-left text-xs font-medium leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-cyan",
                        activeTopic === t.topic ? "bg-brand-cyan-50 text-brand-cyan-600 underline" : "text-brand-navy hover:bg-slate-100",
                      )}
                    >
                      {t.topic}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => {
                const byTopic = new Map<string, FocusItem>(s.top_focus.map((f) => [f.topic, f]));
                return (
                  <tr key={s.submission_id}>
                    <th scope="row" className="sticky left-0 z-10 border-b border-slate-100 bg-white px-2 py-1 text-left font-normal">
                      <Link href={`/report/${s.submission_id}`} className="block max-w-[11rem] truncate rounded-sm text-[13px] font-medium text-slate-800 hover:text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-brand-cyan">
                        {s.student_name}
                      </Link>
                      <UrgencyBadge urgency={s.urgency} size="sm" className="mt-0.5" />
                    </th>
                    {topics.map((t) => {
                      const f = byTopic.get(t.topic);
                      return (
                        <td
                          key={t.topic}
                          className={cn(
                            "h-9 border border-white text-center font-medium tabular-nums [print-color-adjust:exact]",
                            f ? cellClass(f.rank) : "bg-slate-50 text-slate-400",
                          )}
                          title={
                            f
                              ? `${s.student_name}: ${t.topic} rank ${f.rank}, ROI ${fmtNumber(f.roi, 2)}${
                                  f.projected_gain_marks !== null ? `, +${fmtNumber(f.projected_gain_marks)} marks (illustrative)` : ""
                                }`
                              : `${t.topic} is not in ${s.student_name}'s top five`
                          }
                        >
                          {f ? `#${f.rank}` : "·"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <th scope="row" className="sticky left-0 z-10 border-t border-slate-200 bg-white px-2 py-1.5 text-left font-medium text-slate-600">
                  Cohort ({students.length})
                </th>
                {topics.map((t) => (
                  <td key={t.topic} className="border-t border-slate-200 px-1 py-1.5 text-center text-[11px] text-slate-700">
                    <span className="block font-semibold tabular-nums">
                      {t.count}/{students.length}
                    </span>
                    <span className="text-[10px] text-slate-500">mean #{fmtNumber(t.meanRank, 1)}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <span className="mr-1">Rank</span>
        {[1, 2, 3, 4, 5].map((r) => (
          <span key={r} className={cn("rounded-sm px-1.5 py-0.5 font-medium tabular-nums [print-color-adjust:exact]", cellClass(r))}>
            #{r}
          </span>
        ))}
      </div>
      <p className="mt-2 max-w-3xl text-xs text-slate-500">
        Ranks come from the illustrative ROI engine (sample chapter weightage, effort hours and time-to-exam coefficients);
        they order study time, not predicted marks, and are not calibrated against NEET outcomes.
      </p>
    </section>
  );
}
