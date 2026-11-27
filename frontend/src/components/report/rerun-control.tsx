"use client";

import { ChevronRight, Loader2, RefreshCcw } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { errorCode, errorMessage, rerunSubmission } from "@/lib/api";
import type { Submission } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice, btnPrimary, btnSecondary, inputClass } from "./dialog";
import { KeyDraftFields, useKeyDraft } from "./key-draft";

const RERUN_ERRORS: Record<string, string> = {
  upload_missing:
    "The original upload is no longer stored, so the sheet cannot be re-run. Upload it again with its question paper.",
  invalid_state: "This sheet is no longer held or failed (it may already be running). Reload the page.",
  unknown_rubric: "The sheet's answer key no longer exists. Draft the key from its question paper and re-run.",
  ai_not_configured: "A re-run needs AI to read and grade the sheet, but AI is not configured on the server.",
};

function rerunError(err: unknown): string {
  const code = errorCode(err);
  if (code === "invalid_rubric") return `The drafted key cannot be used: ${errorMessage(err)}`;
  if (code && RERUN_ERRORS[code]) return RERUN_ERRORS[code];
  return errorMessage(err);
}

/**
 * Re-run a held or failed sheet: POST /rerun runs the whole pipeline again from the stored upload
 * (the sheet is read again from the start - the stored reading is reused when this exact file was
 * already read with these questions - then the paper check and grading; a voice answer is
 * transcribed and mapped again), either with the same key or with a key
 * drafted on the fly from the right question paper (+ an optional answer-key file) - nothing is
 * picked from a list. `lead` shows it open under the hold reason (another paper, no answers
 * found); otherwise it is a collapsed secondary action. The reviewer name can be shared with the
 * review editor (controlled) or kept here.
 */
export function RerunControl({
  submission,
  onChanged,
  lead = false,
  reviewer: sharedReviewer,
  onReviewerChange,
  className,
}: {
  submission: Submission;
  onChanged: () => void;
  lead?: boolean;
  reviewer?: string;
  onReviewerChange?: (value: string) => void;
  className?: string;
}) {
  const ids = useId();
  const key = useKeyDraft();
  const [ownReviewer, setOwnReviewer] = useState("");
  const [busy, setBusy] = useState<"new" | "same" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewer = sharedReviewer ?? ownReviewer;
  const setReviewer = onReviewerChange ?? setOwnReviewer;
  const drafted = key.draft?.draft ?? null;

  async function rerun(withDraft: boolean) {
    if (withDraft && !drafted) return;
    setBusy(withDraft ? "new" : "same");
    setError(null);
    try {
      await rerunSubmission(submission.id, {
        ...(withDraft && drafted ? { rubric: drafted } : {}),
        reviewer: reviewer.trim() || null,
      });
      onChanged();
    } catch (err) {
      setError(rerunError(err));
    } finally {
      setBusy(null);
    }
  }

  const titleId = `${ids}-title`;
  const locked = busy !== null || key.drafting;
  const title = lead ? "Re-run with the right question paper" : "Re-run with another answer key";

  const body = (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        Upload this sheet&apos;s question paper, and its answer key when the paper has none printed. The key is drafted
        from them and used for this sheet only.
      </p>
      <KeyDraftFields state={key} disabled={busy !== null} />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_auto_auto] sm:items-end">
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-slate-600">Reviewer name (optional)</span>
          <input
            className={cn(inputClass, "h-9 py-0")}
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            maxLength={120}
            placeholder="e.g. Ms. Kavya"
            disabled={busy !== null}
          />
        </label>
        <button
          type="button"
          className={cn(lead ? btnPrimary : btnSecondary, "w-full sm:w-auto")}
          onClick={() => void rerun(true)}
          disabled={locked || !drafted}
          title={drafted ? undefined : "Draft the key from the question paper first"}
        >
          {busy === "new" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCcw className="h-4 w-4" aria-hidden />}
          {busy === "new" ? "Queuing…" : "Re-run with this key"}
        </button>
        <button
          type="button"
          className={cn(btnSecondary, "w-full sm:w-auto")}
          onClick={() => void rerun(false)}
          disabled={locked}
        >
          {busy === "same" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {busy === "same" ? "Queuing…" : "Re-run with the same key"}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        {submission.input_kind === "voice"
          ? "The stored recording is transcribed and mapped again, then graded. Saved transcript corrections are replaced by the new transcript."
          : "The sheet is read again from the start (the stored reading is reused when this exact file was already read with these questions), then the paper check and grading run. Saved transcript corrections are replaced by the new reading."}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );

  if (lead) {
    return (
      <section aria-labelledby={titleId} className={cn("rounded-md border border-slate-200 bg-slate-50 p-3", className)}>
        <h3 id={titleId} className="mb-2 text-sm font-semibold text-brand-navy">
          {title}
        </h3>
        {body}
      </section>
    );
  }
  return (
    <Disclosure className={className} summary={title}>
      {body}
    </Disclosure>
  );
}

function Disclosure({ summary, className, children }: { summary: string; className?: string; children: ReactNode }) {
  return (
    <details className={cn("group", className)}>
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-sm text-sm font-medium text-brand-cyan-600 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 transition-transform duration-150 group-open:rotate-90" aria-hidden />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
