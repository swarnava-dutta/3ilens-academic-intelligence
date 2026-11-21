"use client";

import type { ReactNode } from "react";
import type { Priority, Result } from "@/lib/types";
import { cn, formatConfidence, formatMastery } from "@/lib/utils";
import { NET_TOTAL_TITLE, OUTCOME_LOOK, TONE, clampPct, fmtInr, fmtNumber, fmtSeconds, safeNumber, toneFor } from "./format";
import { MeterBar, Pill } from "./primitives";

/** One figure in the KPI strip: label, value, one detail line. */
function Figure({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div title={title} className="min-w-0 bg-white px-4 py-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 space-y-1">{children}</dd>
    </div>
  );
}

const value = "text-xl font-semibold leading-tight tabular-nums text-brand-navy";
const detail = "text-xs leading-snug text-slate-500";

/** Marks deducted by negative marking across the paper (MCQ penalties). */
export function totalPenalty(result: Result): number {
  return result.question_evaluations.reduce((sum, q) => sum + Math.max(0, safeNumber(q.penalty)), 0);
}

export function topPriority(priorities: Priority[]): Priority | null {
  let best: Priority | null = null;
  for (const p of priorities) {
    if (!best || safeNumber(p.roi) > safeNumber(best.roi)) best = p;
  }
  return best;
}

function OutcomeSplit({ result }: { result: Result }) {
  const o = result.outcome_counts;
  const total = Math.max(1, o.full + o.partial + o.zero + o.blank);
  const parts = [
    { key: "FULL" as const, n: o.full },
    { key: "PARTIAL" as const, n: o.partial },
    { key: "ZERO" as const, n: o.zero },
    { key: "BLANK" as const, n: o.blank },
  ];
  return (
    <>
      <p className={value}>
        {o.full} <span className="text-sm font-normal text-slate-500">full</span> · {o.partial}{" "}
        <span className="text-sm font-normal text-slate-500">partial</span>
      </p>
      <p className={cn(detail, "tabular-nums")}>
        {o.zero} zero · {o.blank} not attempted
      </p>
      <div
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-sm bg-slate-100 [print-color-adjust:exact]"
        role="img"
        aria-label={`Outcomes: ${o.full} full, ${o.partial} partial, ${o.zero} zero, ${o.blank} not attempted`}
      >
        {parts.map((p) =>
          p.n > 0 ? (
            <span key={p.key} className={cn("h-full", OUTCOME_LOOK[p.key].fill)} style={{ width: `${(p.n / total) * 100}%` }} />
          ) : null,
        )}
      </div>
    </>
  );
}

/**
 * KPI strip: score, observed %, outcome split, extraction coverage, processing cost and
 * end-to-end latency against the BRD acceptance targets (Rs 5 / learner, 5 minutes / learner).
 */
