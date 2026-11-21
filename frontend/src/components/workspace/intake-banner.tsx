"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getIntakeBatch } from "@/lib/api";
import type { IntakeBatchStatus, Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDuration, toUtcIso } from "./format";
import { QUEUE_POLL_MS } from "./use-submissions";

/** Default acceptance target (50 PDFs in 30 min) when /api/health has no batch_target_seconds. */
export const DEFAULT_BATCH_TARGET_SECONDS = 1_800;

const ACTIVE = new Set(["PENDING", "PROCESSING"]);

/**
 * Status computed from the queue rows of one intake batch. Used until GET /api/intake-batches/{id}
 * answers (or when it is unavailable on this API build).
 */
export function localIntakeStatus(
  intakeBatchId: string,
  submissions: Submission[] | null,
  now: number | null,
  targetSeconds: number,
): IntakeBatchStatus | null {
  const rows = (submissions ?? []).filter((s) => s.intake_batch_id === intakeBatchId);
  if (rows.length === 0) return null;
  const count = (status: string) => rows.filter((s) => s.status === status).length;
  const completed = count("COMPLETED");
  const humanReview = count("HUMAN_REVIEW_REQUIRED");
  const failed = count("FAILED");
  const processing = rows.filter((s) => ACTIVE.has(s.status)).length;
  const starts = rows.map((s) => new Date(toUtcIso(s.created_at)).getTime()).filter(Number.isFinite);
  const started = starts.length ? Math.min(...starts) : null;
  let elapsed: number | null = null;
  if (started !== null) {
    if (processing === 0) {
      const ends = rows
        .map((s) => new Date(toUtcIso(s.completed_at ?? s.updated_at)).getTime())
        .filter(Number.isFinite);
      elapsed = ends.length ? Math.max(0, (Math.max(...ends) - started) / 1000) : null;
    } else if (now !== null) {
      elapsed = Math.max(0, (now - started) / 1000);
    }
  }
  const done = rows.length - processing;
  const eta = elapsed !== null && done > 0 && processing > 0 ? (elapsed / done) * processing : null;
  return {
    intake_batch_id: intakeBatchId,
    total: rows.length,
    completed,
    human_review: humanReview,
    failed,
    processing,
    started_at: started !== null ? new Date(started).toISOString() : null,
    elapsed_seconds: elapsed,
    eta_seconds: eta,
    target_seconds: targetSeconds,
  };
}

/**
 * The intake batch to show a banner for: the one started from this page, else the newest
 * submission's intake batch while any of its sheets is still in the pipeline.
 */
export function activeIntakeId(started: string | null, submissions: Submission[] | null): string | null {
  if (started) return started;
  const newest = (submissions ?? []).find((s) => s.intake_batch_id);
  if (!newest?.intake_batch_id) return null;
  const id = newest.intake_batch_id;
  return (submissions ?? []).some((s) => s.intake_batch_id === id && ACTIVE.has(s.status)) ? id : null;
}

/**
 * "Batch 7f3c: 38/50 done · 21 min elapsed · ETA 6 min (target 30 min)". Polls
 * GET /api/intake-batches/{id}; falls back to counting the queue rows.
 */
export function IntakeBanner({
  intakeBatchId,
  submissions,
  now,
  targetSeconds = DEFAULT_BATCH_TARGET_SECONDS,
  onDismiss,
}: {
  intakeBatchId: string;
  submissions: Submission[] | null;
  /** Client clock of the last queue poll (never Date.now() during render). */
  now: number | null;
  targetSeconds?: number;
  onDismiss: () => void;
}) {
  const [remote, setRemote] = useState<{ id: string; status: IntakeBatchStatus } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unavailable = false;
    const tick = async () => {
      if (unavailable || document.visibilityState === "hidden") return;
      try {
        const status = await getIntakeBatch(intakeBatchId);
        if (!cancelled) setRemote({ id: intakeBatchId, status });
      } catch {
        // 404 before the first sheet lands, or the endpoint is not on this API build yet:
        // keep counting from the queue rows instead.
        unavailable = true;
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      unavailable = false;
      void tick();
    }, QUEUE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [intakeBatchId]);

  const local = localIntakeStatus(intakeBatchId, submissions, now, targetSeconds);
  const fromApi = remote && remote.id === intakeBatchId && remote.status.total > 0 ? remote.status : null;
  const status = fromApi ?? local;
  if (!status || status.total === 0) return null;

  const done = status.completed + status.human_review + status.failed;
  const finished = status.processing === 0 && done >= status.total;
  const target = status.target_seconds > 0 ? status.target_seconds : targetSeconds;
  const elapsed = status.elapsed_seconds;
  const withinTarget = elapsed !== null ? elapsed <= target : null;
  const pct = Math.round((done / Math.max(1, status.total)) * 100);
  const shortId = intakeBatchId.slice(0, 4);

  return (
    <div role="status" aria-live="polite" className="rounded-md border border-slate-200 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tabular-nums text-brand-navy">
            Batch <span className="font-mono">{shortId}</span>: {done}/{status.total} done
            {finished ? (
              <>
                {" "}
                in {formatDuration(elapsed)}{" "}
                <span className="font-normal text-slate-600">(target {formatDuration(target)})</span>
              </>
            ) : (
              <>
                {elapsed !== null ? <span className="font-normal"> · {formatDuration(elapsed)} elapsed</span> : null}
                {status.eta_seconds !== null ? (
                  <span className="font-normal"> · ETA {formatDuration(status.eta_seconds)}</span>
                ) : null}{" "}
                <span className="font-normal text-slate-600">(target {formatDuration(target)})</span>
              </>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-600">
            <span>{status.completed} completed</span>
            {status.human_review > 0 ? <span className="text-amber-800">{status.human_review} in faculty review</span> : null}
            {status.failed > 0 ? <span className="text-rose-700">{status.failed} failed (retry below)</span> : null}
            {status.processing > 0 ? (
              <span className="text-brand-cyan-600">{status.processing} in the pipeline</span>
            ) : null}
            {withinTarget !== null && finished ? (
              <span className={withinTarget ? "text-lime-700" : "text-rose-700"}>
                {withinTarget ? "within the 30-min acceptance target" : "over the acceptance target"}
              </span>
            ) : null}
            {!fromApi ? <span className="text-slate-400">counted from the queue</span> : null}
          </p>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-slate-100"
            role="progressbar"
            aria-label={`Intake batch ${shortId} progress`}
            aria-valuemin={0}
            aria-valuemax={status.total}
            aria-valuenow={done}
          >
            <div
              className={cn("h-full rounded-sm", finished ? "bg-brand-lime-600" : "bg-brand-cyan")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
          aria-label="Hide the intake batch banner"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
