"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { createIntervention, errorMessage } from "@/lib/api";
import { plural } from "@/lib/format";
import type { CohortChapter } from "@/lib/types";
import { btnPrimary, btnSecondary, Dialog, fieldClass } from "./dialog";
import { formatPct, RETEACH_LINE } from "./format";

export const DEFAULT_CLASS_ACTION = "10-min re-teach + 5 unseen questions";

export interface LogTarget {
  chapter: CohortChapter;
  /** Faculty lead of the batch (prefilled; editable). */
  taughtBy: string;
  /** yyyy-mm-dd, set when the dialog is opened. */
  today: string;
}

/** Local yyyy-mm-dd (call from an event handler, never during render). */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function LogForm({
  target,
  onClose,
  onLogged,
}: {
  target: LogTarget;
  onClose: () => void;
  onLogged: (count: number) => void;
}) {
  const { chapter } = target;
  const [action, setAction] = useState(DEFAULT_CLASS_ACTION);
  const [taughtBy, setTaughtBy] = useState(target.taughtBy);
  const [date, setDate] = useState(target.today);
  const [checked, setChecked] = useState<Set<number>>(() => new Set(chapter.below_60_students.map((s) => s.submission_id)));
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([]);
  const [done, setDone] = useState<Set<number>>(() => new Set());

  const pending = chapter.below_60_students.filter((s) => checked.has(s.submission_id) && !done.has(s.submission_id));
  const formId = `log-${chapter.topic.replace(/\W+/g, "-")}`;

  async function submit() {
    if (!pending.length || !action.trim() || !taughtBy.trim()) return;
    setSaving(true);
    setFailures([]);
    const appliedAt = date && date !== target.today ? `${date}T10:00:00+05:30` : null;
    const failed: { name: string; message: string }[] = [];
    const ok = new Set(done);
    for (const student of pending) {
      try {
        await createIntervention({
          submission_id: student.submission_id,
          topic: chapter.topic,
          kind: "class_intervention",
          action: action.trim(),
          source: "faculty",
          applied_by: taughtBy.trim(),
          applied_at: appliedAt,
          hours: null,
          compliance: null,
          note: null,
        });
        ok.add(student.submission_id);
      } catch (err) {
        failed.push({ name: student.student_name, message: errorMessage(err) });
      }
    }
    setDone(ok);
    setFailures(failed);
    setSaving(false);
    const logged = ok.size - done.size;
    if (!failed.length) onLogged(ok.size);
    else if (logged > 0) onLogged(-logged); // partial: keep the dialog open with the failures listed
  }

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Class intervention"
      title={`Log a re-teach: ${chapter.topic}`}
      description={`${plural(chapter.below_60, "student")} below ${RETEACH_LINE}% in this chapter. The change is measured at each student's next test.`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className={btnSecondary}>
            {done.size ? "Close" : "Cancel"}
          </button>
          <button
            type="submit"
            form={formId}
            disabled={saving || !pending.length || !action.trim() || !taughtBy.trim()}
            className={btnPrimary}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {failures.length && done.size ? "Retry the rest" : `Log for ${plural(pending.length, "student")}`}
          </button>
        </div>
      }
    >
      <form
        id={formId}
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-action`} className="block text-[13px] font-medium text-slate-700">
            What you will do
          </label>
          <textarea
            id={`${formId}-action`}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            rows={2}
            maxLength={1000}
            className={`${fieldClass} h-auto py-2`}
          />
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-slate-700">
            Students ({checked.size} of {chapter.below_60_students.length} selected)
          </legend>
          <ul className="mt-1.5 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
            {chapter.below_60_students.map((s) => (
              <li key={s.submission_id}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={checked.has(s.submission_id)}
                    disabled={done.has(s.submission_id)}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(s.submission_id);
                        else next.delete(s.submission_id);
                        return next;
                      })
                    }
                    className="h-4 w-4 accent-brand-navy"
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-800">{s.student_name}</span>
                  <span className="text-xs tabular-nums text-slate-500">
                    {done.has(s.submission_id) ? "logged" : formatPct(s.mastery)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-by`} className="block text-[13px] font-medium text-slate-700">
              Taught by
            </label>
            <input
              id={`${formId}-by`}
              value={taughtBy}
              onChange={(e) => setTaughtBy(e.target.value)}
              maxLength={120}
              required
              className={fieldClass}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${formId}-date`} className="block text-[13px] font-medium text-slate-700">
              Date
            </label>
            <input
              id={`${formId}-date`}
              type="date"
              value={date}
              max={target.today}
              onChange={(e) => setDate(e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>
        {failures.length ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
            <p className="font-medium">
              {done.size ? `Logged for ${plural(done.size, "student")}; ` : ""}
              {plural(failures.length, "student")} could not be logged:
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {failures.map((f) => (
                <li key={f.name}>
                  {f.name}: {f.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * "Log class intervention" for one chapter: one intervention record per checked student (kind
 * class_intervention, on their sheet in this test), so the effect shows at their next test.
 */
export function LogInterventionDialog({
  target,
  onClose,
  onLogged,
}: {
  target: LogTarget | null;
  onClose: () => void;
  /** count > 0: all logged (the dialog closes); count < 0: some logged, some failed. */
  onLogged: (count: number) => void;
}) {
  if (!target) return null;
  return <LogForm key={target.chapter.topic} target={target} onClose={onClose} onLogged={onLogged} />;
}
