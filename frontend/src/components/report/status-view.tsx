"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useOcrThreshold } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { errorCode, errorMessage, retrySubmission } from "@/lib/api";
import { formatConfidence, formatDateTime } from "@/lib/format";
import type { ProcessingLogEntry, ResultPending } from "@/lib/types";
import { cn, reviewHold, type ReviewHold } from "@/lib/utils";
import { AuditTrailCard } from "./audit-trail";
import { humanizeStep } from "./format";
import { PIPELINE_STAGES, PipelineStepper, VOICE_PIPELINE_STAGES, stageStates, type StageState } from "./pipeline-stepper";
import { Notice, btnPrimary } from "./dialog";
import { MeterBar, Pill } from "./primitives";
import { ReportHeader } from "./report-header";
import { RerunControl } from "./rerun-control";
import { ReviewEditor } from "./review-editor";
import { SourcesPanel } from "./sources-panel";
import { SubmissionDetailsCard } from "./submission-details";
import { rubricLabel as formatRubricLabel, useRubric } from "./use-rubric";

/** How older builds held a sheet with no answers (the mean of zero answer confidences). */
const STALE_ZERO_HOLD = "OCR confidence 0.00 is below";

/** The backend may add a processing log to the 202 body; render it when present. */
function pendingLog(pending: ResultPending): ProcessingLogEntry[] {
  const log = (pending as ResultPending & { processing_log?: unknown }).processing_log;
  return Array.isArray(log) ? (log as ProcessingLogEntry[]) : [];
}

function FactTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <div className="mt-1 text-sm font-semibold text-slate-800">{children}</div>
    </div>
  );
}

