import { URGENCY_LABELS } from "@/components/shared/urgency-badge";
import type { Result, TopicMastery } from "@/lib/types";
import { formatConfidence } from "@/lib/utils";
import { fmtNumber, fmtPct1, fraction, safeNumber } from "./format";
import { SectionCard } from "./primitives";

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
    `Draft result ${fmtNumber(result.total_score)}/${fmtNumber(result.total_marks)} (${fmtPct1(result.total_score, result.total_marks)}).` +
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

/**
 * One-line computed summary (mirrors backend analytics.summary_line): the fallback when no AI
 * narrative was stored (every demo row, and rows graded before narratives were recorded).
 */
export function summaryLine(result: Result): string {
  const { strongest, weakest } = topicExtremes(result.topic_mastery);
  const urgency = URGENCY_LABELS[result.urgency]?.toLowerCase();
  let line = `Scored ${fmtNumber(result.total_score)}/${fmtNumber(result.total_marks)} (${fmtPct1(result.total_score, result.total_marks)}${
    urgency ? `, ${urgency}` : ""
  })`;
  if (strongest && weakest && strongest !== weakest) {
    line += `; strongest ${strongest.topic} (${fraction(strongest.score, strongest.max_marks)}), weakest ${weakest.topic} (${fraction(weakest.score, weakest.max_marks)})`;
  }
  const top = [...result.roi_recommendations].sort(
    (a, b) => (a.qualitative_rank ?? 99) - (b.qualitative_rank ?? 99) || b.roi - a.roi,
  )[0];
  if (top) line += `; top priority ${top.topic}`;
  return `${line}.`;
}

/** The AI narrative when one was stored, else the computed summary line (labelled as such). */
export function narrativeOrSummary(result: Result): { text: string; computed: boolean } {
  const ai = (result.summary ?? "").trim();
  return ai ? { text: ai, computed: false } : { text: summaryLine(result), computed: true };
}

export function ExecutiveSummaryCard({ result, className }: { result: Result; className?: string }) {
  const stored = result.executive_summary;
  const paragraphs = stored.length > 0 ? stored : fallbackParagraphs(result);
  const narrative = narrativeOrSummary(result);
  return (
    <SectionCard
      id="executive-summary"
      title="Executive teaching summary"
      description="Built only from the computed numbers."
      className={className}
    >
      <div className="max-w-[70ch] space-y-3 text-[15px] leading-relaxed text-slate-800">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {stored.length === 0 ? (
        <p className="mt-3 text-xs text-slate-500">No stored summary for this row: composed in the browser from the marks shown.</p>
      ) : null}

      <div className="mt-5 max-w-[70ch] border-t border-slate-200 pt-4">
        <p className="text-xs text-slate-500">
          {narrative.computed ? (
            <>
              <span className="font-medium text-slate-700">Summary line (computed)</span> ·{" "}
              {result.submission.is_demo
                ? "synthetic record, no AI call, so no AI narrative; built from the marks shown."
                : "no AI narrative was stored for this evaluation; built from the marks shown."}
            </>
          ) : (
            <>
              <span className="font-medium text-slate-700">AI narrative</span> · evaluator&apos;s reading, not
              educator-validated
            </>
          )}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-700">{narrative.text}</p>
      </div>
    </SectionCard>
  );
}
