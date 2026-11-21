"use client";

import Link from "next/link";
import { useId, useRef } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Copy,
  FileText,
  Fingerprint,
  Info,
  Loader2,
  Mic,
  RefreshCw,
  Replace,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import type { Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ACCEPT_ATTR, formatBytes, MULTIPART_THRESHOLD_BYTES, shortHash, type VoiceSettings } from "../format";
import { codeLabel } from "./codes";
import {
  isVoiceRow,
  QUEUE_API_NOTE_THRESHOLD,
  summarize,
  UPLOAD_CONCURRENCY,
  type BatchIntake,
  type RowView,
  type UploadContext,
} from "./use-batch-intake";
import { VoiceChip, VoiceNotes, VoiceQuestionSelect, type VoiceQuestionOption } from "./voice-fields";

const cellInput =
  "block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

const GRID =
  "lg:grid lg:grid-cols-[2rem_minmax(0,1.35fr)_minmax(0,1.25fr)_8.5rem_minmax(0,1fr)_7.5rem] lg:items-start lg:gap-3";

function StatusChip({ view }: { view: RowView }) {
  const { row, blocked, skippedAsDuplicate } = view;
  let tone = "bg-slate-100 text-slate-600 ring-slate-200";
  let text: string;
  let Icon = Info;
  let spin = false;
  if (row.phase === "checking") {
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
    tone = "bg-white text-brand-navy ring-slate-300";
    text = "ready";
    Icon = CheckCircle2;
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tone,
      )}
      title={row.errorDetail ?? blocked?.message ?? undefined}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", spin && "animate-spin")} aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

interface BatchStagingProps {
  intake: BatchIntake;
  /** Upload settings (rubric, languages, batch) chosen in the form; null while no rubric is chosen. */
  context: UploadContext | null;
  /** SHA-256 -> earlier submission (from the queue) for the "seen before" hint. */
  knownHashes: Map<string, Submission>;
  ocrCacheEnabled: boolean;
  voice: VoiceSettings;
  /** Questions of the chosen rubric (for per-question voice recordings). */
  questions: VoiceQuestionOption[];
}

