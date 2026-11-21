"use client";

import { useCallback } from "react";
import { HeartPulse, Info } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getInterventionEffectiveness } from "@/lib/api";
import type { EffectRow, InterventionEffectiveness } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmt, signed } from "./format";
import { CardSkeleton, ErrorNote, SamplePill } from "./states";
import { useAsync } from "./use-async";

const MIN_CALIBRATION_N = 5;

function Stat({ label, value, hint, emphasis = false }: { label: string; value: string; hint: string; emphasis?: boolean }) {
  return (
    <div className={cn("rounded-xl px-3 py-2.5 ring-1 ring-inset ring-slate-200", emphasis && "bg-brand-cyan-50/60 ring-brand-cyan/30")}>
      <p className="text-xs font-medium text-slate-600">{label}</p>
      <p className="mt-0.5 text-xl font-bold tabular-nums text-brand-navy">{value}</p>
      <p className="text-[11px] text-slate-600">{hint}</p>
    </div>
  );
}

/** Diverging bar of the uplift around zero (text carries the sign; colour is secondary). */
function UpliftBar({ row, scale }: { row: EffectRow; scale: number }) {
  const u = row.uplift ?? 0;
  const width = Math.min(50, (Math.abs(u) / scale) * 50);
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
      <span className="min-w-0 truncate text-slate-800" title={row.label}>
        {row.label} <span className="text-xs text-slate-600">n={row.n}</span>
      </span>
      <span className="relative h-2.5 rounded-full bg-slate-100" aria-hidden>
        <span className="absolute inset-y-[-3px] left-1/2 w-px bg-slate-400" />
        {row.uplift !== null ? (
          <span
            className={cn("absolute inset-y-0 rounded-full", u >= 0 ? "left-1/2 bg-brand-lime-600" : "right-1/2 bg-rose-500")}
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
      <p className="mt-4 rounded-xl bg-slate-50 px-4 py-5 text-center text-sm text-slate-600">
        No interventions logged yet. Faculty log an action from a student&apos;s report; the next test measures the change.
      </p>
    );
  }
  const kinds = (data.by_kind ?? []).filter((r) => r.n > 0);
  const topics = (data.by_topic ?? []).filter((r) => r.n > 0).slice(0, compact ? 0 : 5);
  const scale = Math.max(5, ...[...kinds, ...topics].map((r) => Math.abs(r.uplift ?? 0)));

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Stat
          label="Treated topics"
          value={data.mean_change_treated === null ? "—" : `${signed(data.mean_change_treated)} pts`}
          hint="mean mastery change at the next test"
        />
        <Stat
          label="Untreated topics"
          value={data.mean_change_control === null ? "—" : `${signed(data.mean_change_control)} pts`}
          hint="same students, topics with no intervention"
        />
        <Stat
          label="Uplift"
          emphasis
          value={data.uplift === null ? "—" : `${signed(data.uplift)} pts`}
          hint="treated minus untreated (mastery points)"
        />
      </div>
      <p className="text-xs text-slate-600">
        {data.records} logged · {data.measured} measured · <span className="font-medium text-slate-700">{data.pending} pending</span>{" "}
        (waiting for a follow-up test)
      </p>

      {kinds.length ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">By kind</h3>
          <ul className="mt-2 space-y-2">
            {kinds.map((r) => (
              <UpliftBar key={r.key} row={r} scale={scale} />
            ))}
          </ul>
        </div>
      ) : null}

      {topics.length ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">By topic (top 5)</h3>
          <ul className="mt-2 space-y-2">
            {topics.map((r) => (
              <UpliftBar key={r.key} row={r} scale={scale} />
            ))}
          </ul>
        </div>
      ) : null}

      {!compact && data.by_institution?.length ? (
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
            Calibration factor per institution
            <IllustrativePill
              title="Ratio of measured to predicted mastery gain; used by the what-if simulator when you tick 'Use calibration'. Not a validated forecast."
            />
          </h3>
          <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
            {data.by_institution.map((inst) => {
              const ready = inst.calibration_factor !== null && inst.calibration_n >= MIN_CALIBRATION_N;
              return (
                <li key={inst.institution_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="font-medium text-slate-800">{inst.institution_name}</span>
                  <span className="text-slate-700 tabular-nums">
                    {ready ? (
                      <>
                        <span className="font-semibold text-brand-navy">×{fmt(inst.calibration_factor, 2)}</span> (n ={" "}
                        {inst.calibration_n} measured)
                      </>
                    ) : (
                      <span className="text-slate-600">
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

      <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{data.caveat}</span>
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
    <Card aria-labelledby={`effect-title-${compact ? "c" : "o"}`} className={className}>
      <CardHeader
        id={`effect-title-${compact ? "c" : "o"}`}
        icon={HeartPulse}
        title={compact ? "Intervention effect (this view)" : "Intervention effectiveness"}
        subtitle="Logged actions vs the change at the next test - observational, not causal"
        action={data?.is_demo ? <SamplePill /> : null}
      />
      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} className="mt-4" /> : null}
      {data ? <EffectivenessBody data={data} compact={compact} /> : null}
    </Card>
  );
}
