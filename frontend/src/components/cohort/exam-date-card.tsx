"use client";

import { useState } from "react";
import { CalendarClock, Check, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import { useHealth } from "@/components/app-shell";
import { errorCode, errorMessage, errorStatus, updateBatch } from "@/lib/api";
import type { Batch, StrategyMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card } from "./card";
import { fieldClass } from "./dialog";
import { batchLabel } from "./format";

export const STRATEGY_LOOK: Record<StrategyMode, { label: string; range: string; text: string; className: string }> = {
  broad: {
    label: "Broad",
    range: "90+ days",
    text: "Time to learn weak chapters from scratch: cover high-weightage gaps broadly.",
    className: "bg-sky-50 text-sky-800 ring-sky-200",
  },
  focused: {
    label: "Focused",
    range: "30-89 days",
    text: "Concentrate on the top ROI chapters; drill rather than re-learn.",
    className: "bg-brand-cyan-50 text-brand-cyan-600 ring-brand-cyan/30",
  },
  revision: {
    label: "Revision",
    range: "7-29 days",
    text: "Revise and fix recurring errors; no new chapters.",
    className: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  consolidation: {
    label: "Consolidation",
    range: "0-6 days",
    text: "Consolidate strengths, light review, rest.",
    className: "bg-rose-50 text-rose-700 ring-rose-200",
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
    <Card aria-labelledby="cohort-exam-title" className="py-4 sm:py-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-lime-50 text-lime-700">
            <CalendarClock className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="cohort-exam-title" className="flex flex-wrap items-center gap-2 text-base font-semibold text-brand-navy">
              {exam} exam
              <span className="font-normal text-slate-500">· {batchLabel(batch)}</span>
              {batch.exam_date_assumed ? (
                <span
                  className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-inset ring-violet-200"
                  title="Default NEET_EXAM_DATE from .env - not a faculty-entered date"
                >
                  assumed date
                </span>
              ) : null}
            </h2>
            <p className="mt-0.5 text-sm text-slate-600">
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
                <span className={cn("rounded-full px-2 py-0.5 font-semibold ring-1 ring-inset", strategy.className)}>
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
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-navy-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
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
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
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
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Set exam date
            </button>
            {!batch.exam_date_assumed ? (
              <button
                type="button"
                onClick={() => void save(null)}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
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
        <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
