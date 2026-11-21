"use client";

import { Award, Clock3, Gauge, IndianRupee, ListChecks, ScanText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Priority, Result } from "@/lib/types";
import { cn, formatConfidence, formatMastery } from "@/lib/utils";
import { OUTCOME_LOOK, TONE, clampPct, fmtInr, fmtNumber, fmtSeconds, safeNumber, toneFor } from "./format";
import { MeterBar, Pill, RadialGauge } from "./primitives";

function Tile({
  label,
  icon: Icon,
  accent,
  title,
  children,
  caption,
}: {
  label: string;
  icon: LucideIcon;
  accent: string;
  title?: string;
  children: ReactNode;
  caption?: ReactNode;
}) {
  return (
    <div
      title={title}
      className="relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 print:break-inside-avoid print:shadow-none"
    >
      <div aria-hidden className={cn("absolute inset-x-0 top-0 h-1 [print-color-adjust:exact]", accent)} />
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-500">{label}</h3>
        <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      </div>
      <div className="mt-3 flex flex-1 flex-col justify-center">{children}</div>
      {caption ? <p className="mt-3 text-xs leading-snug text-slate-500">{caption}</p> : null}
    </div>
  );
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
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Full / partial</dt>
          <dd className="text-xl font-semibold tabular-nums text-brand-navy">
            {o.full} <span className="text-slate-300">/</span> {o.partial}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Zero / not attempted</dt>
          <dd className="text-xl font-semibold tabular-nums text-brand-navy">
            {o.zero} <span className="text-slate-300">/</span> {o.blank}
          </dd>
        </div>
      </dl>
      <div
        className="mt-3 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100 [print-color-adjust:exact]"
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
 * KPI tiles: observed score, outcome split, extraction coverage, processing cost and
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

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-3">
      <Tile label="Score" icon={Award} accent="bg-brand-cyan" caption="Partial credit in 0.5 steps; totals summed server-side.">
        <div className="flex items-center gap-4">
          <RadialGauge percent={pct} label={`Score ${fmtNumber(score)} out of ${fmtNumber(total)} marks`} size={88} strokeWidth={8}>
            <span className="leading-none">
              <span className="block text-xl font-semibold tabular-nums text-brand-navy">{fmtNumber(score)}</span>
              <span className="text-[11px] text-slate-500">of {fmtNumber(total)}</span>
            </span>
          </RadialGauge>
          <div className="min-w-0">
            <p className="text-3xl font-semibold tabular-nums tracking-tight text-brand-navy">
              {fmtNumber(score)}/{fmtNumber(total)}
            </p>
            <p className="mt-0.5 text-sm tabular-nums text-slate-500">({fmtNumber(pct)}%)</p>
          </div>
        </div>
      </Tile>

      <Tile
        label="Observed score %"
        icon={Gauge}
        accent={tone.fill}
        title="Screening result, not certified competency"
        caption="Screening result, not certified competency."
      >
        <div className="flex items-center gap-4">
          <RadialGauge
            percent={pct}
            label={`Observed score ${formatMastery(pct)}, ${tone.label}`}
            size={88}
            strokeWidth={8}
            colorClass={tone.stroke}
            trackClass={tone.trackStroke}
          >
            <span className="text-lg font-semibold tabular-nums text-brand-navy">{formatMastery(pct)}</span>
          </RadialGauge>
          <div className="min-w-0 space-y-2">
            <Pill className={tone.pill}>{tone.label}</Pill>
            <p className="text-sm text-slate-500">
              Across {topicCount} {topicCount === 1 ? "topic" : "topics"}
            </p>
          </div>
        </div>
      </Tile>

      <Tile label="Question outcomes" icon={ListChecks} accent="bg-brand-lime" caption="Blank answers count in the denominator.">
        <OutcomeSplit result={result} />
      </Tile>

      <Tile
        label="Extraction coverage"
        icon={ScanText}
        accent={ex.below_threshold > 0 ? "bg-amber-400" : "bg-brand-cyan"}
        caption="Mapping is not approval."
      >
        <p className="text-2xl font-semibold tabular-nums text-brand-navy">
          Mapped {ex.mapped}/{ex.total_questions}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {isDemo ? (
            "Synthetic transcript - no OCR run"
          ) : (
            <>
              Mean OCR <span className="font-semibold tabular-nums">{formatConfidence(ex.mean_confidence)}</span> ·{" "}
              <span className={cn("font-semibold tabular-nums", ex.below_threshold > 0 ? "text-amber-700" : "")}>
                {ex.below_threshold}
              </span>{" "}
              below the {thresholdPct}% threshold
            </>
          )}
        </p>
        {ex.ocr_cache_hit ? (
          <p className="mt-1 text-xs font-medium text-cyan-800">OCR cache hit - no vision call (Rs 0.00)</p>
        ) : null}
      </Tile>

      <Tile
        label="Processing cost"
        icon={IndianRupee}
        accent={isDemo || costOk === null ? "bg-slate-300" : costOk ? "bg-brand-lime" : "bg-amber-400"}
        caption={`BRD target: under ${fmtInr(cost.target_inr)} per learner.`}
      >
        {isDemo || cost.synthetic ? (
          <>
            <p className="text-2xl font-semibold text-slate-500">Rs 0.00</p>
            <p className="mt-1 text-sm text-slate-500">Synthetic - no AI call</p>
          </>
        ) : costValue === null ? (
          <>
            <p className="text-2xl font-semibold text-slate-400">—</p>
            <p className="mt-1 text-sm text-slate-500">No per-call cost recorded for this run</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums text-brand-navy">{fmtInr(costValue)}</p>
            <p className={cn("mt-1 text-sm font-medium", costOk ? "text-lime-700" : "text-amber-700")}>
              {costOk ? "Within" : "Above"} the {fmtInr(cost.target_inr)} target · {cost.calls}{" "}
              {cost.calls === 1 ? "call" : "calls"}
            </p>
            <MeterBar
              className="mt-2"
              size="sm"
              percent={(costValue / Math.max(cost.target_inr, 0.01)) * 100}
              label="Cost against the target"
              valueText={`${fmtInr(costValue)} of ${fmtInr(cost.target_inr)}`}
              fillClass={costOk ? "bg-brand-lime" : "bg-amber-400"}
              trackClass="bg-slate-100"
            />
          </>
        )}
      </Tile>

      <Tile
        label="End-to-end latency"
        icon={Clock3}
        accent={isDemo || latOk === null ? "bg-slate-300" : latOk ? "bg-brand-lime" : "bg-amber-400"}
        caption={`BRD target: under ${fmtSeconds(lat.target_seconds)} per learner.`}
      >
        {isDemo ? (
          <>
            <p className="text-2xl font-semibold text-slate-500">—</p>
            <p className="mt-1 text-sm text-slate-500">Synthetic - no pipeline run</p>
          </>
        ) : lat.seconds === null ? (
          <>
            <p className="text-2xl font-semibold text-slate-400">—</p>
            <p className="mt-1 text-sm text-slate-500">Start/finish times not recorded for this run</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums text-brand-navy">{fmtSeconds(lat.seconds)}</p>
            <p className={cn("mt-1 text-sm font-medium", latOk ? "text-lime-700" : "text-amber-700")}>
              {latOk ? "Within" : "Over"} the {fmtSeconds(lat.target_seconds)} target
            </p>
            <MeterBar
              className="mt-2"
              size="sm"
              percent={(lat.seconds / Math.max(lat.target_seconds, 1)) * 100}
              label="Latency against the target"
              valueText={`${fmtSeconds(lat.seconds)} of ${fmtSeconds(lat.target_seconds)}`}
              fillClass={latOk ? "bg-brand-lime" : "bg-amber-400"}
              trackClass="bg-slate-100"
            />
          </>
        )}
      </Tile>
    </div>
  );
}
