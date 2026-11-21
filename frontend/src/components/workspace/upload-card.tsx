"use client";

import { useEffect, useId, useState } from "react";
import { CloudUpload, FileStack, FolderOpen, Gauge, Info, Upload } from "lucide-react";
import { RubricDraftWorkbench, RubricSourceControl } from "@/components/rubrics/rubric-source";
import { useRubricSource } from "@/components/rubrics/use-rubric-source";
import type { Health, LanguageHint, Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MAX_UPLOAD_BYTES } from "./format";
import { BatchStaging } from "./intake/batch-staging";
import { DropZone } from "./intake/drop-zone";
import { BatchSelect, LanguageChips } from "./intake/intake-options";
import { SingleSheetPanel, SingleSubmit } from "./intake/single-sheet";
import { QUEUE_API_NOTE_THRESHOLD, UPLOAD_CONCURRENCY, useBatchIntake, type UploadContext } from "./intake/use-batch-intake";
import { useSingleIntake } from "./intake/use-single-intake";

type Mode = "single" | "batch";

const MODES: { value: Mode; label: string; Icon: typeof Upload }[] = [
  { value: "single", label: "Single sheet", Icon: Upload },
  { value: "batch", label: "Batch / folder", Icon: FolderOpen },
];

interface UploadCardProps {
  /** Whether the last health check reached the API (used to retry loading rubrics). */
  apiOnline: boolean;
  health: Health | null;
  /** SHA-256 -> earlier submission (from the queue) for the "seen before / OCR cache" hint. */
  knownHashes: Map<string, Submission>;
  onUploaded: (submission: Submission) => void;
  /** A batch run started: the queue shows the intake-batch banner for this id. */
  onIntakeStarted?: (intakeBatchId: string) => void;
}

/**
 * Intake card. Single sheet (one student) or Batch / folder (many files, staged and checked in
 * the browser, uploaded 3 at a time under one intake batch id). Rubric, answer language and batch
 * apply to everything uploaded from here.
 */
export function UploadCard({ apiOnline, health, knownHashes, onUploaded, onIntakeStarted }: UploadCardProps) {
  const ids = useId();
  const [mode, setMode] = useState<Mode>("single");
  const [languages, setLanguages] = useState<LanguageHint[]>(["en"]);
  const [batchId, setBatchId] = useState<number | null>(null);

  const maxMb = health?.max_upload_mb && health.max_upload_mb > 0 ? health.max_upload_mb : MAX_UPLOAD_BYTES / (1024 * 1024);
  const maxBytes = Math.round(maxMb * 1024 * 1024);
  const ocrCacheEnabled = health?.ocr_cache_enabled ?? false;

  const rubric = useRubricSource(apiOnline);
  const single = useSingleIntake(onUploaded, maxBytes);
  const batch = useBatchIntake(maxBytes);
  const busy = single.uploading || batch.running;

  // A file dropped just outside the drop zone must not make the browser navigate away from the demo.
  useEffect(() => {
    const preventFileNavigation = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  const settings = {
    rubricId: rubric.choice?.rubricId,
    rubricJson: rubric.choice?.rubricJson,
    languages,
    batchId,
  };
  const batchContext: UploadContext | null = rubric.choice
    ? { ...settings, onUploaded, onIntakeStarted }
    : null;

  return (
    <section
      id="upload"
      aria-labelledby={`${ids}-title`}
      className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-cyan-50 text-brand-cyan">
            <CloudUpload className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 id={`${ids}-title`} className="text-lg font-semibold text-brand-navy">
              Answer sheet intake
            </h2>
            <p className="text-sm text-slate-500">
              PDF (up to 10 pages), photo/scan or Word · max {Math.round(maxMb)} MB per file · checked by magic bytes and
              SHA-256
            </p>
          </div>
        </div>
        <div role="radiogroup" aria-label="Intake mode" className="inline-flex shrink-0 rounded-xl bg-slate-100 p-1">
          {MODES.map(({ value, label, Icon }) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => setMode(value)}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60",
                  active ? "bg-white text-brand-navy shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-brand-navy",
                )}
              >
                <Icon className={cn("h-4 w-4", active ? "text-brand-cyan" : "text-slate-400")} aria-hidden />
                {label}
                {value === "batch" && batch.views.length > 0 ? (
                  <span className="rounded-full bg-brand-cyan-50 px-1.5 text-xs tabular-nums text-brand-cyan-600">
                    {batch.views.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-6 p-5 sm:p-6">
        <div className="grid gap-6 lg:grid-cols-5">
          {/* ---------------- Files ---------------- */}
          <div className="min-w-0 space-y-3 lg:col-span-3">
            {mode === "single" ? (
              <SingleSheetPanel
                intake={single}
                maxMb={Math.round(maxMb)}
                knownHashes={knownHashes}
                ocrCacheEnabled={ocrCacheEnabled}
              />
            ) : (
              <>
                <DropZone
                  mode="batch"
                  disabled={batch.running}
                  maxMb={Math.round(maxMb)}
                  hintId={`${ids}-batch-hint`}
                  onFiles={(files) => void batch.addFiles(files)}
                />
                <ul className="space-y-1.5 text-xs text-slate-500">
                  <li className="flex items-start gap-1.5">
                    <FileStack className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                    Each file becomes one student row: the name comes from the file name
                    (&ldquo;answer_sheet_aarav_sharma.png&rdquo; &rarr; Aarav Sharma) or its sub-folder. Non-answer files
                    (notes.txt, Thumbs.db) are listed as skipped.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Gauge className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                    Uploads {UPLOAD_CONCURRENCY} at a time under one intake batch; a rejected file never blocks the
                    rest. Target: 50 sheets processed in 30 min.
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                    Above {QUEUE_API_NOTE_THRESHOLD} files production uses the queue API; this PoC uploads from the
                    browser.
                  </li>
                </ul>
              </>
            )}
          </div>

          {/* ---------------- Settings shared by both modes ---------------- */}
          <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
            <RubricSourceControl state={rubric} disabled={busy} />
            <LanguageChips value={languages} onChange={setLanguages} disabled={busy} />
            <BatchSelect value={batchId} onChange={setBatchId} fallback={health?.batch ?? null} disabled={busy} />
            {mode === "single" ? (
              <div className="mt-auto">
                <SingleSubmit intake={single} settings={settings} />
              </div>
            ) : (
              <p className="mt-auto rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
                Rubric, answer language and batch apply to every staged sheet. Review the rows below, then upload.
              </p>
            )}
          </div>
        </div>

        <RubricDraftWorkbench state={rubric} disabled={busy} />

        {mode === "batch" ? (
          <BatchStaging
            intake={batch}
            context={batchContext}
            knownHashes={knownHashes}
            ocrCacheEnabled={ocrCacheEnabled}
          />
        ) : null}
      </div>
    </section>
  );
}
