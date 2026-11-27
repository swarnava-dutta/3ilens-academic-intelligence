"use client";

import { useCallback, useState } from "react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getInterventionEffectiveness } from "@/lib/api";
import type { EffectRow, InterventionEffectiveness } from "@/lib/types";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { fmt, signed } from "./format";
import { Figure, stripCls } from "./kpis";
import { Disclosure, signed1 } from "./owner-ui";
import { CardSkeleton, EmptyNote, ErrorNote, Panel, SamplePill, tagCls } from "./states";

const MIN_CALIBRATION_N = 5;
/** Owner view: rows measured on fewer actions than this are drawn quietly and tagged. */
const MIN_ROW_N = 5;
const PLAIN_CAVEAT = "Observational: students were not randomised, so the uplift is indicative, not causal.";

/**
 * Uplift as shown: treated minus untreated from the two 1-dp parts, so the row always equals its own
 * tooltip ("+6.7 vs +2.0" is +4.7, never +4.6 from the unrounded means). Falls back to the API value.
 */
function shownUplift(treated: number | null | undefined, control: number | null | undefined, api: number | null): number | null {
  if (typeof treated === "number" && typeof control === "number") return Math.round((treated - control) * 10) / 10;
  return api;
}

/** Diverging bar of the uplift around zero (text carries the sign; colour is secondary). */
function UpliftBar({ row, scale, owner = false }: { row: EffectRow; scale: number; owner?: boolean }) {
  const uplift = owner ? shownUplift(row.mean_change, row.control_change, row.uplift) : row.uplift;
  const u = uplift ?? 0;
  const sgn = owner ? signed1 : signed;
  const width = Math.min(50, (Math.abs(u) / scale) * 50);
  const small = owner && row.n < MIN_ROW_N;
  const improved =
    owner && row.improved_share !== null && row.improved_share !== undefined
      ? `${Math.round(row.improved_share * row.n)} of ${row.n} improved`
      : null;
  return (
    <li
      className={cn(
        "grid items-center gap-2 text-sm",
        // Owner view below sm: label and value on one line, then a full-width bar.
        owner
          ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,12rem)_1fr_auto]"
          : "grid-cols-[minmax(0,9rem)_1fr_auto] sm:grid-cols-[minmax(0,12rem)_1fr_auto]",
      )}
    >
      <span className="min-w-0 text-slate-800" title={row.label}>
        <span className="block truncate">
          {row.label} <span className="text-xs tabular-nums text-slate-500">n={row.n}</span>
        </span>
        {small ? (
          <span className={cn(tagCls, "bg-slate-100 font-normal text-slate-600")}>small sample</span>
        ) : improved ? (
          <span className="block text-xs text-slate-600">{improved}</span>
        ) : null}
      </span>
      <span className={cn("relative h-2 bg-slate-100", owner && "order-last col-span-2 sm:order-none sm:col-span-1")} aria-hidden>
        <span className="absolute inset-y-[-3px] left-1/2 w-px bg-slate-400" />
        {uplift !== null ? (
          <span
            className={cn(
              "absolute inset-y-0",
              u >= 0 ? "left-1/2" : "right-1/2",
              small ? "bg-slate-300" : u >= 0 ? "bg-brand-lime-600" : "bg-rose-600",
            )}
            style={{ width: `${width}%` }}
          />
        ) : null}
      </span>
      <span
        className={cn("w-28 text-right text-xs tabular-nums", small ? "text-slate-500" : "text-slate-700")}
        title={`Treated ${sgn(row.mean_change)} pts vs untreated ${sgn(row.control_change)} pts`}
      >
        {uplift === null ? "not measured" : `${sgn(uplift)} pts uplift`}
      </span>
    </li>
  );
}

