"use client";

import { CheckCircle2, FileText, Loader2 } from "lucide-react";
import type { KeyOrigin } from "@/components/rubrics/use-rubric-source";
import type { PaperInspection, RubricMatch } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  answerKeyLine,
  codesDiffer,
  codesLine,
  matchExamples,
  matchHoldNote,
  matchLine,
  matchMessage,
  printedPaperLine,
  shownMatch,
} from "./paper";

const primaryBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-brand-navy px-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";

interface PaperNoticeProps {
  inspection: PaperInspection | null;
  inspecting: boolean;
  /** Faculty chose "Upload as a student sheet anyway" for an answer-key paper. */
  dismissed: boolean;
  disabled?: boolean;
  /**
   * Make the file the intake's answer-key source and start drafting: "key" (a paper with its own
   * key), "paper" (the question paper - the sheet stays staged) or "ticks" (the ticks are the key).
   * Null hides these actions.
   */
  onUseForKey: ((how: KeyOrigin) => void) | null;
  /** No answer key yet: offer "Use as the question paper" for a printed paper. */
  canUseAsPaper?: boolean;
  onDismiss: () => void;
}

/**
 * Under the staged file in single-sheet mode: what the document looks like. An answer-key paper
 * is steered to the answer key; a printed MCQ paper is graded from the student's ticks and can also
 * be the intake's question paper. Answer sheets and unknown files show nothing.
 */
export function PaperNotice({
  inspection,
  inspecting,
  dismissed,
  disabled,
  onUseForKey,
  canUseAsPaper = false,
  onDismiss,
}: PaperNoticeProps) {
  if (inspecting && !inspection) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-slate-500" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        Reading the document&apos;s printed text…
      </p>
    );
  }
  if (!inspection) return null;

  if (inspection.role === "answer_key_paper" && !dismissed) {
    return (
      <div className="rounded-md border border-amber-300 bg-white p-3" role="status" aria-live="polite">
        <div className="flex items-start gap-2">
          <span className="mt-px inline-flex shrink-0 items-center rounded-sm bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">
            Answer key paper
          </span>
          <PaperMeta inspection={inspection} />
        </div>
        <p className="mt-2 text-sm text-slate-800">
          {answerKeyLine(inspection)} This is not a student&apos;s sheet.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {onUseForKey ? (
            <button type="button" onClick={() => onUseForKey("key")} disabled={disabled} className={primaryBtn}>
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Use as the answer key
            </button>
          ) : null}
          <button type="button" onClick={onDismiss} disabled={disabled} className={secondaryBtn}>
            Upload as a student sheet anyway
          </button>
        </div>
      </div>
    );
  }

  if (inspection.role === "question_paper") {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-3" role="status" aria-live="polite">
        <div className="flex items-start gap-2">
          <span className="mt-px inline-flex shrink-0 items-center rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
            Printed MCQ paper
          </span>
          <PaperMeta inspection={inspection} />
        </div>
        <p className="mt-2 text-sm text-slate-800">
          {printedPaperLine(inspection)} Ticked, circled or shaded options are read as the student&apos;s answers.
          {canUseAsPaper
            ? " No answer key yet: use this paper as the question paper (it stays staged as this student's sheet) and drop its answer key into the Answer key box too."
            : ""}
        </p>
        {onUseForKey ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {canUseAsPaper ? (
              <button type="button" onClick={() => onUseForKey("paper")} disabled={disabled} className={primaryBtn}>
                <FileText className="h-3.5 w-3.5" aria-hidden />
                Use as the question paper
              </button>
            ) : null}
            {/* The server reads ticks only from PDF page images (key_source=marks is ignored for DOCX). */}
            {inspection.file_type === "pdf" ? (
              <button
                type="button"
                onClick={() => onUseForKey("ticks")}
                disabled={disabled}
                className={secondaryBtn}
                title="A teacher's marked copy: the ticked options become the answer key (the file is not graded)"
              >
                <FileText className="h-3.5 w-3.5" aria-hidden />
                Use the ticks as the answer key
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}

/**
 * Under the staged file: how its printed questions compare with the intake's answer key (once its
 * snapshot exists on the server, i.e. after the first upload). The same
 * paper gets one quiet line; another code / set (same questions, other numbers) an amber warning;
 * a different paper (or the wrong rubric for it) a rose one. Never blocks the upload; the server
 * checks such a PDF or Word file again (`held`, paper.mismatchHeld) and holds it for faculty review
 * unless its answers map to the key (a paper far larger than the key is held either way).
 * Unknown (too little printed text) shows nothing.
 */
export function RubricMatchNotice({
  match,
  checking,
  held = false,
}: {
  match: RubricMatch | null;
  checking?: boolean;
  /** The server checks this file on upload and holds a mismatch unless its answers map (paper.mismatchHeld). */
  held?: boolean;
}) {
  const shown = shownMatch(match);
  if (checking && !shown) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-slate-500" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        Comparing the printed questions with the answer key in use…
      </p>
    );
  }
  if (!shown) return null;

  if (shown.verdict === "match") {
    return (
      <div className="space-y-0.5 text-xs" role="status" aria-live="polite">
        <p className="flex items-start gap-1.5 text-slate-600">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-brand-lime-600" aria-hidden />
          <span className="min-w-0">{matchLine(shown)}</span>
        </p>
        {codesDiffer(shown) ? (
          <p className="pl-5 text-amber-800">
            The printed code ({shown.sheet_code}) differs from the answer key&apos;s ({shown.rubric_code}) - check
            the version.
          </p>
        ) : null}
      </div>
    );
  }

  const mismatch = shown.verdict === "mismatch";
  const codes = codesLine(shown);
  const examples = matchExamples(shown);
  return (
    <div
      className={cn("rounded-md border bg-white p-3", mismatch ? "border-rose-300" : "border-amber-300")}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span
          className={cn(
            "mt-px inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-xs font-medium",
            mismatch ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800",
          )}
        >
          {mismatch ? "Different paper" : "Other code / set"}
        </span>
        {codes ? <p className="min-w-0 break-words pt-0.5 text-xs text-slate-500">{codes}</p> : null}
      </div>
      {mismatch ? <p className="mt-2 text-sm font-medium text-rose-800">Doesn&apos;t match the answer key in use</p> : null}
      <p className={cn("break-words text-sm text-slate-800", mismatch ? "mt-0.5" : "mt-2")}>{matchMessage(shown)}</p>
      {examples.length ? (
        <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
          {examples.map((example, i) => (
            <li key={i} className="break-words">
              {example}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-slate-600">
        {mismatch
          ? "Grade it in its own intake, with its own question paper and key. "
          : "Grade it in its own intake, with the key for this code / set. "}
        {matchHoldNote(shown, held)}
      </p>
    </div>
  );
}

/** Title and section headings when the text layer has them ("NEET (UG) 2025 · Physics"). */
function PaperMeta({ inspection }: { inspection: PaperInspection }) {
  const parts = [inspection.title, inspection.subjects.join(", ")].filter((p): p is string => !!p && !!p.trim());
  if (!parts.length) return null;
  return (
    <p className={cn("min-w-0 break-words pt-0.5 text-xs text-slate-500")} title={parts.join(" · ")}>
      {parts.join(" · ")}
    </p>
  );
}
