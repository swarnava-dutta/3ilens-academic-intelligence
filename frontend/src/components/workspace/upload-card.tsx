"use client";

import { useEffect, useId, useState } from "react";
import { RubricDraftWorkbench, RubricSourceControl } from "@/components/rubrics/rubric-source";
import { useRubricSource } from "@/components/rubrics/use-rubric-source";
import type { Health, LanguageHint, Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DEFAULT_VOICE, MAX_UPLOAD_BYTES, type VoiceSettings } from "./format";
import { BatchStaging } from "./intake/batch-staging";
import { DropZone } from "./intake/drop-zone";
import { BatchSelect, LanguageChips } from "./intake/intake-options";
import { SingleSheetPanel, SingleSubmit } from "./intake/single-sheet";
import { QUEUE_API_NOTE_THRESHOLD, UPLOAD_CONCURRENCY, useBatchIntake, type UploadContext } from "./intake/use-batch-intake";
import { isVoiceRow } from "./intake/use-batch-intake";
import { useSingleIntake } from "./intake/use-single-intake";
import { rubricQuestionOptions } from "./intake/voice-fields";

type Mode = "single" | "batch";

const MODES: { value: Mode; label: string }[] = [
  { value: "single", label: "Single sheet" },
  { value: "batch", label: "Batch / folder" },
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
  // Voice answers (FR-2.8): unknown health = assume on (the server enforces voice_disabled).
  const voice: VoiceSettings = health
    ? {
        enabled: health.voice_enabled ?? DEFAULT_VOICE.enabled,
        ready: health.voice_ready ?? DEFAULT_VOICE.ready,
        model: health.transcription_model || DEFAULT_VOICE.model,
      }
    : DEFAULT_VOICE;

  const rubric = useRubricSource(apiOnline);
  const single = useSingleIntake(onUploaded, maxBytes, voice.enabled);
  const batch = useBatchIntake(maxBytes, voice.enabled);
  const busy = single.uploading || batch.running;
  const questions = rubricQuestionOptions(rubric);
  const questionNumbers = questions.map((q) => q.question);
  const voiceStaged = mode === "single" ? single.isVoice : batch.views.some((v) => isVoiceRow(v.row));

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
    questionNumbers,
  };
  const batchContext: UploadContext | null = rubric.choice
    ? { ...settings, onUploaded, onIntakeStarted }
    : null;

  return (
    <section
      id="upload"
      aria-labelledby={`${ids}-title`}
      className="scroll-mt-24 rounded-md border border-slate-200 bg-white"
    >
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex items-start gap-3">
          <div>
            <h2 id={`${ids}-title`} className="text-base font-semibold text-brand-navy">
              Answer sheet intake
            </h2>
            <p className="text-xs text-slate-500">
              PDF (up to 10 pages), photo/scan or Word{voice.enabled ? ", or a voice answer (MP3/WAV/M4A/OGG)" : ""} ·
              max {Math.round(maxMb)} MB per file · checked by magic bytes and SHA-256
            </p>
          </div>
        </div>
        <div role="radiogroup" aria-label="Intake mode" className="inline-flex shrink-0 rounded-md border border-slate-300 bg-white p-0.5">
          {MODES.map(({ value, label }) => {
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
                  "inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-sm font-medium transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60",
                  active ? "bg-brand-navy text-white" : "text-slate-600 hover:bg-slate-50 hover:text-brand-navy",
                )}
              >
                {label}
                {value === "batch" && batch.views.length > 0 ? (
                  <span className={cn("text-xs tabular-nums", active ? "text-white/80" : "text-slate-500")}>
                    {batch.views.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-6 p-4 sm:p-5">
        <div className="grid gap-6 lg:grid-cols-5">
          {/* ---------------- Files ---------------- */}
          <div className="min-w-0 space-y-3 lg:col-span-3">
            {mode === "single" ? (
              <SingleSheetPanel
                intake={single}
                maxMb={Math.round(maxMb)}
                knownHashes={knownHashes}
                ocrCacheEnabled={ocrCacheEnabled}
                voice={voice}
                questions={questions}
              />
            ) : (
              <>
                <DropZone
                  mode="batch"
                  disabled={batch.running}
                  maxMb={Math.round(maxMb)}
                  voiceEnabled={voice.enabled}
                  hintId={`${ids}-batch-hint`}
                  onFiles={(files) => void batch.addFiles(files)}
                />
                <ul className="list-disc space-y-1 pl-4 text-xs text-slate-500">
                  <li>
                    Each file becomes one student row: the name comes from the file name
                    (&ldquo;answer_sheet_aarav_sharma.png&rdquo; &rarr; Aarav Sharma) or its sub-folder. Non-answer files
                    (notes.txt, Thumbs.db) are listed as skipped.
                  </li>
                  <li>
                    Uploads {UPLOAD_CONCURRENCY} at a time under one intake batch; a rejected file never blocks the
                    rest. Target: 50 sheets processed in 30 min.
                  </li>
                  <li>
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
            <LanguageChips value={languages} onChange={setLanguages} disabled={busy} voice={voiceStaged} />
            <BatchSelect value={batchId} onChange={setBatchId} fallback={health?.batch ?? null} disabled={busy} />
            {mode === "single" ? (
              <div className="mt-auto">
                <SingleSubmit intake={single} settings={settings} />
              </div>
            ) : (
              <p className="mt-auto text-xs text-slate-500">
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
            voice={voice}
            questions={questions}
          />
        ) : null}
      </div>
    </section>
  );
}