export function BatchStaging({ intake, context, knownHashes, ocrCacheEnabled, voice, questions }: BatchStagingProps) {
  const ids = useId();
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceKeyRef = useRef<string | null>(null);
  const { views, skipped, running } = intake;

  if (views.length === 0 && skipped.length === 0) return null;

  const uploadable = views.filter((v) => v.uploadable).length;
  const attempted = views.filter((v) => v.row.phase === "queued" || v.row.phase === "rejected" || v.row.phase === "uploading");
  const queued = views.filter((v) => v.row.phase === "queued").length;
  const rejected = views.filter((v) => v.row.phase === "rejected").length;
  // During a run the not-yet-started rows are still "ready" (waiting for a free upload slot).
  const runTotal = attempted.length + (running ? uploadable : 0);
  const groups = summarize(views, skipped);
  const checking = views.some((v) => v.row.phase === "checking");
  const shortId = intake.intakeBatchId ? intake.intakeBatchId.slice(0, 4) : null;
  const voiceRows = views.filter((v) => isVoiceRow(v.row)).length;

  function pickReplacement(key: string) {
    replaceKeyRef.current = key;
    replaceInputRef.current?.click();
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:p-5">
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
            One row per student. Names come from the file or sub-folder name - edit them before uploading. Rubric,
            language and batch apply to the whole batch.
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
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Clear / new batch
        </button>
      </div>

      {views.length > QUEUE_API_NOTE_THRESHOLD ? (
        <p className="flex items-start gap-2 rounded-xl bg-brand-cyan-50 px-3 py-2 text-xs text-brand-navy ring-1 ring-inset ring-brand-cyan/30">
          <Info className="mt-px h-3.5 w-3.5 shrink-0 text-brand-cyan-600" aria-hidden />
          More than {QUEUE_API_NOTE_THRESHOLD} files: production uses the batch queue API (presigned S3 multipart
          uploads + one SQS job per student). This PoC uploads them {UPLOAD_CONCURRENCY} at a time from the browser.
        </p>
      ) : null}

      {voiceRows > 0 ? (
        <div className="flex items-start gap-2 rounded-xl bg-violet-50/60 px-3 py-2 ring-1 ring-inset ring-violet-200">
          <Mic className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" aria-hidden />
          <div className="min-w-0 text-xs">
            <p className="font-medium text-violet-900">
              {voiceRows} voice {voiceRows === 1 ? "answer" : "answers"} staged. Pick every language spoken in the
              answer-language chips above.
            </p>
            <VoiceNotes voice={voice} className="mt-0.5" />
          </div>
        </div>
      ) : null}

      {attempted.length > 0 ? (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700">
              {queued}/{runTotal} uploaded{rejected > 0 ? ` · ${rejected} rejected` : ""}
              {running ? ` · ${UPLOAD_CONCURRENCY} at a time` : ""}
            </span>
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-cyan" aria-hidden /> : null}
          </div>
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-label="Batch upload progress"
            aria-valuemin={0}
            aria-valuemax={runTotal}
            aria-valuenow={queued}
          >
            <span className="h-full bg-brand-lime-600 transition-[width] duration-300" style={{ width: `${(queued / Math.max(1, runTotal)) * 100}%` }} />
            <span className="h-full bg-rose-400 transition-[width] duration-300" style={{ width: `${(rejected / Math.max(1, runTotal)) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {views.length > 0 ? (
        <div className="space-y-2">
          <div
            className={cn(GRID, "hidden px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500")}
            aria-hidden
          >
            <span>#</span>
            <span>Student · roll no</span>
            <span>File</span>
            <span>Custody (SHA-256)</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          <ol className="space-y-2">
            {views.map((view) => (
              <StagedRowItem
                key={view.row.key}
                view={view}
                views={views}
                intake={intake}
                context={context}
                seenBefore={view.row.hash ? (knownHashes.get(view.row.hash) ?? null) : null}
                ocrCacheEnabled={ocrCacheEnabled}
                questions={questions}
                voiceReady={voice.ready}
                onReplace={() => pickReplacement(view.row.key)}
              />
            ))}
          </ol>
        </div>
      ) : null}

      {skipped.length > 0 ? (
        <details className="rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-inset ring-slate-200">
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
        <button
          type="button"
          onClick={() => context && void intake.start(context)}
          disabled={running || checking || uploadable === 0 || !context}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-cyan px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          {running
            ? "Uploading…"
            : checking
              ? "Checking files…"
              : uploadable > 0
                ? `Upload ${uploadable} ${uploadable === 1 ? "sheet" : "sheets"} & start AI evaluation`
                : "Nothing left to upload"}
        </button>
      </div>

      {!context && uploadable > 0 ? (
        <p className="text-xs text-amber-800">Choose a rubric above before uploading.</p>
      ) : null}

      {intake.message ? (
        <p className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-200" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
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
  context,
  seenBefore,
  ocrCacheEnabled,
  questions,
  voiceReady,
  onReplace,
}: {
  view: RowView;
  views: RowView[];
  intake: BatchIntake;
  context: UploadContext | null;
  seenBefore: Submission | null;
  ocrCacheEnabled: boolean;
  questions: VoiceQuestionOption[];
  voiceReady: boolean;
  onReplace: () => void;
}) {
  const ids = useId();
  const { row, index, duplicateOf, blocked } = view;
  const locked = row.phase === "uploading" || row.phase === "queued" || intake.running;
  const canRetry = row.phase === "rejected" && !blocked;
  const canReplace = row.phase !== "uploading" && row.phase !== "queued";
  const original = duplicateOf !== null ? views[duplicateOf] : null;
  const isVoice = isVoiceRow(row);

  return (
    <li
      className={cn(
        "rounded-xl border bg-white p-3 shadow-sm",
        GRID,
        row.phase === "rejected" || blocked ? "border-rose-200" : view.skippedAsDuplicate ? "border-amber-200" : "border-slate-200",
      )}
    >
      <span className="hidden pt-1.5 text-xs font-semibold tabular-nums text-slate-400 lg:block">{index + 1}</span>

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

      {/* File */}
      <div className="mt-2 min-w-0 text-sm lg:mt-0">
        <p className="flex items-center gap-1.5 text-slate-700" title={row.path}>
          {isVoice ? (
            <Mic className="h-4 w-4 shrink-0 text-violet-700" aria-hidden />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          )}
          <span className="truncate">{row.file.name}</span>
        </p>
        {isVoice ? <VoiceChip className="mt-1" /> : null}
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          <span>{formatBytes(row.file.size)}</span>
          {row.signature?.kind ? <span className="uppercase">· {row.signature.kind}</span> : null}
          {row.path !== row.file.name ? <span className="truncate">· {row.path.split("/").slice(0, -1).join("/")}</span> : null}
        </p>
        {row.file.size > MULTIPART_THRESHOLD_BYTES ? (
          <p className="mt-1 inline-flex items-start gap-1 rounded-md bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-800 ring-1 ring-inset ring-sky-200">
            <Cloud className="mt-px h-3 w-3 shrink-0" aria-hidden />
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

      {/* Custody */}
      <div className="mt-2 text-xs lg:mt-0 lg:pt-1.5">
        {row.hash ? (
          <span className="inline-flex items-center gap-1 font-mono text-slate-600" title={`SHA-256 ${row.hash}`}>
            <Fingerprint className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            {shortHash(row.hash)}
          </span>
        ) : row.phase === "checking" ? (
          <span className="text-slate-400">hashing…</span>
        ) : blocked ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span className="text-slate-400" title="Web Crypto is unavailable here; the server hashes the bytes on upload.">
            server-side
          </span>
        )}
        {original ? (
          <p className="mt-1 text-amber-800">
            Same bytes as row {original.index + 1}
            <span className="hidden lg:inline"> ({original.row.file.name})</span>
          </p>
        ) : seenBefore ? (
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
          <div className="h-1 w-full max-w-40 overflow-hidden rounded-full bg-slate-200" aria-hidden>
            <div className="h-full rounded-full bg-brand-cyan transition-[width] duration-300" style={{ width: `${row.percent}%` }} />
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
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-brand-cyan-600 ring-1 ring-inset ring-brand-cyan/30 hover:bg-brand-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
          >
            Open
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            onClick={() => context && void intake.retryRow(row.key, context)}
            disabled={!context || intake.running}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-brand-navy ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </button>
        ) : null}
        {canReplace ? (
          <button
            type="button"
            onClick={onReplace}
            disabled={intake.running}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
          >
            <Replace className="h-3.5 w-3.5" aria-hidden />
            Replace
          </button>
        ) : null}
        {row.phase !== "uploading" && row.phase !== "queued" ? (
          <button
            type="button"
            onClick={() => intake.removeRow(row.key)}
            disabled={intake.running}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
            aria-label={`Remove ${row.file.name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </li>
  );
}
