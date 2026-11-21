"use client";

/* eslint-disable @next/next/no-img-element -- page scans come from the FastAPI backend (another origin); next/image adds nothing here. */

import { Camera, CheckCircle2, Loader2, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  errorCode,
  errorMessage,
  errorStatus,
  getOcrReview,
  pageImageUrl,
  rescanSubmission,
  submitOcrReview,
} from "@/lib/api";
import type { OcrReviewData, PageRef, Submission } from "@/lib/types";
import { cn, formatConfidence } from "@/lib/utils";
import { Notice, btnAmber, btnPrimary, btnSecondary, inputClass } from "./dialog";
import { fmtIST } from "./format";
import { Pill } from "./primitives";
import { UncertainText } from "./uncertain-text";
import { VoiceAnswerPanel, voiceInfoFromSubmission } from "./voice-answer";

type LoadState = { kind: "loading" } | { kind: "ready"; data: OcrReviewData } | { kind: "error"; message: string };

const REVIEW_ERRORS: Record<string, string> = {
  no_transcript: "There is no OCR transcript to approve: type the answers and save them as corrections, or request a rescan.",
  invalid_question: "One of the corrected question numbers is not on the rubric.",
  invalid_state: "This sheet is no longer waiting for review (it may already be grading). Reload the page.",
  input_kind_mismatch: "A voice answer can only be replaced by audio, and a written sheet only by a document.",
};

function reviewError(err: unknown): string {
  const code = errorCode(err);
  return (code && REVIEW_ERRORS[code]) || errorMessage(err);
}

