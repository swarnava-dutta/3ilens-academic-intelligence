"use client";

import { useCallback } from "react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getInterventionEffectiveness } from "@/lib/api";
import type { EffectRow, InterventionEffectiveness } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, signed } from "./format";
import { Figure, stripCls } from "./kpis";
import { CardSkeleton, EmptyNote, ErrorNote, Panel, SamplePill } from "./states";
import { useAsync } from "./use-async";

const MIN_CALIBRATION_N = 5;

/** Diverging bar of the uplift around zero (text carries the sign; colour is secondary). */
function UpliftBar({ row, scale }: { row: EffectRow; scale: number }) {
  const u = row.uplift ?? 0;
  const width = Math.min(50, (Math.abs(u) / scale) * 50);
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
      <span className="min-w-0 truncate text-slate-800" title={row.label}>
        {row.label} <span className="text-xs tabular-nums text-slate-500">n={row.n}</span>
      </span>
      <span className="relative h-2 bg-slate-100" aria-hidden>
        <span className="absolute inset-y-[-3px] left-1/2 w-px bg-slate-400" />
        {row.uplift !== null ? (
          <span
            className={cn("absolute inset-y-0", u >= 0 ? "left-1/2 bg-brand-lime-600" : "right-1/2 bg-rose-600")}
            style={{ width: `${width}%` }}
          />
        ) : null}
      </span>
      <span
        className="w-28 text-right text-xs tabular-nums text-slate-700"
        title={`Treated ${signed(row.mean_change)} pts vs untreated ${signed(row.control_change)} pts`}
      >
        {row.uplift === null ? "not measured" : `${signed(row.uplift)} pts uplift`}
      </span>
    </li>
  );
}

function EffectivenessBody({ data, compact }: { data: InterventionEffectiveness; compact: boolean }) {
  if (data.records === 0) {
    return (
      <EmptyNote>
        No interventions logged yet. Faculty log an action from a student&apos;s report; the next test measures the change.
      </EmptyNote>
    );
  }
  const kinds = (data.by_kind ?? []).filter((r) => r.n > 0);
  const topics = (data.by_topic ?? []).filter((r) => r.n > 0).slice(0, compact ? 0 : 5);
  const scale = Math.max(5, ...[...kinds, ...topics].map((r) => Math.abs(r.uplift ?? 0)));

  return (
    <div className="space-y-4">
      <div className={cn(stripCls, "grid-cols-1 sm:grid-cols-3", compact && "xl:grid-cols-1")}>
        <Figure
          label="Treated topics"
          value={data.mean_change_treated === null ? "—" : `${signed(data.mean_change_treated)} pts`}
          hint="mean mastery change at the next test"
        />
        <Figure
          label="Untreated topics"
          value={data.mean_change_control === null ? "—" : `${signed(data.mean_change_control)} pts`}
          hint="same students, topics with no intervention"
        />
        <Figure
          label="Uplift"
          value={data.uplift === null ? "—" : `${signed(data.uplift)} pts`}
          hint="treated minus untreated (mastery points)"
        />
      </div>
      <p className="text-xs tabular-nums text-slate-500">
        {data.records} logged · {data.measured} measured · {data.pending} pending (waiting for a follow-up test)
      </p>

      {kinds.length ? (
        <div>
          <h3 className="text-[13px] font-semibold text-slate-700">By kind</h3>
          <ul className="mt-2 space-y-2">
            {kinds.map((r) => (
              <UpliftBar key={r.key} row={r} scale={scale} />
            ))}
          </ul>
        </div>
      ) : null}

      {topics.length ? (
        <div>
          <h3 className="text-[13px] font-semibold text-slate-700">By topic (top 5)</h3>
          <ul className="mt-2 space-y-2">
            {topics.map((r) => (
              <UpliftBar key={r.key} row={r} scale={scale} />
            ))}
          </ul>
        </div>
      ) : null}

      {!compact && data.by_institution?.length ? (
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
                        <span className="font-medium text-slate-900">×{fmt(inst.calibration_factor, 2)}</span> (n ={" "}
                        {inst.calibration_n} measured)
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

      <p className="border-t border-slate-200 pt-3 text-xs text-slate-600">
        <span className="font-medium text-slate-700">Caveat: </span>
        {data.caveat}
      </p>
    </div>
  );
}

/**
 * Intervention effectiveness (FR-4.13): treated vs untreated mastery change, by kind / topic,
 * calibration per institution. `compact` drops the per-topic and per-institution detail.
 */
export function EffectivenessCard({
  institutionId = null,
  batchId = null,
  compact = false,
  className,
}: {
  institutionId?: number | null;
  batchId?: number | null;
  compact?: boolean;
  className?: string;
}) {
  const fetcher = useCallback(
    () => getInterventionEffectiveness({ institution_id: institutionId, batch_id: batchId }),
    [institutionId, batchId],
  );
  const { data, error, loading, reload } = useAsync(fetcher);

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
      {data ? <EffectivenessBody data={data} compact={compact} /> : null}
    </Panel>
  );
}