export function StatCards({ result }: { result: Result }) {
  const total = safeNumber(result.total_marks);
  const score = safeNumber(result.total_score);
  const pct = clampPct(result.percentage);
  const tone = TONE[toneFor(pct)];
  const isDemo = result.submission.is_demo;
  const ex = result.extraction;
  const cost = result.cost;
  const lat = result.latency;
  const thresholdPct = Math.round(ex.threshold * 100);
  const costValue = cost.llm_cost_inr;
  const costOk = cost.within_target ?? (costValue === null ? null : costValue <= cost.target_inr);
  const latOk = lat.within_target ?? (lat.seconds === null ? null : lat.seconds <= lat.target_seconds);
  const topicCount = result.topic_mastery.length;
  const penalty = totalPenalty(result);
  const markingRule = result.scoring_controls?.marking_rule || "Partial credit in 0.5 steps; totals summed server-side.";

  return (
    <div className="space-y-2 print:break-inside-avoid">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 md:grid-cols-3 xl:grid-cols-6 print:grid-cols-6">
        <Figure label="Score" title={score < 0 || penalty > 0 ? NET_TOTAL_TITLE : undefined}>
          <p className={cn(value, score < 0 && "text-rose-700")}>
            {fmtNumber(score)} <span className="text-sm font-normal text-slate-500">/ {fmtNumber(total)}</span>
          </p>
          {penalty > 0 ? (
            <p className="text-xs font-medium tabular-nums text-rose-700">{fmtNumber(-penalty)} from negative marking</p>
          ) : (
            <p className={detail}>Marks, provisional</p>
          )}
        </Figure>

        <Figure label="Observed score" title="Screening result, not certified competency">
          <p className={value}>{formatMastery(pct)}</p>
          <p className={detail}>
            <Pill className={tone.pill}>{tone.label}</Pill> across {topicCount} {topicCount === 1 ? "topic" : "topics"}
          </p>
          <MeterBar size="sm" percent={pct} label={`Observed score ${formatMastery(pct)}, ${tone.label}`} fillClass={tone.fill} />
        </Figure>

        <Figure label="Question outcomes">
          <OutcomeSplit result={result} />
        </Figure>

        <Figure label="Extraction coverage">
          <p className={value}>
            {ex.mapped} <span className="text-sm font-normal text-slate-500">/ {ex.total_questions} mapped</span>
          </p>
          <p className={detail}>
            {isDemo ? (
              "Synthetic transcript, no OCR run"
            ) : (
              <>
                Mean OCR <span className="tabular-nums text-slate-700">{formatConfidence(ex.mean_confidence)}</span> ·{" "}
                <span className={cn("tabular-nums", ex.below_threshold > 0 ? "font-medium text-amber-700" : "text-slate-700")}>
                  {ex.below_threshold}
                </span>{" "}
                below {thresholdPct}%
              </>
            )}
          </p>
          {ex.ocr_cache_hit ? <p className={detail}>OCR cache hit, no vision call (Rs 0.00)</p> : null}
        </Figure>

        <Figure label="Processing cost">
          {isDemo || cost.synthetic ? (
            <>
              <p className={cn(value, "text-slate-500")}>Rs 0.00</p>
              <p className={detail}>Synthetic, no AI call</p>
            </>
          ) : costValue === null ? (
            <>
              <p className={cn(value, "text-slate-400")}>—</p>
              <p className={detail}>No per-call cost recorded</p>
            </>
          ) : (
            <>
              <p className={value}>{fmtInr(costValue)}</p>
              <p className={cn("text-xs font-medium tabular-nums", costOk ? "text-lime-700" : "text-amber-700")}>
                {costOk ? "Within" : "Above"} {fmtInr(cost.target_inr)} target · {cost.calls} {cost.calls === 1 ? "call" : "calls"}
              </p>
              <MeterBar
                size="sm"
                percent={(costValue / Math.max(cost.target_inr, 0.01)) * 100}
                label="Cost against the target"
                valueText={`${fmtInr(costValue)} of ${fmtInr(cost.target_inr)}`}
                fillClass={costOk ? "bg-brand-lime-600" : "bg-amber-500"}
              />
            </>
          )}
        </Figure>

        <Figure label="End-to-end latency">
          {isDemo ? (
            <>
              <p className={cn(value, "text-slate-500")}>—</p>
              <p className={detail}>Synthetic, no pipeline run</p>
            </>
          ) : lat.seconds === null ? (
            <>
              <p className={cn(value, "text-slate-400")}>—</p>
              <p className={detail}>Start/finish times not recorded</p>
            </>
          ) : (
            <>
              <p className={value}>{fmtSeconds(lat.seconds)}</p>
              <p className={cn("text-xs font-medium tabular-nums", latOk ? "text-lime-700" : "text-amber-700")}>
                {latOk ? "Within" : "Over"} {fmtSeconds(lat.target_seconds)} target
              </p>
              <MeterBar
                size="sm"
                percent={(lat.seconds / Math.max(lat.target_seconds, 1)) * 100}
                label="Latency against the target"
                valueText={`${fmtSeconds(lat.seconds)} of ${fmtSeconds(lat.target_seconds)}`}
                fillClass={latOk ? "bg-brand-lime-600" : "bg-amber-500"}
              />
            </>
          )}
        </Figure>
      </dl>
      <p className="text-xs leading-snug text-slate-500">
        {markingRule} Observed score is a screening result, not certified competency. Blank answers count in the
        denominator; mapping is not approval. BRD targets: under {fmtInr(cost.target_inr)} and{" "}
        {fmtSeconds(lat.target_seconds)} per learner.
      </p>
    </div>
  );
}
