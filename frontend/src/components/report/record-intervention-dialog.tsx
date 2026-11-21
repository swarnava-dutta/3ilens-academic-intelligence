"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useHealth } from "@/components/app-shell";
import { createIntervention, errorCode, errorMessage } from "@/lib/api";
import type { ContentSource, InterventionKind, InterventionRecord, Result } from "@/lib/types";
import { Modal, Notice, btnPrimary, btnSecondary, inputClass } from "./dialog";

export const KIND_LABELS: Record<InterventionKind, string> = {
  nudge: "Nudge",
  study_focus: "Study focus",
  class_intervention: "Class intervention",
  custom: "Custom",
};

const APPLIED_BY_KEY = "3ilens.intervention.appliedBy";
const DEFAULT_HOURS = 3;

const ERRORS: Record<string, string> = {
  invalid_state: "Interventions can be recorded only against a completed result.",
  unknown_topic: "That topic is not in this result's topic mastery.",
  unknown_submission: "This submission no longer exists. Reload the page.",
  invalid_applied_at: "The applied date cannot be in the future.",
};

function readAppliedBy(): string {
  try {
    return window.localStorage.getItem(APPLIED_BY_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberAppliedBy(name: string) {
  try {
    window.localStorage.setItem(APPLIED_BY_KEY, name);
  } catch {
    // Private mode / blocked storage: the name is just not remembered.
  }
}

/** Today in IST as YYYY-MM-DD (the date input's value). */
function todayIst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

/** Suggested action for a topic: its teaching nudge, else the ROI intervention's "teach" line. */
export function suggestedAction(result: Result, topic: string): { text: string; source: ContentSource } | null {
  const nudge = result.teaching_nudges.find((n) => n.topic === topic && n.text.trim());
  if (nudge) return { text: nudge.text.trim(), source: nudge.source };
  const roi = result.roi_recommendations.find((p) => p.topic === topic && p.intervention?.teach?.trim());
  if (roi?.intervention) return { text: roi.intervention.teach.trim(), source: roi.intervention.source };
  return null;
}

/**
 * "Record intervention" (FR-4.13): which teaching action was applied to one of this student's
 * topics. The baseline mastery and the illustrative predicted gain are captured server-side.
 */
export function RecordInterventionDialog({
  open,
  onClose,
  result,
  initialTopic,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  result: Result;
  initialTopic?: string | null;
  onRecorded: (record: InterventionRecord) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Intervention log"
      title="Record intervention"
      description={`${result.submission.student_name} · baseline: this result (${result.rubric.name} ${result.rubric.version})`}
      size="lg"
    >
      {open ? <RecordForm result={result} initialTopic={initialTopic} onClose={onClose} onRecorded={onRecorded} /> : null}
    </Modal>
  );
}

function RecordForm({
  result,
  initialTopic,
  onClose,
  onRecorded,
}: {
  result: Result;
  initialTopic?: string | null;
  onClose: () => void;
  onRecorded: (record: InterventionRecord) => void;
}) {
  const ids = useId();
  const defaultHours = useHealth().health?.intervention_default_hours;
  const topics = [...result.topic_mastery].sort((a, b) => a.mastery - b.mastery);
  const firstTopic = initialTopic && topics.some((t) => t.topic === initialTopic) ? initialTopic : (topics[0]?.topic ?? "");
  const firstSuggestion = suggestedAction(result, firstTopic);

  const [topic, setTopic] = useState(firstTopic);
  const [kind, setKind] = useState<InterventionKind>("study_focus");
  const [action, setAction] = useState(firstSuggestion?.text ?? "");
  const [suggestion, setSuggestion] = useState(firstSuggestion);
  const [appliedBy, setAppliedBy] = useState(readAppliedBy);
  const [appliedAt, setAppliedAt] = useState(todayIst);
  const [hours, setHours] = useState(() =>
    String(typeof defaultHours === "number" && Number.isFinite(defaultHours) && defaultHours >= 0 ? defaultHours : DEFAULT_HOURS),
  );
  const [complianceOn, setComplianceOn] = useState(false);
  const [compliance, setCompliance] = useState(70);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefilled = suggestion !== null && action.trim() === suggestion.text;
  const source: ContentSource = prefilled && suggestion ? suggestion.source : "faculty";

  function chooseTopic(next: string) {
    setTopic(next);
    // Replace the action only while it is still an untouched suggestion (or empty).
    const s = suggestedAction(result, next);
    if (!action.trim() || prefilled) setAction(s?.text ?? "");
    setSuggestion(s);
  }

  function validate(): string | null {
    if (!topic) return "Choose a topic.";
    if (!action.trim()) return "Describe the action that was applied.";
    if (action.trim().length > 1000) return "Action: at most 1000 characters.";
    if (!appliedBy.trim()) return "Enter who applied it.";
    if (appliedBy.trim().length > 120) return "Applied by: at most 120 characters.";
    const h = Number(hours);
    if (hours.trim() && (!Number.isFinite(h) || h < 0 || h > 100)) return "Hours must be between 0 and 100.";
    if (appliedAt && appliedAt > todayIst()) return "The applied date cannot be in the future.";
    if (note.length > 1000) return "Note: at most 1000 characters.";
    return null;
  }

  async function submit() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const record = await createIntervention({
        submission_id: result.submission.id,
        topic,
        kind,
        action: action.trim(),
        source,
        applied_by: appliedBy.trim(),
        // Today = now; an earlier date is recorded at noon IST.
        applied_at: !appliedAt || appliedAt === todayIst() ? null : `${appliedAt}T12:00:00+05:30`,
        hours: hours.trim() ? Number(hours) : null,
        compliance: complianceOn ? compliance / 100 : null,
        note: note.trim() || null,
      });
      rememberAppliedBy(appliedBy.trim());
      onRecorded(record);
    } catch (err) {
      const code = errorCode(err);
      setError((code && ERRORS[code]) || errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${ids}-topic`} className="text-sm font-medium text-slate-700">
            Topic
          </label>
          <select id={`${ids}-topic`} className={inputClass} value={topic} onChange={(e) => chooseTopic(e.target.value)}>
            {topics.map((t) => (
              <option key={t.topic} value={t.topic}>
                {t.topic} ({Math.round(t.mastery)}%)
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${ids}-kind`} className="text-sm font-medium text-slate-700">
            Kind
          </label>
          <select
            id={`${ids}-kind`}
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as InterventionKind)}
          >
            {(Object.keys(KIND_LABELS) as InterventionKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${ids}-action`} className="text-sm font-medium text-slate-700">
          Action applied
        </label>
        <textarea
          id={`${ids}-action`}
          className={inputClass}
          rows={4}
          maxLength={1000}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="What was done, e.g. two worked examples on X-linked crosses plus 10 practice items"
        />
        <p className="text-xs text-slate-500">
          {prefilled
            ? `Prefilled from the report's ${suggestion?.source === "ai" ? "model" : "rule-template"} suggestion - recorded as source "${source}" unless you edit it.`
            : suggestion
              ? 'Edited - recorded as source "faculty".'
              : 'No suggestion for this topic - recorded as source "faculty".'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor={`${ids}-by`} className="text-sm font-medium text-slate-700">
            Applied by
          </label>
          <input
            id={`${ids}-by`}
            className={inputClass}
            maxLength={120}
            value={appliedBy}
            onChange={(e) => setAppliedBy(e.target.value)}
            placeholder="e.g. Ms. K. Menon"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${ids}-at`} className="text-sm font-medium text-slate-700">
            Applied on
          </label>
          <input
            id={`${ids}-at`}
            type="date"
            className={inputClass}
            max={todayIst()}
            value={appliedAt}
            onChange={(e) => setAppliedAt(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${ids}-hours`} className="text-sm font-medium text-slate-700">
            Hours
          </label>
          <input
            id={`${ids}-hours`}
            type="number"
            min={0}
            max={100}
            step={0.5}
            className={inputClass}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium text-slate-700">Compliance (optional)</legend>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={complianceOn}
            onChange={(e) => setComplianceOn(e.target.checked)}
            className="h-4 w-4 rounded-sm border-slate-300 accent-brand-cyan-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
          />
          Record how much of the plan the student completed
        </label>
        <div className="flex items-center gap-3">
          <label htmlFor={`${ids}-compliance`} className="sr-only">
            Compliance percentage
          </label>
          <input
            id={`${ids}-compliance`}
            type="range"
            min={0}
            max={100}
            step={5}
            disabled={!complianceOn}
            value={compliance}
            onChange={(e) => setCompliance(Number(e.target.value))}
            className="w-full accent-brand-cyan-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan disabled:opacity-50"
          />
          <span className="w-24 shrink-0 text-right text-sm tabular-nums text-slate-700">
            {complianceOn ? `${compliance}%` : "not recorded"}
          </span>
        </div>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor={`${ids}-note`} className="text-sm font-medium text-slate-700">
          Note <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id={`${ids}-note`}
          className={inputClass}
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnSecondary} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={btnPrimary} disabled={busy || topics.length === 0}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {busy ? "Recording…" : "Record intervention"}
        </button>
      </div>
    </form>
  );
}
