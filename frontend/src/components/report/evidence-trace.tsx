"use client";

import { FileImage } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { QuestionEvaluation, Result, ResultKind } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { Modal, btnSecondary } from "./dialog";
import { RESULT_LOOK, fraction, resultLabel } from "./format";
import { Pill, SectionCard } from "./primitives";
import { focusQuestion, openSourcePage } from "./report-events";
import { OutcomeBadge } from "./question-evaluations";
import { UncertainText } from "./uncertain-text";

const KINDS: ResultKind[] = ["right", "wrong", "blank", "bonus", "partial", "zero"];

function subjectOf(result: Result, q: QuestionEvaluation): string {
  return (
    result.topic_mastery.find((t) => t.questions.includes(q.question))?.subject ??
    result.topic_mastery.find((t) => t.topic === q.topic)?.subject ??
    "—"
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "min-h-8 rounded-sm border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
        active ? "border-brand-navy bg-brand-navy text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {children}
    </button>
  );
}

function InspectDrawer({
  result,
  q,
  prompt,
  onClose,
}: {
  result: Result;
  q: QuestionEvaluation | null;
  prompt?: string;
  onClose: () => void;
}) {
  const isDemo = result.submission.is_demo;
  const threshold = result.extraction.threshold;
  return (
    <Modal
      open={q !== null}
      onClose={onClose}
      variant="drawer"
      eyebrow={q ? `Q${q.question} · ${subjectOf(result, q)}` : undefined}
      title={q ? q.topic : ""}
      description={q ? `${fraction(q.estimated_marks, q.max_marks)} marks · ${resultLabel(q)}` : undefined}
      footer={
        q ? (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                const n = q.question;
                onClose();
                window.setTimeout(() => focusQuestion(n), 50);
              }}
            >
              Go to question card
            </button>
          </div>
        ) : null
      }
    >
      {q ? (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeBadge q={q} />
            {isDemo ? (
              <span className="text-xs text-slate-500">Sample record: nothing was scanned</span>
            ) : (
              <Pill
                className={
                  q.confidence > 0 && q.confidence < threshold
                    ? "bg-amber-50 text-amber-800"
                    : "bg-slate-100 text-slate-600"
                }
              >
                Read with {formatConfidence(q.confidence)} confidence (review line {Math.round(threshold * 100)}%)
              </Pill>
            )}
            {q.corrected_by_faculty ? <Pill className="bg-slate-100 text-slate-700">Corrected by faculty</Pill> : null}
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">Prompt</h3>
            <p className="leading-normal text-slate-700">{prompt || "The rubric has no prompt text for this question."}</p>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">{isDemo ? "Sample answer" : "Answer as read"}</h3>
            {q.student_answer.trim() ? (
              <blockquote className="whitespace-pre-wrap break-words border-l-2 border-slate-300 bg-slate-50 px-3 py-2 leading-normal text-slate-700">
                <UncertainText text={q.student_answer} words={q.uncertain_words} />
              </blockquote>
            ) : (
              <p className="text-slate-500">Not attempted (no answer detected).</p>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">Evaluator evidence</h3>
            <p className="leading-normal text-slate-700">{q.evidence || "—"}</p>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">Missed criteria</h3>
            {q.gaps.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-slate-700">
                {q.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-500">None recorded.</p>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500">Source</h3>
            {isDemo ? (
              <p className="text-slate-500">Synthetic record: no source scan.</p>
            ) : q.source_pages.length ? (
              <div className="flex flex-wrap gap-2">
                {q.source_pages.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={btnSecondary}
                    onClick={() => {
                      onClose();
                      window.setTimeout(() => openSourcePage(p), 50);
                    }}
                  >
                    <FileImage className="h-4 w-4" aria-hidden />
                    Open page {p}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-slate-500">No page reference was recorded for this answer.</p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/** Evidence trace (SAIR "Trace a finding back to the source"): every question, filterable, inspectable. */
export function EvidenceTraceCard({ result, prompts }: { result: Result; prompts: Record<number, string> }) {
  const [subject, setSubject] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ResultKind | null>(null);
  const [inspect, setInspect] = useState<number | null>(null);
  const questions = [...result.question_evaluations].sort((a, b) => a.question - b.question);
  const subjects = [...new Set(questions.map((q) => subjectOf(result, q)))].filter((s) => s !== "—");
  const rows = questions.filter(
    (q) => (subject === null || subjectOf(result, q) === subject) && (outcome === null || q.result_kind === outcome),
  );
  const notFull = questions.filter((q) => q.result_kind !== "right" && q.result_kind !== "bonus");
  const selected = questions.find((q) => q.question === inspect) ?? null;

  return (
    <SectionCard
      id="evidence-trace"
      title="Every question"
      description={`Every question with its answer, marks and page · ${notFull.length} did not score full marks.`}
    >
      <div className="mb-3 flex flex-col gap-2 print:hidden">
        {subjects.length > 1 ? (
          <div role="group" aria-label="Filter by subject" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-slate-500">Subject</span>
            <Chip active={subject === null} onClick={() => setSubject(null)}>
              All {subjects.length} subjects
            </Chip>
            {subjects.map((s) => (
              <Chip key={s} active={subject === s} onClick={() => setSubject(s)}>
                {s}
              </Chip>
            ))}
          </div>
        ) : null}
        <div role="group" aria-label="Filter by outcome" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-slate-500">Outcome</span>
          <Chip active={outcome === null} onClick={() => setOutcome(null)}>
            All ({questions.length})
          </Chip>
          {KINDS.map((o) => {
            const n = questions.filter((q) => q.result_kind === o).length;
            if (!n && o !== "right" && o !== "wrong" && o !== "blank") return null;
            return (
              <Chip key={o} active={outcome === o} onClick={() => setOutcome(o)}>
                {RESULT_LOOK[o].label} ({n})
              </Chip>
            );
          })}
        </div>
      </div>

      <div className="relative overflow-x-auto print:overflow-visible print:hidden">
        <table className="w-full min-w-[40rem] border-collapse text-sm print:min-w-0">
          <caption className="sr-only">Evidence trace</caption>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th scope="col" className="px-2.5 py-2 font-medium">Q</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Topic</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Subject</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Outcome</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">Marks</th>
              <th scope="col" className="px-2.5 py-2 text-right font-medium">Page(s)</th>
              <th scope="col" className="px-2.5 py-2 font-medium">
                <span className="sr-only">Inspect</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2.5 py-4 text-center text-slate-500">
                  No questions match these filters.
                </td>
              </tr>
            ) : (
              rows.map((q) => (
                <tr key={q.question} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-2.5 py-2 tabular-nums text-slate-500">Q{q.question}</td>
                  <th scope="row" className="px-2.5 py-2 text-left font-medium text-slate-800">{q.topic}</th>
                  <td className="px-2.5 py-2 text-slate-600">{subjectOf(result, q)}</td>
                  <td className="px-2.5 py-2">
                    <OutcomeBadge q={q} />
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums text-slate-800">
                    {fraction(q.estimated_marks, q.max_marks)}
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-slate-600">
                    {result.submission.is_demo ? "synthetic" : q.source_pages.length ? q.source_pages.join(", ") : "—"}
                  </td>
                  <td className="px-2.5 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setInspect(q.question)}
                      aria-label={`Inspect question ${q.question}`}
                      className="rounded-sm px-1 py-1 text-sm font-medium text-brand-cyan-600 underline-offset-2 transition-colors duration-150 hover:text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="sair-print-only">
        <h3 className="mb-2 text-sm font-semibold text-brand-navy">Appendix A: questions that did not score full marks</h3>
        {notFull.length === 0 ? (
          <p className="text-sm text-slate-600">Every question scored full marks.</p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-400 text-left text-slate-600">
                <th className="px-2 py-1.5">Q#</th>
                <th className="px-2 py-1.5">Topic</th>
                <th className="px-2 py-1.5">Outcome</th>
                <th className="px-2 py-1.5 text-right">Marks</th>
                <th className="px-2 py-1.5">Missed criteria / evidence</th>
                <th className="px-2 py-1.5">Page(s)</th>
              </tr>
            </thead>
            <tbody>
              {notFull.map((q) => (
                <tr key={q.question} className="border-b border-slate-200 align-top">
                  <td className="px-2 py-1.5 font-mono">Q{q.question}</td>
                  <td className="px-2 py-1.5">{q.topic}</td>
                  <td className="px-2 py-1.5">{resultLabel(q)}</td>
                  <td className="px-2 py-1.5 text-right">{fraction(q.estimated_marks, q.max_marks)}</td>
                  <td className="px-2 py-1.5">{q.gaps.length ? q.gaps.join("; ") : q.evidence || "—"}</td>
                  <td className="px-2 py-1.5">
                    {result.submission.is_demo ? "synthetic" : q.source_pages.join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <InspectDrawer
        result={result}
        q={selected}
        prompt={selected ? prompts[selected.question] : undefined}
        onClose={() => setInspect(null)}
      />
    </SectionCard>
  );
}
