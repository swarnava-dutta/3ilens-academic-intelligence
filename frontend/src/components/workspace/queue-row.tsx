"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { FileDown, Loader2, Mic, RotateCcw } from "lucide-react";
import { useOcrThreshold } from "@/components/app-shell";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { StatusBadge } from "@/components/status-badge";
import { reportPdfUrl } from "@/lib/api";
import type { Submission } from "@/lib/types";
import { cn, formatConfidence, formatDateTime, formatScore } from "@/lib/utils";
import { codeLabel } from "./intake/codes";
import { formatClock, formatInr, formatRelative, PIPELINE_STEP_COUNT, pipelineStepIndex, shortHash, toUtcIso } from "./format";

export const QUEUE_COLUMNS = ["Student", "File", "Status", "Current step", "OCR", "Score", "Cost", "Uploaded", "Action"];
/** Columns hidden on phones (the status badge moves under the student name there). */
export const DESKTOP_ONLY = new Set(["File", "Status", "Current step", "OCR", "Cost", "Uploaded"]);
/** Columns shown only on wide screens (>= 1536 px); below that their content moves into the
 * Status and File cells so the Action column stays on screen without sideways scrolling. */
export const WIDE_ONLY = new Set(["Current step", "Uploaded"]);
/** Shown from 1280 px (cost is also in the report and the cohort operations card). */
export const XL_ONLY = new Set(["Cost"]);
/** Right-aligned (numeric) columns. */
export const NUMERIC_COLUMNS = new Set(["Score", "Cost"]);
const XL_CELL = "hidden xl:table-cell";
const DESKTOP_CELL = "hidden md:table-cell";
const WIDE_CELL = "hidden 2xl:table-cell";

const OCR_CACHE_TITLE = "OCR cache hit - no vision call (Rs 0.00)";