function PagePanel({ id, data }: { id: number; data: OcrReviewData }) {
  const pages: PageRef[] = [...data.pages].sort((a, b) => a.page_number - b.page_number);
  const flagged = new Set(data.flagged_pages);
  const conf = new Map(data.page_confidences.map((p) => [p.page, p.confidence]));
  const firstFlagged = pages.find((p) => flagged.has(p.page_number))?.page_number;
  const [current, setCurrent] = useState<number>(firstFlagged ?? pages[0]?.page_number ?? 1);
  const page = pages.find((p) => p.page_number === current) ?? pages[0];

  if (!page) {
    return (
      <div className="grid h-full min-h-48 place-items-center p-6 text-center text-sm text-slate-600">
        No page images were stored for this sheet.
      </div>
    );
  }
  const c = conf.get(page.page_number);
  return (
    <div className="min-w-0">
      <ol className="flex flex-wrap gap-1.5" aria-label="Pages">
        {pages.map((p) => {
          const isFlagged = flagged.has(p.page_number);
          const pc = conf.get(p.page_number);
          return (
            <li key={p.page_number}>
              <button
                type="button"
                aria-current={p.page_number === page.page_number ? "page" : undefined}
                onClick={() => setCurrent(p.page_number)}
                className={cn(
                  "min-h-8 rounded-sm border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan",
                  p.page_number === page.page_number
                    ? "border-brand-navy bg-brand-navy text-white"
                    : isFlagged
                      ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                p. {p.page_number}
                {pc !== undefined ? ` · ${formatConfidence(pc)}` : ""}
                {isFlagged ? " · flagged" : ""}
              </button>
            </li>
          );
        })}
      </ol>
      <div
        className={cn(
          "mt-2 overflow-hidden rounded-md border bg-white",
          flagged.has(page.page_number) ? "border-amber-400" : "border-slate-200",
        )}
      >
        <img
          key={page.page_number}
          src={pageImageUrl(id, page.page_number)}
          alt={`Answer sheet page ${page.page_number}`}
          className="mx-auto max-h-[70vh] w-full object-contain"
        />
      </div>
      <p className={cn("mt-1 text-xs tabular-nums", flagged.has(page.page_number) ? "text-amber-800" : "text-slate-500")}>
        Page {page.page_number}: legibility {c === undefined ? "not recorded" : formatConfidence(c)} (threshold{" "}
        {Math.round(data.threshold * 100)}%){flagged.has(page.page_number) ? " - below the threshold" : ""}.
      </p>
    </div>
  );
}

/**
 * Faculty OCR review (FR-2.4): page images on the left, the per-question transcript on the right.
 * Approve the transcript as-is, save corrections, or request a rescan; grading follows.
 */
export function ReviewEditor({ submission, onChanged }: { submission: Submission; onChanged: () => void }) {
  const id = submission.id;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "correct" | "rescan">(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getOcrReview(id)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            errorStatus(err) === 404
              ? "The review editor needs GET /api/submissions/{id}/ocr, which this backend does not serve yet."
              : errorMessage(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the transcript and page images…
      </p>
    );
  }
  if (state.kind === "error") return <Notice tone="warn">{state.message}</Notice>;

  const data = state.data;
  const answers = [...data.answers].sort((a, b) => a.question - b.question);
  const changed = answers.filter((a) => edits[a.question] !== undefined && edits[a.question] !== a.answer);
  const name = reviewer.trim();

  async function submit(action: "approve" | "correct") {
    if (!name) {
      setError("Enter the reviewer's name.");
      return;
    }
    setBusy(action);
    setError(null);
    try {
      await submitOcrReview(id, {
        reviewer: name,
        action,
        answers: action === "correct" ? changed.map((a) => ({ question: a.question, answer: edits[a.question] ?? "" })) : [],
        note: note.trim() ? note.trim() : null,
      });
      onChanged();
    } catch (err) {
      setError(reviewError(err));
    } finally {
      setBusy(null);
    }
  }

  async function rescan(file: File) {
    setBusy("rescan");
    setError(null);
    setProgress(0);
    try {
      await rescanSubmission(id, file, setProgress);
      onChanged();
    } catch (err) {
      setError(reviewError(err));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <h3 className="text-[15px] font-semibold text-brand-navy">Faculty transcript review</h3>
        <span className="text-xs tabular-nums text-slate-500">Threshold {Math.round(data.threshold * 100)}% (any page below it)</span>
        {data.flagged_pages.length ? (
          <Pill className="bg-amber-50 text-amber-900">Flagged page(s) {data.flagged_pages.join(", ")}</Pill>
        ) : null}
        {!data.has_transcript ? (
          <Pill className="bg-rose-50 text-rose-700">No OCR transcript (vision call skipped)</Pill>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200 bg-white p-3">
          {submission.input_kind === "voice" ? (
            <VoiceAnswerPanel submissionId={id} voice={voiceInfoFromSubmission(submission)} isDemo={submission.is_demo} />
          ) : (
            <PagePanel id={id} data={data} />
          )}
        </div>

        <div className="min-w-0 space-y-3 rounded-md border border-slate-200 bg-white p-3">
          {answers.length === 0 ? (
            <p className="text-sm text-slate-600">No rubric questions were returned for this sheet.</p>
          ) : (
            <ol className="max-h-[70vh] divide-y divide-slate-200 overflow-y-auto pr-1">
              {answers.map((a) => {
                const value = edits[a.question] ?? a.answer;
                const low = a.confidence !== null && a.confidence < data.threshold;
                return (
                  <li key={a.question} className="py-3 first:pt-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold tabular-nums text-slate-500">Q{a.question}</span>
                      <span className="text-sm font-medium text-slate-800">{a.topic}</span>
                      <span
                        className={cn(
                          "ml-auto rounded-sm px-1.5 py-0.5 text-xs font-medium tabular-nums",
                          low ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600",
                        )}
                      >
                        OCR {formatConfidence(a.confidence)}
                      </span>
                      {a.source_pages.length ? <span className="text-xs tabular-nums text-slate-500">p. {a.source_pages.join(", ")}</span> : null}
                    </div>
                    {a.prompt ? <p className="mt-1 text-xs text-slate-500">{a.prompt}</p> : null}
                    {a.uncertain_words.length && a.answer ? (
                      <p className="mt-2 whitespace-pre-wrap rounded-sm bg-slate-50 px-2 py-1.5 text-sm leading-normal text-slate-700">
                        <UncertainText text={a.answer} words={a.uncertain_words} />
                      </p>
                    ) : null}
                    <label className="mt-2 block">
                      <span className="sr-only">Answer to question {a.question}</span>
                      <textarea
                        className={cn(inputClass, "min-h-20", value !== a.answer && "border-brand-cyan-600 bg-brand-cyan-50")}
                        value={value}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [a.question]: e.target.value }))}
                        placeholder={data.has_transcript ? "Blank (not attempted)" : "Type the student's answer from the page"}
                      />
                    </label>
                    {value !== a.answer ? (
                      <button
                        type="button"
                        className="mt-1 rounded-sm text-xs font-medium text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                        onClick={() =>
                          setEdits((prev) => {
                            const next = { ...prev };
                            delete next[a.question];
                            return next;
                          })
                        }
                      >
                        Undo correction
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Reviewer name</span>
              <input className={inputClass} value={reviewer} onChange={(e) => setReviewer(e.target.value)} maxLength={120} placeholder="e.g. Ms. Kavya" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Note (optional)</span>
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </label>
          </div>

          {error ? <Notice tone="error">{error}</Notice> : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={busy !== null || !data.has_transcript || !name || changed.length > 0}
              title={
                !data.has_transcript
                  ? "No OCR transcript to approve"
                  : changed.length
                    ? "You have corrections: save them instead"
                    : undefined
              }
              onClick={() => void submit("approve")}
            >
              {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
              Approve &amp; grade
            </button>
            <button
              type="button"
              className={btnAmber}
              disabled={busy !== null || changed.length === 0 || !name}
              onClick={() => void submit("correct")}
            >
              {busy === "correct" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
              Save corrections &amp; grade{changed.length ? ` (${changed.length})` : ""}
            </button>
            <button type="button" className={btnSecondary} disabled={busy !== null} onClick={() => fileRef.current?.click()}>
              {busy === "rescan" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />}
              {busy === "rescan" && progress !== null ? `Uploading ${progress}%` : "Request rescan"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={
                submission.input_kind === "voice"
                  ? ".mp3,.wav,.m4a,.ogg,audio/*"
                  : ".pdf,.jpg,.jpeg,.png,.webp,.docx,application/pdf,image/jpeg,image/png,image/webp"
              }
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void rescan(file);
              }}
            />
          </div>
          <p className="text-xs text-slate-500">
            Approve or correct sends the transcript to rubric grading (one model call). A rescan replaces the file and runs OCR again.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-3">
        <h3 className="text-sm font-semibold text-brand-navy">Review history</h3>
        {data.reviews.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No review actions yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-1 text-sm text-slate-700">
            {[...data.reviews]
              .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
              .map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-slate-900">{r.reviewer}</span>
                  <span>{r.action}</span>
                  {r.changed_questions.length ? <span>Q{r.changed_questions.join(", Q")}</span> : null}
                  <span className="text-xs tabular-nums text-slate-500">{fmtIST(r.created_at)}</span>
                  {r.note ? <span className="w-full text-xs text-slate-500">{r.note}</span> : null}
                </li>
              ))}
          </ul>
        )}
      </div>
      {!data.has_transcript ? (
        <p className="text-xs text-amber-900">
          The sheet was routed to review before any vision call, so there is no OCR transcript to approve.
        </p>
      ) : null}
    </div>
  );
}
