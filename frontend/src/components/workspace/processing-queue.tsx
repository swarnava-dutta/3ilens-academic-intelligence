"use client";

import { useState } from "react";
import { CheckCircle2, Inbox, ListChecks, Loader2, RefreshCw, Sparkles, WifiOff, XCircle } from "lucide-react";
import { FilterBar, useDashboardFilters } from "@/components/shared/filter-bar";
import { errorCode, errorMessage, retrySubmission, seedDemoCohort } from "@/lib/api";
import type { Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { countByFilter, matchesFilter, type QueueFilter } from "./format";
import { IntakeBanner } from "./intake-banner";
import { DESKTOP_ONLY, QUEUE_COLUMNS, QueueRow, retryErrorText, WIDE_ONLY, XL_ONLY, type RowAction } from "./queue-row";
import { hasDashboardFilters, QUEUE_POLL_MS, useSubmissions, type SubmissionsQueue } from "./use-submissions";

const FILTERS: { value: QueueFilter; label: string; activeClass: string; dotClass: string }[] = [
  { value: "ALL", label: "All", activeClass: "bg-brand-navy text-white ring-brand-navy", dotClass: "bg-slate-400" },
  {
    value: "PROCESSING",
    label: "Processing",
    activeClass: "bg-brand-cyan text-white ring-brand-cyan",
    dotClass: "bg-brand-cyan",
  },
  {
    value: "COMPLETED",
    label: "Completed",
    activeClass: "bg-brand-lime-600 text-white ring-brand-lime-600",
    dotClass: "bg-brand-lime-600",
  },
  {
    value: "HUMAN_REVIEW_REQUIRED",
    label: "Human review",
    activeClass: "bg-amber-500 text-white ring-amber-500",
    dotClass: "bg-amber-500",
  },
  { value: "FAILED", label: "Failed", activeClass: "bg-rose-600 text-white ring-rose-600", dotClass: "bg-rose-500" },
];

const DESKTOP_CELL = "hidden md:table-cell";

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
    <section aria-labelledby="queue-title" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-cyan-50 text-brand-cyan">
              <ListChecks className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 id="queue-title" className="text-lg font-semibold text-brand-navy">
                Processing Queue
              </h2>
              <p className="flex items-center gap-2 text-sm text-slate-500" aria-live="polite">
                {reconnecting ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                    <WifiOff className="h-3.5 w-3.5" aria-hidden />
                    Reconnecting… showing last known status
                  </span>
                ) : (
                  <>
                    <span className="relative flex h-2 w-2" aria-hidden>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-lime opacity-60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-lime-600" />
                    </span>
                    Live · refreshes every {QUEUE_POLL_MS / 1000} s
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {queue.submissions && queue.submissions.length > 0 && !hasDemo ? (
              <button
                type="button"
                onClick={loadDemoCohort}
                disabled={seeding}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-brand-cyan-600 ring-1 ring-inset ring-brand-cyan/30 transition-colors hover:bg-brand-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60"
              >
                {seeding ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                Load demo cohort
              </button>
            ) : null}
            <button
              type="button"
              onClick={manualRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-slate-600 ring-1 ring-inset ring-slate-200 transition-colors hover:bg-slate-50 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60"
              aria-label="Refresh the queue now"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
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
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
            {FILTERS.map(({ value, label, activeClass, dotClass }) => {
              const active = filter === value;
              const count = counts?.[value];
              const highlight =
                (value === "HUMAN_REVIEW_REQUIRED" || value === "FAILED") && !active && (count ?? 0) > 0;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1",
                    active
                      ? activeClass
                      : highlight
                        ? value === "FAILED"
                          ? "bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100"
                          : "bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100"
                        : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                  )}
                >
                  {!active ? <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} aria-hidden /> : null}
                  {label}
                  <span
                    className={cn(
                      "min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums",
                      active ? "bg-white/25" : "bg-slate-100 text-slate-500",
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
              "flex items-start gap-2 rounded-xl px-3 py-2 text-sm ring-1 ring-inset",
              seedNotice.kind === "success"
                ? "bg-brand-lime-50 text-brand-navy ring-brand-lime/50"
                : "bg-rose-50 text-rose-800 ring-rose-200",
            )}
            role={seedNotice.kind === "error" ? "alert" : "status"}
          >
            {seedNotice.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-lime-600" aria-hidden />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
            )}
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
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm md:min-w-[900px]">
            <thead>
              <tr className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {QUEUE_COLUMNS.map((c, i) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(
                      "whitespace-nowrap px-3 py-3 md:px-4",
                      DESKTOP_ONLY.has(c) &&
                        (WIDE_ONLY.has(c) ? "hidden 2xl:table-cell" : XL_ONLY.has(c) ? "hidden xl:table-cell" : DESKTOP_CELL),
                      i === 0 && "pl-5 sm:pl-6",
                      i === QUEUE_COLUMNS.length - 1 && "pr-5 text-right sm:pr-6",
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
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Processing Queue">
      <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
        <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
      </div>
      <QueueSkeleton />
    </section>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-3 p-5 sm:p-6" aria-busy="true" aria-label="Loading the processing queue">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-4">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="h-4 flex-1 rounded bg-slate-100" />
          <div className="h-6 w-24 rounded-full bg-slate-100" />
          <div className="hidden h-4 w-20 rounded bg-slate-100 sm:block" />
        </div>
      ))}
    </div>
  );
}

function QueueError({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" role="alert">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-500 ring-1 ring-rose-200">
        <WifiOff className="h-6 w-6" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="font-semibold text-slate-800">Can&apos;t load the processing queue</p>
        <p className="max-w-md text-sm text-slate-500">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60"
      >
        <RefreshCw className={cn("h-4 w-4", retrying && "animate-spin")} aria-hidden />
        Try again
      </button>
    </div>
  );
}

function EmptyQueue({ onSeed, seeding }: { onSeed: () => void; seeding: boolean }) {
  return (
    <div className="flex flex-col items-center gap-5 px-6 py-14 text-center">
      <div className="relative flex h-28 w-28 items-center justify-center" aria-hidden>
        <span className="absolute inset-0 rounded-full bg-brand-cyan-50" />
        <span className="absolute inset-3 rounded-full border-2 border-dashed border-brand-cyan/30" />
        <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-brand-cyan shadow-sm ring-1 ring-slate-200">
          <Inbox className="h-7 w-7" />
        </span>
        <span className="absolute right-3 top-3 h-3 w-3 rounded-full bg-brand-lime ring-4 ring-white" />
      </div>
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-brand-navy">No answer sheets in the queue yet</p>
        <p className="max-w-md text-sm text-slate-500">
          Upload a handwritten answer sheet (or a whole folder) above to watch it move through the pipeline, or load the
          synthetic demo cohort to explore reports and the cohort dashboard right away (no AI keys needed).
        </p>
      </div>
      <button
        type="button"
        onClick={onSeed}
        disabled={seeding}
        className="inline-flex items-center gap-2 rounded-xl bg-brand-cyan px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70"
      >
        {seeding ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
        {seeding ? "Loading demo cohort…" : "Load demo cohort"}
      </button>
    </div>
  );
}
