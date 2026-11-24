"use client";

import { FileText, Loader2 } from "lucide-react";
import type { PaperInspection } from "@/lib/types";
import { cn } from "@/lib/utils";
import { answerKeyLine, printedPaperLine } from "./paper";

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
  /** Hand the file to the rubric source and start drafting (null hides the drafting actions). */
  onDraftRubric: ((options?: { keyFromMarks?: boolean }) => void) | null;
  onDismiss: () => void;
}

/**
 * Under the staged file in single-sheet mode: what the document looks like. An answer-key paper
 * is steered to rubric drafting; a printed MCQ paper is graded from the student's ticks. Answer
 * sheets and unknown files show nothing.
 */
export function PaperNotice({ inspection, inspecting, dismissed, disabled, onDraftRubric, onDismiss }: PaperNoticeProps) {
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
          {onDraftRubric ? (
            <button type="button" onClick={() => onDraftRubric()} disabled={disabled} className={primaryBtn}>
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Draft rubric from this paper
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
          {printedPaperLine(inspection)} Ticked, circled or shaded options are read as the student&apos;s answers; pick
          this paper&apos;s answer-key rubric.
        </p>
        {/* The server reads ticks only from PDF page images (key_source=marks is ignored for DOCX). */}
        {onDraftRubric && inspection.file_type === "pdf" ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => onDraftRubric({ keyFromMarks: true })}
              disabled={disabled}
              className={secondaryBtn}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Use the ticks as the answer key
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return null;
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
