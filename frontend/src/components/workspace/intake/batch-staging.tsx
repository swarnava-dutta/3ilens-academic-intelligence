"use client";

import Link from "next/link";
import { useId, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  Replace,
  Trash2,
  XCircle,
} from "lucide-react";
import type { KeyOrigin } from "@/components/rubrics/use-rubric-source";
import type { Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ACCEPT_ATTR, formatBytes, MULTIPART_THRESHOLD_BYTES, shortHash, type VoiceSettings } from "../format";
import { codeLabel } from "./codes";
import { KEY_SAVE_WAIT, keySaveNote, queuedNote, type IntakeGate } from "./gate";
import { matchTag, mismatchHeld, paperTag } from "./paper";
import { SheetThumb } from "./sheet-thumb";
import {
  isVoiceRow,
  QUEUE_API_NOTE_THRESHOLD,
  summarize,
  UPLOAD_CONCURRENCY,
  type BatchIntake,
  type RowView,
} from "./use-batch-intake";
import { VoiceChip, VoiceNotes, VoiceQuestionSelect, type VoiceQuestionOption } from "./voice-fields";

const cellInput =
  "block w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

/** # · student · sheet thumbnail · file · custody · status · actions (stacked below lg). */
const GRID =
  "lg:grid lg:grid-cols-[2rem_minmax(0,1.35fr)_7.5rem_minmax(0,1.25fr)_8.5rem_minmax(0,1fr)_7.5rem] lg:items-start lg:gap-3";

function StatusChip({ view }: { view: RowView }) {
  const { row, blocked, skippedAsDuplicate } = view;
  let tone = "bg-slate-100 text-slate-600 ring-slate-200";
  let text: string;
  let Icon = Info;
  let spin = false;
  let title = row.errorDetail ?? blocked?.message ?? undefined;
  if (view.waiting) {
    tone = "bg-brand-cyan-50 text-brand-cyan-600 ring-brand-cyan/30";
    text = "waiting to upload";
    Icon = Clock;
    title = keySaveNote("this sheet goes");
  } else if (row.phase === "checking") {
    text = "checking…";
    Icon = Loader2;
    spin = true;
  } else if (row.phase === "uploading") {
    tone = "bg-brand-cyan-50 text-brand-cyan-600 ring-brand-cyan/30";
    text = row.percent >= 100 ? "validating…" : `uploading ${row.percent}%`;
    Icon = Loader2;
    spin = true;
  } else if (row.phase === "queued") {
    tone = "bg-brand-lime-50 text-lime-800 ring-brand-lime/50";
    text = `queued #${row.submission?.id ?? "?"}`;
    Icon = CheckCircle2;
  } else if (row.phase === "rejected") {
    tone = "bg-rose-50 text-rose-700 ring-rose-200";
    text = `rejected: ${codeLabel(row.errorCode)}`;
    Icon = XCircle;
  } else if (blocked) {
    tone = "bg-rose-50 text-rose-700 ring-rose-200";
    text = `rejected: ${codeLabel(blocked.code)}`;
    Icon = XCircle;
  } else if (skippedAsDuplicate) {
    tone = "bg-amber-50 text-amber-800 ring-amber-200";
    text = "duplicate - skipped";
    Icon = Copy;
  } else {
    tone = "bg-slate-100 text-brand-navy";
    text = "ready";
    Icon = CheckCircle2;
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium",
        tone,
      )}
      title={title}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", spin && "motion-safe:animate-spin")} aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

interface BatchStagingProps {
  intake: BatchIntake;
  /** Upload now / queue until the answer key is ready / why nothing can be sent yet. */
  gate: IntakeGate;
  /** Re-upload one rejected row (needs a ready answer key). */
  onRetry: (key: string) => void;
  /** Re-upload every rejected row in one run. */
  onRetryRejected: () => void;
  /** The answer key is ready (a retry can be sent now). */
  keyReady: boolean;
  /** SHA-256 -> earlier submission (from the queue) for the "seen before" hint. */
  knownHashes: Map<string, Submission>;
  ocrCacheEnabled: boolean;
  voice: VoiceSettings;
  /** Questions of the answer key (for per-question voice recordings). */
  questions: VoiceQuestionOption[];
  /**
   * Make a staged file the intake's answer-key source: "key" (an answer-key paper - the row is
   * removed) or "paper" (a printed question paper - the row stays as a student's sheet).
   */
  onUseForKey?: (file: File, how: KeyOrigin) => void;
  /** No answer key yet: printed papers offer "Use as question paper". */
  canUseAsPaper?: boolean;
}

