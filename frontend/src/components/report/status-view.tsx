"use client";

import { AlertTriangle, Brain, Loader2, RotateCcw, ServerCrash, UserCheck, WifiOff, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useOcrThreshold } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { errorCode, errorMessage, retrySubmission } from "@/lib/api";
import type { ProcessingLogEntry, ResultPending } from "@/lib/types";
import { formatConfidence, formatDateTime } from "@/lib/utils";
import { AuditTrailCard } from "./audit-trail";
import { humanizeStep } from "./format";
import { PIPELINE_STAGES, PipelineStepper, VOICE_PIPELINE_STAGES, stageStates, type StageState } from "./pipeline-stepper";
import { Notice, btnPrimary } from "./dialog";
import { MeterBar, Pill } from "./primitives";
import { ReportHeader } from "./report-header";
import { ReviewEditor } from "./review-editor";
import { SubmissionDetailsCard } from "./submission-details";
import { rubricLabel as formatRubricLabel, useRubric } from "./use-rubric";

/** The backend may add a processing log to the 202 body; render it when present. */
export function pendingLog(pending: ResultPending): ProcessingLogEntry[] {
  const log = (pending as ResultPending & { processing_log?: unknown }).processing_log;
  return Array.isArray(log) ? (log as ProcessingLogEntry[]) : [];
}

function FactTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white/70 p-3.5 ring-1 ring-inset ring-amber-200">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">{label}</p>
      <div className="mt-1 text-sm font-semibold text-amber-950">{children}</div>
    </div>
  );
}

function HumanReviewPanel({
  pending,
  states,
  onChanged,
}: {
  pending: ResultPending;
  states: StageState[] | null;
  onChanged: () => void;
}) {
  const s = pending.submission;
  const confidence = s.ocr_confidence;
  const threshold = Math.round(useOcrThreshold() * 100);
  const flagged = s.flagged_pages ?? [];
  return (
    <section
      aria-labelledby="review-title"
      className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 shadow-sm [print-color-adjust:exact] sm:p-7"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-300">
          <AlertTriangle className="h-7 w-7" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">BRD safety constraint</p>
          <h2 id="review-title" className="mt-1 text-2xl font-semibold tracking-tight text-amber-950">
            Human review required
          </h2>
          <p className="mt-2 max-w-3xl leading-relaxed text-amber-900">
            OCR confidence for this answer sheet is <strong>{formatConfidence(confidence)}</strong>
            {flagged.length ? (
              <>
                {" "}
                with page{flagged.length === 1 ? "" : "s"} <strong>{flagged.join(", ")}</strong> below
              </>
            ) : (
              ", below"
            )}{" "}
            the <strong>{threshold}%</strong> threshold required for automated grading (any page below it routes the sheet
            here). To protect grading accuracy, AI rubric evaluation was skipped and no AI marks were published. Review the
            transcript below, then approve or correct it to grade, or request a rescan.
          </p>
          {pending.detail ? <p className="mt-2 text-sm text-amber-800">System note: {pending.detail}</p> : null}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FactTile label="OCR confidence">
          <span className="text-2xl tabular-nums">{formatConfidence(confidence)}</span>
          <MeterBar
            className="mt-2"
            size="sm"
            percent={confidence === null ? 0 : confidence * 100}
            label="OCR confidence against the auto-grade threshold"
            valueText={`${formatConfidence(confidence)}; threshold ${threshold}%`}
            fillClass="bg-amber-500"
            trackClass="bg-amber-100"
            markerPercent={threshold}
            markerLabel={`Threshold ${threshold}%`}
          />
        </FactTile>
        <FactTile label="Auto-grade threshold">
          <span className="text-2xl tabular-nums">{threshold}%</span>
          <p className="mt-1 text-xs font-normal text-amber-800">Minimum OCR confidence</p>
        </FactTile>
        <FactTile label="AI evaluation">
          <span className="inline-flex items-center gap-1.5">
            <Brain className="h-4 w-4" aria-hidden /> Skipped
          </span>
          <p className="mt-1 text-xs font-normal text-amber-800">Pipeline halted before grading</p>
        </FactTile>
        <FactTile label="Routed to">
          <span className="inline-flex items-center gap-1.5">
            <UserCheck className="h-4 w-4" aria-hidden /> Faculty review
          </span>
          <p className="mt-1 text-xs font-normal text-amber-800">Manual marking queue</p>
        </FactTile>
      </div>

      <div className="mt-6 border-t border-amber-200 pt-5">
        <ReviewEditor submission={s} onChanged={onChanged} />
      </div>

      {states ? (
        <div className="mt-6">
          <PipelineStepper states={states} voice={pending.submission.input_kind === "voice"} />
        </div>
      ) : null}
    </section>
  );
}

