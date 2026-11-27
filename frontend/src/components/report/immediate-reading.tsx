"use client";

import type { Priority, Result, TopicMastery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { safeNumber } from "./format";
import { focusQuestion } from "./report-events";

/** Clickable "Q3" chip: scrolls to the question card and flashes it. */
export function QRefChip({ q, className }: { q: number; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => focusQuestion(q)}
      className={cn(
        "inline-flex cursor-pointer items-center rounded-sm border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-brand-cyan-600 transition-colors duration-150 hover:border-brand-cyan hover:bg-brand-cyan-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
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
