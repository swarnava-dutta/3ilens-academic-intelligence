"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { btnPrimary, btnSecondary, Dialog, fieldClass, type ToastMessage } from "@/components/cohort/dialog";
import {
  createRubricVersion,
  errorMessage,
  getReevaluationEstimate,
  getRubrics,
} from "@/lib/api";
import { inr, plural } from "@/lib/format";
import type { ReevaluationEstimate, Rubric, RubricContent, RubricVersionResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BloomSuggestions } from "./bloom-suggestions";
import { RubricDraftEditor } from "./rubric-draft-editor";
import {
  cloneContent,
  compareContents,
  normalizeContent,
  paperCodeOf,
  policyKey,
  questionList,
  rubricLabel,
  rubricStatusLabel,
  validateContent,
  versionLabel,
} from "./rubric-utils";

type EstimateState = { rubricId: number; data: ReevaluationEstimate | null; error: string | null } | null;

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
 * Collapsible "Answer keys used" card on /cohort: pick an intake's key, edit it in the review table and
 * save it as the next version. Re-grading asks for confirmation first, showing how many students will
 * be re-graded and the estimated cost (the saved reading of each sheet is reused: no sheet is read again).
 */
export function RubricVersionsPanel({
  preferredRubricId,
  defaultOpen = false,
  onRerunQueued,
  onToast,
}: {
  /** Answer key to open first (the test filter, or the cohort's key). */
  preferredRubricId: number | null;
  /** Start expanded; turning true later ("Check the key") expands it too. */
  defaultOpen?: boolean;
  onRerunQueued: () => Promise<void> | void;
  onToast: (toast: ToastMessage) => void;
}) {
  const ids = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [wasDefaultOpen, setWasDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== wasDefaultOpen) {
    setWasDefaultOpen(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
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
  // A rubric-wide marking-policy change re-scores every question even when no question changed.
  const policyChanged = !!(baseline && normalized && policyKey(normalizeContent(baseline)) !== policyKey(normalized));
  const paperCodeChanged = !!(baseline && normalized && paperCodeOf(baseline) !== paperCodeOf(normalized));
  const issues = editing ? validateContent(editing) : null;
  const anyChange = changed || nameChanged || policyChanged || paperCodeChanged;
  const canSave = !!selected && !!normalized && anyChange && (issues?.count ?? 1) === 0 && !saving;
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
          ? "same question numbers, the saved reading of each sheet is reused"
          : `question numbers changed (added ${questionList(compat.added)}, removed ${questionList(compat.removed)})`
        : "";
      onToast({
        kind: "success",
        message: reprocess
          ? `${plural(queued, "report")} queued to be re-graded - no sheet is read again. ${result.rubric.name} ${versionLabel(result.rubric.version)} saved; ${compatText}.`
          : `${result.rubric.name} ${versionLabel(result.rubric.version)} saved (no reports re-graded); ${compatText}.`,
      });
      // Show the new version in the picker and keep editing from it.
      setRubrics((prev) => [...(prev ?? []).filter((r) => r.id !== result.rubric.id), result.rubric]);
      setSelectedId(result.rubric.id);
      setContent(null);
      setChangeNote("");
      await onRerunQueued();
    } catch (err) {
      const message = errorMessage(err);
      setSaveError(message);
      onToast({ kind: "error", message: `Answer key not saved: ${message}` });
    } finally {
      setSaving(false);
    }
  }

  const family = selected && rubrics ? lineage(selected, rubrics) : [];

  return (
    <section aria-labelledby={`${ids}-title`} className="min-w-0 rounded-md border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`${ids}-panel`}
        className="flex w-full items-start justify-between gap-3 rounded-md px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan sm:px-5"
      >
        <span className="flex min-w-0 items-start gap-3">
          <span className="min-w-0">
            <span id={`${ids}-title`} className="block text-base font-semibold text-brand-navy">
              Answer keys used · edit &amp; re-grade
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Fix the answer key or marks, save it as the next version and re-grade every report from the saved
              reading of its sheet (no sheet is read again).
            </span>
          </span>
        </span>
        <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-slate-500", open && "rotate-180")} aria-hidden />
      </button>

      <div id={`${ids}-panel`} hidden={!open} className="space-y-5 border-t border-slate-200 p-4 sm:p-5">
        {!rubrics ? (
          loadError ? (
            <p role="alert" className="text-sm text-rose-700">
              Could not load the answer keys: {loadError}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> Loading answer keys…
            </p>
          )
        ) : rubrics.length === 0 || !selected || !editing ? (
          <p className="text-sm text-slate-500">
            No answer keys yet. Every intake brings its own: add the question paper or answer key with the sheets on
            the intake page.
          </p>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <label htmlFor={`${ids}-rubric`} className="text-sm font-medium text-slate-700">
                  Answer key to revise
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
                    <span className="font-mono" title={`Answer key fingerprint (SHA-256) ${selected.rubric_hash}`}>
                      {" "}
                      · {selected.rubric_hash.slice(0, 10)}…
                    </span>
                  ) : null}
                </p>
              </div>
              {family.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-slate-700">
                    Version history
                  </p>
                  <ol className="space-y-1 text-xs">
                    {family.map((r) => (
                      <li key={r.id} className={cn("flex flex-wrap items-baseline gap-x-2", r.id === selected.id && "font-semibold")}>
                        <span className="text-brand-navy">{versionLabel(r.version)}</span>
                        <span className="tabular-nums text-slate-500">{formatDate(r.created_at)}</span>
                        <span className={r.status === "FACULTY_APPROVED" ? "text-lime-700" : "text-slate-600"}>
                          {r.status === "FACULTY_APPROVED" ? "approved" : "draft"}
                        </span>
                        {r.change_note ? <span className="font-normal text-slate-500">- {r.change_note}</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>

            <BloomSuggestions
              rubricId={selected.id}
              content={editing}
              disabled={saving}
              onApply={(next, mode) => {
                setContent(next);
                if (!changeNote.trim()) {
                  setChangeNote(mode === "ai" ? "Bloom levels (AI-suggested)" : "Bloom levels (heuristic-suggested)");
                }
              }}
            />

            <RubricDraftEditor
              key={selected.id}
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

            {/* Preview of what re-grading will do */}
            <div
              className={cn(
                "rounded-md border border-slate-200 px-4 py-3 text-sm",
                anyChange ? "text-slate-700" : "text-slate-500",
              )}
              aria-live="polite"
            >
              {!anyChange ? (
                <p>No changes yet. Edit a question above to see what re-grading will do.</p>
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-brand-navy">
                    {students !== null
                      ? `${plural(students, "report")} will be re-graded from the saved reading of each sheet`
                      : "Every completed report on this answer key will be re-graded from the saved reading of its sheet"}
                    <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                      No sheet read again
                    </span>
                  </p>
                  {diff ? (
                    <p className="mt-1 text-xs text-slate-600">
                      Questions added: {questionList(diff.added)} · removed: {questionList(diff.removed)} · changed:{" "}
                      {questionList(diff.changed)}
                      {policyChanged ? " · marking policy changed (every question re-graded)" : ""}
                      {paperCodeChanged ? ` · paper code / set: ${paperCodeOf(baseline) || "none"} → ${paperCodeOf(normalized) || "none"}` : ""}
                    </p>
                  ) : null}
                  {diff && !diff.reusable ? (
                    <p className="mt-1 text-xs text-amber-800">
                      Question numbers differ from {versionLabel(selected.version)}: the saved reading of each sheet is
                      matched by question number, so added questions have no answer until the sheet is uploaded again.
                    </p>
                  ) : null}
                  {current?.error ? (
                    <p className="mt-1 text-xs text-slate-500">Cost estimate unavailable: {current.error}</p>
                  ) : null}
                </>
              )}
            </div>

            {saveError ? (
              <p role="alert" className="border-l-2 border-rose-600 pl-3 text-sm text-rose-800">
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
                disabled={saving || !anyChange}
                className={btnSecondary}
              >
                Discard edits
              </button>
              <button type="button" onClick={() => void save(false)} disabled={!canSave} className={btnSecondary}>
                {saving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
                Save version only
              </button>
              <button type="button" onClick={() => setConfirmOpen(true)} disabled={!canSave} className={btnPrimary}>
                Save &amp; re-grade reports…
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
        eyebrow="Confirm re-grading"
        title={selected ? `Re-grade reports on ${selected.name} ${versionLabel(selected.version)}?` : "Re-grade reports?"}
        description="Each report is re-graded against the new version from the saved reading of its sheet; no sheet is read again."
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setConfirmOpen(false)} disabled={saving} className={btnSecondary}>
              Cancel
            </button>
            <button type="button" onClick={() => void save(true)} disabled={saving || !canSave} className={btnPrimary}>
              {saving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : null}
              {students !== null ? `Re-grade ${plural(students, "report")}` : "Re-grade reports"}
            </button>
          </div>
        }
      >
        {est ? (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 divide-slate-200 overflow-hidden rounded-md border border-slate-200 sm:grid-cols-4 sm:divide-x">
              {[
                ["Students", String(est.students), `${est.live_students} uploaded · ${est.demo_students} sample`],
                ["AI grading calls", String(est.evaluation_calls), "one per uploaded sheet"],
                ["Sheets read again", String(est.ocr_calls), "saved reading reused"],
                ["Estimated cost", inr(est.estimated_cost_inr), `${inr(est.estimated_cost_per_student_inr)} per student`],
              ].map(([label, value, hint]) => (
                <div key={label} className="border-b border-slate-200 px-3 py-2 sm:border-b-0">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="text-base font-semibold tabular-nums text-brand-navy">{value}</dd>
                  <dd className="text-xs text-slate-500">{hint}</dd>
                </div>
              ))}
            </dl>
            {est.basis ? <p className="text-xs text-slate-500">Basis: {est.basis}</p> : null}
            {est.demo_students > 0 ? (
              <p className="text-xs text-slate-500">
                Sample (demo) sheets are re-graded without an AI call, so they add no cost.
              </p>
            ) : null}
            {est.students === 0 ? (
              <p className="border-l-2 border-amber-500 pl-3 text-xs text-amber-900">
                No completed report uses this answer key yet - the new version is saved and nothing is re-graded.
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
            <p>Every completed report on this answer key will be re-graded; no sheet is read again.</p>
          </div>
        )}
        {saveError ? (
          <p role="alert" className="mt-3 border-l-2 border-rose-600 pl-3 text-sm text-rose-800">
            {saveError}
          </p>
        ) : null}
      </Dialog>
    </section>
  );
}
