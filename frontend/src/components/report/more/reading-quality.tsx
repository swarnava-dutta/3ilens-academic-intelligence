"use client";

import { ChartFrame, HeatStrip } from "@/components/charts";
import { formatConfidence } from "@/lib/format";
import type { QuestionEvaluation, Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProvenanceGatesCard } from "../controls";
import { fmtFraction1 } from "../format";
import { QRefChip } from "../immediate-reading";
import { numeric } from "../summary/tokens";

/** Answers something was read for (a blank bonus question reads FULL but has nothing to read). */
function readAnswers(result: Result): QuestionEvaluation[] {
  return [...result.question_evaluations]
    .sort((a, b) => a.question - b.question)
    .filter((q) => q.outcome !== "BLANK" && (Boolean(q.selected_option) || q.student_answer.trim() !== ""));
}

/** "133 answers read · 4 below the 70% confidence line" for the fold teaser. */
export function readingTeaser(result: Result): string {
  if (result.submission.is_demo) return "Sample record: nothing was scanned";
  const read = readAnswers(result);
  const threshold = result.extraction.threshold;
  const low = read.filter((q) => q.confidence > 0 && q.confidence < threshold).length;
  return `${read.length} answers read · ${low} below the ${formatConfidence(threshold)} confidence line`;
}

/**
 * F8 "Reading quality" (faculty): how well the sheet was read — coverage, mean and lowest confidence,
 * the answers below the review line, confidence per answer, the reading engine and the paper checks.
 */
export function ReadingQuality({ result }: { result: Result }) {
  const ex = result.extraction;
  const isDemo = result.submission.is_demo;
  const read = readAnswers(result);
  const low = read.filter((q) => q.confidence > 0 && q.confidence < ex.threshold);
  const least = read.length ? read.reduce((w, q) => (q.confidence < w.confidence ? q : w)) : null;
  return (
    <div className="space-y-4">
      {isDemo ? (
        <p className="text-[13px] text-slate-600">Sample record: the answers were generated, so nothing was scanned or read.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Answers read", `${read.length}`, `of ${ex.total_questions} questions`],
              ["Mean confidence", fmtFraction1(ex.mean_confidence), "over answers read"],
              ["Below the line", `${low.length}`, `under ${formatConfidence(ex.threshold)}`],
              ["Lowest", least ? formatConfidence(least.confidence) : "—", least ? `Q${least.question}` : ""],
            ].map(([k, v, sub]) => (
              <div key={k} className="rounded-md border border-slate-200 px-3 py-2">
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className={cn("text-lg font-semibold text-[#1E3A8A]", numeric)}>{v}</dd>
                <dd className="text-[11px] text-slate-500">{sub}</dd>
              </div>
            ))}
          </dl>
          {low.length ? (
            <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-slate-700">
              Check these answers on the sheet:
              {low.map((q) => (
                <QRefChip key={q.question} q={q.question} />
              ))}
            </p>
          ) : null}
          {read.length ? (
            <ChartFrame
              title={result.voice ? "Transcript confidence by question" : "Reading confidence by question"}
              takeaway={
                least
                  ? `${low.length ? `${low.length} of ${read.length} answers` : "No answer"} read below the ${formatConfidence(ex.threshold)} review line; lowest Q${least.question} at ${formatConfidence(least.confidence)}. Blank answers are left out.`
                  : undefined
              }
              table={{
                columns: ["Question", "Confidence %"],
                rows: read.map((q) => [`Q${q.question}`, Math.round(q.confidence * 1000) / 10]),
              }}
            >
              <HeatStrip
                cells={read.map((q) => ({ label: `Q${q.question}`, value: q.confidence * 100 }))}
                domain={[50, 100]}
                format={(v) => `${Math.round(v)}%`}
              />
            </ChartFrame>
          ) : null}
          <p className="text-xs text-slate-600">
            Reading engine: {ex.ocr_adapter}
            {ex.ocr_cache_hit ? " · reused an earlier reading of the same file" : ""}
            {ex.flagged_pages.length ? ` · flagged pages ${ex.flagged_pages.join(", ")}` : ""}.
          </p>
        </>
      )}
      <ProvenanceGatesCard result={result} />
    </div>
  );
}
