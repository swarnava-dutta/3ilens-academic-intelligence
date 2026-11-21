import { RefreshCw, WifiOff } from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { COHORT_REFRESH_MS } from "./use-cohort";
import { batchLabel, plural } from "./format";

const TAG = "inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 text-xs";

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
    <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold text-brand-navy sm:text-2xl">Cohort Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          <span className="sr-only">Institution: </span>
          {cohort.institution?.name ?? "Institution"}
          <span aria-hidden className="mx-1.5 text-slate-300">
            /
          </span>
          <span className="sr-only">Batch: </span>
          <span className="font-medium text-slate-800">{batchLabel(cohort.batch)}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-500">
        <ProvenancePills cohort={cohort} />
        <span aria-live="polite" className="tabular-nums">
          {updatedLabel ? `Updated ${updatedLabel}` : "Live"} · refreshes every {Math.round(COHORT_REFRESH_MS / 1000)} s
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh cohort data now"
          title="Refresh now"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan disabled:opacity-60"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden />
        </button>
      </div>
    </header>
  );
}

/** Data provenance: the client must never mistake synthetic demo data for real results. */
export function ProvenancePills({ cohort }: { cohort: Cohort }) {
  const demo = cohort.demo_count ?? 0;
  const real = cohort.real_count ?? 0;

  return (
    <span className="flex flex-wrap gap-1.5" aria-label="Data provenance">
      {demo > 0 ? (
        <>
          <span className={cn(TAG, "border-amber-300 text-amber-800")}>
            Includes {plural(demo, "synthetic demo record")}
          </span>
          <span className={cn(TAG, "border-slate-300 text-slate-600")}>{plural(real, "live record")}</span>
        </>
      ) : real > 0 ? (
        <span className={cn(TAG, "border-slate-300 text-slate-600")}>Live data only · {plural(real, "record")}</span>
      ) : (
        <span className={cn(TAG, "border-slate-300 text-slate-600")}>No records yet</span>
      )}
    </span>
  );
}

export function DemoNotice({ cohort }: { cohort: Cohort }) {
  const demo = cohort.demo_count ?? 0;
  const real = cohort.real_count ?? 0;
  if (demo <= 0) return null;
  const total = demo + real;

  return (
    <p role="note" className="text-[13px] text-slate-600">
      <span className={cn(TAG, "mr-1.5 border-amber-300 text-amber-800")}>Sample data</span>
      {real === 0
        ? "Everything on this dashboard is synthetic demo data"
        : `${demo} of ${total} records are synthetic demo data`}
      , inserted by the demo seed rather than graded from uploaded sheets. Live uploads are always graded by the real
      pipeline and never fall back to sample grades.
    </p>
  );
}

/** Shown when a background refresh fails but earlier data is still on screen. */
export function StaleBanner({ message, updatedLabel }: { message: string; updatedLabel: string | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
      <p>
        <span className="font-semibold text-slate-800">Live refresh paused.</span>{" "}
        {updatedLabel ? `Showing data from ${updatedLabel}. ` : null}
        <span className="text-slate-500">{message}</span> Retrying automatically.
      </p>
    </div>
  );
}