function RetryControl({ pending, onChanged }: { pending: ResultPending; onChanged: () => void }) {
  const s = pending.submission;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempts = typeof s.attempts === "number" ? s.attempts : 0;
  const max = typeof s.max_attempts === "number" && s.max_attempts > 0 ? s.max_attempts : 3;

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await retrySubmission(s.id);
      onChanged();
    } catch (err) {
      const code = errorCode(err);
      setError(
        code === "upload_missing"
          ? "The original upload is no longer on disk, so it cannot be re-driven. Upload the sheet again."
          : code === "invalid_state"
            ? "This submission is no longer FAILED. Reload the page."
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={retry} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
          {busy ? "Re-queuing…" : "Retry"}
        </button>
        <Pill className="bg-white text-rose-800 ring-rose-200">
          {attempts > max ? `Attempt ${attempts}` : `Attempts ${attempts}/${max}`}
        </Pill>
        {s.last_error_code ? (
          <Pill className="bg-white font-mono text-rose-800 ring-rose-200">{s.last_error_code}</Pill>
        ) : null}
      </div>
      <p className="text-xs text-rose-800/80">
        Retry re-drives the job from the dead-letter queue with the stored upload (and any cached OCR).
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function FailedPanel({
  pending,
  states,
  onChanged,
}: {
  pending: ResultPending;
  states: StageState[] | null;
  onChanged: () => void;
}) {
  const s = pending.submission;
  return (
    <section
      aria-labelledby="failed-title"
      className="rounded-2xl border-2 border-rose-300 bg-rose-50 p-5 shadow-sm [print-color-adjust:exact] sm:p-7"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-rose-100 text-rose-700 ring-1 ring-inset ring-rose-300">
          <XCircle className="h-7 w-7" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">Dead-letter queue</p>
          <h2 id="failed-title" className="mt-1 text-2xl font-semibold tracking-tight text-rose-950">
            Processing failed
          </h2>
          <p className="mt-2 max-w-3xl leading-relaxed text-rose-900">
            The pipeline could not complete this submission. It was marked <strong>FAILED</strong> and routed to the
            dead-letter queue for investigation. No partial grades were published.
          </p>
          <div className="mt-4 rounded-xl bg-white/80 p-4 ring-1 ring-inset ring-rose-200">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-700">
              <ServerCrash className="h-3.5 w-3.5" aria-hidden /> Error
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-rose-950">
              {s.error_message || pending.detail || "No error message was recorded."}
            </p>
          </div>
          {pending.detail && s.error_message && pending.detail !== s.error_message ? (
            <p className="mt-2 text-sm text-rose-800">System note: {pending.detail}</p>
          ) : null}
          <RetryControl pending={pending} onChanged={onChanged} />
        </div>
      </div>
      {states ? (
        <div className="mt-6">
          <PipelineStepper states={states} voice={pending.submission.input_kind === "voice"} />
        </div>
      ) : null}
    </section>
  );
}

function ActivePanel({ pending, states }: { pending: ResultPending; states: StageState[] | null }) {
  const s = pending.submission;
  const index = states ? states.indexOf("active") : -1;
  const progress = ((Math.max(index, 0) + 0.5) / PIPELINE_STAGES.length) * 100;
  const stages = s.input_kind === "voice" ? VOICE_PIPELINE_STAGES : PIPELINE_STAGES;
  const stepLabel = s.current_step ? humanizeStep(s.current_step) : stages[Math.max(index, 0)].label;
  return (
    <section
      aria-labelledby="active-title"
      aria-live="polite"
      className="rounded-2xl border border-brand-cyan/30 bg-white p-5 shadow-sm sm:p-7"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-cyan-50 text-brand-cyan-600 ring-1 ring-inset ring-brand-cyan/30">
          <Loader2 className="h-7 w-7 animate-spin" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="active-title" className="text-2xl font-semibold tracking-tight text-brand-navy">
              Report in progress
            </h2>
            <StatusBadge status={pending.status} />
          </div>
          <p className="mt-2 max-w-3xl leading-relaxed text-slate-600">
            The answer sheet is moving through the AI pipeline. This page refreshes automatically and will show the
            full Student Intelligence Report as soon as evaluation completes.
          </p>
          {pending.detail ? <p className="mt-1 text-sm text-slate-500">{pending.detail}</p> : null}
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="text-slate-600">
            Current step: <span className="font-semibold text-brand-navy">{stepLabel}</span>
          </p>
          <p className="inline-flex items-center gap-2 text-xs text-slate-500">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-cyan opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-cyan" />
            </span>
            Auto-refreshing every 3 s
          </p>
        </div>
        <MeterBar
          size="lg"
          percent={progress}
          label="Pipeline progress"
          valueText={`Stage ${Math.max(index, 0) + 1} of ${PIPELINE_STAGES.length}: ${stepLabel}`}
          fillClass="bg-linear-to-r from-brand-cyan to-brand-lime animate-pulse"
        />
      </div>

      {states ? (
        <div className="mt-5">
          <PipelineStepper states={states} voice={pending.submission.input_kind === "voice"} />
        </div>
      ) : null}
    </section>
  );
}

export function ConnectionBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 print:hidden"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        <span className="font-semibold">Connection interrupted.</span> {message} Retrying automatically…
      </p>
    </div>
  );
}

