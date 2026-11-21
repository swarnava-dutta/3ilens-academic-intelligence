"use client";

import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  CalendarClock,
  Download,
  FileText,
  GraduationCap,
  Hash,
  MessageCircle,
  Printer,
  RefreshCcw,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { StatusBadge } from "@/components/status-badge";
import { UrgencyBadge } from "@/components/shared/urgency-badge";
import { errorCode, errorMessage, getRubrics, reevaluateSubmission, reportPdfUrl } from "@/lib/api";
import type { ReleaseInfo, Result, Rubric, Submission } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { Modal, Notice, btnPrimary, btnSecondary, inputClass } from "./dialog";
import { fmtIST } from "./format";
import { ReleaseChip } from "./release-gate";
import { rubricLabel } from "./use-rubric";

function MetaChip({ icon: Icon, children, title }: { icon: typeof Hash; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-100 ring-1 ring-inset ring-white/15"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-brand-cyan" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function BackToWorkspace({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={
        className ??
        "inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-cyan-100 transition hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan print:hidden"
      }
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Back to workspace
    </Link>
  );
}

function Glow() {
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand-cyan/30 blur-3xl print:hidden" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 left-1/3 h-56 w-56 rounded-full bg-brand-lime/20 blur-3xl print:hidden" />
    </>
  );
}

/** Navy hero header used by the status views (pending, processing, review, failed). */
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
    <header className="relative overflow-hidden rounded-2xl bg-brand-navy p-5 text-white shadow-sm [print-color-adjust:exact] sm:p-8">
      <Glow />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackToWorkspace />
          {showPrint ? (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white ring-1 ring-inset ring-white/20 transition hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan print:hidden"
            >
              <Printer className="h-4 w-4" aria-hidden />
              Print report
            </button>
          ) : null}
        </div>

        <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-cyan">
              <GraduationCap className="h-4 w-4" aria-hidden />
              Student Academic Intelligence Report
            </p>
            <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight sm:text-4xl">
              {submission.student_name || "Unnamed student"}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {submission.is_demo ? (
              <span className="inline-flex items-center rounded-full bg-brand-lime px-3 py-1 text-xs font-semibold text-brand-navy">
                Demo data
              </span>
            ) : null}
            <StatusBadge status={submission.status} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <MetaChip icon={BookOpen}>{label}</MetaChip>
          <MetaChip icon={FileText} title={submission.original_filename}>
            {submission.original_filename || "Unknown file"}
          </MetaChip>
          <MetaChip icon={CalendarClock}>{dateLabel}</MetaChip>
          <MetaChip icon={Hash}>Submission {submission.id}</MetaChip>
        </div>
      </div>
    </header>
  );
}

export function evaluatedLabel(submission: Submission): string {
  return `Evaluated ${formatDateTime(submission.updated_at)}`;
}

const heroBtn =
  "inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

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
      eyebrow="FR-5.7 · re-run without OCR"
      title="Re-run with rubric…"
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

/**
 * SAIR header: breadcrumb, title, the student's urgency and release status, and the report actions
 * (PDF, simulated WhatsApp, re-run with another rubric, print).
 */
export function SairHeader({
  result,
  release,
  onWhatsApp,
  onReevaluated,
}: {
  result: Result;
  release: ReleaseInfo;
  onWhatsApp: () => void;
  onReevaluated: () => void;
}) {
  const [rerunOpen, setRerunOpen] = useState(false);
  const { submission, report_meta: meta } = result;
  const batch = meta.batch;
  return (
    <header className="relative overflow-hidden rounded-2xl bg-brand-navy p-5 text-white shadow-sm [print-color-adjust:exact] sm:p-8 print:rounded-none print:p-5">
      <Glow />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Breadcrumb" className="min-w-0 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-100/90">
            <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <li>3i Academic Intelligence</li>
              <li aria-hidden className="text-white/40">/</li>
              <li>{meta.institution.name}</li>
              <li aria-hidden className="text-white/40">/</li>
              <li className="text-brand-cyan">
                {batch.name}
                {batch.exam_type ? ` · ${batch.exam_type}` : ""}
              </li>
            </ol>
          </nav>
          <BackToWorkspace />
        </div>

        <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand-cyan">
              <GraduationCap className="h-4 w-4" aria-hidden />
              Student Academic Intelligence Report
            </p>
            <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight sm:text-4xl">
              {submission.student_name || "Unnamed student"}
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Question-linked academic diagnostic from the uploaded{" "}
              {submission.input_kind === "voice" ? "voice answer" : "answer sheet"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {submission.is_demo ? (
              <span className="inline-flex items-center rounded-full bg-brand-lime px-3 py-1 text-xs font-semibold text-brand-navy">
                Synthetic demo record
              </span>
            ) : null}
            <UrgencyBadge urgency={result.urgency} reasons={result.urgency_reasons} />
            <ReleaseChip release={release} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <MetaChip icon={BookOpen}>
            {rubricLabel(result.rubric)} · {result.rubric.status}
          </MetaChip>
          <MetaChip icon={FileText} title={submission.original_filename}>
            {submission.original_filename || "Unknown file"}
          </MetaChip>
          <MetaChip icon={CalendarClock}>Executed {fmtIST(meta.executed_at)}</MetaChip>
          <MetaChip icon={Hash}>{meta.run_id}</MetaChip>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 print:hidden">
          <a href={reportPdfUrl(submission.id)} className={cn(heroBtn, "bg-brand-cyan text-brand-navy hover:bg-cyan-300")}>
            <Download className="h-4 w-4" aria-hidden />
            Download PDF
          </a>
          <button type="button" onClick={onWhatsApp} className={cn(heroBtn, "bg-white/10 text-white ring-1 ring-inset ring-white/20 hover:bg-white/20")}>
            <MessageCircle className="h-4 w-4" aria-hidden />
            Send via WhatsApp
            <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold uppercase text-amber-950">Simulated</span>
          </button>
          <button
            type="button"
            onClick={() => setRerunOpen(true)}
            className={cn(heroBtn, "bg-white/10 text-white ring-1 ring-inset ring-white/20 hover:bg-white/20")}
          >
            <RefreshCcw className="h-4 w-4" aria-hidden />
            Re-run with rubric…
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className={cn(heroBtn, "bg-white/10 text-white ring-1 ring-inset ring-white/20 hover:bg-white/20")}
          >
            <Printer className="h-4 w-4" aria-hidden />
            Print
          </button>
        </div>
      </div>
      <RerunDialog open={rerunOpen} onClose={() => setRerunOpen(false)} result={result} onQueued={onReevaluated} />
    </header>
  );
}
