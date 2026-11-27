"use client";

import { ChevronLeft, ChevronRight, CircleCheck, CircleDashed, CircleHelp, CircleMinus, Lock, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BloomBadge } from "@/components/shared/bloom-badge";
import type { QuestionEvaluation } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import {
  BONUS_TAG,
  NET_TOTAL_TITLE,
  RESULT_LOOK,
  TONE,
  confidenceTone,
  fmtMarks,
  fmtNumber,
  isBonusNote,
  orJoin,
  ratioPct,
  resultLabel,
  toneFor,
} from "./format";
import { MeterBar, Pill, SectionCard } from "./primitives";
import { SHOW_QUESTION_EVENT, openSourcePage, takePendingQuestion } from "./report-events";
import { focusRing } from "./summary/tokens";
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

/** How the question went, in the paper's vocabulary: "Wrong −1", "Right +4", "Bonus +4", "Blank 0", "Partial credit". */
export function OutcomeBadge({ q, className }: { q: QuestionEvaluation; className?: string }) {
  const kind = q.result_kind ?? "partial";
  const look = RESULT_LOOK[kind];
  return (
    <Pill className={cn("text-xs ring-1 ring-inset", look.pill, className)}>
      {kind === "bonus" ? <Star className="h-3 w-3" aria-hidden /> : null}
      {resultLabel(q)}
    </Pill>
  );
}

/** "Bonus" next to a bonus question's outcome. */
export function BonusTag({ className }: { className?: string }) {
  return (
    <span title={BONUS_TAG.title} className="inline-flex">
      <Pill className={cn("bg-brand-lime-50 text-xs text-lime-800", className)}>{BONUS_TAG.label}</Pill>
    </span>
  );
}

/**
 * How the key settles an MCQ, read from its marking note: "Bonus question - full marks to everyone",
 * "Accepted options B or C" (a key that accepts several options) or, for another option marked on
 * such a key, "Marked D, accepted B or C".
 */
export function mcqKeyNote(note: string | null): { bonus: boolean; accepted: string[] } {
  const text = note ?? "";
  const match = /[Aa]ccepted(?: options?:?)?\s+([A-F](?:\s*(?:,|or|\/)\s*[A-F])+)/.exec(text);
  return {
    bonus: isBonusNote(text),
    accepted: match ? [...new Set(match[1].match(/[A-F]/g) ?? [])] : [],
  };
}

/** "B" / "B or C" from the key (accepted_options, else the grader's note). */
function acceptedText(q: QuestionEvaluation): string {
  const opts = q.accepted_options?.length ? q.accepted_options : mcqKeyNote(q.marking_note).accepted;
  return opts.length ? orJoin(opts) : (q.correct_option ?? "?");
}

const signedMarks = (n: number) => (n > 0 ? `+${fmtMarks(n)}` : fmtMarks(n));

