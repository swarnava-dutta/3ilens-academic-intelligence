"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, X } from "lucide-react";
import type { RubricQuestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  OPTION_LETTERS,
  acceptedLetters,
  isMcq,
  keyModePatch,
  mcqKeyLabel,
  mcqKeyMode,
  mcqKeySet,
  withKeyTexts,
} from "./rubric-utils";

const selectClass =
  "block h-8 w-[4.75rem] rounded-md border border-slate-300 bg-white px-1.5 text-sm font-semibold text-slate-800 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

/** Option letters an MCQ can take: its option count (2-6), A-D when the options are unknown. */
function lettersFor(q: RubricQuestion): string[] {
  const count = q.options && q.options.length >= 2 ? Math.min(q.options.length, OPTION_LETTERS.length) : 4;
  return OPTION_LETTERS.slice(0, count) as unknown as string[];
}

/**
 * An MCQ without a usable key: no correct option within its options, fewer than two accepted
 * options, and not a bonus question.
 */
export function missingKey(q: RubricQuestion): boolean {
  return isMcq(q) && !mcqKeySet(q);
}

/** The Key select's value: a letter, "several", "bonus" or "" (not set). */
function keyValue(q: RubricQuestion): string {
  const mode = mcqKeyMode(q);
  if (mode !== "single") return mode;
  const letter = (q.correct_option ?? "").trim().toUpperCase();
  return lettersFor(q).includes(letter) ? letter : "";
}

/** Title of the Key select for a question keyed with several options or as a bonus. */
function keyTitle(q: RubricQuestion): string | undefined {
  const mode = mcqKeyMode(q);
  if (mode === "bonus") return "Bonus question - full marks to everyone";
  if (mode === "several") return `Accepted options ${mcqKeyLabel(q) || "- tick them in Edit"}`;
  return undefined;
}

/** Label of the "several" choice: "B or C" (mcqKeyLabel), "B/…" while one is ticked, "Several…" before. */
function severalLabel(q: RubricQuestion): string {
  const letters = mcqKeyMode(q) === "several" ? acceptedLetters(q) : [];
  if (letters.length >= 2) return mcqKeyLabel(q);
  return letters.length === 1 ? `${letters[0]}/…` : "Several…";
}

/** The key patch for a Key select choice (expected answer and criteria follow when generic). */
function keyChoice(q: RubricQuestion, value: string): Partial<RubricQuestion> {
  if (value === "several" || value === "bonus") return withKeyTexts(q, keyModePatch(q, value));
  return withKeyTexts(q, { bonus: undefined, accepted_options: undefined, correct_option: value || undefined });
}

interface AnswerKeyTableProps {
  questions: RubricQuestion[];
  /** Validation problems per question index (validateContent().byIndex). */
  problems: Record<number, string[]>;
  /** Question numbers whose answer key the AI wrote. */
  drafted: Set<number>;
  disabled?: boolean;
  onChange: (index: number, patch: Partial<RubricQuestion>) => void;
  /** Index whose detailed editor is open (null = none). */
  editing: number | null;
  onEdit: (index: number | null) => void;
  /** The detailed editor of one question (rendered in a panel under the table). */
  renderEditor: (index: number) => ReactNode;
}

/**
 * Dense answer-key review for long papers (a 180-MCQ NEET paper): one row per question with
 * its subject, topic, the key select (a letter, several accepted options - ticked in the question's
 * editor - or bonus) and the problems to fix; "Edit" opens the full editor for that one question.
 */
