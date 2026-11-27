"use client";

import { useState } from "react";
import { BadgeCheck, Loader2 } from "lucide-react";
import { errorMessage, releaseResult } from "@/lib/api";
import { btnPrimary, btnSecondary, Dialog, fieldClass } from "./dialog";
import { pct1, plural } from "./format";

export interface ReleaseTarget {
  submission_id: number;
  student_name: string;
  pct: number;
}

function ReleaseForm({
  rows,
  isDemo,
  onClose,
  onReleased,
}: {
  rows: ReleaseTarget[];
  isDemo: boolean;
  onClose: () => void;
  onReleased: (count: number) => void;
}) {
  const [reviewer, setReviewer] = useState("");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([]);
  const pending = rows.filter((r) => !done.has(r.submission_id));

  async function submit() {
    const name = reviewer.trim();
    if (!name || !checked || !pending.length) return;
    setSaving(true);
    setFailures([]);
    const ok = new Set(done);
    const failed: { name: string; message: string }[] = [];
    for (const row of pending) {
      try {
        await releaseResult(row.submission_id, { reviewer_name: name, note: null });
        ok.add(row.submission_id);
      } catch (err) {
        failed.push({ name: row.student_name, message: errorMessage(err) });
      }
    }
    const released = ok.size - done.size;
    setDone(ok);
    setFailures(failed);
    setSaving(false);
    if (released > 0) onReleased(failed.length ? -released : ok.size);
  }

  const formId = "release-reports";
  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Academic release"
      title={`Release ${plural(rows.length, "report")}`}
      description="Released reports are no longer marked provisional. Each can be revoked from its report page."
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className={btnSecondary}>
            {done.size ? "Close" : "Cancel"}
          </button>
          <button
            type="submit"
            form={formId}
            disabled={saving || !pending.length || !checked || !reviewer.trim()}
            className={btnPrimary}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <BadgeCheck className="h-4 w-4" aria-hidden />}
            {failures.length && done.size ? "Retry the rest" : `Release ${plural(pending.length, "report")}`}
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
        <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
          {rows.map((r) => (
            <li key={r.submission_id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate text-slate-800">{r.student_name}</span>
              <span className="text-xs tabular-nums text-slate-600">
                {done.has(r.submission_id) ? "released" : pct1(r.pct)}
              </span>
            </li>
          ))}
        </ul>
        {isDemo ? (
          <p className="text-xs text-slate-600">Synthetic demo sheets: releasing them only demonstrates the gate.</p>
        ) : null}
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-by`} className="block text-[13px] font-medium text-slate-700">
            Reviewer name
          </label>
          <input
            id={`${formId}-by`}
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            maxLength={120}
            required
            autoComplete="name"
            className={fieldClass}
          />
        </div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-brand-navy"
          />
          <span className="text-slate-700">I have checked these marks and the answer key; release them to students.</span>
        </label>
        {failures.length ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
            <p className="font-medium">
              {done.size ? `Released ${plural(done.size, "report")}; ` : ""}
              {plural(failures.length, "report")} could not be released:
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

/** Bulk academic release of the provisional reports in view: a named reviewer and a confirm. */
export function ReleaseDialog({
  rows,
  isDemo,
  onClose,
  onReleased,
}: {
  rows: ReleaseTarget[] | null;
  isDemo: boolean;
  onClose: () => void;
  /** count > 0: all released (the dialog closes); count < 0: some released, some failed. */
  onReleased: (count: number) => void;
}) {
  if (!rows || rows.length === 0) return null;
  return <ReleaseForm rows={rows} isDemo={isDemo} onClose={onClose} onReleased={onReleased} />;
}
