"use client";

import type { Priority, Result, TeachingNudge, TopicMastery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { topicExtremes } from "./executive-summary";
import { NUDGE_LOOK, SOURCE_LABEL, fmtIST, fmtNumber, fraction, safeNumber } from "./format";
import { Pill, SectionCard } from "./primitives";
import { focusQuestion, scrollToId } from "./report-events";

/** Clickable "Q3" chip: scrolls to the question card and flashes it. */
export function QRefChip({ q, className }: { q: number; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => focusQuestion(q)}
      className={cn(
        "inline-flex items-center rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-brand-cyan-600 transition-colors duration-150 hover:border-brand-cyan hover:bg-brand-cyan-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
        className,
      )}
      title={`Go to question ${q}`}
    >
      Q{q}
    </button>
  );
}

/** Priorities in the qualitative (observed-gap) order the report leads with. */
export function observedPriorities(result: Result): Priority[] {
  return [...result.roi_recommendations].sort(
    (a, b) =>
      (a.qualitative_rank ?? 999) - (b.qualitative_rank ?? 999) ||
      safeNumber(a.mastery) - safeNumber(b.mastery) ||
      safeNumber(b.roi) - safeNumber(a.roi),
  );
}

export function topicRow(result: Result, topic: string): TopicMastery | undefined {
  return result.topic_mastery.find((t) => t.topic === topic);
}

function NudgeItem({ nudge }: { nudge: TeachingNudge }) {
  const look = NUDGE_LOOK[nudge.priority];
  return (
    <li className="py-3 first:pt-0 last:pb-0 print:break-inside-avoid">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className={cn("text-[11px]", look.pill)}>{look.label}</Pill>
        <span className="font-semibold text-brand-navy">{nudge.label || "Teaching nudge"}</span>
        <span className="ml-auto text-xs text-slate-500">{SOURCE_LABEL[nudge.source]}</span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-700">{nudge.text}</p>
      {nudge.question_refs.length > 0 || nudge.topic ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {nudge.topic ? <span className="text-xs text-slate-500">{nudge.topic}</span> : null}
          {nudge.question_refs.map((q) => (
            <QRefChip key={q} q={q} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** "Teacher's immediate reading": strongest/weakest topic, nudges, observed priorities, release gate. */
export function ImmediateReadingCard({ result }: { result: Result }) {
  const { strongest, weakest } = topicExtremes(result.topic_mastery);
  const priorities = observedPriorities(result).slice(0, 2);
  const released = result.release.status === "RELEASED";

  return (
    <SectionCard
      id="immediate-reading"
      title="Teacher's immediate reading"
      description="Every action links back to a question."
    >
      <div className="grid gap-6 lg:grid-cols-5 print:grid-cols-5">
        <div className="space-y-4 lg:col-span-3 print:col-span-3">
          <dl className="grid gap-x-6 gap-y-4 border-b border-slate-200 pb-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-500">Strongest observed topic</dt>
              <dd className="mt-1 text-sm text-slate-700">
                {strongest ? (
                  <>
                    <span className="font-semibold text-brand-navy">{strongest.topic}</span>{" "}
                    <span className="tabular-nums">{fraction(strongest.score, strongest.max_marks)}</span> (
                    {fmtNumber(strongest.mastery, 0)}%). Maintain rather than assuming future performance.
                  </>
                ) : (
                  "No topic data recorded."
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Weakest observed topic</dt>
              <dd className="mt-1 text-sm text-slate-700">
                {weakest && weakest !== strongest ? (
                  <>
                    <span className="font-semibold text-brand-navy">{weakest.topic}</span>{" "}
                    <span className="tabular-nums">{fraction(weakest.score, weakest.max_marks)}</span> (
                    {fmtNumber(weakest.mastery, 0)}%)
                    {weakest.zero + weakest.blank > 0
                      ? ` · ${weakest.zero} zero, ${weakest.blank} blank`
                      : weakest.partial > 0
                        ? ` · ${weakest.partial} partial`
                        : ""}
                    .
                  </>
                ) : (
                  "Only one topic was assessed."
                )}
              </dd>
            </div>
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-brand-navy">Teaching nudges</h3>
            {result.teaching_nudges.length === 0 ? (
              <p className="text-sm text-slate-500">
                No teaching nudges were recorded for this evaluation.
              </p>
            ) : (
              <ul className="divide-y divide-slate-200">
                {result.teaching_nudges.map((n, i) => (
                  <NudgeItem key={`${n.label}-${i}`} nudge={n} />
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-3 lg:col-span-2 lg:border-l lg:border-slate-200 lg:pl-6 print:col-span-2">
          {priorities.length === 0 ? (
            <p className="text-sm text-slate-600">
              No observed priority: every assessed topic is at or near full marks.
            </p>
          ) : (
            priorities.map((p, i) => {
              const row = topicRow(result, p.topic);
              return (
                <div
                  key={p.topic}
                  className="border-b border-slate-200 pb-3 print:break-inside-avoid"
                >
                  <p className="text-xs text-slate-500">
                    Observed priority {String(i + 1).padStart(2, "0")} · {p.subject}
                  </p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums text-brand-navy">
                    {row ? fraction(row.score, row.max_marks) : `${fmtNumber(p.mastery, 0)}%`}
                  </p>
                  <p className="text-sm text-slate-700">
                    {p.topic}
                    {row ? ` · ${row.zero + row.blank} zero/blank, ${row.partial} partial` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Root cause not proven.</p>
                </div>
              );
            })
          )}

          <button
            type="button"
            onClick={() => scrollToId("release-gate")}
            className={cn(
              "w-full rounded-md border border-l-[3px] border-slate-200 bg-white p-3 text-left transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan [print-color-adjust:exact]",
              released ? "border-l-brand-lime-600" : "border-l-amber-500",
            )}
          >
            <span className="block text-xs text-slate-500">Academic release gate</span>
            <span className={cn("mt-0.5 block text-base font-semibold", released ? "text-lime-800" : "text-amber-800")}>
              {released ? "Released" : "Pending"}
            </span>
            <span className="block text-xs text-slate-600">
              {released
                ? `Signed off by ${result.release.reviewed_by ?? "faculty"}${result.release.reviewed_at ? ` on ${fmtIST(result.release.reviewed_at)}` : ""}.`
                : `${result.rubric.status === "AUTHOR_DRAFT" ? "Author-draft rubric; " : ""}teacher review required before academic release.`}
            </span>
          </button>
        </div>
      </div>
    </SectionCard>
  );
}
