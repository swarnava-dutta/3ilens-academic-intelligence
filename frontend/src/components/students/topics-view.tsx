"use client";

import { ChevronDown, Loader2, Users } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import { ShareBar } from "@/components/charts/sparkline";
import { Modal, Notice, btnPrimary, btnSecondary, inputClass } from "@/components/report/dialog";
import { createIntervention, errorCode, errorMessage, getInterventions } from "@/lib/api";
import { pct1 } from "@/lib/format";
import type { InterventionRecord, RosterRow, RosterTopic, RosterTopicStudent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { OutcomeChip } from "./bits";
import { fmtDay, fmtMarks, masteryFill, rowKey, todayIst, WEAK_MASTERY } from "./format";
import { appliedAtFor, INTERVENTION_ERRORS, readAppliedBy, rememberAppliedBy } from "./log-action-dialog";

const TH = "px-3 py-2 text-left text-xs font-medium text-slate-500";
const TD = "px-3 py-2.5 align-top text-sm text-slate-700";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase();
const studentKey = (s: { student_ref: string; is_demo: boolean }) => rowKey(s);

type Records = { key: string; data: InterventionRecord[] } | { key: string; error: string };

function improvedShare(t: RosterTopic): string {
  if (t.actions_logged === 0) return "—";
  return `${t.actions_logged} · ${t.actions_improved} improved`;
}

function TopicStudents({
  topic,
  records,
  rowsByKey,
  onOpen,
}: {
  topic: RosterTopic;
  records: Records | null;
  rowsByKey: Map<string, RosterRow>;
  onOpen: (row: RosterRow, opener: HTMLElement) => void;
}) {
  const lastAction = (s: RosterTopicStudent): InterventionRecord | null => {
    if (!records || "error" in records) return null;
    return (
      records.data.find(
        (r) => r.student_ref === s.student_ref && r.is_demo === s.is_demo && norm(r.topic) === norm(topic.topic),
      ) ?? null
    );
  };
  if (topic.students_below.length === 0) {
    return <p className="text-sm text-slate-500">Nobody is below {WEAK_MASTERY}% in {topic.topic}.</p>;
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
      {topic.students_below.map((s) => {
        const row = rowsByKey.get(studentKey(s));
        const last = lastAction(s);
        return (
          <li key={studentKey(s)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[13px]">
            <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-sm", masteryFill(s.mastery))} />
            {row ? (
              <button
                type="button"
                onClick={(e) => onOpen(row, e.currentTarget)}
                className="min-w-0 truncate rounded-sm text-left font-medium text-brand-navy hover:text-brand-cyan-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
              >
                {s.student_name}
              </button>
            ) : (
              <span className="min-w-0 truncate font-medium text-slate-800">{s.student_name}</span>
            )}
            <span className="tabular-nums text-slate-700">{pct1(s.mastery)}</span>
            <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
              {records === null ? (
                "…"
              ) : "error" in records ? (
                "actions unavailable"
              ) : last ? (
                <>
                  {fmtDay(last.applied_at)}
                  <OutcomeChip status={last.outcome_status} change={last.outcome?.mastery_change ?? null} />
                </>
              ) : (
                "no action on this topic"
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Topics in scope, most students below 60% first; each row expands to its students. */
export function TopicsView({
  topics,
  rows,
  batchId,
  refreshKey,
  onOpen,
  onLogged,
}: {
  topics: RosterTopic[];
  rows: RosterRow[];
  batchId: number | null;
  refreshKey: number;
  onOpen: (row: RosterRow, opener: HTMLElement) => void;
  onLogged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [classTopic, setClassTopic] = useState<RosterTopic | null>(null);
  const recordsKey = `${batchId ?? "all"}#${refreshKey}`;
  const [records, setRecords] = useState<Records | null>(null);

  useEffect(() => {
    let cancelled = false;
    getInterventions({ batch_id: batchId })
      .then((data) => !cancelled && setRecords({ key: recordsKey, data: Array.isArray(data) ? data : [] }))
      .catch((err) => !cancelled && setRecords({ key: recordsKey, error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [batchId, recordsKey]);

  const current = records?.key === recordsKey ? records : null;
  const rowsByKey = new Map(rows.map((r) => [rowKey(r), r]));
  // Chapter topics first (most students below 60% first, the Shared gaps order); whole-subject rows
  // from papers without topic tags go in their own group at the end.
  const sorted = [...topics].sort(
    (a, b) =>
      Number(a.subject_level) - Number(b.subject_level) ||
      b.below_60 - a.below_60 ||
      (a.mean_mastery ?? 101) - (b.mean_mastery ?? 101) ||
      a.topic.localeCompare(b.topic, undefined, { sensitivity: "base" }),
  );
  const firstSubject = sorted.findIndex((t) => t.subject_level);
  const SUBJECT_GROUP = "Whole-subject scores - these papers had no topic tags";
  const graded = rows.filter((r) => r.latest).length;

  if (sorted.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600">
        No topic breakdown yet - topics appear once a paper in this scope is graded.
      </p>
    );
  }

  const toggle = (topic: string) => setOpen((v) => (v === topic ? null : topic));
  const classButton = (t: RosterTopic) =>
    t.below_60 > 0 ? (
      <button
        type="button"
        onClick={() => setClassTopic(t)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-[13px] font-medium text-slate-700 transition-colors duration-150 hover:border-brand-cyan hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
      >
        <Users className="h-4 w-4" aria-hidden />
        Log class action for these {t.below_60}
      </button>
    ) : null;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-slate-600">
        Each student counts once, on their latest graded paper ({graded} student{graded === 1 ? "" : "s"} in scope).
        Marks lost = penalties for wrong answers on negatively marked MCQs.
      </p>

      {/* Tablet and desktop: a table; each row expands to the students below 60%. */}
      <div className="hidden overflow-hidden rounded-md border border-slate-200 bg-white sm:block print:block">
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">Topics by how many students are below {WEAK_MASTERY}% on their latest paper</caption>
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th scope="col" className={cn(TH, "w-[26%]")}>
                Topic
              </th>
              <th scope="col" className={cn(TH, "hidden md:table-cell")}>
                Subject
              </th>
              <th scope="col" className={cn(TH, "w-[22%]")}>
                Below {WEAK_MASTERY}%
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Mean mastery
              </th>
              <th scope="col" className={cn(TH, "text-right")}>
                Marks lost
              </th>
              <th scope="col" className={TH}>
                Actions logged
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((t, i) => {
              const expandable = t.students_below.length > 0;
              const expanded = expandable && open === t.topic;
              return (
                <Fragment key={t.topic}>
                  {i === firstSubject ? (
                    <tr className="bg-slate-50">
                      <th scope="colgroup" colSpan={6} className="px-3 py-1.5 text-left text-xs font-medium text-slate-600">
                        {SUBJECT_GROUP}
                      </th>
                    </tr>
                  ) : null}
                  <tr className={cn(expanded && "bg-slate-50/70")}>
                    <th scope="row" className={cn(TD, "text-left font-normal")}>
                      {expandable ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => toggle(t.topic)}
                          className="flex max-w-full items-center gap-1.5 rounded-sm text-left font-medium text-brand-navy hover:text-brand-cyan-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                        >
                          <ChevronDown
                            className={cn("h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none", !expanded && "-rotate-90")}
                            aria-hidden
                          />
                          <span className="truncate">{t.topic}</span>
                        </button>
                      ) : (
                        <span className="flex max-w-full items-center gap-1.5 pl-5 font-medium text-slate-800">
                          <span className="truncate">{t.topic}</span>
                        </span>
                      )}
                      <p className="pl-5 text-xs text-slate-500 md:hidden">{t.subject}</p>
                    </th>
                    <td className={cn(TD, "hidden md:table-cell")}>{t.subject || "—"}</td>
                    <td className={cn(TD, "tabular-nums")}>
                      {t.tested ? (
                        <>
                          {t.below_60} of {t.tested}
                          <ShareBar value={t.below_60} max={t.tested} className="mt-1 max-w-32" />
                        </>
                      ) : (
                        <span className="text-slate-500">not tested</span>
                      )}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums")}>{pct1(t.mean_mastery)}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{t.marks_lost > 0 ? fmtMarks(t.marks_lost) : "—"}</td>
                    <td className={cn(TD, "tabular-nums")}>{improvedShare(t)}</td>
                  </tr>
                  {expanded ? (
                    <tr className="bg-slate-50/70">
                      <td colSpan={6} className="px-3 pb-3">
                        <div className="space-y-2 md:pl-5">
                          <TopicStudents topic={t} records={current} rowsByKey={rowsByKey} onOpen={onOpen} />
                          {classButton(t)}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phones: stacked cards. */}
      <ul className="space-y-2 sm:hidden print:hidden" aria-label="Topics">
        {sorted.map((t, i) => {
          const expandable = t.students_below.length > 0;
          const expanded = expandable && open === t.topic;
          return (
            <Fragment key={t.topic}>
            {i === firstSubject ? <li className="px-1 pt-2 text-xs font-medium text-slate-600">{SUBJECT_GROUP}</li> : null}
            <li className="rounded-md border border-slate-200 bg-white">
              <button
                type="button"
                aria-expanded={expandable ? expanded : undefined}
                disabled={!expandable}
                onClick={() => toggle(t.topic)}
                className="block w-full px-4 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-cyan disabled:cursor-default"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-brand-navy">{t.topic}</span>
                    <span className="block text-xs text-slate-500">{t.subject}</span>
                  </span>
                  {expandable ? (
                    <ChevronDown
                      className={cn("mt-0.5 h-4 w-4 shrink-0 text-slate-500 transition-transform", expanded && "rotate-180")}
                      aria-hidden
                    />
                  ) : null}
                </span>
                <span className="mt-1.5 block text-[13px] tabular-nums text-slate-700">
                  {t.tested ? `${t.below_60} of ${t.tested} below ${WEAK_MASTERY}%` : "not tested"} · mean{" "}
                  {pct1(t.mean_mastery)}
                </span>
                {t.tested ? <ShareBar value={t.below_60} max={t.tested} className="mt-1.5" /> : null}
                <span className="mt-1 block text-xs tabular-nums text-slate-500">
                  Marks lost {t.marks_lost > 0 ? fmtMarks(t.marks_lost) : "—"} · actions {improvedShare(t)}
                </span>
              </button>
              {expanded ? (
                <div className="space-y-2 border-t border-slate-200 p-3">
                  <TopicStudents topic={t} records={current} rowsByKey={rowsByKey} onOpen={onOpen} />
                  {classButton(t)}
                </div>
              ) : null}
            </li>
            </Fragment>
          );
        })}
      </ul>

      <ClassActionDialog
        topic={classTopic}
        rowsByKey={rowsByKey}
        onClose={() => setClassTopic(null)}
        onDone={onLogged}
      />
    </div>
  );
}

type Progress = { done: number; total: number; failed: { name: string; message: string }[]; finished: boolean };

/** One action for every student below 60% in a topic: one record each, against their latest paper. */
function ClassActionDialog({
  topic,
  rowsByKey,
  onClose,
  onDone,
}: {
  topic: RosterTopic | null;
  rowsByKey: Map<string, RosterRow>;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal
      open={topic !== null}
      onClose={onClose}
      eyebrow="Class intervention"
      title={topic ? `Log a class action · ${topic.topic}` : "Log a class action"}
      description={topic ? `${topic.below_60} students below ${WEAK_MASTERY}% on their latest paper` : undefined}
      size="lg"
    >
      {topic ? <ClassActionForm key={topic.topic} topic={topic} rowsByKey={rowsByKey} onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

function ClassActionForm({
  topic,
  rowsByKey,
  onClose,
  onDone,
}: {
  topic: RosterTopic;
  rowsByKey: Map<string, RosterRow>;
  onClose: () => void;
  onDone: () => void;
}) {
  const ids = useId();
  const [action, setAction] = useState(`10-min re-teach of ${topic.topic} + 5 unseen questions, checked in class`);
  const [appliedBy, setAppliedBy] = useState(readAppliedBy);
  const [appliedAt, setAppliedAt] = useState(todayIst);
  const [hours, setHours] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const targets = topic.students_below
    .map((s) => ({ s, row: rowsByKey.get(rowKey(s)) }))
    .filter((t): t is { s: RosterTopicStudent; row: RosterRow } => !!t.row?.latest);
  const busy = progress !== null && !progress.finished;

  async function submit() {
    if (!action.trim()) return setError("Describe the action.");
    if (!appliedBy.trim()) return setError("Enter who applied it.");
    const h = Number(hours);
    if (hours.trim() && (!Number.isFinite(h) || h <= 0 || h > 100)) return setError("Hours must be more than 0 and at most 100.");
    if (appliedAt && appliedAt > todayIst()) return setError("The date cannot be in the future.");
    setError(null);
    rememberAppliedBy(appliedBy.trim());
    const failed: Progress["failed"] = [];
    setProgress({ done: 0, total: targets.length, failed, finished: false });
    for (let i = 0; i < targets.length; i++) {
      const { s, row } = targets[i];
      try {
        if (!row.latest) throw new Error("No graded paper.");
        await createIntervention({
          submission_id: row.latest.submission_id,
          topic: topic.topic,
          kind: "class_intervention",
          action: action.trim(),
          source: "faculty",
          applied_by: appliedBy.trim(),
          applied_at: appliedAtFor(appliedAt, row.latest.date),
          hours: hours.trim() ? Number(hours) : null,
          compliance: null,
          note: null,
        });
      } catch (err) {
        const code = errorCode(err);
        failed.push({ name: s.student_name, message: (code && INTERVENTION_ERRORS[code]) || errorMessage(err) });
      }
      setProgress({ done: i + 1, total: targets.length, failed: [...failed], finished: i + 1 === targets.length });
    }
    if (targets.length === 0) setProgress({ done: 0, total: 0, failed, finished: true });
    onDone();
  }

  if (progress?.finished) {
    const ok = progress.total - progress.failed.length;
    return (
      <div className="space-y-3">
        <Notice tone={progress.failed.length ? "warn" : "ok"}>
          Logged for {ok} of {progress.total} students.
          {progress.failed.length ? ` ${progress.failed.length} could not be logged:` : ""}
        </Notice>
        {progress.failed.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-slate-700">
            {progress.failed.map((f) => (
              <li key={f.name}>
                {f.name}: {f.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end">
          <button type="button" className={btnPrimary} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13px] text-slate-600">
        One record per student ({targets.length}), each against that student&apos;s latest paper, so the outcome is
        measured on their next paper that covers {topic.topic}:{" "}
        {targets.map((t) => t.s.student_name).join(", ")}.
      </p>
      <div className="space-y-1">
        <label htmlFor={`${ids}-action`} className="text-sm font-medium text-slate-700">
          Action
        </label>
        <textarea
          id={`${ids}-action`}
          className={inputClass}
          rows={3}
          maxLength={1000}
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
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
            className={inputClass}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {busy && progress ? (
        <p className="flex items-center gap-2 text-sm text-slate-600" role="status">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          Logging {progress.done} of {progress.total}…
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btnSecondary} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={btnPrimary} disabled={busy || targets.length === 0}>
          Log for {targets.length} student{targets.length === 1 ? "" : "s"}
        </button>
      </div>
    </form>
  );
}