/** 202 body from GET /api/results/{id}: pending, processing, human review, or failed. */
export function StatusView({ pending, onChanged }: { pending: ResultPending; onChanged?: () => void }) {
  const changed = onChanged ?? (() => window.location.reload());
  const submission = { ...pending.submission, status: pending.status ?? pending.submission.status };
  const log = pendingLog(pending);
  const states = stageStates(submission, log);
  const rubric = useRubric(submission.rubric_id);
  const rubricLabel = rubric ? formatRubricLabel(rubric) : `Rubric ${submission.rubric_id}`;

  return (
    <div className="space-y-6">
      <ReportHeader
        submission={submission}
        rubricLabel={rubricLabel}
        dateLabel={`Submitted ${formatDateTime(submission.created_at)}`}
      />

      {submission.status === "HUMAN_REVIEW_REQUIRED" ? (
        <HumanReviewPanel pending={{ ...pending, submission }} states={states} onChanged={changed} />
      ) : submission.status === "FAILED" ? (
        <FailedPanel pending={{ ...pending, submission }} states={states} onChanged={changed} />
      ) : (
        <ActivePanel pending={{ ...pending, submission, status: submission.status }} states={states} />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <SubmissionDetailsCard submission={submission} rubricLabel={rubricLabel} className="lg:col-span-2" />
        <AuditTrailCard
          log={log}
          className="lg:col-span-3 lg:self-start"
          emptyText={
            submission.status === "PENDING" || submission.status === "PROCESSING"
              ? "Step-by-step events will appear here as the worker records them."
              : "No detailed processing log was returned for this submission."
          }
        />
      </div>
    </div>
  );
}
