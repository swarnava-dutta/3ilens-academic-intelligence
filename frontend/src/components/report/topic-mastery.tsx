"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { Priority, TopicMastery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { clampPct, fmtNumber, fraction, priorityGroup, safeNumber } from "./format";
import { SectionCard } from "./primitives";
import { QRefChip } from "./immediate-reading";

type Filter = "all" | "priorities" | "other";

const LEGEND = [
  { fill: "bg-rose-500", label: "P1-P2 priority" },
  { fill: "bg-amber-500", label: "P3-P5 priority" },
  { fill: "bg-sky-600", label: "Other topics" },
] as const;

/** Weakest first (ties: more marks at stake first, then name). */
export function weakestFirst(topics: TopicMastery[]): TopicMastery[] {
  return [...topics].sort(
    (a, b) =>
      safeNumber(a.mastery) - safeNumber(b.mastery) ||
      safeNumber(b.max_marks) - safeNumber(a.max_marks) ||
      a.topic.localeCompare(b.topic),
  );
}

/**
 * Topic screening (SAIR "Topic screening, not proven mastery"): observed score per topic,
 * weakest first, coloured by priority group, with the full/partial/zero/blank counts.
 * P1..P5 follow `observed` (the observed-gap order of "Choose an intervention") when given,
 * else the stored priority_rank.
 */
export function TopicScreeningCard({
  topics,
  observed,
  className,
}: {
  topics: TopicMastery[];
  observed?: Priority[];
  className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tableOpen, setTableOpen] = useState(false);
  const observedRank = new Map((observed ?? []).map((p, i) => [p.topic, i + 1]));
  const rankOf = (t: TopicMastery): number | null => (observed ? (observedRank.get(t.topic) ?? null) : t.priority_rank);
  const sorted = weakestFirst(topics);
  const priorities = sorted.filter((t) => rankOf(t) !== null);
  const shown = filter === "all" ? sorted : filter === "priorities" ? priorities : sorted.filter((t) => rankOf(t) === null);
  const chips: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: `All ${sorted.length}`, n: sorted.length },
    { key: "priorities", label: "Priorities", n: priorities.length },
    { key: "other", label: "Other topics", n: sorted.length - priorities.length },
  ];

  return (
    <SectionCard
      id="topic-screening"
      title="Topic screening (not proven mastery)"
      description="Observed marks per topic, weakest first. Score / max · n = questions in the topic."
      className={className}
    >
      {sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          No topic data was recorded for this assessment.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div role="group" aria-label="Filter topics" className="flex flex-wrap gap-1.5 print:hidden">
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={filter === c.key}
                  onClick={() => setFilter(c.key)}
                  className={cn(
                    "h-8 rounded-sm border px-2.5 text-xs font-medium tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                    filter === c.key
                      ? "border-brand-cyan-600 bg-brand-cyan-50 text-brand-navy"
                      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {c.key === "all" ? c.label : `${c.label} (${c.n})`}
                </button>
              ))}
            </div>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600" aria-label="Colour legend">
              {LEGEND.map((l) => (
                <li key={l.label} className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={cn("h-2.5 w-2.5 rounded-sm [print-color-adjust:exact]", l.fill)} />
                  {l.label}
                </li>
              ))}
            </ul>
          </div>

          {shown.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">
              No topics in this group.
            </p>
          ) : (
            <ul className="space-y-3">
              {shown.map((t) => {
                const group = priorityGroup(rankOf(t));
                const pct = clampPct(t.mastery);
                return (
                  <li key={t.topic} className="print:break-inside-avoid">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="min-w-0 text-sm font-medium text-slate-800">
                        {rankOf(t) !== null ? (
                          <span className="mr-1.5 rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-700">
                            {group.label}
                          </span>
                        ) : null}
                        {t.topic}
                        <span className="ml-1.5 text-xs font-normal text-slate-500">{t.subject}</span>
                      </p>
                      <p className="text-xs tabular-nums text-slate-600">
                        <span className="font-semibold text-brand-navy">{fraction(t.score, t.max_marks)}</span> · n=
                        {t.n || t.questions.length} · {fmtNumber(pct, 0)}%
                      </p>
                    </div>
                    <div
                      className="mt-1.5 h-2 w-full overflow-hidden rounded-sm bg-slate-100 [print-color-adjust:exact]"
                      role="meter"
                      aria-label={`${t.topic}: ${fraction(t.score, t.max_marks)}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(pct)}
                    >
                      <div className={cn("h-full rounded-sm", group.fill)} style={{ width: `${Math.max(pct, 1.5)}%` }} />
                    </div>
                    {t.questions.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1 print:hidden">
                        {t.questions.map((q) => (
                          <QRefChip key={q} q={q} />
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-5 border-t border-slate-200 pt-3">
            <button
              type="button"
              aria-expanded={tableOpen}
              onClick={() => setTableOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-brand-cyan-600 transition-colors duration-150 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan print:hidden"
            >
              <ChevronDown className={cn("h-4 w-4", tableOpen && "rotate-180")} aria-hidden />
              {tableOpen ? "Hide" : "Show"} outcome counts table
            </button>
            <div className={cn("relative mt-3 overflow-x-auto", tableOpen ? "block" : "hidden print:block")}>
              <table className="w-full min-w-[32rem] print:min-w-0 border-collapse text-sm">
                <caption className="sr-only">Topic outcome counts</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th scope="col" className="px-2.5 py-2 font-medium">Topic</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">Score/max</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">Full</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">Partial</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">Zero</th>
                    <th scope="col" className="px-2.5 py-2 text-right font-medium">Blank</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => (
                    <tr key={t.topic} className="border-b border-slate-100">
                      <th scope="row" className="px-2.5 py-1.5 text-left font-medium text-slate-800">
                        {t.topic}
                        <span className="ml-1 text-xs font-normal text-slate-500">{t.subject}</span>
                      </th>
                      <td className="px-2.5 py-1.5 text-right font-semibold tabular-nums text-brand-navy">
                        {fraction(t.score, t.max_marks)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{t.full}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{t.partial}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{t.zero}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{t.blank}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Blank answers count in the denominator; colours are presentation aids, not psychometric mastery.
          </p>
        </>
      )}
    </SectionCard>
  );
}
