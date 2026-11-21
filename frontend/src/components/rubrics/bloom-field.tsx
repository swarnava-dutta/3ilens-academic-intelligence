"use client";

import { BLOOM_LABELS, BLOOM_SOURCE_LABELS, BloomBadge } from "@/components/shared/bloom-badge";
import type { BloomLevel, RubricQuestion } from "@/lib/types";

const LEVELS: BloomLevel[] = ["K1", "K2", "K3", "K4", "K5"];

const fieldClass =
  "block w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";
const labelClass = "mb-1 block text-xs font-medium text-slate-500";

/**
 * Bloom level (FR-3.9) and concept for one question. "Auto" leaves the level to the server's
 * verb heuristic; picking a level records it as set by faculty.
 */
export function BloomField({
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
  return (
    <>
      <div className="min-w-0">
        <label htmlFor={`${idPrefix}-bloom`} className={labelClass}>
          Bloom level
        </label>
        <div className="flex items-center gap-2">
          <select
            id={`${idPrefix}-bloom`}
            className={fieldClass}
            value={q.bloom_level ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                e.target.value
                  ? { bloom_level: e.target.value as BloomLevel, bloom_source: "faculty" }
                  : { bloom_level: undefined, bloom_source: undefined },
              )
            }
          >
            <option value="">Auto (heuristic)</option>
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {level} {BLOOM_LABELS[level]}
              </option>
            ))}
          </select>
          <BloomBadge level={q.bloom_level} source={q.bloom_source} size="sm" className="hidden sm:inline-flex" />
        </div>
        {q.bloom_level && q.bloom_source && q.bloom_source !== "faculty" ? (
          <p className="mt-0.5 text-[11px] text-slate-500">{BLOOM_SOURCE_LABELS[q.bloom_source]}</p>
        ) : null}
      </div>
      <div className="min-w-0">
        <label htmlFor={`${idPrefix}-concept`} className={labelClass}>
          Concept <span className="normal-case text-slate-400">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-concept`}
          className={fieldClass}
          value={q.concept ?? ""}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => onChange({ concept: e.target.value })}
          placeholder={(q.chapter ?? "").trim() || q.topic || "chapter or topic"}
        />
      </div>
    </>
  );
}
