"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { errorMessage } from "@/lib/api";
import type { BatchSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtDate, inr, pct, signed } from "./format";
import { UrgencyBar } from "./kpis";
import { DemoTag, EmptyNote, focusRing, Panel, theadCls, thCls } from "./states";

const TREND_TOOLTIP = "Compared with the previous test in this batch - different papers, indicative only";

function TrendDelta({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-slate-500">—</span>;
  const tone = value > 0.05 ? "text-lime-800" : value < -0.05 ? "text-rose-700" : "text-slate-600";
  return (
    <span className={cn("whitespace-nowrap tabular-nums", tone)} title={TREND_TOOLTIP}>
      {signed(value)} pts
      <span className="sr-only"> ({TREND_TOOLTIP})</span>
    </span>
  );
}

function FacultyLeadCell({
  summary,
  onSave,
}: {
  summary: BatchSummary;
  onSave: (batchId: number, lead: string | null) => Promise<void>;
}) {
  const lead = summary.batch.faculty_lead;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `lead-${summary.batch.id}`;

  function start() {
    setValue(lead ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const next = value.replace(/\s+/g, " ").trim();
    setSaving(true);
    setError(null);
    setEditing(false); // optimistic: the parent shows the new name right away
    try {
      await onSave(summary.batch.id, next ? next : null);
    } catch (err) {
      setError(`Not saved (restored): ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div className="flex min-w-48 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <label htmlFor={inputId} className="sr-only">
          Faculty lead for {summary.batch.name}
        </label>
        <input
          id={inputId}
          autoFocus
          maxLength={120}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder="e.g. Dr. A. Rao"
          className={cn("h-8 w-full min-w-0 rounded-md border border-slate-300 px-2 text-sm", focusRing)}
        />
        <button
          type="button"
          onClick={() => void save()}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-700 hover:bg-slate-100", focusRing)}
          aria-label={`Save faculty lead for ${summary.batch.name}`}
        >
          <Check className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100", focusRing)}
          aria-label="Cancel"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <span className={cn("min-w-0", lead ? "text-slate-800" : "italic text-slate-500")}>{lead || "Not set"}</span>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-label="Saving" /> : null}
        <button
          type="button"
          onClick={start}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-brand-navy", focusRing)}
          aria-label={`Edit faculty lead for ${summary.batch.name}`}
          title="Edit faculty lead"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 max-w-56 text-xs text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One row per batch; a row click opens the cohort dashboard filtered to that batch. */
export function BatchesTable({
  batches,
  onSaveLead,
}: {
  batches: BatchSummary[];
  onSaveLead: (batchId: number, lead: string | null) => Promise<void>;
}) {
  const router = useRouter();
  const th = thCls;
  const td = "px-3 py-2 align-top text-sm text-slate-700";

  return (
    <Panel
      id="owner-batches-title"
      title="Batches"
      subtitle="Latest test per batch, results and costs. Select a row to open its cohort dashboard."
    >
      {batches.length === 0 ? (
        <EmptyNote>No batches yet.</EmptyNote>
      ) : (
        <div className="relative -mx-4 -mt-4 overflow-x-auto sm:-mx-5">
          <table className="min-w-[1100px] w-full border-collapse">
            <caption className="sr-only">Batches with faculty lead, latest test, results and cost</caption>
            <thead className={theadCls}>
              <tr>
                <th scope="col" className={cn(th, "pl-4 sm:pl-5")}>Batch</th>
                <th scope="col" className={th}>Faculty lead</th>
                <th scope="col" className={th}>Latest test</th>
                <th scope="col" className={cn(th, "text-right")}>Students</th>
                <th scope="col" className={cn(th, "text-right")}>Avg %</th>
                <th scope="col" className={th} title={TREND_TOOLTIP}>Trend</th>
                <th scope="col" className={th}>Urgency</th>
                <th scope="col" className={cn(th, "text-right")}>Backlog</th>
                <th scope="col" className={cn(th, "text-right")}>Released</th>
                <th scope="col" className={th}>Top gap topic</th>
                <th scope="col" className={cn(th, "pr-4 text-right sm:pr-5")}>AI cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((s) => {
                const href = `/cohort?batch_id=${s.batch.id}`;
                return (
                  <tr
                    key={s.batch.id}
                    onClick={() => router.push(href)}
                    className="cursor-pointer transition-colors duration-150 hover:bg-slate-50"
                  >
                    <td className={cn(td, "pl-4 sm:pl-5")}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                          className={cn("font-medium text-brand-cyan-600 hover:underline", focusRing)}
                        >
                          {s.batch.name}
                        </Link>
                        {s.is_demo ? <DemoTag /> : null}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {s.batch.exam || s.batch.exam_type} · exam {fmtDate(s.batch.exam_date)}
                        {s.batch.exam_date_assumed ? " (assumed)" : ""}
                      </p>
                    </td>
                    <td className={td}>
                      <FacultyLeadCell summary={s} onSave={onSaveLead} />
                    </td>
                    <td className={td}>
                      {s.latest_test ? (
                        <>
                          <p className="text-slate-800">
                            {s.latest_test.name} <span className="text-slate-500">{s.latest_test.version}</span>
                          </p>
                          <p className="text-xs text-slate-500">{fmtDate(s.latest_test_date)}</p>
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className={cn(td, "text-right tabular-nums")}>{s.students}</td>
                    <td className={cn(td, "text-right font-medium tabular-nums text-slate-900")}>
                      {pct(s.average_pct)}
                    </td>
                    <td className={td}>
                      <TrendDelta value={s.trend_delta_pct} />
                    </td>
                    <td className={cn(td, "min-w-32")}>
                      <UrgencyBar counts={s.urgency_counts} className="mt-1.5 h-1.5" />
                      <p className="mt-1 text-xs tabular-nums text-slate-500">
                        {s.urgency_counts.at_risk} at risk · {s.urgency_counts.needs_attention} attention
                      </p>
                    </td>
                    <td
                      className={cn(
                        td,
                        "text-right tabular-nums",
                        s.review_backlog > 0 && "font-medium text-amber-800",
                      )}
                      title={`${s.review_backlog} awaiting OCR review · ${s.failed} failed`}
                    >
                      {s.review_backlog}
                      {s.failed > 0 ? <span className="block text-xs text-rose-700">{s.failed} failed</span> : null}
                    </td>
                    <td className={cn(td, "text-right tabular-nums")} title={`${s.provisional} provisional`}>
                      {s.released}
                      <span className="text-slate-500"> / {s.completed}</span>
                    </td>
                    <td className={td}>{s.top_gap_topic ?? <span className="text-slate-500">—</span>}</td>
                    <td className={cn(td, "pr-4 text-right whitespace-nowrap tabular-nums sm:pr-5")}>{inr(s.cost_inr)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500">
        Avg % = completed results as a share of max marks (net of negative marking). Trend = change in points versus
        the previous test in the batch: different papers, indicative only. Released = released / completed results.
      </p>
    </Panel>
  );
}
