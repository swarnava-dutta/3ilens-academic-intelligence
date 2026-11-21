"use client";

import { CheckCircle2, ClipboardCheck, FileImage, Quote, ScanText, Target, UserCheck } from "lucide-react";
import type { QuestionEvaluation } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { OUTCOME_LOOK, TONE, confidenceTone, fmtNumber, ratioPct, toneFor } from "./format";
import { Eyebrow, MeterBar, Pill, SectionCard } from "./primitives";
import { openSourcePage } from "./report-events";
import { UncertainText } from "./uncertain-text";

/** "p. 2" chip that opens the page in the source-page viewer (section 05). */
export function SourcePageChip({ page, className }: { page: number; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openSourcePage(page)}
      title={`Open page ${page} of the original scan`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-300 transition hover:bg-brand-cyan-50 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-brand-cyan",
        className,
      )}
    >
      <FileImage className="h-3 w-3" aria-hidden />
      p. {page}
    </button>
  );
}

export function OutcomeBadge({ outcome, className }: { outcome: QuestionEvaluation["outcome"]; className?: string }) {
  const look = OUTCOME_LOOK[outcome] ?? OUTCOME_LOOK.PARTIAL;
  return <Pill className={cn("text-[11px]", look.pill, className)}>{look.label}</Pill>;
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

  return (
    <article
      id={`q-${q.question}`}
      aria-labelledby={`q-${q.question}-title`}
      className="flex min-w-0 scroll-mt-[11.5rem] flex-col rounded-xl border border-slate-200 bg-white p-4 sm:p-5 md:scroll-mt-[8.5rem] print:break-inside-avoid"
    >
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-navy text-sm font-semibold text-white [print-color-adjust:exact]">
          Q{q.question}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`q-${q.question}-title`} className="font-semibold leading-snug text-brand-navy">
            {q.topic}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <OutcomeBadge outcome={q.outcome} />
            {q.corrected_by_faculty ? (
              <Pill className="bg-violet-50 text-[11px] text-violet-700 ring-violet-200">
                <UserCheck className="h-3 w-3" aria-hidden />
                Corrected by faculty
              </Pill>
            ) : null}
            {q.source_pages.map((p) => (
              <SourcePageChip key={p} page={p} className="print:hidden" />
            ))}
          </div>
        </div>
        <p className="shrink-0 text-right">
          <span className="text-2xl font-semibold tabular-nums text-brand-navy">{fmtNumber(q.estimated_marks)}</span>
          <span className="text-sm text-slate-500"> / {fmtNumber(q.max_marks)}</span>
          <span className="block text-[11px] uppercase tracking-wider text-slate-400">marks</span>
        </p>
      </header>

      <MeterBar
        className="mt-3"
        percent={pct}
        label={`Question ${q.question} marks`}
        valueText={`${fmtNumber(q.estimated_marks)} of ${fmtNumber(q.max_marks)} marks`}
        fillClass={tone.fill}
        trackClass={tone.track}
      />

      {prompt ? <p className="mt-4 text-sm leading-relaxed text-slate-600">{prompt}</p> : null}

      <div className="mt-4">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <Eyebrow icon={ScanText}>{isDemo ? "Synthetic answer" : "Transcribed answer"}</Eyebrow>
          {isDemo ? (
            <Pill className="bg-slate-50 text-[11px] text-slate-500 ring-slate-200">No OCR (synthetic)</Pill>
          ) : (
            <Pill className={cn("text-[11px]", ocrTone.pill)}>
              OCR {formatConfidence(q.confidence)}
              {lowOcr ? " · low" : ""}
            </Pill>
          )}
        </div>
        {answer ? (
          <blockquote className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-r-lg border-l-4 border-brand-cyan bg-slate-50 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-slate-700 [print-color-adjust:exact] print:max-h-none print:overflow-visible">
            <UncertainText text={answer} words={q.uncertain_words} />
          </blockquote>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-sm italic text-slate-500">
            No answer was detected for this question, so it received zero marks.
          </p>
        )}
        {q.uncertain_words.length > 0 ? (
          <p className="mt-1 text-[11px] text-amber-700">
            {q.uncertain_words.length} low-confidence {q.uncertain_words.length === 1 ? "word" : "words"} underlined
            (hover for the OCR confidence).
          </p>
        ) : null}
      </div>

      {q.evidence ? (
        <div className="mt-4">
          <Eyebrow icon={Quote} className="mb-1.5">
            Evaluator evidence
          </Eyebrow>
          <p className="text-sm leading-relaxed text-slate-700">{q.evidence}</p>
        </div>
      ) : null}

      {q.strengths.length > 0 || q.gaps.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {q.strengths.map((s, i) => (
            <span
              key={`s-${i}`}
              className="inline-flex max-w-full items-start gap-1 rounded-full bg-brand-lime-50 px-2.5 py-1 text-xs text-lime-800 ring-1 ring-inset ring-brand-lime/50"
            >
              <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="sr-only">Strength: </span>
              {s}
            </span>
          ))}
          {q.gaps.map((g, i) => (
            <span
              key={`g-${i}`}
              className="inline-flex max-w-full items-start gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800 ring-1 ring-inset ring-amber-200"
            >
              <Target className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="sr-only">Gap: </span>
              {g}
            </span>
          ))}
        </div>
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
          : "AI rubric grading with the transcribed handwriting and the evidence behind each mark."
      }
      icon={ClipboardCheck}
      action={
        <Pill className="bg-slate-50 text-slate-600 ring-slate-200">
          {sorted.length} {sorted.length === 1 ? "question" : "questions"}
        </Pill>
      }
    >
      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
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
