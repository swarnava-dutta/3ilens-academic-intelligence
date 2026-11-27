"use client";

import { Bullet, ChartFrame } from "@/components/charts";
import type { HistoryEntry, Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtISTDate, fmtMarks, fmtPct1, fmtPctValue } from "../format";
import { modalMarks } from "../normalize-summary";
import { BandChip } from "./band-chip";
import { card, numeric } from "./tokens";

/** "70%" for a rule's whole-number cut point, else the 1-decimal format. */
const rulePct = (p: number) => (Number.isInteger(p) ? `${p}%` : fmtPctValue(p));

/** "102 marks to On track — about 26 more right answers (+4 each)." */
function gapLine(result: Result): string | null {
  const band = result.score_band;
  if (!band) return null;
  const toWhat = band.target_source === "batch_target" ? "the batch target" : "On track";
  if (band.marks_to_target <= 0) {
    return band.target_source === "batch_target"
      ? `At or above the batch target of ${fmtMarks(band.target_marks)}.`
      : `At or above the On track line (${fmtMarks(band.target_marks)}).`;
  }
  const mcq = result.question_evaluations.some((q) => q.question_type === "mcq");
  const per = modalMarks(result.question_evaluations);
  const n = band.right_answers_to_target;
  const answers =
    mcq && n > 0 ? ` — about ${n} more right ${n === 1 ? "answer" : "answers"}${per > 0 ? ` (+${fmtMarks(per)} each)` : ""}` : "";
  return `${fmtMarks(band.marks_to_target)} ${band.marks_to_target === 1 ? "mark" : "marks"} to ${toWhat}${answers}.`;
}

/** Small score trend with every value printed (only with two or more tests). */
function Trend({ history }: { history: HistoryEntry[] }) {
  const tests = [...history].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-6);
  if (tests.length < 2) return null;
  const values = tests.map((h) => (h.total_marks > 0 ? (h.score / h.total_marks) * 100 : h.pct));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const y = (v: number) => 26 - ((v - lo) / (hi - lo || 1)) * 22;
  const x = (i: number) => 4 + (i / (tests.length - 1)) * 192;
  const label = tests.map((h) => `${fmtISTDate(h.date)} ${fmtPct1(h.score, h.total_marks)}`).join(", ");
  return (
    <div className="mt-3 border-t border-slate-100 pt-2">
      <p className="text-xs font-medium text-slate-600">Score trend ({tests.length} tests, not equated for difficulty)</p>
      <div className="mt-1 flex items-center gap-3">
        <svg viewBox="0 0 200 30" className="h-8 w-32 shrink-0" role="img" aria-label={`Score trend: ${label}`}>
          <polyline
            points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            fill="none"
            stroke="#1E40AF"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {values.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill="#1E40AF" />
          ))}
        </svg>
        <p className={cn("min-w-0 text-xs text-slate-700", numeric)} aria-hidden>
          {tests.map((h) => fmtPct1(h.score, h.total_marks)).join(" → ")}
        </p>
      </div>
    </div>
  );
}

/**
 * Score hero: "402 / 720", "55.8%" and the band, then a bullet chart (bands from the urgency rule,
 * the On track line or a batch target as the target) and the gap to the target in right answers.
 */
export function ScoreHero({
  result,
  batchMedian,
  className,
}: {
  result: Result;
  /** Batch median in marks, only when the batch has 5 or more other graded students. */
  batchMedian?: number | null;
  className?: string;
}) {
  const score = result.total_score;
  const total = result.total_marks;
  const band = result.score_band;
  const pctText = fmtPct1(score, total);
  const median = band?.batch_median_marks ?? batchMedian ?? null;
  const gap = gapLine(result);
  return (
    <section aria-labelledby="score-heading" className={cn(card, "p-3 sm:p-4", className)}>
      <h2 id="score-heading" className="text-xs font-semibold text-slate-600">
        Score
      </h2>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <p className={cn("text-[40px] font-semibold leading-none text-[#1E3A8A]", numeric)}>
          {fmtMarks(score)}
          <span className="text-xl font-medium text-slate-500"> / {fmtMarks(total)}</span>
        </p>
        <p className={cn("text-xl font-semibold text-slate-800", numeric)}>{pctText}</p>
        {band ? <BandChip band={band.key} label={band.label} className="self-center" /> : null}
      </div>
      {band ? (
        <ChartFrame
          title="Score against the target"
          titleClassName="mt-3 text-xs font-medium text-slate-600"
          className="space-y-1"
          table={{
            columns: ["Measure", "Marks"],
            rows: [
              ["Score", `${fmtMarks(score)} (${pctText})`],
              [
                band.target_source === "batch_target" ? "Target (batch)" : "Target (On track line)",
                `${fmtMarks(band.target_marks)} (${rulePct(band.target_pct)})`,
              ],
              ...band.thresholds.map((t) => [t.label, `${fmtMarks(t.from_marks)}–${fmtMarks(t.to_marks)}`]),
              ...(median !== null ? [["Batch median", fmtMarks(median)]] : []),
            ],
          }}
        >
          <Bullet
            max={total}
            value={score}
            bands={band.thresholds.map((t) => ({ label: t.label, from: t.from_marks, to: t.to_marks }))}
            target={{
              value: band.target_marks,
              label: `Target ${fmtMarks(band.target_marks)} (${rulePct(band.target_pct)})`,
            }}
            median={median !== null ? { value: median, label: `Batch median ${fmtMarks(median)}` } : null}
            label={`Score ${fmtMarks(score)} of ${fmtMarks(total)}, ${pctText}, ${band.label}; target ${fmtMarks(band.target_marks)}`}
          />
        </ChartFrame>
      ) : null}
      {gap ? <p className="mt-2 text-[13px] font-medium text-slate-800">{gap}</p> : null}
      <Trend history={result.history} />
    </section>
  );
}
