"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, MessageCircle, Printer, RefreshCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { StatusBadge } from "@/components/status-badge";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import {
  errorCode,
  errorMessage,
  getResultVersions,
  reevaluateSubmission,
  reportPdfUrl,
} from "@/lib/api";
import type { ReleaseInfo, Result, ResultVersion, RubricContent, Submission } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { Modal, Notice, btnPrimary, btnSecondary } from "./dialog";
import { fmtIST } from "./format";
import { KeyDraftFields, questionRefs, useKeyDraft } from "./key-draft";
import { ReleaseChip } from "./release-gate";
import { rubricLabel } from "./use-rubric";

export function BackToWorkspace({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={
        className ??
        "inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-brand-cyan-600 transition-colors duration-150 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan print:hidden"
      }
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Back to workspace
    </Link>
  );
}

/** Report metadata as a definition list under the title row. */
function MetaList({
  items,
  children,
}: {
  items: { term: string; value: ReactNode; mono?: boolean; title?: string }[];
  children?: ReactNode;
}) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-slate-200 px-4 py-3 sm:px-6">
      {items.map((it) => (
        <div key={it.term} className="min-w-0 max-w-full">
          <dt className="text-xs text-slate-500">{it.term}</dt>
          <dd title={it.title} className={cn("truncate text-sm text-slate-800", it.mono && "font-mono text-[13px]")}>
            {it.value}
          </dd>
        </div>
      ))}
      {children}
    </dl>
  );
}

const quietTag = "inline-flex items-center rounded-sm border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600";

