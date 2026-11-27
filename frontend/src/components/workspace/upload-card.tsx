"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RubricDraftWorkbench, RubricSourceControl } from "@/components/rubrics/rubric-source";
import { useRubricSource, type KeyOrigin, type RubricTarget } from "@/components/rubrics/use-rubric-source";
import type { Health, LanguageHint, Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DEFAULT_MAX_PDF_PAGES, DEFAULT_VOICE, MAX_UPLOAD_BYTES, type VoiceSettings } from "./format";
import { BatchStaging } from "./intake/batch-staging";
import { DropZone } from "./intake/drop-zone";
import type { IntakeGate } from "./intake/gate";
import { BatchSelect, LanguageChips } from "./intake/intake-options";
import { SingleSheetPanel, SingleSubmit } from "./intake/single-sheet";
import {
  isVoiceRow,
  NO_KEY_MESSAGE,
  QUEUE_API_NOTE_THRESHOLD,
  UPLOAD_CONCURRENCY,
  useBatchIntake,
  type UploadContext,
} from "./intake/use-batch-intake";
import { useSingleIntake } from "./intake/use-single-intake";
import { rubricQuestionOptions } from "./intake/voice-fields";

type Mode = "single" | "batch";

const MODES: { value: Mode; label: string }[] = [
  { value: "single", label: "Single sheet" },
  { value: "batch", label: "Batch / folder" },
];

interface UploadCardProps {
  health: Health | null;
  /** SHA-256 -> earlier submission (from the queue) for the "seen before / OCR cache" hint. */
  knownHashes: Map<string, Submission>;
  /** The polled queue: this intake's sheets (for "Re-grade with this key"). */
  submissions: Submission[] | null;
  onUploaded: (submission: Submission) => void;
  /** A batch run started: the queue shows the intake-batch banner for this id. */
  onIntakeStarted?: (intakeBatchId: string) => void;
  /** Sheets were queued for a re-grade: refresh the queue. */
  onQueueChanged?: () => void;
}

/**
 * Intake card. Single sheet (one student) or Batch / folder (many files, staged and checked in
 * the browser, uploaded 3 at a time under one intake batch id). Every intake brings its own answer
 * key: the answer key file, the question paper or both (one drop zone), a JSON / text key or pasted
 * text, drafted on the fly and used at once - nothing is picked from a saved list. Sheets sent
 * while the key is still drafted wait in the browser and go the moment it is ready.
 */
