import { RefreshCw, WifiOff } from "lucide-react";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, fullDate, plural } from "./format";

/** "NEET-C (sample) · NEET MCQ Practice - Mock 10 · sat 24 Nov 2026 · 12 students". Never batch.exam_type. */
export function scopeSentence(cohort: Cohort): string {
  const scope = cohort.scope;
  if (!scope) return cohort.batch?.name ?? "All batches";
  const batch = scope.batch_name ?? "All batches";
  const students = plural(scope.students, "student");
  if (scope.mode === "all") return `${batch} · each student's latest test · ${students}`;
  const parts = [batch, scope.test_name ?? "Test"];
  if (scope.date) parts.push(`sat ${fullDate(scope.date)}`);
  parts.push(students);
  return parts.join(" · ");
}

export function CohortHeader({
  cohort,
  updatedLabel,
  pollSeconds,
  refreshing,
  onRefresh,
  announcement,
  onOpenAbout,
  paused = false,
}: {
  cohort: Cohort | null;
  updatedLabel: string | null;
  pollSeconds: number;
  refreshing: boolean;
  onRefresh: () => void;
  announcement: string;
  onOpenAbout: () => void;
  /** The last refresh failed: the dot turns grey and says "Paused". */
  paused?: boolean;
}) {
  // Every sheet in scope (any status, before the one-per-student rule); older APIs: the v1 counts.
  const demo = cohort?.scope?.demo_sheets ?? cohort?.demo_count ?? 0;
  const total = cohort?.scope?.sheets_in_scope ?? demo + (cohort?.real_count ?? 0);
  const summary = (cohort?.summary ?? []).map((s) => s.text).join(" ");

  return (
    <header className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold text-brand-navy sm:text-2xl">Cohort</h1>
        <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
          <span
            className="inline-flex items-center gap-1.5 text-slate-600"
            title={
              paused
                ? `Refresh failed${updatedLabel ? `; showing data from ${updatedLabel}` : ""}. Retrying on its own.`
                : `${updatedLabel ? `Last change ${updatedLabel}. ` : ""}Checks for new results every ${pollSeconds} s.`
            }
          >
            <span className={cn("h-2 w-2 rounded-full", paused ? "bg-slate-400" : "bg-brand-lime-600")} aria-hidden />
            {paused ? "Paused" : "Live"}
          </span>
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh cohort data now"
            title="Refresh now"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:opacity-60"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin motion-reduce:animate-none")} aria-hidden />
          </button>
        </div>
      </div>
      <div className="min-w-0">
        <p className="mt-0.5 text-sm font-medium text-slate-800">
          {cohort ? scopeSentence(cohort) : "Loading…"}
          {demo > 0 ? (
            <a
              href="#about-data"
              onClick={onOpenAbout}
              title={`${demo} of ${plural(total, "sheet")} in this view ${demo === 1 ? "is" : "are"} synthetic demo data`}
              className={cn(
                "ml-2 inline-flex translate-y-[-1px] items-center rounded-sm border border-amber-300 px-1.5 align-middle text-xs font-normal text-amber-900 hover:bg-amber-50",
                FOCUS_RING,
              )}
            >
              {demo === total ? "Sample data" : `${demo} of ${total} sheets are sample data`}
            </a>
          ) : null}
        </p>
        {summary ? <p className="mt-1 max-w-4xl text-sm text-slate-700">{summary}</p> : null}
      </div>
    </header>
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
