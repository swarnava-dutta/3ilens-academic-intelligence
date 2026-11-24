"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, Undo2, X, XCircle } from "lucide-react";
import { errorCode, errorMessage, errorStatus, extractAnswerKey } from "@/lib/api";
import type { AnswerKeyExtraction, RubricContent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { applyAnswerKey, keyApplySummary, methodLabel, questionNumbers, type KeyApplyReport } from "./answer-key-apply";

const KEY_EXTENSIONS = [".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".txt"];
export const KEY_FILE_ACCEPT =
  ".pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp,text/plain";
const MAX_PASTE_CHARS = 100_000;
/** Changed keys listed with their old and new option. */
const CHANGES_SHOWN = 12;

const primaryBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-brand-navy px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";
const fieldClass =
  "block w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";
const fileInputClass = cn(
  "block w-full cursor-pointer rounded-md border border-slate-300 bg-white text-sm text-slate-500 transition-colors duration-150 hover:border-slate-400",
  "file:mr-3 file:cursor-pointer file:border-0 file:border-r file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-navy",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:cursor-not-allowed disabled:opacity-60",
);

type KeySource = "file" | "text";

const SOURCES: { value: KeySource; label: string }[] = [
  { value: "file", label: "File" },
  { value: "text", label: "Paste text" },
];

interface AppliedKey {
  report: KeyApplyReport;
  extraction: AnswerKeyExtraction;
  /** File name, or null for pasted text. */
  fileName: string | null;
  /** Content before the import (Undo) and right after it (to tell later edits apart). */
  previous: RubricContent;
  applied: RubricContent;
  /** Questions keyed from files before this import (restored by Undo). */
  keyedBefore: number[];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function isKeyFileName(name: string): boolean {
  return KEY_EXTENSIONS.includes(extensionOf(name));
}

/** Friendly text for POST /api/rubrics/answer-key failures. */
export function answerKeyErrorMessage(err: unknown): string {
  const code = errorCode(err);
  const status = errorStatus(err);
  if (code === "no_answer_key") {
    return 'No answer key was found. Use a table such as "1-2, 2-4" or "Q1 (B)", a "Que. / Ans." grid, or a question paper with "Ans." lines.';
  }
  if (code === "empty_rubric_source") {
    return "No readable text was found. Paste the key as text, or upload a clearer scan.";
  }
  if (code === "corrupt_pdf") return "That PDF could not be opened (it may be damaged). Export it again or paste the key as text.";
  if (code === "password_pdf") return "That PDF is password-protected. Remove the password, or paste the key as text.";
  if (code === "ai_not_configured" || status === 503) {
    return "This key has to be read from the page images, which needs the Anthropic key in .env (ANTHROPIC_API_KEY). Paste the key as text instead.";
  }
  if (status === 413) return "That file is over the upload limit. Upload only the answer-key pages, or paste the key as text.";
  if (status === 415) return "Use a PDF, Word (.docx), image (PNG, JPG, WEBP) or text file for the answer key.";
  if (status === 502) return `The page images could not be read (${errorMessage(err)}). Try again, or paste the key as text.`;
  if (!code && (status === 404 || status === 405)) {
    return "Answer-key import is not available on this API build yet. Set the keys in the table instead.";
  }
  if ((err as { code?: unknown } | null)?.code === "ECONNABORTED") {
    return "Reading the key took longer than 10 minutes. Upload only the answer-key pages, or paste the key as text.";
  }
  return errorMessage(err);
}

/** 75 -> "1:15". */
function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * "Apply answer key from file" in the rubric editor: a key-only file (PDF, Word, image, text) or
 * pasted text is read by POST /api/rubrics/answer-key and applied here to the MCQs by question
 * number, with a summary of what changed and a one-step Undo. Nothing is saved until faculty save
 * the rubric.
 */
export function AnswerKeyImport({
  value,
  onChange,
  onKeyed,
  keyed = [],
  disabled,
}: {
  value: RubricContent;
  onChange: (next: RubricContent) => void;
  /** All question numbers keyed from answer-key files so far (this import added; Undo restores the list before it). */
  onKeyed?: (questions: number[]) => void;
  /** Question numbers keyed from earlier imports. */
  keyed?: number[];
  disabled?: boolean;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<KeySource>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedKey | null>(null);
  const [undone, setUndone] = useState(false);
  // The key is applied to the content as it is when the reply arrives (faculty may keep editing
  // while a scan is read), and dropped when the editor has gone (draft discarded or replaced).
  const latest = useRef(value);
  const alive = useRef(true);

  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(
      () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000))),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);

  function chooseFile(next: File | null) {
    setError(null);
    if (next && !isKeyFileName(next.name)) {
      setFile(null);
      setError(`"${next.name}" is not a PDF, Word (.docx), image (PNG, JPG, WEBP) or text (.txt) file.`);
      return;
    }
    setFile(next);
  }

  async function run() {
    if (busy) return;
    setError(null);
    setUndone(false);
    let input: { file?: File; text?: string };
    if (source === "file") {
      if (!file) {
        setError("Choose the answer-key file (PDF, Word, image or text).");
        return;
      }
      if (file.size === 0) {
        setError(`"${file.name}" is empty.`);
        return;
      }
      input = { file };
    } else {
      const pasted = text.trim();
      if (pasted.length < 3) {
        setError('Paste the answer key, e.g. "1-2, 2-4, 3-1" or "Q1 (B)".');
        return;
      }
      input = { text: pasted };
    }

    const fileName = source === "file" ? (file?.name ?? null) : null;
    setBusy(true);
    setElapsed(0);
    setStartedAt(Date.now());
    try {
      const extraction = await extractAnswerKey(input);
      if (!alive.current) return;
      if (!extraction.entries?.length) {
        setError('No answer-key entries were found. Use a table such as "1-2, 2-4", a "Que. / Ans." grid, or a paper with "Ans." lines.');
        return;
      }
      const previous = latest.current;
      const result = applyAnswerKey(previous, extraction);
      onChange(result.content);
      const keyedBefore = keyed;
      onKeyed?.([...new Set([...keyedBefore, ...result.report.keyed])].sort((a, b) => a - b));
      setApplied({ report: result.report, extraction, fileName, previous, applied: result.content, keyedBefore });
      setOpen(false);
      setFile(null);
      setText("");
    } catch (err) {
      if (alive.current) setError(answerKeyErrorMessage(err));
    } finally {
      if (alive.current) {
        setBusy(false);
        setStartedAt(null);
      }
    }
  }

  function undo() {
    if (!applied) return;
    onChange(applied.previous);
    onKeyed?.(applied.keyedBefore);
    setApplied(null);
    setUndone(true);
  }

  const editedSince = !!applied && value !== applied.applied;

  return (
    <section aria-labelledby={`${ids}-title`} className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-60">
          <h4 id={`${ids}-title`} className="text-sm font-medium text-brand-navy">
            Answer key from a separate file
          </h4>
          <p className="text-xs text-slate-500">
            A key-only file sets the MCQ answers by question number: a table such as &ldquo;1-2, 2-4&rdquo;, a
            &ldquo;Que. / Ans.&rdquo; grid, or a question paper with &ldquo;Ans.&rdquo; lines.
          </p>
        </div>
        {!open && !busy ? (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setUndone(false);
            }}
            disabled={disabled}
            className={secondaryBtn}
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
            Apply answer key from file
          </button>
        ) : null}
      </div>

      {open || busy ? (
        <div className="mt-3 space-y-2">
          <div
            role="radiogroup"
            aria-label="Answer key source"
            className="inline-flex rounded-md border border-slate-300 bg-white p-0.5"
          >
            {SOURCES.map((option) => {
              const active = source === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  onClick={() => {
                    setSource(option.value);
                    setError(null);
                  }}
                  className={cn(
                    "inline-flex h-7 items-center rounded-sm px-3 text-xs font-medium transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60",
                    active ? "bg-brand-navy text-white" : "text-slate-600 hover:bg-slate-50 hover:text-brand-navy",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {source === "file" ? (
            file ? (
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                <p className="min-w-0 flex-1 truncate text-sm text-slate-800" title={file.name}>
                  {file.name}
                </p>
                <button
                  type="button"
                  onClick={() => chooseFile(null)}
                  disabled={busy}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <>
                <label htmlFor={`${ids}-file`} className="sr-only">
                  Answer-key file (PDF, Word, image or text)
                </label>
                <input
                  id={`${ids}-file`}
                  type="file"
                  accept={KEY_FILE_ACCEPT}
                  disabled={busy || disabled}
                  onChange={(e) => {
                    chooseFile(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                  className={fileInputClass}
                />
                <p className="text-xs text-slate-500">PDF, image, Word or text. A scan is read from its page images.</p>
              </>
            )
          ) : (
            <>
              <label htmlFor={`${ids}-text`} className="sr-only">
                Answer key text
              </label>
              <textarea
                id={`${ids}-text`}
                rows={4}
                value={text}
                maxLength={MAX_PASTE_CHARS}
                disabled={busy || disabled}
                onChange={(e) => setText(e.target.value)}
                placeholder={"1-2, 2-4, 3-1, 4-3 …\nor\nQue.  1  2  3  4\nAns.  2  4  1  3"}
                className={cn(fieldClass, "resize-y font-mono text-xs")}
              />
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void run()} disabled={busy || disabled} className={primaryBtn}>
              {busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : null}
              {busy ? "Reading the key…" : "Read and apply the key"}
            </button>
            {!busy ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                className={secondaryBtn}
              >
                Cancel
              </button>
            ) : null}
          </div>
          {busy ? (
            <p className="flex items-center gap-1.5 text-xs text-slate-600" role="status" aria-live="polite">
              <Loader2 className="h-3.5 w-3.5 shrink-0 text-brand-cyan motion-safe:animate-spin" aria-hidden />
              <span>
                A typed key takes seconds; a scan is read from its page images and can take a few minutes.{" "}
                <span className="tabular-nums text-slate-500">{formatElapsed(elapsed)} elapsed</span>
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-rose-700" role="alert">
          <XCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}

      <div aria-live="polite">
        {applied ? (
          <AppliedSummary applied={applied} editedSince={editedSince} disabled={disabled} onUndo={undo} onDismiss={() => setApplied(null)} />
        ) : undone ? (
          <p className="mt-2 text-xs text-slate-600">Answer key import undone.</p>
        ) : null}
      </div>
    </section>
  );
}

function AppliedSummary({
  applied,
  editedSince,
  disabled,
  onUndo,
  onDismiss,
}: {
  applied: AppliedKey;
  editedSince: boolean;
  disabled?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { report, extraction, fileName } = applied;
  const changes = report.changed.slice(0, CHANGES_SHOWN);
  const warnings = extraction.warnings ?? [];
  return (
    <div className="mt-3 border-l-2 border-brand-cyan pl-3" role="status">
      <p className="text-sm font-medium text-slate-800">{keyApplySummary(report)}</p>
      <p className="mt-0.5 break-words text-xs text-slate-500">
        Key {methodLabel(extraction.method)}
        {fileName ? ` of ${fileName}` : " you pasted"} - {extraction.entries.length}{" "}
        {extraction.entries.length === 1 ? "entry" : "entries"}.
        {extraction.method === "ai" ? " Check the changed keys against the paper before saving." : ""}
      </p>
      {changes.length ? (
        <p className="mt-1 break-words text-xs text-slate-600">
          Changed:{" "}
          {changes.map((c) => `Q${c.question} ${c.from} → ${c.to}`).join(" · ")}
          {report.changed.length > CHANGES_SHOWN ? ` · +${report.changed.length - CHANGES_SHOWN} more` : ""}
        </p>
      ) : null}
      {report.notInRubric.length ? (
        <p className="mt-1 break-words text-xs text-slate-500">
          Not in this rubric: {questionNumbers(report.notInRubric, 10)}.
        </p>
      ) : null}
      {report.stillMissing.length ? (
        <p className="mt-1 break-words text-xs text-amber-800">
          Still without a key: {questionNumbers(report.stillMissing, 10)} - set them in the table.
        </p>
      ) : null}
      {report.paperCode.filled ? (
        <p className="mt-1 break-words text-xs text-slate-600">
          Paper code / set filled in from the key: {report.paperCode.key}.
        </p>
      ) : report.paperCode.differs ? (
        <p className="mt-1 flex items-start gap-1.5 break-words text-xs text-amber-800">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
          <span className="min-w-0">
            The key is printed for {report.paperCode.key}; this rubric is {report.paperCode.rubric}. Another code / set
            numbers the same questions differently - check it is this paper&apos;s key.
          </span>
        </p>
      ) : null}
      {warnings.length ? (
        <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
              <span className="min-w-0 break-words">{w}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onUndo} disabled={disabled} className={secondaryBtn}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
          Undo
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
        >
          Keep and close
        </button>
        {editedSince ? <span className="text-xs text-slate-500">Undo also reverts the edits made since.</span> : null}
      </div>
    </div>
  );
}
