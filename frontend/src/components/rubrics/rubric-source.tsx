"use client";

import { useId, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Dialog } from "@/components/cohort/dialog";
import { DocPreview } from "@/components/preview/doc-preview";
import { errorMessage } from "@/lib/api";
import { inr } from "@/lib/format";
import type { RubricContent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { KeyFilesDrop, sourceFileLabel } from "./key-files-drop";
import { RubricDraftEditor } from "./rubric-draft-editor";
import {
  downloadJson,
  isMcq,
  mcqKeyMode,
  mcqKeySet,
  normalizeContent,
  RUBRIC_TEMPLATE,
  sourceLabel,
  totalMarks,
} from "./rubric-utils";
import {
  isPdfFile,
  type RegradeEstimate,
  type RubricMode,
  type RubricSourceState,
} from "./use-rubric-source";

const MODES: { value: RubricMode; label: string }[] = [
  { value: "file", label: "Upload files" },
  { value: "paste", label: "Paste text" },
];

const inputClass =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

const primaryBtn =
  "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-brand-navy px-3 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-navy-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryBtn =
  "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";

/** 75 -> "1:15". */
function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What the draft used a dropped file as (known once the draft is back). */
function fileRoleLabel(state: RubricSourceState, file: File): string {
  // A key file added next to the draft's paper: read on its own, then applied to the draft.
  if (state.keyStep?.file === file) {
    return { reading: "Reading…", waiting: "Answer key", held: "Waiting…" }[state.keyStep.step];
  }
  if (state.parsing) return "Reading…";
  if (!state.draft) return "Not drafted yet";
  return sourceFileLabel(state.sources, file);
}

/**
 * The intake's answer key, taken on the fly: one or two dropped files (the key, the question paper,
 * or both - drafted as soon as they are added; a JSON or text key is read without AI) or pasted
 * text. Nothing is picked from a library: every intake brings its own key.
 */
export function RubricSourceControl({ state, disabled }: { state: RubricSourceState; disabled?: boolean }) {
  const ids = useId();
  const { mode } = state;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span id={`${ids}-label`} className="text-sm font-medium text-slate-700">
          Answer key
        </span>
        <button
          type="button"
          onClick={() => downloadJson(RUBRIC_TEMPLATE, "answer-key-template.json")}
          className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-cyan-600 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          JSON template
        </button>
      </div>

      <div
        role="radiogroup"
        aria-labelledby={`${ids}-label`}
        className="grid grid-cols-2 gap-0.5 rounded-md border border-slate-300 bg-white p-0.5"
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

      {mode === "file" ? (
        <div className="space-y-3">
          <KeyFilesDrop
            id={`${ids}-files`}
            files={state.files}
            note={state.filesNote}
            disabled={disabled}
            hint="PDF, Word, image, text or JSON - one or two files. Drafting starts at once."
            label={(file) => fileRoleLabel(state, file)}
            onAdd={state.addFiles}
            onRemove={state.removeFile}
          />
          {state.origin === "paper" && state.files.length === 1 ? (
            <p className="border-l-2 border-amber-500 pl-3 text-xs text-amber-900">
              A student&apos;s ticked copy? Drop the answer key here too - otherwise the ticked options can be read as
              the key.
            </p>
          ) : null}
          {/* Not when the file was read as the answer key itself (a key alone has no ticks to read). */}
          {state.files.length === 1 && state.sources.key !== state.files[0] && state.sources.role !== "answer_key" ? (
            <MarkedKeyOption state={state} disabled={disabled} file={state.files[0]} />
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor={`${ids}-paste`} className="block text-xs font-medium text-slate-600">
            Questions with marks and the answer key
          </label>
          <textarea
            id={`${ids}-paste`}
            rows={6}
            value={state.pasteText}
            disabled={disabled || state.parsing}
            onChange={(e) => state.setPasteText(e.target.value)}
            placeholder={"Q1. Explain incomplete dominance with an example. (5 marks)\nMarking: definition 2, example 2, ratio 1\n\nQ2. … (4 marks) Ans: B"}
            className={cn(inputClass, "resize-y font-mono text-xs")}
          />
        </div>
      )}

      <DraftControls state={state} disabled={disabled} ids={ids} />
      <DraftStatus state={state} />

      <p className="text-xs text-slate-500">
        Uploads use: <span className="font-medium text-slate-700">{state.usesLabel}</span>
      </p>
    </div>
  );
}

/** "Ticks mark the key" - only for a PDF: the server reads ticks from page images, not from Word text. */
function MarkedKeyOption({ state, disabled, file }: { state: RubricSourceState; disabled?: boolean; file: File }) {
  const pdf = isPdfFile(file);
  if (!pdf) return null;
  return (
    <label className="flex items-start gap-2 text-xs text-slate-600">
      <input
        type="checkbox"
        checked={state.keyFromMarks}
        onChange={(e) => state.setKeyFromMarks(e.target.checked)}
        disabled={disabled || state.parsing}
        className="mt-0.5 h-3.5 w-3.5 rounded-sm border-slate-300 text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-cyan"
      />
      <span>The ticks or circles on this paper mark the correct options (a teacher&apos;s marked copy, no printed key) - then draft it again.</span>
    </label>
  );
}

/** Subject hint and the Draft / Draft again button. */
function DraftControls({ state, disabled, ids }: { state: RubricSourceState; disabled?: boolean; ids: string }) {
  const fileMode = state.mode === "file";
  // A file is drafted the moment it is added: the button is only for drafting it again.
  if (fileMode && !state.files.length) return null;
  const label = state.parsing
    ? "Drafting…"
    : state.content || state.parseError || fileMode
      ? "Draft again"
      : "Draft the answer key";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${ids}-subject-hint`} className="sr-only">
        Subject (optional, helps the draft)
      </label>
      <input
        id={`${ids}-subject-hint`}
        value={state.subjectHint}
        onChange={(e) => state.setSubjectHint(e.target.value)}
        disabled={disabled || state.parsing}
        maxLength={100}
        placeholder="Subject (optional)"
        className={cn(inputClass, "w-36 flex-1 py-2")}
      />
      <button
        type="button"
        onClick={() => void state.runParse()}
        disabled={disabled || state.parsing}
        className={cn(fileMode ? secondaryBtn : primaryBtn, "flex-1")}
      >
        {state.parsing ? (
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
        ) : fileMode ? (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        ) : null}
        {label}
      </button>
    </div>
  );
}

/** Drafting progress, the draft's state (ready / needs fixes) and errors. */
function DraftStatus({ state }: { state: RubricSourceState }) {
  return (
    <div aria-live="polite" className="space-y-1.5">
      {state.keyStep ? (
        <p className="flex items-start gap-1.5 text-xs text-slate-600" role="status">
          <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 motion-safe:animate-spin text-brand-cyan" aria-hidden />
          <span className="min-w-0 break-words">
            {state.keyStep.step === "reading"
              ? `Reading the answer key from "${state.keyStep.file.name}" - it is applied to the draft (the paper is not read again).`
              : state.keyStep.step === "held"
                ? `"${state.keyStep.file.name}" is taken when the first file's draft is back - it tells which file is the answer key.`
                : `Answer key from "${state.keyStep.file.name}" read - it is applied as soon as the paper's draft is ready.`}
          </span>
        </p>
      ) : null}
      {state.parsing ? (
        <p className="flex items-start gap-1.5 text-xs text-slate-600" role="status">
          <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 motion-safe:animate-spin text-brand-cyan" aria-hidden />
          <span>
            {/* A one-page key PDF is back within seconds: the long-paper note only once it takes longer. */}
            {state.parsingPdf && state.parseElapsed >= 5
              ? "Reading the paper page by page - a full paper takes a few minutes."
              : "Drafting the answer key…"}
            {state.mode === "file" && state.files.length > 1 && !state.keyStep ? " Both files are read together." : ""}{" "}
            <span className="tabular-nums text-slate-500">{formatElapsed(state.parseElapsed)} elapsed</span>. Keep this
            page open; sheets can be staged meanwhile.
          </span>
        </p>
      ) : state.status === "ready" ? (
        <p className="flex items-start gap-1.5 text-xs text-slate-700" role="status">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-brand-lime-600" aria-hidden />
          <span>Ready - sheets are graded with this key as soon as they are uploaded. Review or edit it below.</span>
        </p>
      ) : state.status === "fix" ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-900" role="status">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
          <span className="min-w-0 break-words">
            Set {state.fixCount === 1 ? "this" : `these ${state.fixCount}`} in the draft below before grading:{" "}
            {state.fixList}.
          </span>
        </p>
      ) : state.mode === "file" && !state.files.length ? (
        <p className="text-xs text-slate-500">
          Add the answer key, the question paper, or both - Claude drafts an editable answer key and the sheets are
          graded with it straight away. Keys the AI had to write are marked{" "}
          <span className="font-medium text-slate-600">Draft - teacher review pending</span>.
        </p>
      ) : null}
      {state.parseError ? (
        <p className="flex items-start gap-1.5 text-xs text-rose-700" role="alert">
          <XCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {state.parseError}
        </p>
      ) : null}
      {state.notice?.kind === "error" ? (
        <p className="flex items-start gap-1.5 text-xs text-rose-800" role="alert">
          <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden />
          {state.notice.message}
        </p>
      ) : state.notice ? (
        <p className="text-xs text-slate-600" role="status">
          {state.notice.message}
        </p>
      ) : null}
    </div>
  );
}

