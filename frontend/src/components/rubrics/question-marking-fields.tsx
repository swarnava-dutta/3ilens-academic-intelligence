"use client";

import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import type { MarkingPolicy, MarkingStep, PartialCreditMode, QuestionType, RubricQuestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PARTIAL_CREDIT_LABELS } from "./marking-policy-fields";
import { MARK_STEPS, MAX_SCHEME_STEPS, OPTION_LETTERS, isMcq, schemeTotal } from "./rubric-utils";

const fieldClass =
  "block w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";
const labelClass = "mb-1 block text-xs font-medium text-slate-500";
const iconBtn =
  "grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-40";

function num(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** Question type select: Descriptive / MCQ. Switching drops the other type's fields. */
export function QuestionTypeField({
  idPrefix,
  question: q,
  disabled,
  onChange,
}: {
  idPrefix: string;
  question: RubricQuestion;
  disabled?: boolean;
  onChange: (patch: Partial<RubricQuestion>) => void;
}) {
  function setType(type: QuestionType) {
    if (type === "mcq") {
      onChange({
        question_type: "mcq",
        options: q.options && q.options.length >= 2 ? q.options : ["", "", "", ""],
        correct_option: q.correct_option,
        marking_scheme: undefined,
        partial_credit: undefined,
        mark_step: undefined,
      });
    } else {
      onChange({ question_type: "descriptive", options: undefined, correct_option: undefined, negative_marks: undefined });
    }
  }
  return (
    <div className="min-w-0">
      <label htmlFor={`${idPrefix}-type`} className={labelClass}>
        Type
      </label>
      <select
        id={`${idPrefix}-type`}
        className={fieldClass}
        value={isMcq(q) ? "mcq" : "descriptive"}
        disabled={disabled}
        onChange={(e) => setType(e.target.value as QuestionType)}
      >
        <option value="descriptive">Descriptive</option>
        <option value="mcq">MCQ</option>
      </select>
    </div>
  );
}

/** MCQ: options A-F (2-6), the correct-option radio and the per-question negative marks. */
function McqFields({
  idPrefix,
  question: q,
  policy,
  disabled,
  onChange,
}: {
  idPrefix: string;
  question: RubricQuestion;
  policy: MarkingPolicy | undefined;
  disabled?: boolean;
  onChange: (patch: Partial<RubricQuestion>) => void;
}) {
  const options = q.options ?? [];
  function setOption(index: number, text: string) {
    onChange({ options: options.map((o, i) => (i === index ? text : o)) });
  }
  function removeOption(index: number) {
    const letter = OPTION_LETTERS[index];
    const next = options.filter((_, i) => i !== index);
    let correct = q.correct_option;
    if (correct === letter) correct = undefined;
    else if (correct && OPTION_LETTERS.indexOf(correct as (typeof OPTION_LETTERS)[number]) > index) {
      correct = OPTION_LETTERS[OPTION_LETTERS.indexOf(correct as (typeof OPTION_LETTERS)[number]) - 1];
    }
    onChange({ options: next, correct_option: correct });
  }
  const policyNeg = policy?.negative_marks ?? 0;

  return (
    <div className="space-y-2">
      <fieldset>
        <legend className={labelClass}>Options · pick the correct one</legend>
        <ol className="space-y-1.5">
          {options.map((text, i) => {
            const letter = OPTION_LETTERS[i];
            return (
              <li key={letter} className="flex items-center gap-2">
                <input
                  type="radio"
                  id={`${idPrefix}-correct-${letter}`}
                  name={`${idPrefix}-correct`}
                  checked={q.correct_option === letter}
                  disabled={disabled}
                  onChange={() => onChange({ correct_option: letter })}
                  className="h-4 w-4 shrink-0 border-slate-300 text-brand-cyan focus:ring-brand-cyan"
                />
                <label htmlFor={`${idPrefix}-correct-${letter}`} className="w-16 shrink-0 text-sm font-semibold text-slate-700">
                  {letter}
                  {q.correct_option === letter ? <span className="ml-1 text-[10px] font-semibold text-lime-700">correct</span> : null}
                </label>
                <label htmlFor={`${idPrefix}-opt-${letter}`} className="sr-only">
                  Option {letter} text
                </label>
                <input
                  id={`${idPrefix}-opt-${letter}`}
                  className={fieldClass}
                  value={text}
                  maxLength={500}
                  disabled={disabled}
                  placeholder={`Option ${letter} text (optional)`}
                  onChange={(e) => setOption(i, e.target.value)}
                />
                <button
                  type="button"
                  className={iconBtn}
                  onClick={() => removeOption(i)}
                  disabled={disabled || options.length <= 2}
                  aria-label={`Remove option ${letter}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <button
          type="button"
          onClick={() => onChange({ options: [...options, ""] })}
          disabled={disabled || options.length >= OPTION_LETTERS.length}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add option
        </button>
        <div className="w-44">
          <label htmlFor={`${idPrefix}-neg`} className={labelClass}>
            Negative marks (wrong)
          </label>
          <input
            id={`${idPrefix}-neg`}
            type="number"
            min={0}
            step={0.25}
            className={fieldClass}
            value={typeof q.negative_marks === "number" && Number.isFinite(q.negative_marks) ? q.negative_marks : ""}
            disabled={disabled}
            placeholder={`${policyNeg} (policy)`}
            onChange={(e) => onChange({ negative_marks: e.target.value === "" ? undefined : num(e.target.value) })}
          />
        </div>
        <p className="pb-1.5 text-xs text-slate-500">
          Scored by letter: +{Number.isFinite(q.max_marks) ? q.max_marks : "?"} correct, &minus;
          {typeof q.negative_marks === "number" && Number.isFinite(q.negative_marks) ? q.negative_marks : policyNeg} wrong or
          multiple, 0 blank.
        </p>
      </div>
    </div>
  );
}

/** Descriptive: marking-scheme steps with a live sum, plus partial-credit mode and mark step. */
function DescriptiveFields({
  idPrefix,
  question: q,
  policy,
  disabled,
  onChange,
}: {
  idPrefix: string;
  question: RubricQuestion;
  policy: MarkingPolicy | undefined;
  disabled?: boolean;
  onChange: (patch: Partial<RubricQuestion>) => void;
}) {
  const steps = q.marking_scheme ?? [];
  const total = schemeTotal(q);
  const balanced = Number.isFinite(q.max_marks) && Math.abs(total - q.max_marks) <= 0.01;

  function setSteps(next: MarkingStep[]) {
    onChange({ marking_scheme: next.length ? next : undefined });
  }
  function patchStep(index: number, patch: Partial<MarkingStep>) {
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function move(index: number, by: -1 | 1) {
    const next = [...steps];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    setSteps(next);
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-pc`} className={labelClass}>
            Partial credit
          </label>
          <select
            id={`${idPrefix}-pc`}
            className={fieldClass}
            value={q.partial_credit ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ partial_credit: (e.target.value || undefined) as PartialCreditMode | undefined })}
          >
            <option value="">Rubric default: {PARTIAL_CREDIT_LABELS[policy?.partial_credit ?? "steps"]}</option>
            {(Object.keys(PARTIAL_CREDIT_LABELS) as PartialCreditMode[]).map((m) => (
              <option key={m} value={m}>
                {PARTIAL_CREDIT_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-ms`} className={labelClass}>
            Mark step
          </label>
          <select
            id={`${idPrefix}-ms`}
            className={fieldClass}
            value={q.mark_step ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ mark_step: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Rubric default: {policy?.mark_step ?? 0.5}</option>
            {MARK_STEPS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cn(labelClass, "mb-0")}>Marking scheme {steps.length ? "" : "(optional)"}</p>
          {steps.length ? (
            <p
              className={cn("text-xs font-semibold tabular-nums", balanced ? "text-lime-700" : "text-rose-700")}
              aria-live="polite"
            >
              {total} / {Number.isFinite(q.max_marks) ? q.max_marks : "?"} marks{balanced ? "" : " - must add up to the question marks"}
            </p>
          ) : null}
        </div>
        {steps.length ? (
          <ol className="mt-1 space-y-1.5">
            {steps.map((step, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <span className="w-5 shrink-0 text-xs font-semibold tabular-nums text-slate-400">{i + 1}</span>
                <label htmlFor={`${idPrefix}-step-${i}`} className="sr-only">
                  Step {i + 1} criterion
                </label>
                <input
                  id={`${idPrefix}-step-${i}`}
                  className={cn(fieldClass, "min-w-[10rem] flex-1")}
                  value={step.criterion}
                  maxLength={500}
                  disabled={disabled}
                  placeholder="e.g. Writes the dihybrid ratio 9:3:3:1"
                  onChange={(e) => patchStep(i, { criterion: e.target.value })}
                />
                <label htmlFor={`${idPrefix}-step-${i}-marks`} className="sr-only">
                  Step {i + 1} marks
                </label>
                <input
                  id={`${idPrefix}-step-${i}-marks`}
                  type="number"
                  min={0.25}
                  step={0.25}
                  className={cn(fieldClass, "w-20")}
                  value={Number.isFinite(step.marks) ? step.marks : ""}
                  disabled={disabled}
                  onChange={(e) => patchStep(i, { marks: num(e.target.value) })}
                />
                <label className="inline-flex shrink-0 items-center gap-1 text-xs text-slate-700" title="Below 50% of this step's marks the whole question scores 0">
                  <input
                    type="checkbox"
                    checked={!!step.required}
                    disabled={disabled}
                    onChange={(e) => patchStep(i, { required: e.target.checked || undefined })}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-cyan focus:ring-brand-cyan"
                  />
                  <Lock className="h-3 w-3 text-slate-500" aria-hidden />
                  required
                </label>
                <span className="flex shrink-0">
                  <button type="button" className={iconBtn} onClick={() => move(i, -1)} disabled={disabled || i === 0} aria-label={`Move step ${i + 1} up`}>
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    onClick={() => move(i, 1)}
                    disabled={disabled || i === steps.length - 1}
                    aria-label={`Move step ${i + 1} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                    disabled={disabled}
                    aria-label={`Remove step ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            Without a scheme the grader awards overall marks against the criteria above.
          </p>
        )}
        <button
          type="button"
          onClick={() => setSteps([...steps, { criterion: "", marks: steps.length ? 1 : Number.isFinite(q.max_marks) ? q.max_marks : 1 }])}
          disabled={disabled || steps.length >= MAX_SCHEME_STEPS}
          className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {steps.length ? "Add step" : "Add marking scheme"}
        </button>
      </div>
    </div>
  );
}

/** Type-specific marking fields for one rubric question (FR-3.8 / FR-4.8). */
export function QuestionMarkingFields(props: {
  idPrefix: string;
  question: RubricQuestion;
  policy: MarkingPolicy | undefined;
  disabled?: boolean;
  onChange: (patch: Partial<RubricQuestion>) => void;
}) {
  return isMcq(props.question) ? <McqFields {...props} /> : <DescriptiveFields {...props} />;
}
