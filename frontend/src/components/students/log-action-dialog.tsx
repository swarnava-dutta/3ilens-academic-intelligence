"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Modal, Notice, btnPrimary, btnSecondary, inputClass } from "@/components/report/dialog";
import { createIntervention, errorCode, errorMessage } from "@/lib/api";
import { pct1 } from "@/lib/format";
import type { ContentSource, InterventionKind, InterventionRecord, RosterRow, TeachingNudge } from "@/lib/types";
import { fmtDay, isoDay, KIND_LABELS, shortOf, todayIst } from "./format";

/** Same key as the report's Record-intervention dialog, so the name is remembered across both. */
const APPLIED_BY_KEY = "3ilens.intervention.appliedBy";

export const INTERVENTION_ERRORS: Record<string, string> = {
  invalid_state: "Actions can be logged only against a graded result.",
  unknown_topic: "That topic is not in this student's latest result.",
  unknown_submission: "This sheet no longer exists. Refresh the page.",
  invalid_applied_at: "The date cannot be in the future.",
};

export function readAppliedBy(): string {
  try {
    return window.localStorage.getItem(APPLIED_BY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberAppliedBy(name: string) {
  try {
    window.localStorage.setItem(APPLIED_BY_KEY, name);
  } catch {
    // Private mode / blocked storage: the name is just not remembered.
  }
}

/** "Today" = now; an earlier day is recorded at noon IST - except on the latest paper's own upload
 * day, where it is recorded just after the upload (an action logged for that day is meant to count
 * as "since the latest paper", even when the sheet was uploaded in the afternoon). */
export function appliedAtFor(day: string, latestDate?: string | null): string | null {
  if (!day || day === todayIst()) return null;
  const noon = `${day}T12:00:00+05:30`;
  if (latestDate && isoDay(latestDate) === day) {
    const after = new Date(new Date(latestDate).getTime() + 1000);
    if (!Number.isNaN(after.getTime()) && after.getTime() > new Date(noon).getTime()) return after.toISOString();
  }
  return noon;
}

/** What opened the dialog: a student, optionally a topic and a nudge to prefill from. */
export interface LogTarget {
  row: RosterRow;
  topic?: string | null;
  nudge?: TeachingNudge | null;
}

function nudgeFor(row: RosterRow, topic: string): TeachingNudge | null {
  return row.nudges.find((n) => n.topic === topic && n.text.trim()) ?? null;
}

/**
 * "Log action" from the students page: one teaching action on one of the student's topics,
 * recorded against their latest graded paper (POST /api/interventions; the baseline mastery and
 * the illustrative predicted gain are captured server-side).
 */
export function LogActionDialog({
  target,
  onClose,
  onRecorded,
}: {
  target: LogTarget | null;
  onClose: () => void;
  onRecorded: (record: InterventionRecord) => void;
}) {
  const latest = target?.row.latest ?? null;
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      eyebrow="Intervention log"
      title={target ? `Log action · ${target.row.student_name}` : "Log action"}
      description={latest ? `Baseline: ${latest.test_name} (uploaded ${fmtDay(latest.date)})` : undefined}
      size="lg"
    >
      {target && latest ? (
        <LogForm
          key={`${target.row.student_ref}:${target.topic ?? ""}:${target.nudge?.label ?? ""}`}
          target={target}
          onClose={onClose}
          onRecorded={onRecorded}
        />
      ) : target ? (
        <Notice tone="info">This student has no graded paper yet, so there is no baseline to log an action against.</Notice>
      ) : null}
    </Modal>
  );
}

function LogForm({
  target,
  onClose,
  onRecorded,
}: {
  target: LogTarget;
  onClose: () => void;
  onRecorded: (record: InterventionRecord) => void;
}) {
  const ids = useId();
  const { row } = target;
  const topics = row.topics; // weakest first
  // The context's topic; else the top teaching nudge's topic (so the action comes prefilled); else the weakest.
  const wanted =
    target.topic ??
    target.nudge?.topic ??
    row.nudges.find((n) => n.topic && n.text.trim() && topics.some((t) => t.topic === n.topic))?.topic ??
    null;
  const firstTopic = wanted && topics.some((t) => t.topic === wanted) ? wanted : (topics[0]?.topic ?? "");
  const firstNudge = target.nudge ?? nudgeFor(row, firstTopic);

  const [topic, setTopic] = useState(firstTopic);
  const [kind, setKind] = useState<InterventionKind>(target.nudge ? "nudge" : "study_focus");
  const [action, setAction] = useState(firstNudge?.text.trim() ?? "");
  const [suggestion, setSuggestion] = useState<TeachingNudge | null>(firstNudge);
  const [appliedBy, setAppliedBy] = useState(readAppliedBy);
  const [appliedAt, setAppliedAt] = useState(todayIst);
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefilled = suggestion !== null && action.trim() === suggestion.text.trim();
  const source: ContentSource = prefilled && suggestion ? suggestion.source : "faculty";
  const mastery = topics.find((t) => t.topic === topic)?.mastery;

  function chooseTopic(next: string) {
    setTopic(next);
    const s = nudgeFor(row, next);
    if (!action.trim() || prefilled) setAction(s?.text.trim() ?? "");
    setSuggestion(s);
  }

  function validate(): string | null {
    if (!topic) return "Choose a topic.";
    if (!action.trim()) return "Describe the action.";
    if (action.trim().length > 1000) return "Action: at most 1000 characters.";
    if (!appliedBy.trim()) return "Enter who applied it.";
    if (appliedBy.trim().length > 120) return "Applied by: at most 120 characters.";
    const h = Number(hours);
    if (hours.trim() && (!Number.isFinite(h) || h <= 0 || h > 100)) return "Hours must be more than 0 and at most 100.";
    if (appliedAt && appliedAt > todayIst()) return "The date cannot be in the future.";
    return null;
  }

  async function submit() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (!row.latest) return;
    setBusy(true);
    setError(null);
    try {
      const record = await createIntervention({
        submission_id: row.latest.submission_id,
        topic,
        kind,
        action: action.trim(),
        source,
        applied_by: appliedBy.trim(),
        applied_at: appliedAtFor(appliedAt, row.latest.date),
        hours: hours.trim() ? Number(hours) : null,
        compliance: null,
        note: null,
      });
      rememberAppliedBy(appliedBy.trim());
      onRecorded(record);
    } catch (err) {
      const code = errorCode(err);
      setError((code && INTERVENTION_ERRORS[code]) || errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (topics.length === 0) {
    return <Notice tone="info">The latest paper has no topic breakdown, so an action cannot be tied to a topic.</Notice>;
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
                {t.topic} ({pct1(t.mastery)})
              </option>
            ))}
          </select>
          {mastery !== undefined ? (
            <p className="text-xs text-slate-500">Baseline mastery {pct1(mastery)} on the latest paper.</p>
          ) : null}
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
          Action
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
            ? "Prefilled from the teaching nudge for this topic - edit it to describe what was actually done."
            : suggestion
              ? "Edited - recorded as written by faculty."
              : "No nudge for this topic - describe the action."}
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
            Date
          </label>
          <input
            id={`${ids}-at`}
            type="date"
            className={inputClass}
            max={todayIst()}
            value={appliedAt}
            onChange={(e) => setAppliedAt(e.target.value)}
          />
          {row.latest && appliedAt && appliedAt < isoDay(row.latest.date) ? (
            <p className="text-xs text-amber-800">
              Before {shortOf(row.latest)} (uploaded {fmtDay(row.latest.date)}): it will not count as an action since the
              latest paper.
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <label htmlFor={`${ids}-hours`} className="text-sm font-medium text-slate-700">
            Hours <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id={`${ids}-hours`}
            type="number"
            min={0.5}
            max={100}
            step={0.5}
            inputMode="decimal"
            className={inputClass}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnSecondary} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={btnPrimary} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {busy ? "Logging…" : "Log action"}
        </button>
      </div>
    </form>
  );
}
