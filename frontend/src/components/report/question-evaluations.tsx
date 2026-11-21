"use client";

import { CheckCircle2, CircleDashed, CircleHelp, Lock, MinusCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BloomBadge } from "@/components/shared/bloom-badge";
import type { QuestionEvaluation } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { NET_TOTAL_TITLE, OUTCOME_LOOK, TONE, confidenceTone, fmtNumber, fmtSigned, ratioPct, toneFor } from "./format";
import { MeterBar, Pill, SectionCard } from "./primitives";
import { openSourcePage } from "./report-events";
import { UncertainText } from "./uncertain-text";

/** "p. 2" chip that opens the page in the source-page viewer (the "Original pages" section). */
export function SourcePageChip({ page, className }: { page: number; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openSourcePage(page)}
      title={`Open page ${page} of the original scan`}
      className={cn(
        "inline-flex items-center rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-brand-cyan-600 transition-colors duration-150 hover:bg-brand-cyan-50 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
        className,
      )}
    >
      p. {page}
    </button>
  );
}

export function OutcomeBadge({ outcome, className }: { outcome: QuestionEvaluation["outcome"]; className?: string }) {
  const look = OUTCOME_LOOK[outcome] ?? OUTCOME_LOOK.PARTIAL;
  return <Pill className={cn("text-xs", look.pill, className)}>{look.label}</Pill>;
}

/** MCQ outcome line: "Marked B · Correct B · +4", "Marked C · Correct B · −1", "Not attempted · 0"... */
export function mcqOutcome(q: QuestionEvaluation): { text: string; Icon: LucideIcon; look: string } {
  const sel = (q.selected_option ?? "").trim().toUpperCase();
  const correct = (q.correct_option ?? "").trim().toUpperCase();
  const marks = fmtSigned(q.estimated_marks);
  if (!sel) return { text: `Not attempted · ${marks}`, Icon: CircleDashed, look: "text-slate-700" };
  if (sel === "MULTI") {
    return { text: `More than one option · ${marks}`, Icon: MinusCircle, look: "text-rose-700" };
  }
  if (sel === "UNKNOWN") {
    return { text: `Option unclear · ${marks} (check sheet)`, Icon: CircleHelp, look: "text-amber-800" };
  }
  const right = correct !== "" && sel === correct;
  return {
    text: `Marked ${sel} · Correct ${correct || "?"} · ${marks}`,
    Icon: right ? CheckCircle2 : MinusCircle,
    look: right ? "text-lime-800" : "text-rose-700",
  };
}

