"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { FilterBar, useDashboardFilters } from "@/components/shared/filter-bar";
import { errorCode, errorMessage, retrySubmission, seedDemoCohort } from "@/lib/api";
import type { Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { countByFilter, matchesFilter, type QueueFilter } from "./format";
import { IntakeBanner } from "./intake-banner";
import { DESKTOP_ONLY, NUMERIC_COLUMNS, QUEUE_COLUMNS, QueueRow, retryErrorText, WIDE_ONLY, XL_ONLY, type RowAction } from "./queue-row";
import { hasDashboardFilters, QUEUE_POLL_MS, useSubmissions, type SubmissionsQueue } from "./use-submissions";

const FILTERS: { value: QueueFilter; label: string; countClass?: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PROCESSING", label: "Processing" },
  { value: "COMPLETED", label: "Completed" },
  { value: "HUMAN_REVIEW_REQUIRED", label: "Human review", countClass: "text-amber-700" },
  { value: "FAILED", label: "Failed", countClass: "text-rose-700" },
];

const DESKTOP_CELL = "hidden md:table-cell";
const BTN_SECONDARY =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:opacity-60";

type Notice = { kind: "success" | "error"; message: string };

interface ProcessingQueueProps {
  /** Unfiltered queue polled by the workspace (reused when no dashboard filter is set). */
  queue: SubmissionsQueue;
  /** Intake batch to show the progress banner for (null = none). */
  intakeBatchId: string | null;
  onDismissIntake: () => void;
  batchTargetSeconds?: number;
}

/**
 * Processing queue with status chips plus batch / test / urgency filters (URL params). Uses
 * useSearchParams, so it must render inside <Suspense>.
 */
export function ProcessingQueue({ queue, intakeBatchId, onDismissIntake, batchTargetSeconds }: ProcessingQueueProps) {
  const query = useDashboardFilters();
  const filtered = hasDashboardFilters(query);
  const own = useSubmissions(query, filtered);
  const view = filtered ? own : queue;
  const { submissions, error, fetchedAt } = view;

  const [filter, setFilter] = useState<QueueFilter>("ALL");
  const [refreshing, setRefreshing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedNotice, setSeedNotice] = useState<Notice | null>(null);
  const [actions, setActions] = useState<Record<number, RowAction>>({});

  const counts = submissions ? countByFilter(submissions) : null;
  const visible = submissions?.filter((s) => matchesFilter(s.status, filter)) ?? [];
  const hasDemo = queue.submissions?.some((s) => s.is_demo) ?? false;
  const reconnecting = error !== null && submissions !== null;

  async function refreshAll() {
    await Promise.all([queue.refresh(), filtered ? own.refresh() : Promise.resolve()]);
  }

  async function manualRefresh() {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }

  async function retry(s: Submission) {
    setActions((prev) => ({ ...prev, [s.id]: { busy: true, error: null } }));
    try {
      const updated = await retrySubmission(s.id);
      queue.addOptimistic(updated);
      setActions((prev) => ({ ...prev, [s.id]: { busy: false, error: null } }));
      await refreshAll();
    } catch (err) {
      setActions((prev) => ({
        ...prev,
        [s.id]: { busy: false, error: retryErrorText(errorCode(err), errorMessage(err)) },
      }));
    }
  }

  async function loadDemoCohort() {
    setSeeding(true);
    setSeedNotice(null);
    try {
      const res = await seedDemoCohort("all");
      setSeedNotice({
        kind: "success",
        message:
          res.message ||
          (res.created > 0 ? `Loaded ${res.created} synthetic demo submissions.` : "Demo cohort is already loaded."),
      });
      setFilter("ALL");
      await refreshAll();
    } catch (err) {
      setSeedNotice({ kind: "error", message: errorMessage(err) });
    } finally {
      setSeeding(false);
    }
  }

  return (
    <section aria-labelledby="queue-title" className="rounded-md border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 id="queue-title" className="text-base font-semibold text-brand-navy">
              Processing queue
            </h2>
            <p className="text-xs text-slate-500" aria-live="polite">
              {reconnecting ? (
                <span className="font-medium text-amber-800">Reconnecting - showing last known status</span>
              ) : (
                <>Refreshes every {QUEUE_POLL_MS / 1000} s</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {queue.submissions && queue.submissions.length > 0 && !hasDemo ? (
              <button
                type="button"
                onClick={loadDemoCohort}
                disabled={seeding}
                className={BTN_SECONDARY}
              >
                {seeding ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
                Load demo cohort
              </button>
            ) : null}
            <button
              type="button"
              onClick={manualRefresh}
              disabled={refreshing}
              className={BTN_SECONDARY}
              aria-label="Refresh the queue now"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "motion-safe:animate-spin")} aria-hidden />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>

        {intakeBatchId ? (
          <IntakeBanner
            intakeBatchId={intakeBatchId}
            submissions={queue.submissions}
            now={queue.fetchedAt}
            targetSeconds={batchTargetSeconds}
            onDismiss={onDismissIntake}
          />
        ) : null}

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          {/* Status chips */}
          <div className="flex flex-wrap gap-1 xl:shrink-0" role="group" aria-label="Filter by status">
            {FILTERS.map(({ value, label, countClass }) => {
              const active = filter === value;
              const count = counts?.[value];
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1",
                    active
                      ? "border-brand-navy bg-brand-navy font-medium text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                >
                  {label}
                  <span
                    className={cn(
                      "tabular-nums",
                      active ? "text-white/80" : (count ?? 0) > 0 && countClass ? cn("font-semibold", countClass) : "text-slate-500",
                    )}
                  >
                    {count ?? "–"}
                  </span>
                </button>
              );
            })}
          </div>
          {/* Batch / test / urgency (URL params; hidden while /api/filters is unavailable) */}
          <FilterBar show={["batch", "test", "urgency"]} />
        </div>

        {filtered ? (
          <p className="text-xs text-slate-500">
            Filtered view{query.urgency ? " - urgency applies to completed sheets only" : ""}. Clear the filters to see
            every sheet.
          </p>
        ) : null}

        {seedNotice ? (
          <p
            className={cn(
              "text-sm",
              seedNotice.kind === "success" ? "text-slate-700" : "font-medium text-rose-700",
            )}
            role={seedNotice.kind === "error" ? "alert" : "status"}
          >
            {seedNotice.message}
          </p>
        ) : null}
      </div>

      {/* Body */}
      {submissions === null ? (
        error ? (
          <QueueError message={error} onRetry={manualRefresh} retrying={refreshing} />
        ) : (
          <QueueSkeleton />
        )
      ) : submissions.length === 0 && !filtered ? (
        <EmptyQueue onSeed={loadDemoCohort} seeding={seeding} />
      ) : visible.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-slate-500">
          No submissions in this view.{" "}
          {filter !== "ALL" ? (
            <button
              type="button"
              onClick={() => setFilter("ALL")}
              className="font-medium text-brand-cyan-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              Show all statuses
            </button>
          ) : null}
        </div>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm md:min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                {QUEUE_COLUMNS.map((c, i) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(
                      "whitespace-nowrap px-3 py-2 md:px-4",
                      NUMERIC_COLUMNS.has(c) && "text-right",
                      DESKTOP_ONLY.has(c) &&
                        (WIDE_ONLY.has(c) ? "hidden 2xl:table-cell" : XL_ONLY.has(c) ? "hidden xl:table-cell" : DESKTOP_CELL),
                      i === 0 && "pl-4 sm:pl-5",
                      i === QUEUE_COLUMNS.length - 1 && "pr-4 text-right sm:pr-5",
                    )}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <QueueRow key={s.id} submission={s} now={fetchedAt} action={actions[s.id]} onRetry={(row) => void retry(row)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

/** Card-shaped placeholder (also the Suspense fallback while URL filters are read). */
export function QueueSkeletonCard() {
  return (
    <section className="rounded-md border border-slate-200 bg-white" aria-label="Processing Queue">
      <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
        <div className="h-5 w-40 motion-safe:animate-pulse rounded bg-slate-200" />
      </div>
      <QueueSkeleton />
    </section>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-3 p-5 sm:p-6" aria-busy="true" aria-label="Loading the processing queue">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex motion-safe:animate-pulse items-center gap-4">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="h-4 flex-1 rounded bg-slate-100" />
          <div className="h-6 w-24 rounded-sm bg-slate-100" />
          <div className="hidden h-4 w-20 rounded bg-slate-100 sm:block" />
        </div>
      ))}
    </div>
  );
}

function QueueError({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" role="alert">
      <div className="space-y-1">
        <p className="font-semibold text-slate-800">Can&apos;t load the processing queue</p>
        <p className="max-w-md text-sm text-slate-500">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className={BTN_SECONDARY}
      >
        <RefreshCw className={cn("h-4 w-4", retrying && "motion-safe:animate-spin")} aria-hidden />
        Try again
      </button>
    </div>
  );
}

function EmptyQueue({ onSeed, seeding }: { onSeed: () => void; seeding: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-10 sm:px-5">
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-brand-navy">No answer sheets yet</p>
        <p className="max-w-xl text-sm text-slate-600">
          Upload a sheet or a folder above, or load the synthetic demo cohort to explore reports and the cohort
          dashboard without AI keys.
        </p>
      </div>
      <button
        type="button"
        onClick={onSeed}
        disabled={seeding}
        className="inline-flex h-9 items-center gap-2 rounded-md bg-brand-navy px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70"
      >
        {seeding ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
        {seeding ? "Loading demo cohort…" : "Load demo cohort"}
      </button>
    </div>
  );
}