export function BatchStaging({
  intake,
  gate,
  onRetry,
  onRetryRejected,
  keyReady,
  knownHashes,
  ocrCacheEnabled,
  voice,
  questions,
  onUseForKey,
  canUseAsPaper = false,
}: BatchStagingProps) {
  const ids = useId();
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceKeyRef = useRef<string | null>(null);
  const { views, skipped, running, pendingRun, waitingCount } = intake;

  if (views.length === 0 && skipped.length === 0) return null;

  const uploadable = views.filter((v) => v.uploadable).length;
  const attempted = views.filter((v) => v.row.phase === "queued" || v.row.phase === "rejected" || v.row.phase === "uploading");
  const queued = views.filter((v) => v.row.phase === "queued").length;
  const rejected = views.filter((v) => v.row.phase === "rejected").length;
  const retryable = views.filter((v) => v.row.phase === "rejected" && !v.blocked && !v.waiting).length;
  // During a run the not-yet-started rows are still "ready" (waiting for a free upload slot).
  const runTotal = attempted.length + (running ? uploadable : 0);
  const groups = summarize(views, skipped);
  const checking = views.some((v) => v.row.phase === "checking");
  const shortId = intake.intakeBatchId ? intake.intakeBatchId.slice(0, 4) : null;
  const voiceRows = views.filter((v) => isVoiceRow(v.row)).length;
  const otherPapers = views.filter(
    (v) => v.row.phase === "ready" && (v.rubricMatch?.verdict === "mismatch" || v.rubricMatch?.verdict === "reordered"),
  );
  const differentPapers = otherPapers.filter((v) => v.rubricMatch?.verdict === "mismatch").length;
  const otherCodes = otherPapers.length - differentPapers;
  const otherRows = otherPapers.map((v) => v.index + 1);
  const waitingForKey = gate.queued && uploadable > 0;
  const blocked = !!gate.blocked;

  function pickReplacement(key: string) {
    replaceKeyRef.current = key;
    replaceInputRef.current?.click();
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4 border-t border-slate-200 pt-5">
      <input
        ref={replaceInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          const key = replaceKeyRef.current;
          e.target.value = "";
          if (file && key) void intake.replaceFile(key, file);
        }}
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`${ids}-title`} className="text-base font-semibold text-brand-navy">
            Staged answer sheets <span className="font-normal text-slate-500">({views.length})</span>
          </h3>
          <p className="text-xs text-slate-500">
            One row per student. Names come from the file or sub-folder name - edit them before uploading. The
            answer key, language and batch apply to the whole batch.
            {shortId ? (
              <>
                {" "}
                Intake batch <span className="font-mono font-medium text-slate-700">{shortId}</span>.
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={intake.clear}
          disabled={running || pendingRun || waitingCount > 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Clear / new batch
        </button>
      </div>

      {views.length > QUEUE_API_NOTE_THRESHOLD ? (
        <p className="text-xs text-slate-600">
          More than {QUEUE_API_NOTE_THRESHOLD} files: production uses the batch queue API (presigned S3 multipart
          uploads + one SQS job per student). This PoC uploads them {UPLOAD_CONCURRENCY} at a time from the browser.
        </p>
      ) : null}

      {voiceRows > 0 ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 text-xs">
            <p className="font-medium text-slate-700">
              {voiceRows} voice {voiceRows === 1 ? "answer" : "answers"} staged. Pick every language spoken in the
              answer-language chips above.
            </p>
            <VoiceNotes voice={voice} className="mt-0.5" />
          </div>
        </div>
      ) : null}

      {otherPapers.length > 0 ? (
        <p className="border-l-2 border-amber-500 pl-3 text-xs text-amber-900" role="status">
          <span className="font-medium">
            {otherPapers.length} {otherPapers.length === 1 ? "sheet does" : "sheets do"} not match the answer key in
            use
          </span>{" "}
          (
          {[
            differentPapers ? `${differentPapers} different ${differentPapers === 1 ? "paper" : "papers"}` : null,
            otherCodes ? `${otherCodes} other code / set` : null,
          ]
            .filter(Boolean)
            .join(", ")}
          ; {otherRows.length === 1 ? "row" : "rows"} {otherRows.slice(0, 12).join(", ")}
          {otherRows.length > 12 ? ` +${otherRows.length - 12} more` : ""}). They upload, but are held for faculty
          review unless their answers map to the key - remove them and grade them in their own intake with their
          own key.
        </p>
      ) : null}

      {attempted.length > 0 ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700">
              {queued}/{runTotal} uploaded{rejected > 0 ? ` · ${rejected} rejected` : ""}
              {running ? ` · ${UPLOAD_CONCURRENCY} at a time` : ""}
            </span>
            {running ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin text-brand-cyan" aria-hidden /> : null}
          </div>
          <div
            className="flex h-1.5 w-full overflow-hidden rounded-sm bg-slate-200"
            role="progressbar"
            aria-label="Batch upload progress"
            aria-valuemin={0}
            aria-valuemax={runTotal}
            aria-valuenow={queued}
          >
            <span className="h-full bg-brand-lime-600" style={{ width: `${(queued / Math.max(1, runTotal)) * 100}%` }} />
            <span className="h-full bg-rose-600" style={{ width: `${(rejected / Math.max(1, runTotal)) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {views.length > 0 ? (
        <div className="space-y-2">
          <div
            className={cn(GRID, "hidden px-3 text-xs font-medium text-slate-500")}
            aria-hidden
          >
            <span>#</span>
            <span>Student · roll no</span>
            <span>Sheet</span>
            <span>File</span>
            <span>Custody (SHA-256)</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          <ol className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {views.map((view) => (
              <StagedRowItem
                key={view.row.key}
                view={view}
                views={views}
                intake={intake}
                keyReady={keyReady}
                onRetry={() => onRetry(view.row.key)}
                seenBefore={view.row.hash ? (knownHashes.get(view.row.hash) ?? null) : null}
                ocrCacheEnabled={ocrCacheEnabled}
                questions={questions}
                voiceReady={voice.ready}
                canUseAsPaper={canUseAsPaper}
                onReplace={() => pickReplacement(view.row.key)}
                onUseForKey={
                  onUseForKey
                    ? (how: KeyOrigin) => {
                        onUseForKey(view.row.file, how);
                        if (how !== "paper") intake.removeRow(view.row.key);
                      }
                    : undefined
                }
              />
            ))}
          </ol>
        </div>
      ) : null}

      {skipped.length > 0 ? (
        <details className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">
            {skipped.length} {skipped.length === 1 ? "file" : "files"} skipped (not answer sheets)
          </summary>
          <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
            {skipped.map((s, i) => (
              <li key={`${i}-${s.path}`} className="break-all">
                <span className="font-medium text-slate-700">{s.path}</span> - {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-600" aria-live="polite">
          {groups.length ? (
            groups.map((g, i) => (
              <span key={g.label}>
                {i > 0 ? <span className="text-slate-300"> · </span> : null}
                <span
                  className={cn(
                    "font-medium",
                    g.tone === "good" ? "text-lime-700" : g.tone === "bad" ? "text-rose-700" : "text-slate-600",
                  )}
                >
                  {g.count} {g.label}
                </span>
              </span>
            ))
          ) : (
            <span className="text-slate-500">No answer sheets staged.</span>
          )}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {retryable > 0 && !running ? (
            <button
              type="button"
              onClick={onRetryRejected}
              disabled={!keyReady || pendingRun}
              title={keyReady ? undefined : "The answer key is not ready yet"}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry {retryable} rejected
            </button>
          ) : null}
          <button
            type="button"
            onClick={gate.send}
            disabled={running || pendingRun || checking || uploadable === 0 || blocked || waitingForKey}
            aria-describedby={uploadable > 0 && (blocked || gate.waiting) ? `${ids}-why` : undefined}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-brand-navy px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
            {(waitingForKey || pendingRun) && !running ? <Clock className="h-4 w-4" aria-hidden /> : null}
            {running
              ? "Uploading…"
              : pendingRun
                ? KEY_SAVE_WAIT
                : checking
                  ? "Checking files…"
                  : uploadable === 0
                    ? "Nothing left to upload"
                    : waitingForKey
                      ? "Queued - waiting for the answer key"
                      : gate.held
                        ? `Send the ${uploadable} waiting ${uploadable === 1 ? "sheet" : "sheets"}`
                        : gate.waiting
                          ? `Upload ${uploadable} ${uploadable === 1 ? "sheet" : "sheets"} when the key is ready`
                          : `Upload ${uploadable} ${uploadable === 1 ? "sheet" : "sheets"} & start AI evaluation`}
          </button>
        </div>
      </div>

      {waitingCount > 0 ? (
        <p className="text-xs text-slate-600" role="status" aria-live="polite">
          {keySaveNote(`${waitingCount} waiting ${waitingCount === 1 ? "sheet goes" : "sheets go"}`)}
        </p>
      ) : null}

      {uploadable > 0 && !running && !pendingRun ? (
        blocked ? (
          <p id={`${ids}-why`} className="text-xs text-amber-800">
            {gate.blocked}
          </p>
        ) : waitingForKey ? (
          <p id={`${ids}-why`} className="text-xs text-slate-600" role="status" aria-live="polite">
            {queuedNote(`${uploadable} ${uploadable === 1 ? "sheet" : "sheets"}`, gate.waiting)}{" "}
            <button
              type="button"
              onClick={gate.cancel}
              className="font-medium text-brand-cyan-600 underline underline-offset-2 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              Cancel
            </button>
          </p>
        ) : gate.waiting ? (
          <p id={`${ids}-why`} className="text-xs text-slate-500">
            {gate.waiting} A click queues the sheets; they upload the moment the key is ready.
          </p>
        ) : gate.held ? (
          <p className="text-xs text-slate-600" role="status">
            The key was edited after these sheets were queued - check it, then send them.
          </p>
        ) : null
      ) : null}

      {intake.message ? (
        <p className="border-l-2 border-rose-600 pl-3 text-sm text-rose-800" role="alert">
          {intake.message}
        </p>
      ) : null}
    </section>
  );
}

function StagedRowItem({
  view,
  views,
  intake,
  keyReady,
  onRetry,
  seenBefore,
  ocrCacheEnabled,
  questions,
  voiceReady,
  canUseAsPaper,
  onReplace,
  onUseForKey,
}: {
  view: RowView;
  views: RowView[];
  intake: BatchIntake;
  /** The answer key is ready for a retry. */
  keyReady: boolean;
  onRetry: () => void;
  seenBefore: Submission | null;
  ocrCacheEnabled: boolean;
  questions: VoiceQuestionOption[];
  voiceReady: boolean;
  canUseAsPaper: boolean;
  onReplace: () => void;
  onUseForKey?: (how: KeyOrigin) => void;
}) {
  const ids = useId();
  const { row, index, duplicateOf, blocked } = view;
  const tag = paperTag(row.paper);
  const match = matchTag(view.rubricMatch, mismatchHeld(row.paper));
  const answerKeyRow = row.paper?.role === "answer_key_paper";
  const printedRow = row.paper?.role === "question_paper";
  const locked = row.phase === "uploading" || row.phase === "queued" || intake.running || view.waiting;
  const canRetry = row.phase === "rejected" && !blocked;
  const canReplace = row.phase !== "uploading" && row.phase !== "queued";
  const original = duplicateOf !== null ? views[duplicateOf] : null;
  const isVoice = isVoiceRow(row);
  // A page thumbnail once the bytes are checked (not for audio, nor a file refused before upload).
  const showThumb = !isVoice && !!row.signature && !row.signature.error && !blocked;

  return (
    <li
      className={cn(
        "border-l-2 p-3",
        GRID,
        row.phase === "rejected" || blocked
          ? "border-l-rose-600"
          : view.skippedAsDuplicate || ((answerKeyRow || match) && row.phase === "ready")
            ? "border-l-amber-500"
            : "border-l-transparent",
      )}
    >
      <span className="hidden pt-1.5 text-xs tabular-nums text-slate-500 lg:block">{index + 1}</span>

      {/* Student + roll no */}
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
        <div className="min-w-0">
          <label htmlFor={`${ids}-name`} className="sr-only">
            Student name for row {index + 1}
          </label>
          <input
            id={`${ids}-name`}
            className={cn(cellInput, view.nameProblem && "border-rose-300")}
            value={row.studentName}
            maxLength={120}
            disabled={locked}
            placeholder="Student name"
            aria-invalid={view.nameProblem ? true : undefined}
            onChange={(e) => intake.updateRow(row.key, { studentName: e.target.value })}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${ids}-roll`} className="sr-only">
            Roll number for row {index + 1}
          </label>
          <input
            id={`${ids}-roll`}
            className={cn(cellInput, view.rollProblem && "border-rose-300")}
            value={row.rollNo}
            maxLength={40}
            disabled={locked}
            placeholder="Roll no"
            aria-invalid={view.rollProblem ? true : undefined}
            onChange={(e) => intake.updateRow(row.key, { rollNo: e.target.value })}
          />
        </div>
        {view.nameProblem || view.rollProblem ? (
          <p className="col-span-2 text-xs text-rose-700">{view.nameProblem ?? view.rollProblem}</p>
        ) : null}
      </div>

      {/* Sheet thumbnail + file: side by side from 640px, stacked on phones, own grid columns at lg. */}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3 lg:contents">
        {showThumb ? <SheetThumb file={row.file} /> : <div className="hidden lg:block" aria-hidden />}

        {/* File */}
        <div className="min-w-0 text-sm sm:flex-1">
          <p className="flex items-center gap-1.5 text-slate-800" title={row.path}>
            <span className="truncate">{row.file.name}</span>
          </p>
          {isVoice ? <VoiceChip className="mt-1" /> : null}
          {tag ? (
            <p className="mt-1 flex flex-wrap items-start gap-1.5 text-xs">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-medium",
                  tag.tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-700",
                )}
                title={row.paper?.message || undefined}
              >
                {tag.label}
              </span>
              {tag.tone === "amber" ? <span className="min-w-0 text-amber-800">{tag.hint}</span> : null}
            </p>
          ) : row.paperChecking ? (
            <p className="mt-1 text-[11px] text-slate-500">Reading printed text…</p>
          ) : null}
          {match ? (
            <p className="mt-1 flex flex-wrap items-start gap-1.5 text-xs">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-medium",
                  match.tone === "rose" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800",
                )}
                title={match.detail}
              >
                {match.label}
              </span>
              <span className={cn("min-w-0 break-words", match.tone === "rose" ? "text-rose-700" : "text-amber-800")}>
                {match.hint}
              </span>
            </p>
          ) : view.matchChecking ? (
            <p className="mt-1 text-[11px] text-slate-500">Comparing with the answer key in use…</p>
          ) : null}
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span>{formatBytes(row.file.size)}</span>
            {row.signature?.kind ? <span>· {row.signature.kind.toUpperCase()}</span> : null}
            {row.path !== row.file.name ? <span className="truncate">· {row.path.split("/").slice(0, -1).join("/")}</span> : null}
          </p>
          {row.file.size > MULTIPART_THRESHOLD_BYTES ? (
            <p className="mt-1 text-[11px] text-slate-500">
              Production: S3 presigned multipart (resumable). PoC: single streamed upload
            </p>
          ) : null}
          {isVoice ? (
            <div className="mt-2 max-w-[16rem]">
              <VoiceQuestionSelect
                id={`${ids}-voice-q`}
                value={row.voiceQuestion}
                onChange={(q) => intake.updateRow(row.key, { voiceQuestion: q })}
                questions={questions}
                disabled={locked}
                compact
              />
              {!voiceReady ? (
                <p className="mt-1 flex items-start gap-1 text-[11px] font-medium text-amber-900">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-amber-700" aria-hidden />
                  OPENAI_API_KEY missing - this voice answer will fail at transcription
                </p>
              ) : null}
            </div>
          ) : null}
          {/blurry/i.test(row.file.name) ? (
            <p className="mt-1 text-[11px] text-amber-800" title="Mock OCR confidence 65% (below the 70% gate): held for faculty review, no AI call.">
              Human-review demo (&ldquo;blurry&rdquo; in the name)
            </p>
          ) : null}
          {row.signature?.warning ? (
            <p className="mt-1 flex items-start gap-1 text-xs text-amber-800">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
              {row.signature.warning}
            </p>
          ) : null}
        </div>
      </div>

      {/* Custody */}
      <div className="mt-2 text-xs lg:mt-0 lg:pt-1.5">
        {row.hash ? (
          <span className="font-mono text-slate-600" title={`SHA-256 ${row.hash}`}>
            {shortHash(row.hash)}
          </span>
        ) : row.phase === "checking" ? (
          <span className="text-slate-500">hashing…</span>
        ) : blocked ? (
          <span className="text-slate-400">–</span>
        ) : (
          <span className="text-slate-500" title="Web Crypto is unavailable here; the server hashes the bytes on upload.">
            server-side
          </span>
        )}
        {original ? (
          <p className="mt-1 text-amber-800">
            Same bytes as row {original.index + 1}
            <span className="hidden lg:inline"> ({original.row.file.name})</span>
          </p>
        ) : seenBefore && seenBefore.id !== row.submission?.id ? (
          <p className="mt-1 text-slate-500" title="The OCR cache is keyed by file SHA-256 (plus rubric questions and language).">
            Seen before as #{seenBefore.id}
            {ocrCacheEnabled ? " - OCR cache can reuse it (no vision call, Rs 0.00)" : ""}
          </p>
        ) : null}
      </div>

      {/* Status */}
      <div className="mt-2 min-w-0 space-y-1 lg:mt-0 lg:pt-1">
        <StatusChip view={view} />
        {row.phase === "uploading" ? (
          <div className="h-1 w-full max-w-40 overflow-hidden rounded-sm bg-slate-200" aria-hidden>
            <div className="h-full bg-brand-cyan" style={{ width: `${row.percent}%` }} />
          </div>
        ) : null}
        {row.phase === "rejected" && row.errorDetail ? (
          <p className="text-xs text-rose-700">{row.errorDetail}</p>
        ) : blocked && row.phase === "ready" ? (
          <p className="text-xs text-rose-700">{blocked.message}</p>
        ) : null}
        {duplicateOf !== null && row.phase === "ready" ? (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={row.includeDuplicate}
              disabled={locked}
              onChange={(e) => intake.updateRow(row.key, { includeDuplicate: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-cyan focus:ring-brand-cyan"
            />
            Upload anyway
          </label>
        ) : null}
      </div>

      {/* Actions */}
      <div className="mt-2 flex flex-wrap items-center gap-1 lg:mt-0 lg:justify-end">
        {row.phase === "queued" && row.submission ? (
          <Link
            href={`/report/${row.submission.id}`}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-brand-cyan-600 underline underline-offset-2 transition-colors duration-150 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
          >
            Open
          </Link>
        ) : null}
        {answerKeyRow && onUseForKey && row.phase === "ready" ? (
          <button
            type="button"
            onClick={() => onUseForKey("key")}
            disabled={intake.running || intake.pendingRun || view.waiting}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
            title="Draft the answer key from this paper and remove it from the batch"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
            Use as key
          </button>
        ) : null}
        {printedRow && canUseAsPaper && onUseForKey && row.phase === "ready" ? (
          <button
            type="button"
            onClick={() => onUseForKey("paper")}
            disabled={intake.running || intake.pendingRun || view.waiting}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
            title="Use as the question paper: draft the answer key from this printed paper - the row stays staged as a student's sheet; drop its answer key into the Answer key box too"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
            Use as paper
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={!keyReady || intake.running || view.waiting}
            title={view.waiting ? "Waiting to upload" : keyReady ? undefined : "The answer key is not ready yet"}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </button>
        ) : null}
        {canReplace ? (
          <button
            type="button"
            onClick={onReplace}
            disabled={intake.running || view.waiting}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
          >
            <Replace className="h-3.5 w-3.5" aria-hidden />
            Replace
          </button>
        ) : null}
        {row.phase !== "uploading" && row.phase !== "queued" ? (
          <button
            type="button"
            onClick={() => intake.removeRow(row.key)}
            disabled={intake.running || view.waiting}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
            aria-label={`Remove ${row.file.name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </li>
  );
}