/** Compact marking-scheme table: criterion, awarded / marks, required lock. */
function MarkingBreakdown({ q }: { q: QuestionEvaluation }) {
  return (
    <div className="mt-3">
      <div className="relative overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">Marks awarded per marking-scheme step for question {q.question}</caption>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th scope="col" className="py-1.5 pr-2 font-medium">
                Marking step
              </th>
              <th scope="col" className="whitespace-nowrap py-1.5 pl-2 text-right font-medium">
                Awarded
              </th>
            </tr>
          </thead>
          <tbody>
            {q.marking_breakdown.map((m, i) => {
              const missed = m.required && m.marks > 0 && m.awarded < m.marks / 2;
              return (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1.5 pr-2 text-slate-700">
                    {m.criterion}
                    {m.required ? (
                      <span
                        className={cn(
                          "ml-1.5 inline-flex items-center gap-0.5 rounded-sm px-1 py-px text-[11px] font-medium",
                          missed ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600",
                        )}
                        title="Required step: below 50% of its marks the whole question scores 0"
                      >
                        <Lock className="h-2.5 w-2.5" aria-hidden />
                        required{missed ? " - missed" : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pl-2 text-right tabular-nums text-slate-800">
                    {fmtNumber(m.awarded, 2)} / {fmtNumber(m.marks, 2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  prompt,
  threshold,
  isDemo,
}: {
  q: QuestionEvaluation;
  prompt?: string;
  threshold: number;
  isDemo: boolean;
}) {
  const pct = ratioPct(q.estimated_marks, q.max_marks);
  const tone = TONE[toneFor(pct)];
  const ocrTone = TONE[confidenceTone(q.confidence, threshold)];
  const answer = (q.student_answer ?? "").trim();
  const lowOcr = typeof q.confidence === "number" && q.confidence > 0 && q.confidence < threshold;
  const isMcq = q.question_type === "mcq";
  const mcq = isMcq ? mcqOutcome(q) : null;
  const negative = q.estimated_marks < 0;

  return (
    <article
      id={`q-${q.question}`}
      aria-labelledby={`q-${q.question}-title`}
      className="flex min-w-0 scroll-mt-[11.5rem] flex-col rounded-md border border-slate-200 bg-white p-4 md:scroll-mt-[8.5rem] print:break-inside-avoid"
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={`q-${q.question}-title`} className="text-[15px] font-semibold leading-snug text-brand-navy">
            <span className="mr-1.5 tabular-nums text-slate-500">Q{q.question}</span>
            {q.topic}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <OutcomeBadge outcome={q.outcome} />
            {isMcq ? <Pill className="bg-slate-100 text-xs text-slate-700">MCQ</Pill> : null}
            <BloomBadge level={q.bloom_level} source={q.bloom_source} demonstrated={q.demonstrated_level} size="sm" />
            {q.corrected_by_faculty ? (
              <Pill className="bg-slate-100 text-xs text-slate-700">
                Corrected by faculty
              </Pill>
            ) : null}
            {q.source_pages.map((p) => (
              <SourcePageChip key={p} page={p} className="print:hidden" />
            ))}
          </div>
        </div>
        <p className="shrink-0 text-right" title={negative ? NET_TOTAL_TITLE : undefined}>
          <span className={cn("text-lg font-semibold tabular-nums", negative ? "text-rose-700" : "text-brand-navy")}>
            {fmtNumber(q.estimated_marks)}
          </span>
          <span className="text-sm tabular-nums text-slate-500"> / {fmtNumber(q.max_marks)}</span>
          <span className="block text-xs text-slate-500">marks</span>
        </p>
      </header>

      <MeterBar
        className="mt-3"
        percent={pct}
        label={`Question ${q.question} marks`}
        valueText={`${fmtNumber(q.estimated_marks)} of ${fmtNumber(q.max_marks)} marks`}
        fillClass={tone.fill}
        trackClass="bg-slate-100"
        size="sm"
      />

      {prompt ? <p className="mt-3 text-sm leading-normal text-slate-600">{prompt}</p> : null}

      {mcq ? (
        <p
          className={cn(
            "mt-3 flex items-center gap-1.5 text-sm font-medium tabular-nums",
            mcq.look,
          )}
        >
          <mcq.Icon className="h-4 w-4 shrink-0" aria-hidden />
          {mcq.text}
          {q.penalty > 0 ? <span className="sr-only"> (negative marking: {fmtNumber(q.penalty)} deducted)</span> : null}
        </p>
      ) : null}

      <div className="mt-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium text-slate-500">{isDemo ? "Synthetic answer" : "Transcribed answer"}</h4>
          {isDemo ? (
            <span className="text-xs text-slate-500">No OCR (synthetic)</span>
          ) : (
            <Pill className={cn("text-xs", ocrTone.pill)}>
              OCR {formatConfidence(q.confidence)}
              {lowOcr ? " · low" : ""}
            </Pill>
          )}
        </div>
        {answer ? (
          <blockquote className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-sm leading-normal text-slate-700 [print-color-adjust:exact] print:max-h-none print:overflow-visible">
            <UncertainText text={answer} words={q.uncertain_words} />
          </blockquote>
        ) : (
          <p className="text-sm text-slate-500">
            No answer was detected for this question, so it received zero marks.
          </p>
        )}
        {q.uncertain_words.length > 0 ? (
          <p className="mt-1 text-xs text-amber-800">
            {q.uncertain_words.length} low-confidence {q.uncertain_words.length === 1 ? "word" : "words"} underlined
            (hover for the OCR confidence).
          </p>
        ) : null}
      </div>

      {!isMcq && q.marking_breakdown.length > 0 ? <MarkingBreakdown q={q} /> : null}

      {/* An MCQ's note restates the outcome line above; keep it only when it flags something else. */}
      {q.marking_note && (!isMcq || /examiner/i.test(q.marking_note)) ? (
        <p className="mt-3 border-l-2 border-amber-400 pl-2.5 text-xs text-amber-900">
          {q.marking_note}
        </p>
      ) : null}

      {q.evidence ? (
        <div className="mt-3">
          <h4 className="mb-1 text-xs font-medium text-slate-500">Evaluator evidence</h4>
          <p className="text-sm leading-normal text-slate-700">{q.evidence}</p>
        </div>
      ) : null}

      {q.strengths.length > 0 || q.gaps.length > 0 ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {q.strengths.length > 0 ? (
            <>
              <dt className="text-xs font-medium leading-5 text-lime-800">Strengths</dt>
              <dd className="text-slate-700">
                <ul className="space-y-0.5">
                  {q.strengths.map((s, i) => (
                    <li key={`s-${i}`}>{s}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {q.gaps.length > 0 ? (
            <>
              <dt className="text-xs font-medium leading-5 text-amber-800">Gaps</dt>
              <dd className="text-slate-700">
                <ul className="space-y-0.5">
                  {q.gaps.map((g, i) => (
                    <li key={`g-${i}`}>{g}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </article>
  );
}

export function QuestionEvaluationsCard({
  questions,
  prompts,
  threshold,
  isDemo = false,
}: {
  questions: QuestionEvaluation[];
  prompts: Record<number, string>;
  /** OCR auto-grade threshold (0-1) from the result's extraction block. */
  threshold: number;
  isDemo?: boolean;
}) {
  const sorted = [...questions].sort((a, b) => a.question - b.question);
  return (
    <SectionCard
      id="questions"
      title="Question-by-question evaluation"
      description={
        isDemo
          ? "Synthetic demo answers with the evidence behind each mark (no scan, no AI call)."
          : "Rubric grading with the transcribed handwriting and the evidence behind each mark."
      }
      action={
        <span className="text-sm tabular-nums text-slate-500">
          {sorted.length} {sorted.length === 1 ? "question" : "questions"}
        </span>
      }
    >
      {sorted.length === 0 ? (
        <p className="py-6 text-sm text-slate-500">
          No question-level evaluations were recorded.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 print:grid-cols-2">
          {sorted.map((q) => (
            <QuestionCard key={q.question} q={q} prompt={prompts[q.question]} threshold={threshold} isDemo={isDemo} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
