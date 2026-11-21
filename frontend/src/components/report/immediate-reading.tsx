"use client";

import { ArrowDownRight, ArrowUpRight, BadgeCheck, Hourglass, Lightbulb } from "lucide-react";
import type { Priority, Result, TeachingNudge, TopicMastery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { topicExtremes } from "./executive-summary";
import { NUDGE_LOOK, SOURCE_LABEL, fmtIST, fmtNumber, fraction, safeNumber } from "./format";
import { Eyebrow, Pill, SectionCard } from "./primitives";
import { focusQuestion, scrollToId } from "./report-events";

/** Clickable "Q3" chip: scrolls to the question card and flashes it. */
export function QRefChip({ q, className }: { q: number; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => focusQuestion(q)}
      className={cn(
        "inline-flex items-center rounded-md bg-brand-cyan-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-cyan-800 ring-1 ring-inset ring-brand-cyan/30 transition hover:bg-brand-cyan hover:text-white focus-visible:outline-2 focus-visible:outline-brand-cyan print:ring-slate-300",
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
    <li className="rounded-xl border border-slate-200 p-3 print:break-inside-avoid">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className={cn("text-[11px]", look.pill)}>{look.label}</Pill>
        <span className="font-semibold text-brand-navy">{nudge.label || "Teaching nudge"}</span>
        <span className="ml-auto text-[11px] text-slate-400">{SOURCE_LABEL[nudge.source]}</span>
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
      description="From observation to action. Every action links back to a question."
      icon={Lightbulb}
    >
      <div className="grid gap-6 lg:grid-cols-5 print:grid-cols-5">
        <div className="space-y-4 lg:col-span-3 print:col-span-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-lime-200 bg-brand-lime-50 p-3 [print-color-adjust:exact]">
              <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-lime-800">
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> Strongest observed topic
              </dt>
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
            <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3 [print-color-adjust:exact]">
              <dt className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-rose-700">
                <ArrowDownRight className="h-3.5 w-3.5" aria-hidden /> Weakest observed topic
              </dt>
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
            <Eyebrow className="mb-2">Teaching nudges</Eyebrow>
            {result.teaching_nudges.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                No teaching nudges were recorded for this evaluation.
              </p>
            ) : (
              <ul className="space-y-2">
                {result.teaching_nudges.map((n, i) => (
                  <NudgeItem key={`${n.label}-${i}`} nudge={n} />
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-3 lg:col-span-2 print:col-span-2">
          {priorities.length === 0 ? (
            <p className="rounded-xl border border-dashed border-lime-300 bg-brand-lime-50 p-4 text-sm text-slate-600">
              No observed priority: every assessed topic is at or near full marks.
            </p>
          ) : (
            priorities.map((p, i) => {
              const row = topicRow(result, p.topic);
              return (
                <div
                  key={p.topic}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 [print-color-adjust:exact] print:break-inside-avoid"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Observed priority {String(i + 1).padStart(2, "0")} · {p.subject}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-brand-navy">
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
              "w-full rounded-xl border p-3 text-left transition hover:shadow-sm focus-visible:outline-2 focus-visible:outline-brand-cyan [print-color-adjust:exact]",
              released ? "border-lime-300 bg-brand-lime-50" : "border-amber-300 bg-amber-50",
            )}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              {released ? <BadgeCheck className="h-3.5 w-3.5 text-lime-700" aria-hidden /> : <Hourglass className="h-3.5 w-3.5 text-amber-700" aria-hidden />}
              Academic release gate
            </span>
            <span className={cn("mt-1 block text-lg font-semibold", released ? "text-lime-800" : "text-amber-900")}>
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