/** MCQ outcome line: "Marked B · Accepted B · +4", "Marked A · Accepted B or C · −1", "Not answered · Accepted B · 0"... */
export function mcqOutcome(q: QuestionEvaluation): { text: string; Icon: LucideIcon; look: string } {
  const sel = (q.selected_option ?? "").trim().toUpperCase();
  const marks = signedMarks(q.estimated_marks);
  const marked = !sel ? "Not answered" : sel === "MULTI" ? "More than one option marked" : sel === "UNKNOWN" ? "Mark unclear" : `Marked ${sel}`;
  if (q.result_kind === "bonus" || q.bonus || mcqKeyNote(q.marking_note).bonus) {
    return { text: `${marked} · Bonus question · ${marks}`, Icon: CircleCheck, look: "text-sky-800" };
  }
  const key = `Accepted ${acceptedText(q)}`;
  if (!sel) return { text: `${marked} · ${key} · ${marks}`, Icon: CircleDashed, look: "text-slate-700" };
  if (sel === "UNKNOWN") return { text: `${marked} · ${key} · ${marks} (check the sheet)`, Icon: CircleHelp, look: "text-amber-800" };
  const right = q.result_kind === "right";
  return {
    text: `${marked} · ${key} · ${marks}`,
    Icon: right ? CircleCheck : CircleMinus,
    look: right ? "text-[#1E40AF]" : "text-red-700",
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

/** MCQ card: marked / accepted / marks / page; no transcript or reading-confidence badge (those are in the faculty folds). */
function McqCard({ q, prompt, threshold, isDemo }: { q: QuestionEvaluation; prompt?: string; threshold: number; isDemo: boolean }) {
  const mcq = mcqOutcome(q);
  const answered = Boolean(q.selected_option);
  const hardToRead = !isDemo && answered && q.confidence > 0 && q.confidence < threshold;
  return (
    <article
      id={`q-${q.question}`}
      aria-labelledby={`q-${q.question}-title`}
      className="flex min-w-0 scroll-mt-28 flex-col rounded-md border border-slate-200 bg-white p-3 md:scroll-mt-36 print:break-inside-avoid"
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={`q-${q.question}-title`} className="text-[15px] font-semibold leading-snug text-[#1E3A8A]">
            <span className="mr-1.5 font-mono tabular-nums text-slate-500">Q{q.question}</span>
            {q.topic}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <OutcomeBadge q={q} />
            {q.bloom_source && q.bloom_source !== "heuristic" ? (
              <BloomBadge level={q.bloom_level} source={q.bloom_source} demonstrated={q.demonstrated_level} size="sm" />
            ) : null}
            {q.corrected_by_faculty ? <Pill className="bg-slate-100 text-xs text-slate-700">Corrected by faculty</Pill> : null}
          </div>
        </div>
        <p className="shrink-0 text-right" title={q.estimated_marks < 0 ? NET_TOTAL_TITLE : undefined}>
          <span className={cn("font-mono text-lg font-semibold tabular-nums", q.estimated_marks < 0 ? "text-red-700" : "text-[#1E3A8A]")}>
            {fmtMarks(q.estimated_marks)}
          </span>
          <span className="font-mono text-sm tabular-nums text-slate-500"> / {fmtMarks(q.max_marks)}</span>
        </p>
      </header>
      {prompt ? <p className="mt-2 text-sm leading-normal text-slate-600">{prompt}</p> : null}
      <p className={cn("mt-2 flex items-center gap-1.5 text-sm font-medium", mcq.look)}>
        <mcq.Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-mono text-[13px] tabular-nums">{mcq.text}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {!isDemo && q.source_pages.length ? (
          <>
            <span>Page</span>
            {q.source_pages.map((p) => (
              <SourcePageChip key={p} page={p} className="print:hidden" />
            ))}
          </>
        ) : null}
        {hardToRead ? <span className="text-[#B45309]">Hard to read: may change after teacher review.</span> : null}
      </div>
      {q.marking_note && /examiner/i.test(q.marking_note) ? (
        <p className="mt-2 border-l-2 border-amber-400 pl-2.5 text-xs text-amber-900">{q.marking_note}</p>
      ) : null}
    </article>
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
  if (q.question_type === "mcq") return <McqCard q={q} prompt={prompt} threshold={threshold} isDemo={isDemo} />;
  const pct = ratioPct(q.estimated_marks, q.max_marks);
  const tone = TONE[toneFor(pct)];
  const ocrTone = TONE[confidenceTone(q.confidence, threshold)];
  const answer = (q.student_answer ?? "").trim();
  const lowOcr = typeof q.confidence === "number" && q.confidence > 0 && q.confidence < threshold;
  const negative = q.estimated_marks < 0;

  return (
    <article
      id={`q-${q.question}`}
      aria-labelledby={`q-${q.question}-title`}
      className="flex min-w-0 scroll-mt-28 flex-col rounded-md border border-slate-200 bg-white p-4 md:scroll-mt-36 print:break-inside-avoid"
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={`q-${q.question}-title`} className="text-[15px] font-semibold leading-snug text-[#1E3A8A]">
            <span className="mr-1.5 font-mono tabular-nums text-slate-500">Q{q.question}</span>
            {q.topic}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <OutcomeBadge q={q} />
            {q.bloom_source && q.bloom_source !== "heuristic" ? (
              <BloomBadge level={q.bloom_level} source={q.bloom_source} demonstrated={q.demonstrated_level} size="sm" />
            ) : null}
            {q.corrected_by_faculty ? <Pill className="bg-slate-100 text-xs text-slate-700">Corrected by faculty</Pill> : null}
            {isDemo ? null : q.source_pages.map((p) => <SourcePageChip key={p} page={p} className="print:hidden" />)}
          </div>
        </div>
        <p className="shrink-0 text-right" title={negative ? NET_TOTAL_TITLE : undefined}>
          <span className={cn("font-mono text-lg font-semibold tabular-nums", negative ? "text-red-700" : "text-[#1E3A8A]")}>
            {fmtMarks(q.estimated_marks)}
          </span>
          <span className="font-mono text-sm tabular-nums text-slate-500"> / {fmtMarks(q.max_marks)}</span>
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

      <div className="mt-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium text-slate-500">{isDemo ? "Sample answer" : "Answer as read"}</h4>
          {/* No confidence badge on a blank: there was nothing to read. */}
          {isDemo || !answer ? null : (
            <Pill className={cn("text-xs", ocrTone.pill)}>
              Read with {formatConfidence(q.confidence)} confidence
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
            {q.result_kind === "bonus"
              ? "No answer was detected for this question; as a bonus question it still scores full marks."
              : "No answer was detected for this question, so it received zero marks."}
          </p>
        )}
        {q.uncertain_words.length > 0 ? (
          <p className="mt-1 text-xs text-amber-800">
            {q.uncertain_words.length} hard-to-read {q.uncertain_words.length === 1 ? "word" : "words"} underlined (hover
            for the reading confidence).
          </p>
        ) : null}
      </div>

      {q.marking_breakdown.length > 0 ? <MarkingBreakdown q={q} /> : null}

      {q.marking_note ? (
        <p className="mt-3 border-l-2 border-amber-400 pl-2.5 text-xs text-amber-900">{q.marking_note}</p>
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

const PAGE_SIZE = 20;

function PageButton({
  onClick,
  disabled,
  children,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-[13px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40",
        focusRing,
      )}
    >
      {children}
    </button>
  );
}

/** Question cards, 20 at a time; a question asked for by a chip or #q-n opens on its page. */
export function QuestionEvaluationsCard({
  questions,
  prompts,
  threshold,
  isDemo = false,
}: {
  questions: QuestionEvaluation[];
  prompts: Record<number, string>;
  /** Reading-confidence review line (0-1) from the result's extraction block. */
  threshold: number;
  isDemo?: boolean;
}) {
  const sorted = [...questions].sort((a, b) => a.question - b.question);
  const order = sorted.map((q) => q.question);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const [page, setPage] = useState(() => {
    const i = order.indexOf(takePendingQuestion() ?? -1);
    return i < 0 ? 0 : Math.floor(i / PAGE_SIZE);
  });
  const key = order.join(",");

  useEffect(() => {
    const numbers = key.split(",").map(Number);
    const onShow = (e: Event) => {
      const i = numbers.indexOf((e as CustomEvent<number>).detail);
      if (i >= 0) setPage(Math.floor(i / PAGE_SIZE));
    };
    window.addEventListener(SHOW_QUESTION_EVENT, onShow);
    return () => window.removeEventListener(SHOW_QUESTION_EVENT, onShow);
  }, [key]);

  const shown = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const first = shown[0]?.question;
  const last = shown[shown.length - 1]?.question;
  const pager = (where: string) =>
    pages > 1 ? (
      <nav aria-label={`Question pages (${where})`} className="flex flex-wrap items-center gap-2 print:hidden">
        <PageButton onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} label="Previous 20 questions">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Previous
        </PageButton>
        <span className="font-mono text-[13px] tabular-nums text-slate-700">
          Q{first}–Q{last} of {sorted.length}
        </span>
        <PageButton
          onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          disabled={page >= pages - 1}
          label="Next 20 questions"
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </PageButton>
      </nav>
    ) : null;

  return (
    <SectionCard
      id="question-cards"
      title="Question by question"
      description={
        isDemo
          ? "Sample answers with the marks for each (no scan, no AI call)."
          : "The marked option, the key and the marks for every question, 20 at a time."
      }
      action={
        <span className="text-sm tabular-nums text-slate-500">
          {sorted.length} {sorted.length === 1 ? "question" : "questions"}
        </span>
      }
    >
      {sorted.length === 0 ? (
        <p className="py-6 text-sm text-slate-500">No question-level evaluations were recorded.</p>
      ) : (
        <div className="space-y-3">
          {pager("top")}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 print:grid-cols-2">
            {shown.map((q) => (
              <QuestionCard key={q.question} q={q} prompt={prompts[q.question]} threshold={threshold} isDemo={isDemo} />
            ))}
          </div>
          {pager("bottom")}
        </div>
      )}
    </SectionCard>
  );
}
