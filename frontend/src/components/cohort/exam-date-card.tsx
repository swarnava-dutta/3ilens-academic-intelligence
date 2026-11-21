"use client";

import { useState } from "react";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { useHealth } from "@/components/app-shell";
import { errorCode, errorMessage, errorStatus, updateBatch } from "@/lib/api";
import type { Batch, StrategyMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { btnPrimary, btnSecondary, fieldClass } from "./dialog";
import { batchLabel } from "./format";

export const STRATEGY_LOOK: Record<StrategyMode, { label: string; range: string; text: string; className: string }> = {
  broad: {
    label: "Broad",
    range: "90+ days",
    text: "Time to learn weak chapters from scratch: cover high-weightage gaps broadly.",
    className: "border-slate-300 text-slate-700",
  },
  focused: {
    label: "Focused",
    range: "30-89 days",
    text: "Concentrate on the top ROI chapters; drill rather than re-learn.",
    className: "border-brand-cyan/40 text-brand-cyan-600",
  },
  revision: {
    label: "Revision",
    range: "7-29 days",
    text: "Revise and fix recurring errors; no new chapters.",
    className: "border-amber-300 text-amber-800",
  },
  consolidation: {
    label: "Consolidation",
    range: "0-6 days",
    text: "Consolidate strengths, light review, rest.",
    className: "border-red-200 text-red-700",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "not set";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Exam date of the (filtered) batch: days to exam drive the study-plan strategy mode. */
export function ExamDateCard({ batch, onSaved }: { batch: Batch; onSaved: () => Promise<void> | void }) {
  const { refresh: refreshHealth } = useHealth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(batch.exam_date ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strategy = batch.strategy_mode ? STRATEGY_LOOK[batch.strategy_mode] : null;
  const days = batch.days_to_exam;
  const exam = batch.exam || batch.exam_type || "NEET";

  async function save(examDate: string | null) {
    setSaving(true);
    setError(null);
    try {
      await updateBatch(batch.id, { exam_date: examDate });
      setEditing(false);
      await Promise.all([onSaved(), refreshHealth()]);
    } catch (err) {
      const status = errorStatus(err);
      setError(
        !errorCode(err) && (status === 404 || status === 405)
          ? "Editing the exam date is not available on this API build yet."
          : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card aria-labelledby="cohort-exam-title" className="p-4 sm:p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start">
          <div className="min-w-0">
            <h2 id="cohort-exam-title" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold text-brand-navy">
              {exam} exam
              <span className="font-normal text-slate-500">· {batchLabel(batch)}</span>
              {batch.exam_date_assumed ? (
                <span
                  className="rounded-sm border border-slate-300 px-1.5 text-xs font-normal text-slate-600"
                  title="Default NEET_EXAM_DATE from .env - not a faculty-entered date"
                >
                  assumed date
                </span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm tabular-nums text-slate-600">
              <span className="font-medium text-slate-800">{formatDate(batch.exam_date)}</span>
              {typeof days === "number" ? (
                <>
                  {" · "}
                  <span className="font-semibold tabular-nums text-brand-navy">{days}</span> {days === 1 ? "day" : "days"} to
                  go
                </>
              ) : batch.exam_date ? (
                " · date has passed"
              ) : null}
            </p>
            {strategy ? (
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className={cn("rounded-sm border px-1.5 font-medium", strategy.className)}>
                  {strategy.label} mode · {strategy.range}
                </span>
                <span>{strategy.text}</span>
              </p>
            ) : null}
          </div>
        </div>

        {editing ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft) void save(draft);
            }}
          >
            <label htmlFor="cohort-exam-date" className="sr-only">
              Exam date
            </label>
            <input
              id="cohort-exam-date"
              type="date"
              value={draft}
              required
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              className={cn(fieldClass, "w-auto")}
            />
            <button
              type="submit"
              disabled={saving || !draft}
              className={btnPrimary}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
              className={cn(btnSecondary, "w-9 px-0")}
              aria-label="Cancel editing"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(batch.exam_date ?? "");
                setEditing(true);
              }}
              className={cn(btnSecondary, "whitespace-nowrap")}
            >
              Set exam date
            </button>
            {!batch.exam_date_assumed ? (
              <button
                type="button"
                onClick={() => void save(null)}
                disabled={saving}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-brand-cyan-600 transition-colors hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
                title="Go back to the assumed default (NEET_EXAM_DATE)"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
                Use default
              </button>
            ) : null}
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
