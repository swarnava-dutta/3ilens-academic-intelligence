"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, GitBranch, History, Loader2, RefreshCcw, Save, ScanText, Sparkles } from "lucide-react";
import { btnPrimary, btnSecondary, Dialog, fieldClass, type ToastMessage } from "@/components/cohort/dialog";
import {
  createRubricVersion,
  errorCode,
  errorMessage,
  errorStatus,
  getReevaluationEstimate,
  getRubrics,
} from "@/lib/api";
import type { ReevaluationEstimate, Rubric, RubricContent, RubricVersionResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RubricDraftEditor } from "./rubric-draft-editor";
import {
  cloneContent,
  compareContents,
  normalizeContent,
  questionList,
  rubricLabel,
  rubricStatusLabel,
  validateContent,
  versionLabel,
} from "./rubric-utils";

type EstimateState = { rubricId: number; data: ReevaluationEstimate | null; error: string | null } | null;

function inr(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `Rs ${value.toFixed(2)}` : "—";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Rubrics in the same family as `rubric` (same name, or linked by parent_id), oldest first. */
function lineage(rubric: Rubric, all: Rubric[]): Rubric[] {
  const ids = new Set<number>([rubric.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of all) {
      if (ids.has(r.id)) continue;
      if ((r.parent_id !== null && ids.has(r.parent_id)) || all.some((x) => ids.has(x.id) && x.parent_id === r.id)) {
        ids.add(r.id);
        grew = true;
      }
    }
  }
  return all
    .filter((r) => ids.has(r.id) || r.name === rubric.name)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id - b.id);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Collapsible "Rubric versions" card on /cohort: pick a rubric, edit it in the review table and
 * save it as the next version. Re-running asks for confirmation first, showing how many students
 * will be re-graded and the estimated cost (OCR is reused, so 0 vision calls).
 */
export function RubricVersionsPanel({
  preferredRubricId,
  onRerunQueued,
  onToast,
}: {
  /** Rubric to open first (the test filter, or the cohort's rubric). */
  preferredRubricId: number | null;
  onRerunQueued: () => Promise<void> | void;
  onToast: (toast: ToastMessage) => void;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [content, setContent] = useState<RubricContent | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [estimate, setEstimate] = useState<EstimateState>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RubricVersionResult | null>(null);

  const selected =
    rubrics?.find((r) => r.id === selectedId) ??
    rubrics?.find((r) => r.id === preferredRubricId) ??
    rubrics?.[rubrics.length - 1] ??
    null;
  const baseline = selected?.content ?? null;
  const editing = content && selected ? content : selected ? cloneContent(selected.content) : null;

  // Load the rubrics the first time the card is opened.
  useEffect(() => {
    if (!open || rubrics) return;
    let cancelled = false;
    getRubrics()
      .then((list) => {
        if (!cancelled) setRubrics(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, rubrics]);

  // Students affected and estimated cost of re-grading everything on the selected rubric.
  const selectedRubricId = selected?.id ?? null;
  useEffect(() => {
    if (!open || selectedRubricId === null) return;
    let cancelled = false;
    getReevaluationEstimate(selectedRubricId)
      .then((data) => {
        if (!cancelled) setEstimate({ rubricId: selectedRubricId, data, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setEstimate({ rubricId: selectedRubricId, data: null, error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedRubricId, lastResult]);

  function select(id: number) {
    setSelectedId(id);
    setContent(null);
    setChangeNote("");
    setSaveError(null);
  }

  const current = estimate && estimate.rubricId === selectedRubricId ? estimate : null;
  const est = current?.data ?? null;
  const normalized = editing ? normalizeContent(editing) : null;
  const diff = baseline && normalized ? compareContents(normalizeContent(baseline), normalized) : null;
  const changed = diff ? diff.added.length + diff.removed.length + diff.changed.length > 0 : false;
  const nameChanged = !!(baseline && normalized && normalizeContent(baseline).name !== normalized.name);
  const issues = editing ? validateContent(editing) : null;
  const canSave = !!selected && !!normalized && (changed || nameChanged) && (issues?.count ?? 1) === 0 && !saving;
  const students = est?.students ?? null;

  async function save(reprocess: boolean) {
    if (!selected || !normalized) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await createRubricVersion(selected.id, {
        content: normalized,
        change_note: changeNote.trim() || null,
        reprocess,
      });
      setLastResult(result);
      setConfirmOpen(false);
      const queued = result.queued_submission_ids?.length ?? 0;
      const compat = result.compatibility;
      const compatText = compat
        ? compat.reusable
          ? "same question numbers, stored OCR reused as-is"
          : `question numbers changed (added ${questionList(compat.added)}, removed ${questionList(compat.removed)})`
        : "";
      onToast({
        kind: "success",
        message: reprocess
          ? `${plural(queued, "report")} queued for regeneration - 0 OCR calls. ${result.rubric.name} ${versionLabel(result.rubric.version)} saved; ${compatText}.`
          : `${result.rubric.name} ${versionLabel(result.rubric.version)} saved (no reports re-run); ${compatText}.`,
      });
      // Show the new version in the picker and keep editing from it.
      setRubrics((prev) => [...(prev ?? []).filter((r) => r.id !== result.rubric.id), result.rubric]);
      setSelectedId(result.rubric.id);
      setContent(null);
      setChangeNote("");
      await onRerunQueued();
    } catch (err) {
      const status = errorStatus(err);
      const message =
        !errorCode(err) && (status === 404 || status === 405)
          ? "Rubric versions are not available on this API build yet."
          : errorMessage(err);
      setSaveError(message);
      onToast({ kind: "error", message: `Rubric version not saved: ${message}` });
    } finally {
      setSaving(false);
    }
  }

  const family = selected && rubrics ? lineage(selected, rubrics) : [];

  return (
    <section aria-labelledby={`${ids}-title`} className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`${ids}-panel`}
        className="flex w-full items-start justify-between gap-3 rounded-2xl p-5 text-left focus-visible:outline-2 focus-visible:outline-brand-cyan sm:p-6"
      >
        <span className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700">
            <GitBranch className="h-4.5 w-4.5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span id={`${ids}-title`} className="block text-base font-semibold text-brand-navy">
              Rubric versions · edit &amp; re-run
            </span>
            <span className="mt-0.5 block text-sm text-slate-500">
              Fix the answer key or marks, save it as the next version and re-grade every report from the stored OCR
              (no new vision calls).
            </span>
          </span>
        </span>
        <ChevronDown className={cn("mt-2 h-5 w-5 shrink-0 text-slate-400 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      <div id={`${ids}-panel`} hidden={!open} className="space-y-5 border-t border-slate-100 p-5 sm:p-6">
        {!rubrics ? (
          loadError ? (
            <p role="alert" className="text-sm text-rose-700">
              Could not load rubrics: {loadError}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading rubrics…
            </p>
          )
        ) : rubrics.length === 0 || !selected || !editing ? (
          <p className="text-sm text-slate-500">No rubrics yet. Create one from the intake page.</p>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <label htmlFor={`${ids}-rubric`} className="text-sm font-medium text-slate-700">
                  Rubric to revise
                </label>
                <select
                  id={`${ids}-rubric`}
                  value={selected.id}
                  disabled={saving}
                  onChange={(e) => select(Number(e.target.value))}
                  className={cn(fieldClass, "appearance-auto")}
                >
                  {rubrics.map((r) => (
                    <option key={r.id} value={r.id}>
                      {rubricLabel(r)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500">
                  {rubricStatusLabel(selected.status)}
                  {selected.rubric_hash ? (
                    <span className="font-mono" title={`Rubric SHA-256 ${selected.rubric_hash}`}>
                      {" "}
                      · {selected.rubric_hash.slice(0, 10)}…
                    </span>
                  ) : null}
                </p>
              </div>
              {family.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                    <History className="h-4 w-4 text-slate-400" aria-hidden />
                    Version history
                  </p>
                  <ol className="space-y-1 text-xs">
                    {family.map((r) => (
                      <li key={r.id} className={cn("flex flex-wrap items-baseline gap-x-2", r.id === selected.id && "font-semibold")}>
                        <span className="text-brand-navy">{versionLabel(r.version)}</span>
                        <span className="text-slate-400">{formatDate(r.created_at)}</span>
                        <span className={r.status === "FACULTY_APPROVED" ? "text-lime-700" : "text-violet-700"}>
                          {r.status === "FACULTY_APPROVED" ? "approved" : "draft"}
                        </span>
                        {r.change_note ? <span className="font-normal text-slate-500">- {r.change_note}</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>

            <RubricDraftEditor
              value={editing}
              onChange={(next) => setContent(next)}
              baseline={baseline}
              disabled={saving}
            />

            <div className="space-y-1.5">
              <label htmlFor={`${ids}-note`} className="text-sm font-medium text-slate-700">
                Change note <span className="font-normal text-slate-400">(kept with the version for audit)</span>
              </label>
              <input
                id={`${ids}-note`}
                value={changeNote}
                maxLength={500}
                disabled={saving}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="e.g. Q2: accept 'semi-dominance' as incomplete dominance; Q3 marks 4 → 5"
                className={fieldClass}
              />
            </div>

            {/* Preview of what the re-run will do */}
            <div
              className={cn(
                "rounded-xl px-4 py-3 text-sm ring-1 ring-inset",
                changed || nameChanged ? "bg-violet-50/60 text-slate-700 ring-violet-200" : "bg-slate-50 text-slate-500 ring-slate-200",
              )}
              aria-live="polite"
            >
              {!(changed || nameChanged) ? (
                <p>No changes yet. Edit a question above to preview the re-run.</p>
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-brand-navy">
                    <RefreshCcw className="h-4 w-4 text-violet-600" aria-hidden />
                    {students !== null
                      ? `${plural(students, "report")} will regenerate; OCR reused for ${students}`
                      : "Every completed report on this rubric will regenerate; OCR is reused"}
                    <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-violet-700 ring-1 ring-inset ring-violet-200">
                      <ScanText className="h-3 w-3" aria-hidden />0 OCR calls
                    </span>
                  </p>
                  {diff ? (
                    <p className="mt-1 text-xs text-slate-600">
                      Questions added: {questionList(diff.added)} · removed: {questionList(diff.removed)} · changed:{" "}
                      {questionList(diff.changed)}
                    </p>
                  ) : null}
                  {diff && !diff.reusable ? (
                    <p className="mt-1 text-xs text-amber-800">
                      Question numbers differ from {versionLabel(selected.version)}: stored transcripts are matched by
                      question number, so added questions have no stored answer until a sheet is re-scanned.
                    </p>
                  ) : null}
                  {current?.error ? (
                    <p className="mt-1 text-xs text-slate-500">Cost estimate unavailable: {current.error}</p>
                  ) : null}
                </>
              )}
            </div>

            {saveError ? (
              <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
                {saveError}
              </p>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setContent(null);
                  setChangeNote("");
                }}
                disabled={saving || !(changed || nameChanged)}
                className={btnSecondary}
              >
                Discard edits
              </button>
              <button type="button" onClick={() => void save(false)} disabled={!canSave} className={btnSecondary}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                Save version only
              </button>
              <button type="button" onClick={() => setConfirmOpen(true)} disabled={!canSave} className={btnPrimary}>
                <Sparkles className="h-4 w-4" aria-hidden />
                Save &amp; re-run reports…
              </button>
            </div>
          </>
        )}
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!saving) setConfirmOpen(false);
        }}
        eyebrow="Confirm bulk re-evaluation"
        title={selected ? `Re-grade reports on ${selected.name} ${versionLabel(selected.version)}?` : "Re-grade reports?"}
        description="Each live report is graded again by Claude against the new version. Stored OCR is reused."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setConfirmOpen(false)} disabled={saving} className={btnSecondary}>
              Cancel
            </button>
            <button type="button" onClick={() => void save(true)} disabled={saving || !canSave} className={btnPrimary}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCcw className="h-4 w-4" aria-hidden />}
              {students !== null ? `Re-run ${plural(students, "report")}` : "Re-run reports"}
            </button>
          </div>
        }
      >
        {est ? (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                ["Students", String(est.students), `${est.live_students} live · ${est.demo_students} demo`],
                ["Grading calls", String(est.evaluation_calls), "one per live student"],
                ["OCR calls", String(est.ocr_calls), "stored OCR reused"],
                ["Estimated cost", inr(est.estimated_cost_inr), `${inr(est.estimated_cost_per_student_inr)} per student`],
              ].map(([label, value, hint]) => (
                <div key={label} className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200">
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="text-lg font-bold tabular-nums text-brand-navy">{value}</dd>
                  <dd className="text-xs text-slate-500">{hint}</dd>
                </div>
              ))}
            </dl>
            {est.basis ? <p className="text-xs text-slate-500">Basis: {est.basis}</p> : null}
            {est.demo_students > 0 ? (
              <p className="text-xs text-slate-500">
                Demo rows are re-scored without an AI call (synthetic), so they add no cost.
              </p>
            ) : null}
            {est.students === 0 ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
                No completed report uses this rubric yet - the new version is saved and nothing is re-run.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              {current?.error
                ? `The cost estimate could not be loaded (${current.error}).`
                : "Loading the number of students and the estimated cost…"}
            </p>
            <p>Every COMPLETED report on this rubric will be re-graded with 0 OCR calls.</p>
          </div>
        )}
        {saveError ? (
          <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
            {saveError}
          </p>
        ) : null}
      </Dialog>
    </section>
  );
}