function HumanReviewPanel({
  pending,
  states,
  rubricText,
  questionCount,
  onChanged,
}: {
  pending: ResultPending;
  states: StageState[] | null;
  /** The answer key's label, e.g. "NEET Mock 12 · custom-3" (or "Rubric 3" until the rubric list loads). */
  rubricText: string;
  questionCount: number | null;
  onChanged: () => void;
}) {
  const s = pending.submission;
  const confidence = s.ocr_confidence;
  const thresholdRatio = useOcrThreshold();
  const threshold = Math.round(thresholdRatio * 100);
  const flagged = s.flagged_pages ?? [];
  const voice = s.input_kind === "voice";
  // One reviewer name for the transcript review and the re-run.
  const [reviewer, setReviewer] = useState("");
  // Held for another reason than low confidence (another paper, no answers found, a mostly blank
  // sheet): the reason leads and the confidence is only a fact tile.
  const hold = reviewHold(s, thresholdRatio);
  const reason = (s.error_message || pending.detail || "").trim();
  // Nothing to measure: a voice answer with no mapped part, or an older row that stored 0 for "no answers".
  const unmeasured = hold === "no_answers" && (confidence === null || confidence === 0);
  // With no answers the sheet confidence is the pages' legibility (newer API builds).
  const confidenceLabel = voice
    ? "Transcript confidence"
    : hold === "no_answers" && !unmeasured
      ? "Page legibility"
      : "OCR confidence";
  const low = !unmeasured && confidence !== null && confidence < thresholdRatio;
  // Demo rows have no stored upload to re-run.
  const canRerun = !s.is_demo;
  const rerunLeads = canRerun && (hold === "paper" || hold === "no_answers");
  // An older build held this legible sheet as "OCR confidence 0.00" (the mean of no answers); the
  // audit trail keeps that line above the start-up re-check that recorded the real reason. Only
  // explained for the holds that re-check can set (no answers, another paper), and only when the
  // log really has that line.
  const staleZero =
    (hold === "no_answers" || hold === "paper") &&
    pendingLog(pending).some((e) => (e.message ?? "").startsWith(STALE_ZERO_HOLD));
  return (
    <section
      aria-labelledby="review-title"
      className="rounded-md border border-l-[3px] border-amber-300 border-l-amber-500 bg-white p-4 [print-color-adjust:exact] sm:p-6"
    >
      <div>
        <div className="min-w-0">
          <p className="text-[13px] text-amber-800">
            {hold === "paper" ? "Paper check" : hold === "no_answers" ? "Answer key check" : "BRD safety constraint"}
          </p>
          <h2 id="review-title" className="mt-0.5 text-lg font-semibold text-brand-navy">
            Human review required
          </h2>
          {hold !== "confidence" ? (
            <HoldReason
              hold={hold}
              reason={reason}
              voice={voice}
              reordered={s.review_reason === "paper_reordered"}
              staleZero={staleZero}
              noFlaggedPages={flagged.length === 0}
              canRerun={canRerun}
              rubricText={rubricText}
              questionCount={questionCount}
            />
          ) : (
            <>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">
                {voice ? "Transcript confidence for this voice answer" : "OCR confidence for this answer sheet"} is{" "}
                <strong>{formatConfidence(confidence)}</strong>
                {!voice && flagged.length ? (
                  <>
                    {" "}
                    with page{flagged.length === 1 ? "" : "s"} <strong>{flagged.join(", ")}</strong> below
                  </>
                ) : (
                  ", below"
                )}{" "}
                the <strong>{threshold}%</strong> threshold required for automated grading
                {voice ? "" : " (any page below it routes the sheet here)"}. To protect grading accuracy, AI rubric
                evaluation was skipped and no AI marks were published. Review the transcript below, then approve or
                correct it to grade, or request a {voice ? "new recording" : "rescan"}.
              </p>
              {pending.detail ? <p className="mt-2 text-sm text-slate-600">System note: {pending.detail}</p> : null}
            </>
          )}
          {rerunLeads ? (
            <RerunControl
              lead
              className="mt-4 max-w-3xl"
              submission={s}
              onChanged={onChanged}
              reviewer={reviewer}
              onReviewerChange={setReviewer}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        <FactTile label={confidenceLabel}>
          {unmeasured ? (
            <>
              <span className="text-xl">Not measured</span>
              <p className="mt-1 text-xs font-normal text-slate-500">
                {voice ? "No part of the recording matched a question" : "No answer was transcribed"}
              </p>
            </>
          ) : (
            <>
              <span className={cn("text-xl tabular-nums", low ? "text-amber-800" : "text-slate-800")}>
                {formatConfidence(confidence)}
              </span>
              <MeterBar
                className="mt-2"
                size="sm"
                percent={confidence === null ? 0 : confidence * 100}
                label={`${confidenceLabel} against the auto-grade threshold`}
                valueText={`${formatConfidence(confidence)}; threshold ${threshold}%`}
                fillClass={low ? "bg-amber-500" : "bg-slate-500"}
                trackClass={low ? "bg-amber-100" : "bg-slate-100"}
                markerPercent={threshold}
                markerLabel={`Threshold ${threshold}%`}
              />
            </>
          )}
        </FactTile>
        <FactTile label="Auto-grade threshold">
          <span className="text-xl tabular-nums">{threshold}%</span>
          <p className="mt-1 text-xs font-normal text-slate-500">
            Minimum {voice ? "transcript confidence" : "OCR confidence"}
          </p>
        </FactTile>
        <FactTile label="AI evaluation">
          Skipped
          <p className="mt-1 text-xs font-normal text-slate-500">Pipeline halted before grading</p>
        </FactTile>
        <FactTile label="Routed to">
          Faculty review
          <p className="mt-1 text-xs font-normal text-slate-500">Manual marking queue</p>
        </FactTile>
      </div>

      <div className="mt-6 border-t border-slate-200 pt-5">
        <ReviewEditor submission={s} onChanged={onChanged} reviewer={reviewer} onReviewerChange={setReviewer} />
      </div>

      {canRerun && !rerunLeads ? (
        <RerunControl
          className="mt-4"
          submission={s}
          onChanged={onChanged}
          reviewer={reviewer}
          onReviewerChange={setReviewer}
        />
      ) : null}

      {states ? (
        <div className="mt-6">
          <PipelineStepper states={states} voice={pending.submission.input_kind === "voice"} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Lead of the review panel when the sheet was held for another reason than low confidence:
 * another paper or another code / set of it, no question of the key answered (usually a key for
 * another paper), or a mostly blank sheet. The re-run control (a key drafted from the right
 * question paper) follows for the first two.
 */
function HoldReason({
  hold,
  reason,
  voice,
  reordered,
  staleZero,
  noFlaggedPages,
  canRerun,
  rubricText,
  questionCount,
}: {
  hold: Exclude<ReviewHold, "confidence">;
  reason: string;
  voice: boolean;
  reordered: boolean;
  /** The audit trail has an older build's "OCR confidence 0.00" line for this sheet (no answers). */
  staleZero: boolean;
  /** No page is below the threshold now (flagged_pages empty). */
  noFlaggedPages: boolean;
  /** The re-run control follows (false for demo rows: no stored upload). */
  canRerun: boolean;
  rubricText: string;
  questionCount: number | null;
}) {
  const rubric = <strong className="font-semibold text-slate-900">{rubricText}</strong>;
  // "Re-run it with that paper's question paper below." / "Upload it again with that paper's question paper."
  const redo = (target: string) => (canRerun ? `Re-run it with ${target} below.` : `Upload it again with ${target}.`);
  let lead: ReactNode;
  let next: string;
  let quote = reason;
  if (hold === "no_answers") {
    lead = voice ? (
      <>
        No part of the recording could be matched to a question of {rubric}, so it was not scored and no marks were
        published.
      </>
    ) : (
      <>
        {questionCount === 1 ? (
          <>The only question of {rubric} has no answer</>
        ) : (
          <>
            None of the {questionCount ? `${questionCount} ` : ""}questions of {rubric} has an answer
          </>
        )}{" "}
        on this sheet, although the pages read clearly. It was not scored and no marks were published.
      </>
    );
    next = voice
      ? `The usual cause is a key for another paper. ${redo("the right question paper")} If this key is right, check the transcript further down and approve or correct it.`
      : `The usual cause is a key for another paper: the sheet belongs to a different paper. ${redo("its own question paper")} If this key is right and the student left it blank, approve the transcript further down to score it as not attempted, or type the answers as corrections.`;
    // The lead already says it in full (the server's sentence repeats it; an older row even stored
    // "OCR confidence 0.00 is below the threshold" here, which is not the reason).
    quote = "";
  } else if (hold === "paper") {
    lead = reordered ? (
      <>
        This sheet is the paper of {rubric} printed in another code / set (the same questions under other numbers), so
        it was not scored and no marks were published.
      </>
    ) : (
      <>This sheet does not look like the paper of {rubric}, so it was not scored and no marks were published.</>
    );
    next = reordered
      ? `${redo("the question paper of its code / set")} If the numbering matches this key after all, approve the transcript further down to score it with this key.`
      : `${redo("its own question paper")} If this is the right key, approve the transcript further down to score it with this key anyway.`;
  } else {
    lead = "This sheet was held before grading, so no AI marks were published.";
    next = `Review the transcript below, then approve or correct it to grade, or request a ${voice ? "new recording" : "rescan"}.`;
  }
  return (
    <div className="mt-2 max-w-3xl space-y-2 text-sm leading-relaxed text-slate-700">
      <p>{lead}</p>
      {quote ? <p className="break-words border-l-2 border-amber-500 pl-3 text-slate-800">{quote}</p> : null}
      {staleZero && !voice ? (
        <p className="text-xs text-slate-500">
          The audit trail also calls this &ldquo;OCR confidence 0.00&rdquo;: older runs counted a sheet with no answers
          as 0% confident.{noFlaggedPages ? " No page was below the threshold." : ""}
        </p>
      ) : null}
      <p>{next}</p>
    </div>
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
        <Pill className="bg-rose-50 text-rose-800">
          {attempts > max ? `Attempt ${attempts}` : `Attempts ${attempts}/${max}`}
        </Pill>
        {s.last_error_code ? (
          <Pill className="bg-rose-50 font-mono text-rose-800">{s.last_error_code}</Pill>
        ) : null}
      </div>
      <p className="text-xs text-slate-600">
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
      className="rounded-md border border-l-[3px] border-rose-300 border-l-rose-600 bg-white p-4 [print-color-adjust:exact] sm:p-6"
    >
      <div>
        <div className="min-w-0">
          <p className="text-[13px] text-rose-700">Dead-letter queue</p>
          <h2 id="failed-title" className="mt-0.5 text-lg font-semibold text-brand-navy">
            Processing failed
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">
            The pipeline could not complete this submission. It was marked <strong>FAILED</strong> and routed to the
            dead-letter queue for investigation. No partial grades were published.
          </p>
          <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs font-medium text-rose-700">Error</p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-rose-950">
              {s.error_message || pending.detail || "No error message was recorded."}
            </p>
          </div>
          {pending.detail && s.error_message && pending.detail !== s.error_message ? (
            <p className="mt-2 text-sm text-slate-600">System note: {pending.detail}</p>
          ) : null}
          <RetryControl pending={pending} onChanged={onChanged} />
          {s.is_demo ? null : <RerunControl className="mt-4" submission={s} onChanged={onChanged} />}
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
      className="rounded-md border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="active-title" className="text-lg font-semibold text-brand-navy">
              Report in progress
            </h2>
            <StatusBadge status={pending.status} />
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
            The answer sheet is in the processing pipeline. This page refreshes automatically and shows the report when
            evaluation completes.
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
            <Loader2 className="h-3.5 w-3.5 text-brand-cyan-600 motion-safe:animate-spin" aria-hidden />
            Auto-refreshing every 3 s
          </p>
        </div>
        <MeterBar
          percent={progress}
          label="Pipeline progress"
          valueText={`Stage ${Math.max(index, 0) + 1} of ${PIPELINE_STAGES.length}: ${stepLabel}`}
          fillClass="bg-brand-cyan-600"
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
      className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 print:hidden"
    >
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
        <HumanReviewPanel
          pending={{ ...pending, submission }}
          states={states}
          rubricText={rubricLabel}
          questionCount={rubric?.content?.questions?.length ?? null}
          onChanged={changed}
        />
      ) : submission.status === "FAILED" ? (
        <FailedPanel pending={{ ...pending, submission }} states={states} onChanged={changed} />
      ) : (
        <ActivePanel pending={{ ...pending, submission, status: submission.status }} states={states} />
      )}

      {(submission.status === "HUMAN_REVIEW_REQUIRED" || submission.status === "FAILED") && !submission.is_demo ? (
        <SourcesPanel submission={submission} />
      ) : null}

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