/** Header used by the status views (pending, processing, review, failed). */
export function ReportHeader({
  submission,
  rubricLabel: label,
  dateLabel,
  showPrint = false,
}: {
  submission: Submission;
  rubricLabel: string;
  dateLabel: string;
  showPrint?: boolean;
}) {
  return (
    <header className="rounded-md border border-slate-200 bg-white">
      <div className="px-4 py-4 sm:px-6 sm:py-5">
        <BackToWorkspace />
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] text-slate-500">Student academic intelligence report</p>
            <h1 className="mt-0.5 break-words text-2xl font-semibold text-brand-navy">
              {submission.student_name || "Unnamed student"}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {submission.is_demo ? <span className={quietTag}>Demo data</span> : null}
            <StatusBadge status={submission.status} />
            {showPrint ? (
              <button type="button" onClick={() => window.print()} className={cn(btnSecondary, "print:hidden")}>
                <Printer className="h-4 w-4" aria-hidden />
                Print
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <MetaList
        items={[
          { term: "Rubric", value: label },
          {
            term: "Source file",
            value: submission.original_filename || "Unknown file",
            mono: true,
            title: submission.original_filename,
          },
          { term: "Date", value: dateLabel },
          { term: "Submission", value: submission.id, mono: true },
        ]}
      />
    </header>
  );
}

export function evaluatedLabel(submission: Submission): string {
  return `Evaluated ${formatDateTime(submission.updated_at)}`;
}

/** Question numbers of a drafted key that the current result does not have, and vice versa. */
function questionDiff(content: RubricContent | null, result: Result): { added: number[]; removed: number[] } {
  if (!content) return { added: [], removed: [] };
  const next = new Set((content.questions ?? []).map((q) => q.question));
  const now = new Set(result.question_evaluations.map((q) => q.question));
  return {
    added: [...next].filter((n) => !now.has(n)).sort((a, b) => a - b),
    removed: [...now].filter((n) => !next.has(n)).sort((a, b) => a - b),
  };
}

function regradeError(err: unknown): string {
  const code = errorCode(err);
  if (code === "ai_not_configured") {
    return "Re-grading a live upload needs a Claude call, but AI is not configured on the server (ai_not_configured).";
  }
  if (code === "invalid_rubric") return `The drafted key cannot be used: ${errorMessage(err)}`;
  if (code === "invalid_state") return "This sheet is no longer completed (it may already be re-grading). Reload the page.";
  return errorMessage(err);
}

/**
 * Re-grade a completed sheet from its stored transcript (no new OCR call): with the same key, or
 * with a key drafted on the fly from the right question paper (+ an optional answer-key file).
 * The drafted key goes inline with the re-grade (POST /reevaluate {rubric}); the API stores it as
 * this sheet's own snapshot, like the one an upload creates. Nothing is picked from a list.
 */
export function RegradeDialog({
  open,
  onClose,
  result,
  onQueued,
}: {
  open: boolean;
  onClose: () => void;
  result: Result;
  onQueued: () => void;
}) {
  const key = useKeyDraft();
  const [busy, setBusy] = useState<"new" | "same" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDemo = result.submission.is_demo;
  const drafted = key.draft?.draft ?? null;
  const diff = questionDiff(drafted, result);
  const locked = busy !== null || key.drafting;

  async function submit(withDraft: boolean) {
    if (withDraft && !drafted) return;
    setBusy(withDraft ? "new" : "same");
    setError(null);
    try {
      // One call: the API validates a drafted key, stores it as this sheet's snapshot and re-grades.
      await reevaluateSubmission(result.submission.id, withDraft && drafted ? { rubric: drafted } : { rubric_id: null });
      onClose();
      onQueued();
    } catch (err) {
      setError(regradeError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Re-grade this sheet"
      description={`${result.submission.student_name} · graded with ${rubricLabel(result.rubric)}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={btnSecondary} onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button type="button" className={btnSecondary} onClick={() => void submit(false)} disabled={locked}>
            <RefreshCcw className={cn("h-4 w-4", busy === "same" && "animate-spin")} aria-hidden />
            {busy === "same" ? "Queuing…" : "Re-grade with the same key"}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void submit(true)} disabled={locked || !drafted}>
            <RefreshCcw className={cn("h-4 w-4", busy === "new" && "animate-spin")} aria-hidden />
            {busy === "new" ? "Queuing…" : "Re-grade with this key"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">
          To grade with another key, upload this sheet&apos;s question paper, and its answer key when the paper has none
          printed. The key is drafted from them and used for this sheet only.
        </p>
        <KeyDraftFields state={key} disabled={busy !== null} />
        {diff.added.length || diff.removed.length ? (
          <Notice tone="warn">
            Question numbers differ from this sheet:
            {diff.added.length ? ` ${questionRefs(diff.added)} not on the stored transcript (graded as not attempted).` : ""}
            {diff.removed.length ? ` ${questionRefs(diff.removed)} dropped.` : ""}
          </Notice>
        ) : null}
        <Notice tone="info">
          The stored transcript is reused: no new vision/OCR call.{" "}
          {isDemo
            ? "This synthetic row is re-graded locally without an AI call."
            : "One live grading call is made (counted in the cost log)."}{" "}
          The current result is archived as a superseded version; the page shows progress until the new result is ready.
        </Notice>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

/** Stored evaluations, newest first. Picking one opens ?version=N; the current one drops the param. */
export function VersionSelect({ submissionId, viewing }: { submissionId: number; viewing?: number }) {
  const router = useRouter();
  const [versions, setVersions] = useState<ResultVersion[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getResultVersions(submissionId)
      .then((list) => {
        if (!cancelled) setVersions(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  if (!versions || versions.length < 2) return null;
  const current = versions.find((v) => v.current)?.version;
  return (
    <div className="print:hidden">
      <dt>
        <label htmlFor="report-version" className="text-xs text-slate-500">
          Version
        </label>
      </dt>
      <dd>
        <select
          id="report-version"
        value={viewing ?? current}
        onChange={(e) => {
          const v = Number(e.target.value);
          router.push(v === current ? `/report/${submissionId}` : `/report/${submissionId}?version=${v}`);
        }}
          className="h-8 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm tabular-nums text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
        >
          {[...versions].reverse().map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · {v.total_score}/{v.total_marks} · {formatDateTime(v.created_at)}
              {v.current ? " (current)" : ""}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
}

/**
 * SAIR header: breadcrumb, student, urgency and release status, run metadata, version picker and
 * the report actions (PDF, simulated WhatsApp, re-grade with the same or another key, print). An archived
 * version (`version` set) only offers print: the other actions act on the current result.
 */
export function SairHeader({
  result,
  release,
  version,
  onWhatsApp,
  onReevaluated,
}: {
  result: Result;
  release: ReleaseInfo;
  version?: number;
  onWhatsApp: () => void;
  onReevaluated: () => void;
}) {
  const [rerunOpen, setRerunOpen] = useState(false);
  const { submission, report_meta: meta } = result;
  const batch = meta.batch;
  return (
    <header className="rounded-md border border-slate-200 bg-white">
      <div className="px-4 py-4 sm:px-6 sm:py-5">
        <nav aria-label="Breadcrumb" className="text-[13px] text-slate-500">
          <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <li>
              <Link
                href="/"
                className="rounded-sm font-medium text-brand-cyan-600 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
              >
                Workspace
              </Link>
            </li>
            <li aria-hidden>/</li>
            <li>{meta.institution.name}</li>
            <li aria-hidden>/</li>
            <li className="text-slate-700">
              {batch.name}
              {batch.exam_type ? ` · ${batch.exam_type}` : ""}
            </li>
          </ol>
        </nav>

        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-slate-500">
              Student academic intelligence report · {submission.input_kind === "voice" ? "voice answer" : "answer sheet"}
            </p>
            <h1 className="mt-0.5 break-words text-2xl font-semibold text-brand-navy">
              {submission.student_name || "Unnamed student"}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <UrgencyBadge urgency={result.urgency} reasons={result.urgency_reasons} />
              <ReleaseChip release={release} />
              {submission.is_demo ? <span className={quietTag}>Synthetic demo record</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">
            {version === undefined ? (
              <>
                <a href={reportPdfUrl(submission.id)} className={btnPrimary}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download PDF
                </a>
                <button type="button" onClick={onWhatsApp} className={btnSecondary}>
                  <MessageCircle className="h-4 w-4" aria-hidden />
                  Send via WhatsApp
                  <span className="text-xs font-normal text-slate-500">(simulated)</span>
                </button>
                <button type="button" onClick={() => setRerunOpen(true)} className={btnSecondary}>
                  <RefreshCcw className="h-4 w-4" aria-hidden />
                  Re-grade…
                </button>
              </>
            ) : null}
            <button type="button" onClick={() => window.print()} className={btnSecondary}>
              <Printer className="h-4 w-4" aria-hidden />
              Print
            </button>
          </div>
        </div>
      </div>

      <MetaList
        items={[
          { term: "Rubric", value: `${rubricLabel(result.rubric)} · ${result.rubric.status}` },
          {
            term: "Source file",
            value: submission.original_filename || "Unknown file",
            mono: true,
            title: submission.original_filename,
          },
          { term: "Executed", value: fmtIST(meta.executed_at) },
          { term: "Run ID", value: meta.run_id, mono: true },
        ]}
      >
        <VersionSelect submissionId={submission.id} viewing={version} />
      </MetaList>
      <RegradeDialog open={rerunOpen} onClose={() => setRerunOpen(false)} result={result} onQueued={onReevaluated} />
    </header>
  );
}
