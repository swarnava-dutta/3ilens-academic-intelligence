"use client";

import { useId, useState } from "react";
import { AlertTriangle, ChevronDown, Plus, Trash2 } from "lucide-react";
import type { MarkingPolicy, RubricContent, RubricQuestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AnswerKeyTable } from "./answer-key-table";
import { BloomField } from "./bloom-field";
import { MarkingPolicyFields } from "./marking-policy-fields";
import { QuestionMarkingFields, QuestionTypeField } from "./question-marking-fields";
import {
  ANSWER_KEY_VIEW_THRESHOLD,
  MAX_RUBRIC_QUESTIONS,
  blankQuestion,
  compareContents,
  isMcq,
  totalMarks,
  validateContent,
} from "./rubric-utils";

/** Warnings shown before "Show all N". */
const WARNINGS_SHOWN = 6;
/** Rows per "Show more" step of the full list on long papers. */
const FULL_LIST_STEP = 20;

type EditorView = "key" | "full";

const fieldClass =
  "block w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

const labelClass = "mb-1 block text-xs font-medium text-slate-500";

function numberValue(value: number): number | "" {
  return Number.isFinite(value) ? value : "";
}

function parseNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

const VIEW_OPTIONS: { value: EditorView; label: string }[] = [
  { value: "key", label: "Answer key" },
  { value: "full", label: "All questions" },
];

interface RubricDraftEditorProps {
  value: RubricContent;
  onChange: (next: RubricContent) => void;
  /** Question numbers whose answer key was drafted by AI (teacher review pending). */
  aiDrafted?: number[];
  warnings?: string[];
  disabled?: boolean;
  /** Original content: questions that differ are marked "changed" / "new". */
  baseline?: RubricContent | null;
}

/**
 * Editable review table for a rubric draft or a new rubric version: question text, topic,
 * subject, chapter, marks, criteria (one per line), effort hours and expected answer.
 */
