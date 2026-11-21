"use client";

import { useId, useState } from "react";
import type { MarkingPolicy, PartialCreditMode } from "@/lib/types";
import { MARK_STEPS } from "./rubric-utils";

const fieldClass =
  "block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";
const labelClass = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500";

export const PARTIAL_CREDIT_LABELS: Record<PartialCreditMode, string> = {
  steps: "Steps (round to the mark step)",
  proportional: "Proportional (2 dp)",
  all_or_nothing: "All or nothing",
};

type Preset = "none" | "neet" | "board" | "whole" | "custom";

const PRESETS: Record<Exclude<Preset, "none" | "custom">, { label: string; policy: MarkingPolicy }> = {
  neet: {
    label: "NEET +4/-1",
    policy: { partial_credit: "steps", mark_step: 0.5, negative_marks: 1, scheme_name: "NEET +4/-1" },
  },
  board: { label: "Board: 0.5-mark steps", policy: { partial_credit: "steps", mark_step: 0.5, negative_marks: 0 } },
  whole: { label: "Whole marks", policy: { partial_credit: "steps", mark_step: 1, negative_marks: 0 } },
};

function detect(policy: MarkingPolicy | undefined): Preset {
  if (!policy) return "none";
  for (const [key, preset] of Object.entries(PRESETS) as [Exclude<Preset, "none" | "custom">, (typeof PRESETS)["neet"]][]) {
    const p = preset.policy;
    if (p.partial_credit === policy.partial_credit && p.mark_step === policy.mark_step && p.negative_marks === policy.negative_marks) {
      return key;
    }
  }
  return "custom";
}

/** One-line summary, e.g. "steps of 0.5 · -1 per wrong MCQ". */
export function policySummary(policy: MarkingPolicy | undefined): string {
  if (!policy) return "Wave-1 rule: 0.5-mark steps, no negative marking";
  const mode =
    policy.partial_credit === "steps"
      ? `partial credit in ${policy.mark_step}-mark steps`
      : policy.partial_credit === "proportional"
        ? "proportional partial credit"
        : "all-or-nothing";
  const neg = policy.negative_marks > 0 ? `−${policy.negative_marks} per wrong MCQ` : "no negative marking";
  return `${policy.scheme_name ? `${policy.scheme_name}: ` : ""}${mode} · ${neg}`;
}

/**
 * Rubric-wide marking policy (FR-3.8 / FR-4.8): presets NEET +4/-1, board 0.5-mark steps,
 * whole marks, none (the wave-1 rule), or custom fields. Questions may override mode and step.
 */
export function MarkingPolicyFields({
  value,
  onChange,
  disabled,
}: {
  value: MarkingPolicy | undefined;
  onChange: (next: MarkingPolicy | undefined) => void;
  disabled?: boolean;
}) {
  const ids = useId();
  const [custom, setCustom] = useState(() => detect(value) === "custom");
  const preset: Preset = custom ? "custom" : detect(value);
  const policy: MarkingPolicy = value ?? { partial_credit: "steps", mark_step: 0.5, negative_marks: 0 };

  function choose(next: Preset) {
    setCustom(next === "custom");
    if (next === "none") onChange(undefined);
    else if (next === "custom") onChange({ ...policy });
    else onChange({ ...PRESETS[next].policy });
  }

  return (
    <fieldset className="rounded-xl border border-slate-200 bg-slate-50/60 p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-semibold text-brand-navy">Marking policy</legend>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
        <div>
          <label htmlFor={`${ids}-preset`} className={labelClass}>
            Preset
          </label>
          <select
            id={`${ids}-preset`}
            className={fieldClass}
            value={preset}
            onChange={(e) => choose(e.target.value as Preset)}
          >
            <option value="none">None (0.5-mark steps, no negative marking)</option>
            <option value="neet">{PRESETS.neet.label}</option>
            <option value="board">{PRESETS.board.label}</option>
            <option value="whole">{PRESETS.whole.label}</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <p className="text-xs text-slate-600">{policySummary(value)}</p>
      </div>

      {preset === "custom" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor={`${ids}-mode`} className={labelClass}>
              Partial credit
            </label>
            <select
              id={`${ids}-mode`}
              className={fieldClass}
              value={policy.partial_credit}
              onChange={(e) => onChange({ ...policy, partial_credit: e.target.value as PartialCreditMode })}
            >
              {(Object.keys(PARTIAL_CREDIT_LABELS) as PartialCreditMode[]).map((m) => (
                <option key={m} value={m}>
                  {PARTIAL_CREDIT_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${ids}-step`} className={labelClass}>
              Mark step
            </label>
            <select
              id={`${ids}-step`}
              className={fieldClass}
              value={policy.mark_step}
              onChange={(e) => onChange({ ...policy, mark_step: Number(e.target.value) })}
            >
              {MARK_STEPS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${ids}-neg`} className={labelClass}>
              Negative marks (wrong MCQ)
            </label>
            <input
              id={`${ids}-neg`}
              type="number"
              min={0}
              max={100}
              step={0.25}
              className={fieldClass}
              value={Number.isFinite(policy.negative_marks) ? policy.negative_marks : ""}
              onChange={(e) => onChange({ ...policy, negative_marks: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
            />
          </div>
          <div>
            <label htmlFor={`${ids}-name`} className={labelClass}>
              Scheme name
            </label>
            <input
              id={`${ids}-name`}
              className={fieldClass}
              maxLength={80}
              value={policy.scheme_name ?? ""}
              placeholder="optional"
              onChange={(e) => onChange({ ...policy, scheme_name: e.target.value })}
            />
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