export function UploadCard({
  health,
  knownHashes,
  submissions,
  onUploaded,
  onIntakeStarted,
  onQueueChanged,
}: UploadCardProps) {
  const ids = useId();
  const [mode, setMode] = useState<Mode>("single");
  const [languages, setLanguages] = useState<LanguageHint[]>(["en"]);
  const [batchId, setBatchId] = useState<number | null>(null);
  /**
   * Sheets queued in the browser until the answer key is ready: the staged file / rows queued (a
   * file removed or replaced, or a cleared batch, is no longer queued) and the key's hand-edit count.
   */
  const [queuedSingle, setQueuedSingle] = useState<{ file: File; edits: number } | null>(null);
  const [queuedBatch, setQueuedBatch] = useState<{ rows: Set<string>; edits: number } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  /** A queued send is in flight (the effect below must not start it twice). */
  const flushing = useRef(false);

  const maxMb = health?.max_upload_mb && health.max_upload_mb > 0 ? health.max_upload_mb : MAX_UPLOAD_BYTES / (1024 * 1024);
  const maxBytes = Math.round(maxMb * 1024 * 1024);
  const maxPages = health?.max_pdf_pages && health.max_pdf_pages > 0 ? health.max_pdf_pages : DEFAULT_MAX_PDF_PAGES;
  const rubricRef = useRef<HTMLDivElement>(null);
  const ocrCacheEnabled = health?.ocr_cache_enabled ?? false;
  // Voice answers (FR-2.8): unknown health = assume on (the server enforces voice_disabled).
  const voice: VoiceSettings = health
    ? {
        enabled: health.voice_enabled ?? DEFAULT_VOICE.enabled,
        ready: health.voice_ready ?? DEFAULT_VOICE.ready,
        model: health.transcription_model || DEFAULT_VOICE.model,
      }
    : DEFAULT_VOICE;

  const rubric = useRubricSource(submissions, onQueueChanged);
  // Printed papers are compared with the key's snapshot on the server (it exists after the first upload).
  const single = useSingleIntake(onUploaded, maxBytes, voice.enabled, rubric.inspectRubricId);
  const batch = useBatchIntake(maxBytes, voice.enabled, rubric.inspectRubricId);
  // Sheets waiting for another upload to save the key count as busy: the key and options they go
  // with stay as they are until they are sent.
  const busy =
    single.uploading ||
    single.waiting ||
    batch.running ||
    batch.pendingRun ||
    batch.views.some((v) => v.row.phase === "uploading" || v.waiting);
  const regrading = rubric.regrade.running;
  const questions = rubricQuestionOptions(rubric);
  const questionNumbers = questions.map((q) => q.question);
  const voiceStaged = mode === "single" ? single.isVoice : batch.views.some((v) => isVoiceRow(v.row));
  const noKey = rubric.status === "none";

  /**
   * This render's intakes and settings. An upload click can wait for another upload to save the key
   * on the server: when it goes, it runs with these (the latest render), not with the render of the
   * click. The intakes read their rows from refs, so a row is never sent twice.
   */
  const latest = useRef({ single, batch, languages, batchId, questionNumbers, onUploaded, onIntakeStarted });
  useEffect(() => {
    latest.current = { single, batch, languages, batchId, questionNumbers, onUploaded, onIntakeStarted };
  });

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

  /** What one upload sends: the key (snapshot id or inline) with the settings as they are now. */
  function contextFor(target: RubricTarget): UploadContext {
    const now = latest.current;
    return {
      rubricId: target.rubricId,
      rubricHash: target.rubricHash,
      rubricJson: target.rubricJson,
      rubricSourceFile: target.rubricSourceFile,
      rubricKeyFile: target.rubricKeyFile,
      rubricSourceRole: target.rubricSourceRole,
      onRubricCreated: target.created,
      onRubricLost: target.lost,
      languages: now.languages,
      batchId: now.batchId,
      questionNumbers: now.questionNumbers,
      onUploaded: now.onUploaded,
      onIntakeStarted: now.onIntakeStarted,
    };
  }

  /**
   * One upload click. Its sheets show "waiting" at once (their buttons disabled, one click per sheet)
   * until the upload starts - at once, or after another upload saved the key on the server - and it
   * runs with the state of that moment. False when the key is not valid then.
   */
  async function sendHeld(keys: string[], run: boolean, go: (target: RubricTarget) => Promise<unknown>): Promise<boolean> {
    let started = false;
    try {
      return await rubric.upload(async (target) => {
        started = true;
        latest.current.batch.release(keys, run);
        await go(target);
      });
    } finally {
      if (!started) latest.current.batch.release(keys, run);
    }
  }

  /**
   * Send with the key as it is now (the queued flag clears once it goes). False when the key is not
   * valid now - e.g. edited while another upload ran: queued sheets keep waiting. True when there was
   * nothing to send (the sheets already wait for an earlier click).
   */
  async function send(which: Mode): Promise<boolean> {
    if (which === "single") {
      if (!single.hold()) return true;
      let started = false;
      try {
        return await rubric.upload(async (target) => {
          started = true;
          const now = latest.current.single;
          now.release();
          setQueuedSingle(null);
          await now.submit(contextFor(target));
        });
      } finally {
        if (!started) latest.current.single.release();
      }
    }
    const keys = batch.hold("uploadable");
    if (keys.length === 0) return true;
    return sendHeld(keys, true, (target) => {
      setQueuedBatch(null);
      return latest.current.batch.start(contextFor(target));
    });
  }

  /** Upload click: send now when the key is ready, else queue the sheets (and start a draft that is due). */
  function request(which: Mode) {
    setSendError(null);
    if (noKey || regrading) return;
    if (which === "single" ? !single.check() : !batch.check()) return;
    if (rubric.ready) {
      void send(which).then((sent) => {
        if (!sent) setSendError(NO_KEY_MESSAGE);
      });
      return;
    }
    if (which === "single") {
      if (single.file) setQueuedSingle({ file: single.file, edits: rubric.edits });
    } else {
      setQueuedBatch({ rows: new Set(batch.views.filter((v) => v.uploadable).map((v) => v.row.key)), edits: rubric.edits });
    }
    rubric.ensureDraft();
  }

  /** "Retry" on one rejected row, or "Retry rejected" (key null) for the rejected rows not already waiting. */
  async function retry(key: string | null) {
    setSendError(null);
    if (noKey || regrading) return;
    const keys = batch.hold(key === null ? "rejected" : { key });
    if (keys.length === 0) return;
    const sent = await sendHeld(keys, key === null, (target) =>
      key === null
        ? latest.current.batch.start(contextFor(target), true, keys)
        : latest.current.batch.retryRow(key, contextFor(target)),
    );
    if (!sent) setSendError(NO_KEY_MESSAGE);
  }

  const singleWaiting = !!queuedSingle && queuedSingle.file === single.file;
  const batchWaiting = !!queuedBatch && batch.views.some((v) => v.uploadable && queuedBatch.rows.has(v.row.key));
  // Queued before a hand edit made the key valid: they wait for a click, not the keystroke that did it.
  const singleHeld = !!queuedSingle && singleWaiting && rubric.ready && queuedSingle.edits !== rubric.edits;
  const batchHeld = !!queuedBatch && batchWaiting && rubric.ready && queuedBatch.edits !== rubric.edits;

  // Queued sheets go the moment the draft is ready (nothing left to fix), one upload per pass: the
  // next pass sees the key as it is then. The first upload sends the key inline; the server keeps it
  // as this intake's snapshot for the rest.
  useEffect(() => {
    if (!rubric.ready || regrading || flushing.current || busy) return;
    const which: Mode | null = singleWaiting && !singleHeld ? "single" : batchWaiting && !batchHeld ? "batch" : null;
    if (!which) return;
    flushing.current = true;
    void send(which).finally(() => {
      flushing.current = false;
    });
  });

  const blockedReason = noKey
    ? "Add the question paper or the answer key first (Answer key panel) - every upload is graded with its own key."
    : regrading
      ? "The re-grade with this key is being queued - upload when it is done."
      : null;
  const singleGate: IntakeGate = {
    blocked: blockedReason,
    waiting: rubric.ready ? null : rubric.waitingNote,
    queued: singleWaiting && !singleHeld,
    held: singleHeld,
    send: () => request("single"),
    cancel: () => setQueuedSingle(null),
  };
  const batchGate: IntakeGate = {
    blocked: blockedReason,
    waiting: rubric.ready ? null : rubric.waitingNote,
    queued: batchWaiting && !batchHeld,
    held: batchHeld,
    send: () => request("batch"),
    cancel: () => setQueuedBatch(null),
  };

  /** A staged file becomes the answer-key source (a key paper, the printed question paper, or a ticked key copy). */
  function takeFileForKey(file: File, how: KeyOrigin) {
    rubric.draftFromFile(file, { keyFromMarks: how === "ticks", origin: how });
    rubricRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

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
              PDF (up to {maxPages} pages) - printed MCQ papers with ticked options or typed answer sheets, photo/scan
              or Word{voice.enabled ? ", or a voice answer (MP3/WAV/M4A/OGG)" : ""} · max {Math.round(maxMb)} MB per
              file · checked by magic bytes and SHA-256
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
                maxPages={maxPages}
                knownHashes={knownHashes}
                ocrCacheEnabled={ocrCacheEnabled}
                voice={voice}
                questions={questions}
                onUseForKey={takeFileForKey}
                canUseAsPaper={noKey}
              />
            ) : (
              <>
                <DropZone
                  mode="batch"
                  disabled={batch.running}
                  maxMb={Math.round(maxMb)}
                  maxPages={maxPages}
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
                    Printed MCQ papers are graded from the ticked, circled or shaded options. A question paper that
                    carries its own answer key is tagged - use it as the answer key instead of grading it. Once the
                    first sheet is uploaded, a printed paper that is not this key&apos;s paper (or is another code /
                    set of it) is tagged, and held for faculty review on upload unless its answers map to the key.
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
            <div ref={rubricRef} className="scroll-mt-24">
              <RubricSourceControl state={rubric} disabled={busy} />
            </div>
            <LanguageChips value={languages} onChange={setLanguages} disabled={busy} voice={voiceStaged} />
            <BatchSelect value={batchId} onChange={setBatchId} fallback={health?.batch ?? null} disabled={busy} />
            {mode === "single" ? (
              <div className="mt-auto">
                <SingleSubmit intake={single} gate={singleGate} />
              </div>
            ) : (
              <p className="mt-auto text-xs text-slate-500">
                The answer key, answer language and batch apply to every staged sheet. Review the rows below, then
                upload.
              </p>
            )}
            {sendError ? (
              <p className="border-l-2 border-rose-600 pl-3 text-sm text-rose-800" role="alert">
                {sendError}
              </p>
            ) : null}
          </div>
        </div>

        <RubricDraftWorkbench state={rubric} disabled={busy} />

        {mode === "batch" ? (
          <BatchStaging
            intake={batch}
            gate={batchGate}
            keyReady={rubric.ready && !regrading}
            onRetry={(key) => void retry(key)}
            onRetryRejected={() => void retry(null)}
            knownHashes={knownHashes}
            ocrCacheEnabled={ocrCacheEnabled}
            voice={voice}
            questions={questions}
            onUseForKey={takeFileForKey}
            canUseAsPaper={noKey}
          />
        ) : null}
      </div>
    </section>
  );
}