export function RubricDraftEditor({ value, onChange, aiDrafted = [], warnings = [], disabled, baseline }: RubricDraftEditorProps) {
  const ids = useId();
  const issues = validateContent(value);
  const diff = baseline ? compareContents(baseline, value) : null;
  const drafted = new Set(aiDrafted);
  // Long papers (a full NEET paper has 180 MCQs) open on the dense answer-key table.
  const large = value.questions.length > ANSWER_KEY_VIEW_THRESHOLD;
  const [view, setView] = useState<EditorView>(large ? "key" : "full");
  const [editing, setEditing] = useState<number | null>(null);
  const [fullLimit, setFullLimit] = useState(FULL_LIST_STEP);
  const [allWarnings, setAllWarnings] = useState(false);
  const showKey = large && view === "key";
  const shownQuestions = large ? value.questions.slice(0, fullLimit) : value.questions;
  const shownWarnings = allWarnings ? warnings : warnings.slice(0, WARNINGS_SHOWN);

  function update(index: number, patch: Partial<RubricQuestion>) {
    onChange({
      ...value,
      questions: value.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    });
  }

  function remove(index: number) {
    setEditing(null);
    onChange({ ...value, questions: value.questions.filter((_, i) => i !== index) });
  }

  function add() {
    onChange({ ...value, questions: [...value.questions, blankQuestion(value.questions, value.subject)] });
    // On the answer-key table, open the new question's editor; on a long full list, show it.
    if (showKey) setEditing(value.questions.length);
    else if (large) setFullLimit(value.questions.length + 1);
  }

  function questionRow(index: number) {
    const q = value.questions[index];
    return (
      <QuestionRow
        key={index}
        idPrefix={`${ids}-q${index}`}
        question={q}
        policy={value.marking_policy}
        problems={issues.byIndex[index] ?? []}
        aiDrafted={drafted.has(q.question)}
        changeTag={diff?.added.includes(q.question) ? "new" : diff?.changed.includes(q.question) ? "changed" : null}
        disabled={disabled}
        onChange={(patch) => update(index, patch)}
        onRemove={value.questions.length > 1 ? () => remove(index) : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label htmlFor={`${ids}-name`} className={labelClass}>
            Rubric name
          </label>
          <input
            id={`${ids}-name`}
            className={fieldClass}
            value={value.name}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="e.g. NEET Mock-08 · Genetics"
          />
        </div>
        <div>
          <label htmlFor={`${ids}-subject`} className={labelClass}>
            Subject <span className="normal-case text-slate-400">(blank = from questions)</span>
          </label>
          <input
            id={`${ids}-subject`}
            className={fieldClass}
            value={value.subject}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, subject: e.target.value })}
            placeholder="Biology / Mixed"
          />
        </div>
      </div>

      <MarkingPolicyFields
        value={value.marking_policy}
        disabled={disabled}
        onChange={(policy) => {
          const next: RubricContent = { ...value };
          if (policy) next.marking_policy = policy;
          else delete next.marking_policy;
          onChange(next);
        }}
      />

      {warnings.length > 0 ? (
        <div className="border-l-2 border-amber-500 pl-3">
          <ul className="space-y-1 text-sm text-amber-900">
            {shownWarnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <span className="min-w-0 break-words">{w}</span>
              </li>
            ))}
          </ul>
          {warnings.length > WARNINGS_SHOWN ? (
            <button
              type="button"
              onClick={() => setAllWarnings((v) => !v)}
              aria-expanded={allWarnings}
              className="mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              {allWarnings ? "Show fewer" : `Show all ${warnings.length}`}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          <span className="font-semibold tabular-nums text-slate-700">{value.questions.length}</span> questions ·{" "}
          <span className="font-semibold tabular-nums text-slate-700">{totalMarks(value)}</span> marks
        </span>
        {drafted.size > 0 ? (
          <span className="inline-flex items-center gap-1 text-slate-600">
            {drafted.size} AI-drafted answer {drafted.size === 1 ? "key" : "keys"}: teacher review pending
          </span>
        ) : null}
        {diff ? (
          <span>
            {diff.changed.length} changed · {diff.added.length} added · {diff.removed.length} removed
          </span>
        ) : null}
      </div>

      {large ? (
        <div role="radiogroup" aria-label="Draft view" className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
          {VIEW_OPTIONS.map((option) => {
            const active = view === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setView(option.value);
                  setEditing(null);
                }}
                className={cn(
                  "inline-flex h-8 items-center rounded-sm px-3 text-xs font-medium transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan",
                  active ? "bg-brand-navy text-white" : "text-slate-600 hover:bg-slate-50 hover:text-brand-navy",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {showKey ? (
        <AnswerKeyTable
          questions={value.questions}
          problems={issues.byIndex}
          drafted={drafted}
          disabled={disabled}
          onChange={update}
          editing={editing !== null && editing < value.questions.length ? editing : null}
          onEdit={setEditing}
          renderEditor={(index) => <ol>{questionRow(index)}</ol>}
        />
      ) : (
        <>
          {/* Column header (desktop) */}
          <div
            className="hidden grid-cols-[4.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem_4.5rem_2.25rem] gap-2 px-3 text-xs font-medium text-slate-500 lg:grid"
            aria-hidden
          >
            <span>Q #</span>
            <span>Topic</span>
            <span>Subject</span>
            <span>Chapter</span>
            <span>Marks</span>
            <span>Effort h</span>
            <span />
          </div>

          <ol className="space-y-3">{shownQuestions.map((_, index) => questionRow(index))}</ol>

          {large && fullLimit < value.questions.length ? (
            <button
              type="button"
              onClick={() => setFullLimit((n) => n + FULL_LIST_STEP)}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-brand-navy hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              Show {Math.min(FULL_LIST_STEP, value.questions.length - fullLimit)} more (
              {value.questions.length - fullLimit} not shown)
            </button>
          ) : null}
        </>
      )}

      {diff && diff.removed.length > 0 ? (
        <p className="text-xs text-rose-700">Removed from the previous version: {diff.removed.map((n) => `Q${n}`).join(", ")}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={add}
          disabled={disabled || value.questions.length >= MAX_RUBRIC_QUESTIONS}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add question
        </button>
        {issues.count > 0 ? (
          <p className="text-xs text-rose-700" role="status">
            {issues.general.join(" ")} {Object.keys(issues.byIndex).length > 0 ? `${Object.keys(issues.byIndex).length} question(s) need fixing.` : ""}
          </p>
        ) : (
          <p className="text-xs text-lime-700">Every question has a topic, marks, criteria and an expected answer.</p>
        )}
      </div>
    </div>
  );
}

function QuestionRow({
  idPrefix,
  question: q,
  policy,
  problems,
  aiDrafted,
  changeTag,
  disabled,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  question: RubricQuestion;
  policy: MarkingPolicy | undefined;
  problems: string[];
  aiDrafted: boolean;
  changeTag: "new" | "changed" | null;
  disabled?: boolean;
  onChange: (patch: Partial<RubricQuestion>) => void;
  onRemove?: () => void;
}) {
  const mcq = isMcq(q);
  const [showAnswer, setShowAnswer] = useState(aiDrafted || (!mcq && !q.expected_answer));
  const criteriaText = (q.grading_criteria ?? []).join("\n");

  return (
    <li
      className={cn(
        "rounded-md border bg-white p-3",
        problems.length ? "border-rose-200" : changeTag ? "border-amber-300" : "border-slate-200",
      )}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[4.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_4.5rem_4.5rem_2.25rem] lg:items-end">
        <div>
          <label htmlFor={`${idPrefix}-num`} className={cn(labelClass, "lg:sr-only")}>
            Q #
          </label>
          <input
            id={`${idPrefix}-num`}
            type="number"
            min={1}
            max={1000}
            step={1}
            className={fieldClass}
            value={numberValue(q.question)}
            disabled={disabled}
            onChange={(e) => onChange({ question: parseNumber(e.target.value) })}
          />
        </div>
        <div className="col-span-2 sm:col-span-2 lg:col-span-1">
          <label htmlFor={`${idPrefix}-topic`} className={cn(labelClass, "lg:sr-only")}>
            Topic
          </label>
          <input
            id={`${idPrefix}-topic`}
            className={fieldClass}
            value={q.topic}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ topic: e.target.value })}
            placeholder="e.g. Mendelian inheritance"
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-subject`} className={cn(labelClass, "lg:sr-only")}>
            Subject
          </label>
          <input
            id={`${idPrefix}-subject`}
            className={fieldClass}
            value={q.subject}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => onChange({ subject: e.target.value })}
            placeholder="Biology"
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-chapter`} className={cn(labelClass, "lg:sr-only")}>
            Chapter
          </label>
          <input
            id={`${idPrefix}-chapter`}
            className={fieldClass}
            value={q.chapter ?? ""}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ chapter: e.target.value })}
            placeholder="optional"
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-marks`} className={cn(labelClass, "lg:sr-only")}>
            Marks
          </label>
          <input
            id={`${idPrefix}-marks`}
            type="number"
            min={0.5}
            step={0.5}
            className={fieldClass}
            value={numberValue(q.max_marks)}
            disabled={disabled}
            onChange={(e) => onChange({ max_marks: parseNumber(e.target.value) })}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-effort`} className={cn(labelClass, "lg:sr-only")}>
            Effort h
          </label>
          <input
            id={`${idPrefix}-effort`}
            type="number"
            min={0.5}
            step={0.5}
            className={fieldClass}
            value={numberValue(q.effort_hours)}
            disabled={disabled}
            onChange={(e) => onChange({ effort_hours: parseNumber(e.target.value) })}
          />
        </div>
        {/* Own full-width row below lg, button at the right edge (not floating mid-form on phones). */}
        <div className="col-span-2 flex items-end justify-end sm:col-span-3 lg:col-span-1">
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              className="rounded-md p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
              aria-label={`Remove question ${Number.isFinite(q.question) ? q.question : ""}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-prompt`} className={labelClass}>
            Question text
          </label>
          <textarea
            id={`${idPrefix}-prompt`}
            rows={2}
            className={cn(fieldClass, "resize-y")}
            value={q.prompt ?? ""}
            maxLength={5000}
            disabled={disabled}
            onChange={(e) => onChange({ prompt: e.target.value })}
            placeholder="Shown to the grader with the student's answer (optional)"
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-criteria`} className={labelClass}>
            Criteria{" "}
            <span className="normal-case text-slate-400">
              (one per line{mcq || q.marking_scheme?.length ? "; optional - generated when blank" : ""})
            </span>
          </label>
          <textarea
            id={`${idPrefix}-criteria`}
            rows={2}
            className={cn(fieldClass, "resize-y")}
            value={criteriaText}
            disabled={disabled}
            onChange={(e) => onChange({ grading_criteria: e.target.value.split("\n") })}
            placeholder={"Names both alleles (1)\nDraws the Punnett square (1)"}
          />
        </div>
      </div>

      <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2.5">
        <div className="grid gap-2 sm:grid-cols-3">
          <QuestionTypeField idPrefix={idPrefix} question={q} disabled={disabled} onChange={onChange} />
          <BloomField idPrefix={idPrefix} question={q} disabled={disabled} onChange={onChange} />
        </div>
        <div className="mt-2">
          <QuestionMarkingFields idPrefix={idPrefix} question={q} policy={policy} disabled={disabled} onChange={onChange} />
        </div>
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowAnswer((v) => !v)}
          aria-expanded={showAnswer}
          aria-controls={`${idPrefix}-answer-panel`}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-slate-600 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAnswer && "rotate-180")} aria-hidden />
          Expected answer{mcq ? " (optional for MCQs)" : ""}
          {aiDrafted ? (
            <span className="ml-1.5 inline-flex items-center gap-1 rounded-sm bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              Draft - teacher review pending
            </span>
          ) : null}
          {changeTag ? (
            <span className="ml-1.5 rounded-sm bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              {changeTag}
            </span>
          ) : null}
        </button>
        <div id={`${idPrefix}-answer-panel`} hidden={!showAnswer} className="mt-1.5">
          <label htmlFor={`${idPrefix}-answer`} className="sr-only">
            Expected answer
          </label>
          <textarea
            id={`${idPrefix}-answer`}
            rows={3}
            className={cn(fieldClass, "resize-y", aiDrafted && "border-slate-300 bg-slate-50")}
            value={q.expected_answer}
            maxLength={10000}
            disabled={disabled}
            onChange={(e) => onChange({ expected_answer: e.target.value })}
            placeholder="Model answer the grader compares against"
          />
        </div>
      </div>

      {problems.length > 0 ? (
        <p className="mt-2 text-xs text-rose-700">Needs: {problems.join(" · ")}</p>
      ) : null}
    </li>
  );
}
