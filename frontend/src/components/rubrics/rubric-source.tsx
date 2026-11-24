"use client";

import { useId, useRef } from "react";
import { CheckCircle2, Download, Loader2, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { RubricDraftEditor } from "./rubric-draft-editor";
import { downloadJson, normalizeContent, rubricLabel, rubricStatusLabel, validateContent } from "./rubric-utils";
import { isPdfFile, type RubricMode, type RubricSourceState } from "./use-rubric-source";

const MODES: { value: RubricMode; label: string }[] = [
  { value: "saved", label: "Saved" },
  { value: "paste", label: "Paste text" },
  { value: "upload", label: "PDF/DOCX" },
  { value: "json", label: "JSON" },
];

const inputClass =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

const fileInputClass = cn(
  "block w-full cursor-pointer rounded-md border border-slate-300 bg-white text-sm text-slate-500 transition-colors duration-150 hover:border-slate-400",
  "file:mr-3 file:cursor-pointer file:border-0 file:border-r file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-navy",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:cursor-not-allowed disabled:opacity-60",
);

function TemplateButton({ state }: { state: RubricSourceState }) {
  const rubric = state.selectedRubric;
  if (!rubric) return null;
  return (
    <button
      type="button"
      onClick={() => downloadJson(rubric.content, "rubric-template.json")}
      className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-cyan-600 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
    >
      <Download className="h-3.5 w-3.5" aria-hidden />
      Template
    </button>
  );
}

/** Rubric picker for the intake form: segmented Saved | Paste text | Upload PDF/DOCX | JSON. */
export function RubricSourceControl({ state, disabled }: { state: RubricSourceState; disabled?: boolean }) {
  const ids = useId();
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const { mode, rubrics, selectedRubric } = state;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span id={`${ids}-label`} className="text-sm font-medium text-slate-700">
          Rubric
        </span>
        {mode === "saved" || mode === "json" ? <TemplateButton state={state} /> : null}
      </div>

      <div
        role="radiogroup"
        aria-labelledby={`${ids}-label`}
        className="grid grid-cols-4 gap-0.5 rounded-md border border-slate-300 bg-white p-0.5"
      >
        {MODES.map(({ value, label }) => {
          const active = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => state.setMode(value)}
              className={cn(
                "flex h-8 min-w-0 items-center justify-center rounded-sm px-1 text-xs font-medium transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60",
                active ? "bg-brand-navy text-white" : "text-slate-600 hover:bg-slate-50 hover:text-brand-navy",
              )}
            >
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>

      {mode === "saved" ? (
        <div className="space-y-1.5">
          <label htmlFor={`${ids}-select`} className="sr-only">
            Saved rubric
          </label>
          <select
            id={`${ids}-select`}
            value={selectedRubric?.id ?? ""}
            disabled={disabled || !rubrics || rubrics.length === 0}
            onChange={(e) => state.selectRubric(Number(e.target.value))}
            className={cn(inputClass, "appearance-auto pr-8")}
          >
            {!rubrics && <option value="">{state.rubricsError ? "Rubrics unavailable" : "Loading rubrics…"}</option>}
            {rubrics?.length === 0 && <option value="">No rubrics seeded</option>}
            {rubrics?.map((r) => (
              <option key={r.id} value={r.id}>
                {rubricLabel(r)}
              </option>
            ))}
          </select>
          {state.rubricsError && !rubrics ? (
            <p className="text-xs text-rose-700">{state.rubricsError}</p>
          ) : selectedRubric ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>
                {selectedRubric.content?.questions?.length ?? 0} questions · {selectedRubric.content?.subject ?? "—"}
              </span>
              <span
                className={cn(
                  "rounded-sm px-1.5 py-0.5 text-xs font-medium",
                  selectedRubric.status === "FACULTY_APPROVED"
                    ? "bg-brand-lime-50 text-lime-800"
                    : "bg-slate-100 text-slate-600",
                )}
              >
                {rubricStatusLabel(selectedRubric.status)}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === "paste" ? (
        <div className="space-y-2">
          <label htmlFor={`${ids}-paste`} className="sr-only">
            Question paper and marking scheme text
          </label>
          <textarea
            id={`${ids}-paste`}
            rows={6}
            value={state.pasteText}
            disabled={disabled || state.parsing}
            onChange={(e) => state.setPasteText(e.target.value)}
            placeholder={"Q1. Explain incomplete dominance with an example. (5 marks)\nMarking: definition 2, example 2, ratio 1\n\nQ2. …"}
            className={cn(inputClass, "resize-y font-mono text-xs")}
          />
          <ParseControls state={state} disabled={disabled} ids={ids} />
        </div>
      ) : null}

      {mode === "upload" ? (
        <div className="space-y-2">
          <label htmlFor={`${ids}-paper`} className="sr-only">
            Question paper or marking scheme (PDF or DOCX)
          </label>
          {state.sourceFile ? (
            <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-3">
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800" title={state.sourceFile.name}>
                {state.sourceFile.name}
              </p>
              <button
                type="button"
                onClick={() => state.setSourceFile(null)}
                disabled={disabled || state.parsing}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
                aria-label="Remove the question paper"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <input
              id={`${ids}-paper`}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={disabled || state.parsing}
              onChange={(e) => {
                state.setSourceFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              className={fileInputClass}
            />
          )}
          {state.sourceFile ? <MarkedKeyOption state={state} disabled={disabled} file={state.sourceFile} /> : null}
          <ParseControls state={state} disabled={disabled} ids={ids} />
        </div>
      ) : null}

      {mode === "json" ? (
        <div className="space-y-1.5">
          {state.custom ? (
            <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-brand-navy" title={state.custom.fileName}>
                  {state.custom.name}
                </p>
                <p className="text-xs text-slate-600">
                  {state.custom.questionCount} questions · {state.custom.totalMarks} marks
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  state.clearCustom();
                  if (jsonInputRef.current) jsonInputRef.current.value = "";
                }}
                disabled={disabled}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50"
                aria-label="Remove custom rubric"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <>
              <label htmlFor={`${ids}-json`} className="sr-only">
                Custom rubric JSON
              </label>
              <input
                ref={jsonInputRef}
                id={`${ids}-json`}
                type="file"
                accept=".json,application/json"
                disabled={disabled}
                onChange={(e) => void state.loadJsonFile(e.target.files?.[0])}
                className={fileInputClass}
              />
            </>
          )}
          {state.customError ? (
            <p className="text-xs text-rose-700" role="alert">
              {state.customError}
            </p>
          ) : !state.custom ? (
            <p className="text-xs text-slate-500">
              A rubric JSON (same shape as the template) used as-is for this upload.
            </p>
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite">
        {state.notice && !state.content ? (
          <p
            className={cn(
              "flex items-start gap-1.5 text-xs",
              state.notice.kind === "success" ? "text-slate-700" : "text-rose-800",
            )}
            role={state.notice.kind === "error" ? "alert" : "status"}
          >
            {state.notice.kind === "success" ? (
              <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-brand-lime-600" aria-hidden />
            ) : (
              <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden />
            )}
            {state.notice.message}
          </p>
        ) : null}
      </div>

      <p className="text-xs text-slate-500">
        Uploads use:{" "}
        <span className="font-medium text-slate-700">
          {state.choice?.label ?? (state.rubricsError ? "the server default rubric" : "…")}
        </span>
        {(mode === "paste" || mode === "upload") && !state.content ? " (until you approve a draft)" : null}
      </p>
    </div>
  );
}

/** "Ticks mark the key" - only for a PDF: the server reads ticks from page images, not from Word text. */
function MarkedKeyOption({ state, disabled, file }: { state: RubricSourceState; disabled?: boolean; file: File }) {
  const pdf = isPdfFile(file);
  return (
    <label className={cn("flex items-start gap-2 text-xs", pdf ? "text-slate-600" : "text-slate-400")}>
      <input
        type="checkbox"
        checked={pdf && state.keyFromMarks}
        onChange={(e) => state.setKeyFromMarks(e.target.checked)}
        disabled={disabled || state.parsing || !pdf}
        className="mt-0.5 h-3.5 w-3.5 rounded-sm border-slate-300 text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-cyan"
      />
      <span>
        The ticks or circles on this paper mark the correct options (no printed answer key)
        {pdf ? null : " - PDF only: ticks are read from the page images"}
      </span>
    </label>
  );
}

function ParseControls({ state, disabled, ids }: { state: RubricSourceState; disabled?: boolean; ids: string }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${ids}-subject-hint`} className="sr-only">
          Subject hint
        </label>
        <input
          id={`${ids}-subject-hint`}
          value={state.subjectHint}
          onChange={(e) => state.setSubjectHint(e.target.value)}
          disabled={disabled || state.parsing}
          maxLength={100}
          placeholder="Subject (optional)"
          className={cn(inputClass, "w-40 flex-1 py-2")}
        />
        <button
          type="button"
          onClick={() => void state.runParse()}
          disabled={disabled || state.parsing}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-brand-navy px-3 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70"
        >
          {state.parsing ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
          {state.parsing ? "Drafting…" : state.content ? "Draft again" : "Draft rubric"}
        </button>
      </div>
      {state.parsing ? (
        <p className="flex items-center gap-1.5 text-xs text-slate-600" role="status" aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin text-brand-cyan" aria-hidden />
          <span>
            {state.parsingPdf
              ? "Reading the paper page by page - a full paper takes a few minutes."
              : "Drafting the rubric…"}{" "}
            <span className="tabular-nums text-slate-500">{formatElapsed(state.parseElapsed)} elapsed</span>
          </span>
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          Claude turns it into an editable draft; a long PDF is read page by page (printed answer keys and ticked
          options become the MCQ key). Answer keys the AI had to write are marked{" "}
          <span className="font-medium text-slate-600">Draft - teacher review pending</span>.
        </p>
      )}
      {state.parseError ? (
        <p className="flex items-start gap-1.5 text-xs text-rose-700" role="alert">
          <XCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {state.parseError}
        </p>
      ) : null}
    </>
  );
}

/** 75 -> "1:15". */
function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Full-width review table for an AI-drafted rubric, with "Approve & save as new rubric". */
export function RubricDraftWorkbench({ state, disabled }: { state: RubricSourceState; disabled?: boolean }) {
  const { content, draft } = state;
  if (!content) return null;
  const issues = validateContent(content);

  return (
    <section
      aria-label="Review the drafted rubric"
      className="rounded-md border border-slate-200 bg-white p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-brand-navy">
            Review the drafted rubric
          </h3>
          <p className="text-sm text-slate-600">
            Source: {draft?.source ?? "text"}. Check every row - marks, criteria, expected answers and MCQ keys are
            what the grader will apply to each student.
          </p>
        </div>
        <button
          type="button"
          onClick={() => downloadJson(normalizeContent(content), "rubric-draft.json")}
          className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-cyan-600 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Download JSON
        </button>
      </div>

      <RubricDraftEditor
        key={state.draftSerial}
        value={content}
        onChange={state.setContent}
        aiDrafted={draft?.ai_drafted_questions ?? []}
        warnings={draft?.warnings ?? []}
        disabled={disabled || state.saving}
      />

      {state.notice?.kind === "error" ? (
        <p
          className="mt-4 border-l-2 border-rose-600 pl-3 text-sm text-rose-800"
          role="alert"
        >
          {state.notice.message}
        </p>
      ) : null}

      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={state.discardDraft}
          disabled={state.saving}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:opacity-60"
        >
          Discard draft
        </button>
        <button
          type="button"
          onClick={() => void state.approveAndSave()}
          disabled={disabled || state.saving || issues.count > 0}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-brand-navy px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.saving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
          Approve &amp; save as new rubric
        </button>
      </div>
    </section>
  );
}
