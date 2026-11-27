"use client";

import { Ellipsis, FileDown, MessageCircle, Pencil, Printer } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { errorMessage, renameSubmission, reportPdfUrl } from "@/lib/api";
import type { Result } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtISTDate, studentName } from "../format";
import { useReportView, ViewSwitch } from "../report-view-mode";
import { Menu, type MenuItem } from "./menu";
import { focusRing, linkButton } from "./tokens";

const primaryButton = cn(
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-[#1E40AF] px-3.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#1E3A8A] disabled:cursor-wait disabled:opacity-60 sm:min-h-9",
  focusRing,
);

const secondaryButton = cn(
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 sm:min-h-9",
  focusRing,
);

/**
 * Teacher view: "Rename" (or "Set the student's name" while the sheet only has its file name) opens an
 * inline field; Save stores the name (PATCH /api/submissions/{id}, logged) and reloads the report.
 */
function RenameStudent({
  submission,
  named,
  onRenamed,
}: {
  submission: Result["submission"];
  named: boolean;
  onRenamed?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = `${inputId}-error`;

  function start() {
    setValue(named ? submission.student_name : "");
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = value.replace(/\s+/g, " ").trim();
    if (!next) {
      setError("Enter the student's name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await renameSubmission(submission.id, next);
      setEditing(false);
      onRenamed?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" onClick={start} className={cn(linkButton, "mt-1 print:hidden")}>
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        {named ? "Rename" : "Set the student's name"}
      </button>
    );
  }
  return (
    <form onSubmit={save} className="mt-2 flex flex-wrap items-end gap-2 print:hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
        <label htmlFor={inputId} className="text-xs font-medium text-slate-700">
          Student name
        </label>
        <input
          id={inputId}
          autoFocus
          maxLength={120}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
          aria-required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn("min-h-11 w-full rounded-md border border-slate-300 px-2 text-sm sm:min-h-9", focusRing)}
        />
      </div>
      <button type="submit" disabled={saving} className={primaryButton}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" onClick={() => setEditing(false)} className={secondaryButton}>
        Cancel
      </button>
      {error ? (
        <p id={errorId} role="alert" className="w-full text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** "NEET-A · Mock-07 · 27 Nov 2026 · 156 days to NEET". */
export function reportSubtitle(result: Result): string {
  const meta = result.report_meta;
  const batch = meta.batch;
  const days = result.study_plan.days_to_exam ?? batch.days_to_exam;
  const exam = batch.exam || result.study_plan.exam || "NEET";
  return [
    batch.name,
    batch.exam_type,
    fmtISTDate(meta.executed_at),
    typeof days === "number" && days >= 0 ? `${days} ${days === 1 ? "day" : "days"} to ${exam}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Compact report header: the student's name (never the upload's file name), batch · test · date · days
 * to the exam, then the Student / Teacher view switch, "Download PDF" and a "More" menu (simulated
 * WhatsApp share, print). The band sits on the score card and the release state in the notice under
 * the header, so neither is repeated here. The teacher view can rename the student. An archived version
 * only offers print.
 */
export function CompactHeader({
  result,
  version,
  onWhatsApp,
  onRenamed,
}: {
  result: Result;
  version?: number;
  onWhatsApp: () => void;
  /** After the teacher renames the student: reload the report. */
  onRenamed?: () => void;
}) {
  const { submission } = result;
  const { teacher } = useReportView();
  const name = studentName(submission);
  const archived = version !== undefined;
  const items: MenuItem[] = [
    ...(archived
      ? []
      : [
          {
            key: "whatsapp",
            label: (
              <span>
                Share via WhatsApp <span className="text-xs text-slate-500">(simulated)</span>
              </span>
            ),
            Icon: MessageCircle,
            onSelect: onWhatsApp,
          },
        ]),
    { key: "print", label: "Print", Icon: Printer, onSelect: () => window.print() },
  ];

  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-semibold leading-tight text-[#1E3A8A]">{name ?? "Student report"}</h1>
        <p className="mt-1 text-[13px] text-slate-600">{reportSubtitle(result)}</p>
        {teacher && !name ? (
          <p className="mt-1 text-xs text-slate-600">
            No student name yet: the sheet was saved under its file name ({submission.original_filename}).
          </p>
        ) : null}
        {teacher && !archived ? (
          <RenameStudent submission={submission} named={name !== null} onRenamed={onRenamed} />
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
          {submission.is_demo ? (
            <span className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs text-slate-700 ring-1 ring-inset ring-slate-300">
              Sample record
            </span>
          ) : null}
          {archived ? (
            <span className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs text-slate-700 ring-1 ring-inset ring-slate-300">
              Archived version {version}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">
        <ViewSwitch />
        {archived ? null : (
          <a href={reportPdfUrl(submission.id)} className={primaryButton}>
            <FileDown className="h-4 w-4" aria-hidden />
            <span className="sm:hidden">PDF</span>
            <span className="hidden sm:inline">Download PDF</span>
          </a>
        )}
        <Menu
          label="More actions"
          button={
            <>
              <Ellipsis className="h-4 w-4" aria-hidden />
              More
            </>
          }
          items={items}
        />
      </div>
    </header>
  );
}