function EffectivenessBody({
  data,
  compact,
  owner,
  hideCalibration,
  atRiskFollowThrough,
}: {
  data: InterventionEffectiveness;
  compact: boolean;
  owner: boolean;
  hideCalibration: boolean;
  atRiskFollowThrough: { actioned: number; total: number } | null;
}) {
  const [topicsOpen, setTopicsOpen] = useState(false);
  if (data.records === 0) {
    return (
      <EmptyNote>
        No interventions logged yet. Faculty log an action from a student&apos;s report; the next test measures the change.
      </EmptyNote>
    );
  }
  const kinds = (data.by_kind ?? []).filter((r) => r.n > 0);
  const topics = (data.by_topic ?? []).filter((r) => r.n > 0).slice(0, compact ? 0 : owner ? undefined : 5);
  const scaleRows = owner ? [...kinds, ...topics].filter((r) => r.n >= MIN_ROW_N) : [...kinds, ...topics];
  const scale = Math.max(
    5,
    ...scaleRows.map((r) => Math.abs((owner ? shownUplift(r.mean_change, r.control_change, r.uplift) : r.uplift) ?? 0)),
  );
  const topUplift = owner ? shownUplift(data.mean_change_treated, data.mean_change_control, data.uplift) : data.uplift;
  const followThrough = owner && atRiskFollowThrough && atRiskFollowThrough.total > 0 ? atRiskFollowThrough : null;
  const caveatTip = data.caveat.replace(/\s*\(V5:[^)]*\)/g, "");
  // The owner view always shows 1 dp ("+2.0 pts"); the cohort card keeps its compact format.
  const sgn = owner ? signed1 : signed;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          stripCls,
          "grid-cols-1 sm:grid-cols-3",
          followThrough && "grid-cols-2 sm:grid-cols-4",
          compact && "xl:grid-cols-1",
        )}
      >
        <Figure
          label="Treated topics"
          value={data.mean_change_treated === null ? "—" : `${sgn(data.mean_change_treated)} pts`}
          hint="mean mastery change at the next test"
        />
        <Figure
          label="Untreated topics"
          value={data.mean_change_control === null ? "—" : `${sgn(data.mean_change_control)} pts`}
          hint="same students, topics with no intervention"
        />
        <Figure
          label="Uplift"
          value={topUplift === null ? "—" : `${sgn(topUplift)} pts`}
          hint="treated minus untreated (mastery points)"
        />
        {followThrough ? (
          <Figure
            label="At-risk students actioned"
            tone={followThrough.actioned < followThrough.total ? "rose" : "default"}
            value={
              <>
                {followThrough.actioned}
                <span className="text-sm font-normal text-slate-500"> of {followThrough.total}</span>
              </>
            }
            hint="with an action since their latest test"
          />
        ) : null}
      </div>
      <p className="text-xs tabular-nums text-slate-500">
        {data.records} logged · {data.measured} measured · {data.pending} pending (waiting for a follow-up test)
      </p>

      {kinds.length ? (
        <div>
          <h3 className="text-[13px] font-semibold text-slate-700">By kind</h3>
          <ul className="mt-2 space-y-2">
            {kinds.map((r) => (
              <UpliftBar key={r.key} row={r} scale={scale} owner={owner} />
            ))}
          </ul>
        </div>
      ) : null}

      {topics.length && owner ? (
        <div>
          <Disclosure open={topicsOpen} onToggle={() => setTopicsOpen((v) => !v)} controls="effect-by-topic">
            {topicsOpen ? "Hide by topic" : `Show by topic (${topics.length})`}
          </Disclosure>
          <ul id="effect-by-topic" hidden={!topicsOpen} className="mt-2 space-y-2">
            {topicsOpen ? topics.map((r) => <UpliftBar key={r.key} row={r} scale={scale} owner />) : null}
          </ul>
        </div>
      ) : topics.length ? (
        <div>
          <h3 className="text-[13px] font-semibold text-slate-700">By topic (top 5)</h3>
          <ul className="mt-2 space-y-2">
            {topics.map((r) => (
              <UpliftBar key={r.key} row={r} scale={scale} />
            ))}
          </ul>
        </div>
      ) : null}

      {!compact && !hideCalibration && data.by_institution?.length ? (
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-slate-700">
            Calibration factor per institution
            <IllustrativePill
              title="Ratio of measured to predicted mastery gain; used by the what-if simulator when you tick 'Use calibration'. Not a validated forecast."
            />
          </h3>
          <ul className="mt-2 divide-y divide-slate-200 border-y border-slate-200">
            {data.by_institution.map((inst) => {
              const ready = inst.calibration_factor !== null && inst.calibration_n >= MIN_CALIBRATION_N;
              return (
                <li key={inst.institution_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-slate-800">{inst.institution_name}</span>
                  <span className="text-slate-700 tabular-nums">
                    {ready ? (
                      <>
                        <span className="font-medium text-slate-900">×{fmt(inst.calibration_factor, 2)}</span> (from{" "}
                        {inst.calibration_n} of {inst.measured} measured actions that had a prediction)
                      </>
                    ) : (
                      <span className="text-slate-500">
                        needs &ge; {MIN_CALIBRATION_N} measured interventions (n = {inst.calibration_n})
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {owner ? (
        <p className="border-t border-slate-200 pt-3 text-xs text-slate-600" title={caveatTip}>
          {PLAIN_CAVEAT}
          {data.is_demo ? " Sample data." : ""}
        </p>
      ) : (
        <p className="border-t border-slate-200 pt-3 text-xs text-slate-600">
          <span className="font-medium text-slate-700">Caveat: </span>
          {data.caveat}
        </p>
      )}
    </div>
  );
}

/**
 * Intervention effectiveness (FR-4.13): treated vs untreated mastery change, by kind / topic,
 * calibration per institution. `compact` drops the per-topic and per-institution detail.
 * `variant="owner"` adds the at-risk follow-through figure, tags rows measured on fewer than 5
 * actions, puts the topics behind a disclosure and shows a one-sentence caveat.
 */
export function EffectivenessCard({
  institutionId = null,
  batchId = null,
  compact = false,
  className,
  variant = "default",
  hideCalibration = false,
  atRiskFollowThrough = null,
}: {
  institutionId?: number | null;
  batchId?: number | null;
  compact?: boolean;
  className?: string;
  variant?: "default" | "owner";
  /** Hide the per-institution calibration list (the owner page shows it in the what-if tab). */
  hideCalibration?: boolean;
  /** At-risk students with an action since their latest test (owner payload). */
  atRiskFollowThrough?: { actioned: number; total: number } | null;
}) {
  const fetcher = useCallback(
    () => getInterventionEffectiveness({ institution_id: institutionId, batch_id: batchId }),
    [institutionId, batchId],
  );
  const { data, error, loading, reload } = useAsync(fetcher);
  const owner = variant === "owner";

  if (!data && loading) return <CardSkeleton rows={4} label="Loading intervention effectiveness…" className={className} />;

  return (
    <Panel
      id={`effect-title-${compact ? "c" : "o"}`}
      className={className}
      title={compact ? "Intervention effect (this view)" : "Intervention effectiveness"}
      subtitle="Logged actions vs the change at the next test. Observational, not causal."
      action={data?.is_demo ? <SamplePill /> : null}
    >
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} /> : null}
      {data ? (
        <EffectivenessBody
          data={data}
          compact={compact}
          owner={owner}
          hideCalibration={hideCalibration}
          atRiskFollowThrough={atRiskFollowThrough}
        />
      ) : null}
    </Panel>
  );
}