export function AnswerKeyTable({
  questions,
  problems,
  drafted,
  disabled,
  onChange,
  editing,
  onEdit,
  renderEditor,
}: AnswerKeyTableProps) {
  const ids = useId();
  const [missingOnly, setMissingOnly] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const editingQuestion = editing !== null ? questions[editing] : undefined;

  // Bring the opened question's editor into view (it sits under the scrolling table).
  useEffect(() => {
    if (editing !== null) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [editing]);
  const mcqs = questions.filter(isMcq);
  const missing = mcqs.filter(missingKey).length;
  const several = mcqs.filter((q) => mcqKeyMode(q) === "several").length;
  const bonus = mcqs.filter((q) => mcqKeyMode(q) === "bonus").length;
  const flagged = Object.keys(problems).length;
  const rows = questions
    .map((q, index) => ({ q, index }))
    .filter(({ q, index }) => !missingOnly || missingKey(q) || index === editing);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-600">
        <p>
          Answer key set for{" "}
          <span className="font-semibold tabular-nums text-slate-800">
            {mcqs.length - missing}/{mcqs.length}
          </span>{" "}
          MCQs
          {several > 0 ? <> · {several} with several accepted options</> : null}
          {bonus > 0 ? <> · {bonus} bonus</> : null}
          {flagged > 0 ? (
            <>
              {" "}
              · <span className="font-medium text-rose-700">{flagged} to fix</span>
            </>
          ) : null}
        </p>
        <label htmlFor={`${ids}-missing`} className="inline-flex items-center gap-1.5">
          <input
            id={`${ids}-missing`}
            type="checkbox"
            checked={missingOnly}
            onChange={(e) => setMissingOnly(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-brand-cyan focus:ring-brand-cyan"
          />
          Missing key only <span className="tabular-nums text-slate-500">({missing})</span>
        </label>
      </div>

      <div className="max-h-[36rem] overflow-auto rounded-md border border-slate-200">
        {/* Phones: Subject hidden and narrower columns, so Q, Topic, Key, Check and Edit fit ~320 px. */}
        <table className="w-full min-w-[20rem] border-collapse text-sm sm:min-w-[34rem]">
          <caption className="sr-only">Answer key: one row per question</caption>
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-500">
            <tr>
              <th scope="col" className="w-9 px-2 py-2 font-medium sm:w-12">
                Q
              </th>
              <th scope="col" className="hidden w-24 px-2 py-2 font-medium sm:table-cell">
                Subject
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Topic
              </th>
              <th scope="col" className="w-[5.75rem] px-2 py-2 font-medium sm:w-24">
                Key
              </th>
              <th scope="col" className="w-24 px-2 py-2 font-medium sm:w-40">
                Check
              </th>
              <th scope="col" className="w-14 px-2 py-2 font-medium sm:w-16">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-xs text-slate-500">
                  Every MCQ has a key (a correct option, accepted options or bonus).
                </td>
              </tr>
            ) : null}
            {rows.map(({ q, index }) => {
              const rowProblems = problems[index] ?? [];
              const open = editing === index;
              const number = Number.isFinite(q.question) ? q.question : "?";
              return (
                <tr key={index} className={cn(rowProblems.length ? "bg-rose-50/40" : undefined, open && "bg-brand-cyan-50")}>
                    <td className="px-2 py-1.5 font-semibold tabular-nums text-slate-700">{number}</td>
                    <td className="hidden truncate px-2 py-1.5 text-slate-600 sm:table-cell" title={q.subject}>
                      {q.subject || "—"}
                    </td>
                    <td className="px-2 py-1.5 text-slate-800">
                      <span className="line-clamp-2 break-words" title={q.prompt || q.topic}>
                        {q.topic || <span className="text-rose-700">no topic</span>}
                      </span>
                      {drafted.has(q.question) ? (
                        <span className="mt-0.5 inline-flex rounded-sm bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                          AI-drafted key
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      {isMcq(q) ? (
                        <>
                          <label htmlFor={`${ids}-key-${index}`} className="sr-only">
                            Answer key for question {number}
                          </label>
                          <select
                            id={`${ids}-key-${index}`}
                            value={keyValue(q)}
                            disabled={disabled}
                            title={keyTitle(q)}
                            onChange={(e) => {
                              const value = e.target.value;
                              onChange(index, keyChoice(q, value));
                              // Several accepted options are ticked in the question's editor.
                              if (value === "several") onEdit(index);
                            }}
                            className={cn(selectClass, missingKey(q) && "border-rose-300")}
                          >
                            <option value="">—</option>
                            {lettersFor(q).map((letter) => (
                              <option key={letter} value={letter}>
                                {letter}
                              </option>
                            ))}
                            <option value="several">
                              {severalLabel(q)}
                            </option>
                            <option value="bonus">Bonus</option>
                          </select>
                        </>
                      ) : (
                        <span className="text-xs text-slate-500">Descriptive</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs">
                      {rowProblems.length ? (
                        <span className="line-clamp-2 text-rose-700" title={rowProblems.join(" · ")}>
                          Needs: {rowProblems.join(" · ")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-lime-700">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          OK
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => onEdit(open ? null : index)}
                        aria-pressed={open}
                        className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-brand-navy hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
                      >
                        {open ? "Editing" : "Edit"}
                      </button>
                    </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing !== null && editingQuestion ? (
        <div ref={panelRef} className="scroll-mt-24 rounded-md border border-slate-200 bg-slate-50 p-2 sm:p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-brand-navy">
              Editing Q{Number.isFinite(editingQuestion.question) ? editingQuestion.question : "?"}
            </p>
            <button
              type="button"
              onClick={() => onEdit(null)}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Close
            </button>
          </div>
          {renderEditor(editing)}
        </div>
      ) : null}
    </div>
  );
}
