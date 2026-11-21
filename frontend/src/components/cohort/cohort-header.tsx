import { Building2, FlaskConical, GraduationCap, Radio, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { COHORT_REFRESH_MS } from "./use-cohort";
import { batchLabel, plural } from "./format";

const PILL = "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset";

export function CohortHeader({
  cohort,
  updatedLabel,
  refreshing,
  onRefresh,
}: {
  cohort: Cohort;
  updatedLabel: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-cyan-600">
          Batch intelligence
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">
          Cohort Dashboard
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <Building2 className="h-4 w-4 text-slate-400" aria-hidden />
            <span className="sr-only">Institution:</span>
            {cohort.institution?.name ?? "Institution"}
          </span>
          <span aria-hidden className="text-slate-300">
            •
          </span>
          <span className="inline-flex items-center gap-1.5">
            <GraduationCap className="h-4 w-4 text-slate-400" aria-hidden />
            <span className="sr-only">Batch:</span>
            <span className="font-medium text-slate-700">{batchLabel(cohort.batch)}</span>
          </span>
        </p>
      </div>

      <div className="flex flex-col items-start gap-2 lg:items-end">
        <ProvenancePills cohort={cohort} />
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span aria-live="polite">
            {updatedLabel ? `Updated ${updatedLabel}` : "Live"} · auto-refresh every{" "}
            {Math.round(COHORT_REFRESH_MS / 1000)} s
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh cohort data now"
            title="Refresh now"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 ring-1 ring-slate-200 transition hover:bg-brand-cyan-50 hover:text-brand-cyan-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan disabled:opacity-60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden />
          </button>
        </div>
      </div>
    </header>
  );
}

/** Data provenance: the client must never mistake synthetic demo data for real results. */
export function ProvenancePills({ cohort }: { cohort: Cohort }) {
  const demo = cohort.demo_count ?? 0;
  const real = cohort.real_count ?? 0;

  return (
    <div className="flex flex-wrap gap-2" aria-label="Data provenance">
      {demo > 0 ? (
        <>
          <span className={cn(PILL, "bg-amber-50 font-semibold text-amber-800 ring-amber-300")}>
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            Includes {plural(demo, "synthetic demo record")}
          </span>
          <span className={cn(PILL, "bg-slate-100 text-slate-700 ring-slate-200")}>
            <Radio className="h-3.5 w-3.5" aria-hidden />
            {plural(real, "live record")}
          </span>
        </>
      ) : real > 0 ? (
        <span className={cn(PILL, "bg-brand-lime-50 text-lime-800 ring-brand-lime/50")}>
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          100% live data · {plural(real, "record")}
        </span>
      ) : (
        <span className={cn(PILL, "bg-slate-100 text-slate-600 ring-slate-200")}>
          <Radio className="h-3.5 w-3.5" aria-hidden />
          No records yet
        </span>
      )}
    </div>
  );
}

export function DemoNotice({ cohort }: { cohort: Cohort }) {
  const demo = cohort.demo_count ?? 0;
  const real = cohort.real_count ?? 0;
  if (demo <= 0) return null;
  const total = demo + real;

  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-900"
    >
      <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <p>
        <span className="font-semibold">
          {real === 0
            ? "Everything on this dashboard is synthetic demo data."
            : `${demo} of ${total} records are synthetic demo data.`}
        </span>{" "}
        They were inserted by the demo seed to illustrate the dashboard and were not produced by AI
        evaluation of uploaded answer sheets. Live uploads are always graded by the real AI pipeline
        and never fall back to sample grades.
      </p>
    </div>
  );
}

/** Shown when a background refresh fails but earlier data is still on screen. */
export function StaleBanner({ message, updatedLabel }: { message: string; updatedLabel: string | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
      <p>
        <span className="font-semibold text-slate-800">Live refresh paused.</span>{" "}
        {updatedLabel ? `Showing data from ${updatedLabel}. ` : null}
        <span className="text-slate-500">{message}</span> Retrying automatically.
      </p>
    </div>
  );
}
