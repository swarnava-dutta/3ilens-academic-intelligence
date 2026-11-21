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
  getRubrics,
  reevaluateSubmission,
  reportPdfUrl,
} from "@/lib/api";
import type { ReleaseInfo, Result, ResultVersion, Rubric, Submission } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { Modal, Notice, btnPrimary, btnSecondary, inputClass } from "./dialog";
import { fmtIST } from "./format";
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
function MetaList({ items }: { items: { term: string; value: ReactNode; mono?: boolean; title?: string }[] }) {
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

/** Question numbers of a rubric that the current result does not have, and vice versa. */
function questionDiff(rubric: Rubric | undefined, result: Result): { added: number[]; removed: number[] } {
  if (!rubric) return { added: [], removed: [] };
  const next = new Set((rubric.content?.questions ?? []).map((q) => q.question));
  const now = new Set(result.question_evaluations.map((q) => q.question));
  return {
    added: [...next].filter((n) => !now.has(n)).sort((a, b) => a - b),
    removed: [...now].filter((n) => !next.has(n)).sort((a, b) => a - b),
  };
}

function RerunDialog({
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
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number>(result.rubric.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDemo = result.submission.is_demo;

  // Load the rubric list the first time the dialog opens.
  useEffect(() => {
    if (!open || rubrics !== null) return;
    let cancelled = false;
    getRubrics()
      .then((list) => {
        if (!cancelled) setRubrics(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, rubrics]);

  const rubric = rubrics?.find((r) => r.id === selected);
  const diff = questionDiff(rubric, result);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await reevaluateSubmission(result.submission.id, { rubric_id: selected });
      onClose();
      onQueued();
    } catch (err) {
      const code = errorCode(err);
      setError(
        code === "ai_not_configured"
          ? "Re-grading a live upload needs a Claude call, but AI is not configured on the server (ai_not_configured)."
          : code === "unknown_rubric"
            ? "That rubric no longer exists (unknown_rubric)."
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Re-run with another rubric"
      description={`${result.submission.student_name} · currently ${rubricLabel(result.rubric)}`}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} onClick={submit} disabled={busy || !rubrics || !rubric}>
            <RefreshCcw className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden />
            {busy ? "Queuing…" : "Re-run evaluation"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {loadError ? <Notice tone="error">Could not load rubrics: {loadError}</Notice> : null}
        <label className="block">
          <span className="mb-1 block font-medium text-slate-700">Rubric</span>
          <select
            className={inputClass}
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            disabled={!rubrics}
          >
            {!rubrics ? <option value={selected}>Loading rubrics…</option> : null}
            {(rubrics ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {rubricLabel(r)} · {r.total_marks} marks · {r.status}
                {r.id === result.rubric.id ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        {rubric && rubric.change_note ? <p className="text-xs text-slate-500">Change note: {rubric.change_note}</p> : null}
        {diff.added.length || diff.removed.length ? (
          <Notice tone="warn">
            Question numbers differ from this sheet:
            {diff.added.length ? ` Q${diff.added.join(", Q")} not on the stored transcript (graded as not attempted).` : ""}
            {diff.removed.length ? ` Q${diff.removed.join(", Q")} dropped.` : ""}
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
function VersionSelect({ submissionId, viewing }: { submissionId: number; viewing?: number }) {
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
    <label className="inline-flex items-center gap-2 text-[13px] text-slate-500">
      Version
      <select
        value={viewing ?? current}
        onChange={(e) => {
          const v = Number(e.target.value);
          router.push(v === current ? `/report/${submissionId}` : `/report/${submissionId}?version=${v}`);
        }}
        className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm tabular-nums text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
      >
        {[...versions].reverse().map((v) => (
          <option key={v.version} value={v.version}>
            v{v.version} · {v.total_score}/{v.total_marks} · {formatDateTime(v.created_at)}
            {v.current ? " (current)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * SAIR header: breadcrumb, student, urgency and release status, run metadata, version picker and
 * the report actions (PDF, simulated WhatsApp, re-run with another rubric, print). An archived
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
          <div className="min-w-0">
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
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <VersionSelect submissionId={submission.id} viewing={version} />
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
                  Re-run…
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
          ...(version !== undefined ? [{ term: "Version", value: `${version} (archived)` }] : []),
        ]}
      />
      <RerunDialog open={rerunOpen} onClose={() => setRerunOpen(false)} result={result} onQueued={onReevaluated} />
    </header>
  );
}