function Chip({ className, title, children }: { className?: string; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-px text-[11px] font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

function pagesLabel(pages: number[]): string {
  return pages.length === 1 ? `p${pages[0]}` : `p${pages.join(", p")}`;
}

export interface RowAction {
  busy: boolean;
  error: string | null;
}

export function QueueRow({
  submission: s,
  now,
  action,
  onRetry,
}: {
  submission: Submission;
  now: number | null;
  action: RowAction | undefined;
  onRetry: (submission: Submission) => void;
}) {
  const threshold = useOcrThreshold();
  const review = s.status === "HUMAN_REVIEW_REQUIRED";
  const failed = s.status === "FAILED";
  const active = s.status === "PENDING" || s.status === "PROCESSING";
  const completed = s.status === "COMPLETED";
  const flagged = review || failed;

  const edge = review ? "border-l-amber-500" : failed ? "border-l-rose-600" : "border-l-transparent";
  const rowBg = flagged ? "" : "hover:bg-slate-50";
  const relative = formatRelative(s.created_at, now);
  const exact = formatDateTime(toUtcIso(s.created_at));
  const stepIndex = active ? pipelineStepIndex(s.current_step) : -1;
  const lowConfidence = s.ocr_confidence !== null && s.ocr_confidence < threshold;
  const pct =
    typeof s.percentage === "number"
      ? Math.round(s.percentage)
      : completed && s.total_score !== null && s.total_marks > 0
        ? Math.round((s.total_score / s.total_marks) * 100)
        : null;
  const attempts = s.attempts ?? 0;
  const maxAttempts = s.max_attempts || 3;
  const retrying = /retrying/i.test(s.current_step ?? "");
  // Only while a sheet is failing or being retried: a completed re-evaluation also counts as a run.
  const showAttempts = !completed && (attempts > 1 || retrying || (failed && attempts > 0));
  // After an operator Retry the counter keeps going past max_attempts: show "attempt N" then.
  const attemptsLabel = attempts > maxAttempts ? `attempt ${attempts}` : `attempts ${attempts}/${maxAttempts}`;
  const flaggedPages = s.flagged_pages ?? [];
  const languages = (s.language_hints ?? []).filter((l) => l !== "en");
  const isVoice = s.input_kind === "voice";
  const duration = isVoice ? formatClock(s.audio_seconds) : null;
  const voiceTitle = isVoice
    ? `Voice answer${duration ? ` (${duration})` : ""}${s.voice_question ? ` for Q${s.voice_question}` : " - whole recording, AI-mapped"}`
    : undefined;

  return (
    <>
      <tr className={cn("border-t border-slate-200 align-middle transition-colors duration-150", rowBg)}>
        <td className={cn("border-l-4 py-2.5 pl-3 pr-2 sm:pl-4 md:pr-4", edge)}>
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-900 md:max-w-[13rem] 2xl:max-w-none 2xl:whitespace-nowrap">
              {s.student_name}
            </span>
            {s.is_demo ? (
              <span
                className="text-xs text-slate-500"
                title="Synthetic demo row - no AI call"
              >
                demo
              </span>
            ) : null}
          </div>
          <div className="text-xs tabular-nums text-slate-500">
            #{s.id}
            {s.student_ref && s.student_ref !== s.student_name ? (
              <span className="hidden lg:inline" title="Student ref (roll no or name slug)">
                {" "}
                · {s.student_ref}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 md:hidden">
            <StatusBadge status={s.status} />
            {isVoice ? (
              <Chip className="bg-slate-50 text-slate-700 ring-slate-200" title={voiceTitle}>
                <Mic className="h-3 w-3" aria-hidden />
                Voice{duration ? ` ${duration}` : ""}
              </Chip>
            ) : null}
            {completed ? <UrgencyBadge urgency={s.urgency} size="sm" /> : null}
          </div>
        </td>

        <td className={cn("max-w-[11rem] px-4 py-2.5 xl:max-w-[13rem] 2xl:max-w-[15rem]", DESKTOP_CELL)}>
          <span className="block truncate text-slate-700" title={s.original_filename}>
            {s.original_filename}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {isVoice ? (
              <Chip className="bg-slate-50 text-slate-700 ring-slate-200" title={voiceTitle}>
                <Mic className="h-3 w-3" aria-hidden />
                Voice{duration ? ` · ${duration}` : ""}
                {s.voice_question ? ` · Q${s.voice_question}` : ""}
              </Chip>
            ) : null}
            {s.file_sha256 ? (
              <span className="font-mono text-[11px] text-slate-500" title={`SHA-256 ${s.file_sha256}`}>
                {shortHash(s.file_sha256)}
              </span>
            ) : null}
            {s.ocr_cache_hit ? (
              <Chip className="bg-slate-50 text-slate-600 ring-slate-200" title={OCR_CACHE_TITLE}>
                OCR cached
              </Chip>
            ) : null}
            {languages.length ? (
              <Chip className="bg-slate-50 text-slate-600 ring-slate-200" title="Answer language hints">
                {(s.language_hints ?? []).join("+").toUpperCase()}
              </Chip>
            ) : null}
            {s.page_count ? <span className="text-[11px] tabular-nums text-slate-500">{s.page_count} p</span> : null}
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-500 2xl:hidden" title={exact}>
            {relative ?? exact}
          </span>
        </td>

        <td className={cn("px-4 py-2.5", DESKTOP_CELL)}>
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={s.status} />
            {active && s.current_step ? (
              <span className="max-w-[11rem] truncate text-[11px] text-slate-500 2xl:hidden" title={s.current_step}>
                {s.current_step}
                {stepIndex >= 0 ? ` · step ${stepIndex + 1}/${PIPELINE_STEP_COUNT}` : ""}
              </span>
            ) : null}
            <span className="flex flex-wrap gap-1">
              {showAttempts ? (
                <Chip
                  className={cn(failed ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800")}
                  title="Transient failures are retried with exponential backoff, then dead-lettered"
                >
                  {attemptsLabel}
                </Chip>
              ) : null}
              {completed && s.release_status ? (
                <Chip
                  className={
                    s.release_status === "RELEASED"
                      ? "bg-brand-lime-50 text-lime-800"
                      : "bg-slate-100 text-slate-600"
                  }
                  title={s.release_status === "RELEASED" ? "Faculty signed off" : "Provisional - teacher review pending"}
                >
                  {s.release_status === "RELEASED" ? "Released" : "Provisional"}
                </Chip>
              ) : null}
            </span>
          </div>
        </td>

        <td className={cn("px-4 py-2.5", WIDE_CELL)}>
          <div
            className={cn("max-w-[13rem] truncate", review ? "font-medium text-amber-900" : "text-slate-600")}
            title={s.current_step}
          >
            {s.current_step || "—"}
          </div>
          {stepIndex >= 0 ? (
            <div className="mt-1.5 flex gap-0.5" aria-label={`Pipeline step ${stepIndex + 1} of ${PIPELINE_STEP_COUNT}`} role="img">
              {Array.from({ length: PIPELINE_STEP_COUNT }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 w-4 rounded-sm",
                    i < stepIndex ? "bg-brand-cyan" : i === stepIndex ? "motion-safe:animate-pulse bg-brand-cyan" : "bg-slate-200",
                  )}
                />
              ))}
            </div>
          ) : null}
        </td>

        <td className={cn("px-4 py-2.5", DESKTOP_CELL)}>
          {s.ocr_confidence === null ? (
            <span className="text-slate-400">–</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className={cn("tabular-nums", lowConfidence ? "font-semibold text-amber-700" : "text-slate-700")}>
                {formatConfidence(s.ocr_confidence)}
              </span>
              <span className="h-1.5 w-12 overflow-hidden rounded-sm bg-slate-200" aria-hidden>
                <span
                  className={cn("block h-full", lowConfidence ? "bg-amber-500" : "bg-brand-lime-600")}
                  style={{ width: `${Math.min(100, Math.max(0, Math.round(s.ocr_confidence * 100)))}%` }}
                />
              </span>
            </div>
          )}
          {flaggedPages.length ? (
            <span
              className="mt-1 block text-[11px] font-medium text-amber-800"
              title={`Page-average confidence below ${Math.round(threshold * 100)}%`}
            >
              {pagesLabel(flaggedPages)} flagged
            </span>
          ) : null}
        </td>

        <td className="whitespace-nowrap px-2 py-2.5 text-right md:px-4">
          {completed && s.total_score !== null ? (
            <div className="flex flex-col items-end gap-1">
              <span>
                <span className="font-semibold tabular-nums text-brand-navy">{formatScore(s.total_score, s.total_marks)}</span>
                {pct !== null ? <span className="ml-1.5 hidden text-xs tabular-nums text-slate-500 sm:inline">{pct}%</span> : null}
              </span>
              <span className="hidden md:inline-flex">
                <UrgencyBadge urgency={s.urgency} size="sm" />
              </span>
            </div>
          ) : (
            <span className="text-slate-400">–</span>
          )}
        </td>

        <td className={cn("whitespace-nowrap px-4 py-2.5 text-right text-xs", XL_CELL)}>
          {s.is_demo ? (
            <span className="text-slate-500" title="Synthetic demo row - no AI call">
              synthetic
            </span>
          ) : typeof s.llm_cost_inr === "number" ? (
            <span className="tabular-nums text-slate-700" title={s.ocr_cache_hit ? OCR_CACHE_TITLE : "LLM cost of this sheet"}>
              {formatInr(s.llm_cost_inr)}
            </span>
          ) : (
            <span className="text-slate-400">–</span>
          )}
        </td>

        <td className={cn("whitespace-nowrap px-4 py-2.5 text-slate-500", WIDE_CELL)} title={exact}>
          {relative ?? exact}
        </td>

        <td className="whitespace-nowrap py-2.5 pl-2 pr-3 text-right sm:pr-5 md:pl-4">
          {/* Stacked on phones so the three visible columns fit 360-390 px screens. */}
          <div className="inline-flex flex-col items-end justify-end gap-1.5 sm:flex-row sm:items-center">
            {completed ? (
              <>
                <a
                  href={reportPdfUrl(s.id)}
                  download
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors duration-150 hover:bg-slate-50 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1"
                  aria-label={`Download the PDF report for ${s.student_name}`}
                  title="Download PDF report"
                >
                  <FileDown className="h-4 w-4" aria-hidden />
                </a>
                <Link
                  href={`/report/${s.id}`}
                  className="inline-flex h-8 items-center rounded-md bg-brand-navy px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1"
                  aria-label={`View report for ${s.student_name}`}
                >
                  <span className="sm:hidden">Open</span>
                  <span className="hidden sm:inline md:hidden xl:inline">View report</span>
                  <span className="hidden md:inline xl:hidden">Report</span>
                </Link>
              </>
            ) : (
              <>
                {failed ? (
                  <button
                    type="button"
                    onClick={() => onRetry(s)}
                    disabled={action?.busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-rose-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:opacity-60"
                    aria-label={`Retry processing for ${s.student_name}`}
                  >
                    {action?.busy ? (
                      <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    )}
                    <span className="hidden sm:inline">Retry</span>
                  </button>
                ) : null}
                <Link
                  href={`/report/${s.id}`}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md border bg-white px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1",
                    review
                      ? "border-amber-400 text-amber-900 hover:bg-amber-50"
                      : "border-slate-300 text-slate-700 hover:bg-slate-50 hover:text-brand-navy",
                  )}
                  aria-label={review ? `Review the transcript for ${s.student_name}` : `Details for ${s.student_name}`}
                >
                  {review ? "Review" : "Details"}
                </Link>
              </>
            )}
          </div>
        </td>
      </tr>

      {flagged ? (
        <tr className={rowBg}>
          <td colSpan={QUEUE_COLUMNS.length} className={cn("border-l-4 pb-2.5 pl-3 pr-4 pt-0 sm:pl-4 sm:pr-5", edge)}>
            {review ? (
              <p className="text-sm text-amber-900">
                <span>
                  <span className="font-medium">
                    Low OCR confidence {formatConfidence(s.ocr_confidence)}
                    {flaggedPages.length ? ` (${pagesLabel(flaggedPages)} below the gate)` : ""} - faculty review
                    required, AI evaluation skipped.
                  </span>{" "}
                  <span className="text-slate-600">
                    Safety gate: any page averaging below {Math.round(threshold * 100)}% is never auto-graded. Open the
                    sheet to correct the transcript or upload a rescan.
                  </span>
                </span>
              </p>
            ) : (
              <div className="space-y-1">
                <p className="text-sm text-rose-700">
                  <span className="min-w-0">
                    <span className="mr-2 rounded-sm bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">
                      Dead-letter
                    </span>
                    {s.last_error_code ? (
                      <span className="mr-2 font-mono text-xs text-rose-600">{s.last_error_code}</span>
                    ) : null}
                    <span className="break-words">{s.error_message || "Processing failed - no score was recorded."}</span>
                    {attempts > 0 ? (
                      <span className="text-rose-600">
                        {" "}
                        · after {attempts > maxAttempts ? `${attempts} attempts` : `${attempts}/${maxAttempts} attempts`}
                      </span>
                    ) : null}
                  </span>
                </p>
                {action?.error ? (
                  <p className="text-xs font-medium text-rose-800" role="alert">
                    Retry not started: {action.error}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">
                    Other students were not affected. Retry re-queues this sheet from the stored upload.
                  </p>
                )}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** "upload_missing" -> readable reason for a refused retry. */
export function retryErrorText(code: string | null, message: string): string {
  if (code === "upload_missing") return "the original upload is no longer stored - upload the sheet again.";
  if (code === "invalid_state") return "only FAILED sheets can be retried (it may already be running).";
  if (code) return `${codeLabel(code)} - ${message}`;
  return message;
}