function sheetsWord(count: number): string {
  return `${count} ${count === 1 ? "sheet" : "sheets"}`;
}

/**
 * "Re-grade with this key" for sheets graded before an edit (or that finished with an earlier edit),
 * confirmed first with the number of sheets and the estimated cost (bulk re-evaluation rule).
 * disabled: uploads are running (each would make its own server copy of the key).
 */
function RegradeBar({
  state,
  compact = false,
  disabled = false,
}: {
  state: RubricSourceState;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { regrade } = state;
  const [confirm, setConfirm] = useState<{ estimate: RegradeEstimate | null; error: string | null } | null>(null);

  function ask() {
    setConfirm({ estimate: null, error: null });
    if (regrade.rubricId === null) return;
    regrade
      .estimate()
      .then((estimate) => setConfirm((open) => (open ? { estimate, error: null } : open)))
      .catch((err: unknown) => setConfirm((open) => (open ? { estimate: null, error: errorMessage(err) } : open)));
  }

  // Covers the snapshot's sheets and those that finished with an earlier edit of the key.
  const est = confirm?.estimate ?? null;
  const button = regrade.offered ? (
    <>
      <button
        type="button"
        onClick={ask}
        disabled={regrade.running || disabled}
        title={disabled ? "Wait for the uploads to finish" : undefined}
        className={cn(primaryBtn, "h-9")}
      >
        {regrade.running ? (
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        )}
        {regrade.completed > 0 ? `Re-grade ${sheetsWord(regrade.completed)} with this key` : "Re-grade with this key"}
      </button>
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        eyebrow="Confirm bulk re-evaluation"
        title={regrade.completed > 0 ? `Re-grade ${sheetsWord(regrade.completed)} with this key?` : "Use this key from now on?"}
        description="Each sheet is graded again by Claude against this key. Stored OCR is reused and the earlier result is archived."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setConfirm(null)} className={secondaryBtn}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirm(null);
                void regrade.run();
              }}
              disabled={!est && !confirm?.error}
              className={primaryBtn}
            >
              {regrade.completed > 0 ? `Re-grade ${sheetsWord(regrade.completed)}` : "Use this key"}
            </button>
          </div>
        }
      >
        {est ? (
          <div className="space-y-2 text-sm">
            <dl className="grid grid-cols-2 divide-x divide-slate-200 overflow-hidden rounded-md border border-slate-200">
              {[
                ["Students", String(regrade.completed), "OCR calls: 0 (stored OCR reused)"],
                est.cost === null || est.perSheet === null
                  ? ["Estimated cost", "Not known yet", "Cost shown after the first sheet is graded"]
                  : [
                      "Estimated cost",
                      inr(est.cost),
                      est.demoOnly ? "Demo sheets - no grading call" : `${inr(est.perSheet)} per student`,
                    ],
              ].map(([label, value, hint]) => (
                <div key={label} className="px-3 py-2">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="text-base font-semibold tabular-nums text-brand-navy">{value}</dd>
                  <dd className="text-xs text-slate-500">{hint}</dd>
                </div>
              ))}
            </dl>
            {est.basis ? <p className="text-xs text-slate-500">Basis: {est.basis}</p> : null}
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            {confirm?.error
              ? `The cost estimate could not be loaded (${confirm.error}). ${sheetsWord(regrade.completed)} would be re-graded with 0 OCR calls.`
              : "Loading the number of students and the estimated cost…"}
          </p>
        )}
      </Dialog>
    </>
  ) : null;
  if (compact) return button;
  if (!regrade.offered && !regrade.notice) return null;

  const headline = regrade.edited
    ? `You edited the key after ${sheetsWord(regrade.sheets)} of this intake ${regrade.sheets === 1 ? "was" : "were"} uploaded with it.`
    : `${sheetsWord(regrade.completed)} finished with the earlier key.`;
  const notes = [
    "A re-grade reuses the OCR text (no new scan) and archives the earlier result.",
    regrade.busy ? `${sheetsWord(regrade.busy)} still being graded finish with the key they started with.` : null,
    regrade.heldMoving
      ? `${sheetsWord(regrade.heldMoving)} held for review or failed ${regrade.heldMoving === 1 ? "moves" : "move"} to the edited key with the re-grade - approve or re-run ${regrade.heldMoving === 1 ? "it from its" : "them from their"} report.`
      : null,
    regrade.held
      ? `${sheetsWord(regrade.held)} held for review or failed under an earlier edit ${regrade.held === 1 ? "keeps" : "keep"} that key - re-run ${regrade.held === 1 ? "it from its" : "them from their"} report.`
      : null,
  ].filter(Boolean);

  return (
    <div className="mb-4 space-y-2" aria-live="polite">
      {regrade.offered ? (
        <div className="flex flex-col gap-2 border-l-2 border-amber-500 pl-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm text-amber-900">
            <span className="font-medium">{headline}</span> <span className="text-xs">{notes.join(" ")}</span>
          </p>
          <div className="shrink-0">{button}</div>
        </div>
      ) : null}
      {regrade.notice ? (
        <p
          className={cn(
            "flex items-start gap-1.5 text-sm",
            regrade.notice.kind === "error" ? "text-rose-800" : "text-slate-700",
          )}
          role={regrade.notice.kind === "error" ? "alert" : "status"}
        >
          {regrade.notice.kind === "error" ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-lime-600" aria-hidden />
          )}
          <span className="min-w-0">{regrade.notice.message}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Full-width view of the answer key in use: the editable draft with its warnings (multi-answer,
 * bonus or missing keys stay flagged). Sheets are graded with it as they are uploaded; editing it
 * afterwards offers "Re-grade with this key" for the sheets already graded.
 */
/** "180 questions · 720 marks · MCQ keys: 174 single, 4 with several accepted options, 2 bonus, 0 missing". */
function draftSummary(content: RubricContent): string {
  const mcqs = content.questions.filter(isMcq);
  const parts = [
    `${content.questions.length} ${content.questions.length === 1 ? "question" : "questions"}`,
    `${totalMarks(content)} marks`,
  ];
  if (mcqs.length) {
    const several = mcqs.filter((q) => mcqKeyMode(q) === "several").length;
    const bonus = mcqs.filter((q) => mcqKeyMode(q) === "bonus").length;
    const missing = mcqs.filter((q) => !mcqKeySet(q)).length;
    const keys = [`${mcqs.length - several - bonus} one correct option`];
    if (several) keys.push(`${several} several accepted`);
    if (bonus) keys.push(`${bonus} bonus`);
    if (missing) keys.push(`${missing} without a key`);
    parts.push(`MCQ keys: ${keys.join(", ")}`);
  }
  return parts.join(" · ");
}

/**
 * Thumbnails of the files the key was drafted from (question paper / key file / marked copy and the
 * answer key), so faculty can check at a glance that the staged sheets are this paper.
 * They go with the intake's first upload (and again after the key or a file changes) and the report
 * previews them again.
 */
function KeySourcePreviews({ state }: { state: RubricSourceState }) {
  const { paper, role } = state.sources;
  // A key file dropped in the drop zone already shows there: one preview of it is enough.
  const key = state.sources.key && !(state.mode === "file" && state.files.includes(state.sources.key)) ? state.sources.key : null;
  if (!paper && !key) return null;
  return (
    <div role="group" aria-label="Files the answer key was drafted from" className="min-w-0 lg:shrink-0">
      {/* Fixed card widths: the group sits in a shrink-to-fit column at lg. */}
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        {paper ? (
          <div className="w-full max-w-[264px] sm:w-[264px]">
            <DocPreview label={sourceLabel("paper", role)} source={{ kind: "file", file: paper }} size="md" />
          </div>
        ) : null}
        {key ? (
          <div className="w-full max-w-[264px] sm:w-[264px]">
            <DocPreview label={sourceLabel("key")} source={{ kind: "file", file: key }} size="md" />
          </div>
        ) : null}
      </div>
      {/* w-0 min-w-full: the note wraps to the cards' width instead of widening the column. */}
      <p className="mt-1.5 w-0 min-w-full text-xs text-slate-500">
        Compare with the staged sheets - they should be this paper. Kept with the uploaded sheets so each report can
        show them.
      </p>
    </div>
  );
}

export function RubricDraftWorkbench({ state, disabled }: { state: RubricSourceState; disabled?: boolean }) {
  const ids = useId();
  const { content, draft } = state;
  // While a paper is drafted (minutes for a full paper) its preview already shows here.
  if (!content) {
    if (!state.parsing || (!state.sources.paper && !state.sources.key)) return null;
    return (
      <section aria-labelledby={`${ids}-title`} className="rounded-md border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h3 id={`${ids}-title`} className="text-[15px] font-semibold text-brand-navy">
              Answer key being drafted
            </h3>
            <p className="flex items-start gap-1.5 text-sm text-slate-600">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 motion-safe:animate-spin text-brand-cyan" aria-hidden />
              <span className="min-w-0">
                From <span className="break-all font-medium text-slate-700">{state.draftFrom}</span>. The editable key
                appears here when it is ready.
              </span>
            </p>
          </div>
          <KeySourcePreviews state={state} />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="rounded-md border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 id={`${ids}-title`} className="text-[15px] font-semibold text-brand-navy">
              Answer key in use
            </h3>
            <button
              type="button"
              onClick={() => downloadJson(normalizeContent(content), "answer-key.json")}
              className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-cyan-600 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Download JSON
            </button>
          </div>
          <p className="text-sm text-slate-600">
            {state.draftFrom ? (
              <>
                Drafted from <span className="break-all font-medium text-slate-700">{state.draftFrom}</span>
                {/* A key file applied in the editor below (dropped files are named in draftFrom). */}
                {state.sources.key && !state.files.includes(state.sources.key) ? (
                  <>
                    {" "}
                    with the answer key <span className="break-all font-medium text-slate-700">{state.sources.key.name}</span>
                  </>
                ) : null}
                .{" "}
              </>
            ) : null}
            Marks, criteria, expected answers and MCQ keys are what the grader applies to every sheet of this intake.
            Edit any row; sheets already graded can then be re-graded with the edited key.
          </p>
          <p className="mt-1 text-xs tabular-nums text-slate-500">{draftSummary(content)}</p>
        </div>
        <KeySourcePreviews state={state} />
      </div>

      <RegradeBar state={state} disabled={disabled} />

      <RubricDraftEditor
        key={state.draftSerial}
        value={content}
        onChange={state.setContent}
        aiDrafted={draft?.ai_drafted_questions ?? []}
        warnings={draft?.warnings ?? []}
        disabled={disabled || state.regrade.running}
        keyFile={state.sources.key}
        onKeyFile={state.setSourceKeyFile}
      />

      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={state.discardDraft}
          disabled={disabled || state.regrade.running}
          className={cn(secondaryBtn, "text-slate-700")}
        >
          Discard this key
        </button>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {state.regrade.sheets > 0 ? (
            <p className="text-xs text-slate-500">
              {sheetsWord(state.regrade.sheets)} of this intake uploaded with this key.
            </p>
          ) : null}
          <RegradeBar state={state} compact disabled={disabled} />
        </div>
      </div>
    </section>
  );
}
