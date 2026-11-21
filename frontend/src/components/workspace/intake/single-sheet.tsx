"use client";

import Link from "next/link";
import { useId } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cloud,
  FileText,
  Fingerprint,
  Info,
  Loader2,
  Send,
  X,
  XCircle,
} from "lucide-react";
import type { Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fileKindLabel, formatBytes, MULTIPART_THRESHOLD_BYTES, shortHash } from "../format";
import { DropZone } from "./drop-zone";
import type { SingleIntake, SingleUploadSettings } from "./use-single-intake";

const inputClass =
  "block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm placeholder:text-slate-400 transition-colors focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

/** Left column of single-sheet mode: drop zone, attached-file chip with custody hash, name + roll no. */
export function SingleSheetPanel({
  intake,
  maxMb,
  knownHashes,
  ocrCacheEnabled,
}: {
  intake: SingleIntake;
  maxMb: number;
  knownHashes: Map<string, Submission>;
  ocrCacheEnabled: boolean;
}) {
  const ids = useId();
  const { file } = intake;
  const isBlurryDemo = file !== null && /blurry/i.test(file.name);
  const seenBefore = intake.hash ? (knownHashes.get(intake.hash) ?? null) : null;
  const nameId = `${ids}-student`;
  const rollId = `${ids}-roll`;

  return (
    <div className="space-y-4">
      <DropZone
        mode="single"
        disabled={intake.uploading}
        hasFile={file !== null}
        error={intake.fileMessage?.tone === "error"}
        maxMb={maxMb}
        hintId={`${ids}-hint`}
        onFiles={(files, meta) => {
          const first = files[0];
          if (!first) return;
          const note =
            files.length > 1
              ? `Only one answer sheet per student in this mode - using "${first.file.name}". Switch to Batch / folder for several.`
              : meta.hadFolder
                ? `A folder was dropped - using "${first.file.name}". Switch to Batch / folder to stage every file.`
                : undefined;
          void intake.chooseFile(first.file, note);
        }}
      />

      {file ? (
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          {intake.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img src={intake.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-slate-200" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-brand-cyan-50 text-brand-cyan">
              <FileText className="h-6 w-6" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-800" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-slate-500">
              {fileKindLabel(file)} · {formatBytes(file.size)}
              {intake.signature?.kind ? ` · bytes: ${intake.signature.kind.toUpperCase()}` : ""}
            </p>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
              <Fingerprint className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              {intake.checking ? (
                <span>Checking signature and hashing…</span>
              ) : intake.hash ? (
                <span className="font-mono" title={`SHA-256 ${intake.hash}`}>
                  SHA-256 {shortHash(intake.hash, 12)}
                </span>
              ) : (
                <span title="Web Crypto is unavailable here; the server hashes the bytes on upload.">
                  Custody hash taken by the server
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={intake.clearFile}
            disabled={intake.uploading}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
            aria-label={`Remove ${file.name}`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {file && file.size > MULTIPART_THRESHOLD_BYTES ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs text-sky-800 ring-1 ring-inset ring-sky-200">
          <Cloud className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Production: S3 presigned multipart (resumable). PoC: single streamed upload
        </p>
      ) : null}
      {intake.signature?.warning ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-800">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
          {intake.signature.warning}
        </p>
      ) : null}
      {seenBefore ? (
        <p className="flex items-start gap-1.5 text-xs text-slate-600">
          <Info className="mt-px h-3.5 w-3.5 shrink-0 text-brand-cyan" aria-hidden />
          Same bytes as #{seenBefore.id} ({seenBefore.student_name}).
          {ocrCacheEnabled ? " OCR cache can reuse it: no vision call (Rs 0.00)." : ""}
        </p>
      ) : null}

      {intake.fileMessage?.tone === "error" ? (
        <p className="flex items-start gap-2 text-sm text-rose-700" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
          {intake.fileMessage.text}
        </p>
      ) : intake.fileMessage?.tone === "info" ? (
        <p className="flex items-start gap-2 text-sm text-slate-600">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-cyan" aria-hidden />
          {intake.fileMessage.text}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="space-y-1.5">
          <label htmlFor={nameId} className="text-sm font-medium text-slate-700">
            Student name <span className="text-rose-500" aria-hidden>*</span>
          </label>
          <input
            id={nameId}
            type="text"
            required
            maxLength={120}
            autoComplete="off"
            placeholder="e.g. Aisha Verma"
            value={intake.studentName}
            disabled={intake.uploading}
            aria-invalid={intake.nameError ? true : undefined}
            aria-describedby={intake.nameError ? `${nameId}-error` : undefined}
            onChange={(e) => intake.setStudentName(e.target.value)}
            className={cn(inputClass, intake.nameError && "border-rose-300 focus:border-rose-400 focus:ring-rose-200")}
          />
          {intake.nameError ? (
            <p id={`${nameId}-error`} className="text-sm text-rose-700">
              {intake.nameError}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={rollId} className="text-sm font-medium text-slate-700">
            Roll no <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id={rollId}
            type="text"
            maxLength={40}
            autoComplete="off"
            placeholder="e.g. NA-0412"
            value={intake.rollNo}
            disabled={intake.uploading}
            onChange={(e) => intake.setRollNo(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <p className="-mt-2 text-xs text-slate-500">
        The roll no links this student&apos;s tests over time; without it the name is used.
      </p>

      {isBlurryDemo ? (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            <span className="font-semibold">Human-review demo:</span> this file name contains &ldquo;blurry&rdquo;, so
            OCR confidence is set to 65% (below the 70% gate) and the sheet is held for faculty review before any AI
            call.
          </span>
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          Tip: a file name containing <span className="font-medium text-slate-700">&ldquo;blurry&rdquo;</span> demos the
          low-confidence human-review path (works without AI keys).
        </p>
      )}
    </div>
  );
}

/** Right-column submit button, progress and result notice for single-sheet mode. */
export function SingleSubmit({
  intake,
  settings,
}: {
  intake: SingleIntake;
  settings: SingleUploadSettings;
}) {
  const { uploading, progress, notice } = intake;
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => void intake.submit(settings)}
        disabled={uploading || intake.checking}
        className={cn(
          "relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors",
          "bg-brand-cyan hover:bg-brand-cyan-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2",
          "disabled:cursor-wait disabled:bg-brand-cyan-600",
        )}
      >
        {uploading ? (
          <span
            className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-300"
            style={{ width: `${progress}%` }}
            aria-hidden
          />
        ) : null}
        <span className="relative flex items-center gap-2">
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {progress < 100 ? `Uploading… ${progress}%` : "Validating & queuing…"}
            </>
          ) : intake.checking ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking the file…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden />
              Upload &amp; start AI evaluation
            </>
          )}
        </span>
      </button>
      {uploading ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="h-full rounded-full bg-brand-lime transition-[width] duration-300" style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      <div aria-live="polite">
        {notice?.kind === "success" ? (
          <p className="flex items-start gap-2 rounded-xl bg-brand-lime-50 px-3 py-2.5 text-sm font-medium text-brand-navy ring-1 ring-inset ring-brand-lime/50">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-lime-600" aria-hidden />
            <span className="min-w-0">
              {notice.message}
              {notice.submission ? (
                <Link
                  href={`/report/${notice.submission.id}`}
                  className="ml-2 inline-flex items-center gap-1 font-semibold text-brand-cyan-600 hover:underline"
                >
                  Follow it
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              ) : null}
            </span>
          </p>
        ) : notice?.kind === "error" ? (
          <p
            className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-800 ring-1 ring-inset ring-rose-200"
            role="alert"
          >
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
            {notice.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
