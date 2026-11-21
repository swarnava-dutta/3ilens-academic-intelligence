import { FileText, Sparkles } from "lucide-react";
import type { Result, TopicMastery } from "@/lib/types";
import { formatConfidence } from "@/lib/utils";
import { fmtNumber, fraction, safeNumber } from "./format";
import { Pill, SectionCard } from "./primitives";

/** Strongest and weakest topic by observed percentage (ties: more marks at stake first). */
export function topicExtremes(topics: TopicMastery[]): { strongest: TopicMastery | null; weakest: TopicMastery | null } {
  if (topics.length === 0) return { strongest: null, weakest: null };
  const sorted = [...topics].sort(
    (a, b) => safeNumber(a.mastery) - safeNumber(b.mastery) || safeNumber(b.max_marks) - safeNumber(a.max_marks),
  );
  return { weakest: sorted[0], strongest: sorted[sorted.length - 1] };
}

/** Same three-paragraph shape as the backend summary, from the numbers on the page (older rows). */
function fallbackParagraphs(result: Result): string[] {
  const o = result.outcome_counts;
  const ex = result.extraction;
  const { strongest, weakest } = topicExtremes(result.topic_mastery);
  const coverage = result.submission.is_demo
    ? `${o.mapped} of ${o.total_questions} rubric questions carry synthetic demo answers (no scan, no OCR); ${o.blank} not attempted.`
    : `${ex.mapped} of ${ex.total_questions} rubric questions were transcribed and mapped${
        ex.mean_confidence !== null ? `; mean OCR confidence ${formatConfidence(ex.mean_confidence)}` : ""
      }; ${o.blank} not attempted.`;
  const resultLine =
    `Draft result ${fmtNumber(result.total_score)}/${fmtNumber(result.total_marks)} (${fmtNumber(result.percentage)}%).` +
    (strongest && weakest && strongest !== weakest
      ? ` Strongest observed topic: ${strongest.topic} (${fraction(strongest.score, strongest.max_marks)}); weakest: ${weakest.topic} (${fraction(weakest.score, weakest.max_marks)}).`
      : "");
  const priorities = [...result.roi_recommendations]
    .sort((a, b) => (a.qualitative_rank ?? 99) - (b.qualitative_rank ?? 99) || b.roi - a.roi)
    .slice(0, 2)
    .map((p, i) => `P${i + 1} ${p.topic}`);
  const actions = priorities.length
    ? `Highest-value next steps: ${priorities.join("; ")}. All prescriptions are provisional pending teacher review.`
    : "No topic below mastery needs a priority action on this assessment. All prescriptions are provisional pending teacher review.";
  return [coverage, resultLine, actions];
}

export function ExecutiveSummaryCard({ result, className }: { result: Result; className?: string }) {
  const stored = result.executive_summary;
  const paragraphs = stored.length > 0 ? stored : fallbackParagraphs(result);
  return (
    <SectionCard
      id="executive-summary"
      title="Executive teaching summary"
      description="Deterministic paragraphs built only from the computed numbers."
      icon={FileText}
      className={className}
    >
      <div className="space-y-3 text-[15px] leading-relaxed text-slate-700">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {stored.length === 0 ? (
        <p className="mt-3 text-xs text-slate-400">No stored summary for this row: composed in the browser from the marks shown.</p>
      ) : null}

      <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50/60 p-4 [print-color-adjust:exact]">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Pill className="bg-white text-violet-700 ring-violet-200">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            AI narrative
          </Pill>
          <span className="text-xs text-violet-700/80">Evaluator&apos;s reading - not educator-validated</span>
        </div>
        {result.summary ? (
          <p className="text-sm leading-relaxed text-slate-700">{result.summary}</p>
        ) : (
          <p className="text-sm italic text-slate-500">
            {result.submission.is_demo
              ? "Synthetic record - no AI call, so there is no AI narrative."
              : "No AI narrative was stored for this evaluation (graded before narratives were recorded)."}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
