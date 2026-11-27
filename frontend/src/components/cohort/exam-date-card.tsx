"use client";

import { useState } from "react";
import { CalendarDays, Check, Loader2, RotateCcw } from "lucide-react";
import { useHealth } from "@/components/app-shell";
import { Popover } from "@/components/shared/popover";
import { errorCode, errorMessage, errorStatus, updateBatch } from "@/lib/api";
import type { Batch, StrategyMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { btnPrimary, btnSecondary, fieldClass } from "./dialog";
import { POPOVER_PANEL } from "./format";

export const STRATEGY_LOOK: Record<StrategyMode, { label: string; range: string; text: string }> = {
  broad: {
    label: "Broad",
    range: "90+ days",
    text: "Time to learn weak chapters from scratch: cover high-weightage gaps broadly.",
  },
  focused: {
    label: "Focused",
    range: "30-89 days",
    text: "Concentrate on the top chapters; drill rather than re-learn.",
  },
  revision: {
    label: "Revision",
    range: "7-29 days",
    text: "Revise and fix recurring errors; no new chapters.",
  },
  consolidation: {
    label: "Consolidation",
    range: "0-6 days",
    text: "Consolidate strengths, light review, rest.",
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return "not set";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function ExamDateForm({ batch, onSaved, close }: { batch: Batch; onSaved: () => Promise<void> | void; close: () => void }) {
  const { refresh: refreshHealth } = useHealth();
  const [draft, setDraft] = useState(batch.exam_date ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strategy = batch.strategy_mode ? STRATEGY_LOOK[batch.strategy_mode] : null;

  async function save(examDate: string | null) {
    setSaving(true);
    setError(null);
    try {
      await updateBatch(batch.id, { exam_date: examDate });
      await Promise.all([onSaved(), refreshHealth()]);
      close();
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
    <div className="space-y-3">
      <div>
        <p className="font-semibold text-brand-navy">
          {batch.exam || "NEET"} exam date · {batch.name}
        </p>
        {batch.exam_date_assumed ? (
          <p className="mt-0.5 text-xs text-slate-500">
            Assumed: the default exam date, not one entered for this batch.
          </p>
        ) : null}
      </div>
      {strategy ? (
        <p className="text-xs text-slate-600">
          <span className="font-medium text-slate-800">
            {strategy.label} mode ({strategy.range}):
          </span>{" "}
          {strategy.text} Students&apos; study plans follow this mode.
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft) void save(draft);
        }}
      >
        <label htmlFor={`exam-date-${batch.id}`} className="sr-only">
          Exam date
        </label>
        <input
          id={`exam-date-${batch.id}`}
          type="date"
          value={draft}
          required
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(fieldClass, "w-auto")}
        />
        <button type="submit" disabled={saving || !draft} className={btnPrimary}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          Save
        </button>
        {!batch.exam_date_assumed ? (
          <button type="button" onClick={() => void save(null)} disabled={saving} className={btnSecondary}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Use default
          </button>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "NEET 2 May 2027 · 156 days · Broad mode" chip; opens the exam-date form. */
export function ExamChip({ batch, onSaved }: { batch: Batch; onSaved: () => Promise<void> | void }) {
  const strategy = batch.strategy_mode ? STRATEGY_LOOK[batch.strategy_mode] : null;
  const days = batch.days_to_exam;
  return (
    <Popover
      align="left"
      chevron={false}
      panelClassName={POPOVER_PANEL}
      title="Exam date and study-plan mode for this batch"
      buttonClassName="inline-flex h-9 max-w-full items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-[13px] text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700"
      label={
        <>
          <CalendarDays className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          {/* Phones: the days left are the useful part ("NEET in 156 days"); the date is in the popover. */}
          <span className="truncate tabular-nums sm:hidden">
            <span className="font-medium text-slate-800">{batch.exam || "NEET"}</span>
            {typeof days === "number"
              ? ` in ${days} ${days === 1 ? "day" : "days"}`
              : batch.exam_date
                ? " · passed"
                : " · date not set"}
          </span>
          <span className="hidden truncate tabular-nums sm:inline">
            <span className="font-medium text-slate-800">
              {batch.exam || "NEET"} {formatDate(batch.exam_date)}
            </span>
            {typeof days === "number" ? ` · ${days} ${days === 1 ? "day" : "days"}` : batch.exam_date ? " · passed" : ""}
            {strategy ? ` · ${strategy.label} mode` : ""}
          </span>
          {batch.exam_date_assumed ? (
            <span className="shrink-0 rounded-sm border border-slate-300 px-1 text-[11px] text-slate-600">assumed</span>
          ) : null}
        </>
      }
    >
      {(close) => <ExamDateForm batch={batch} onSaved={onSaved} close={close} />}
    </Popover>
  );
}
