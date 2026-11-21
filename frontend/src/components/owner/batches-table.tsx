"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { ArrowRight, Check, Layers, Loader2, Minus, Pencil, TrendingDown, TrendingUp, X } from "lucide-react";
import { Card, CardHeader } from "@/components/cohort/card";
import { errorMessage } from "@/lib/api";
import type { BatchSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtDate, inr, pct, signed } from "./format";
import { UrgencyBar } from "./kpis";
import { DemoTag } from "./states";

const TREND_TOOLTIP = "Compared with the previous test in this batch - different papers, indicative only";

function TrendDelta({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-slate-500">—</span>;
  const Icon = value > 0.05 ? TrendingUp : value < -0.05 ? TrendingDown : Minus;
  const tone = value > 0.05 ? "text-lime-800" : value < -0.05 ? "text-rose-700" : "text-slate-600";
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap font-medium tabular-nums", tone)} title={TREND_TOOLTIP}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
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
          className="h-8 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30"
        />
        <button
          type="button"
          onClick={() => void save()}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-lime-800 hover:bg-lime-50 focus-visible:outline-2 focus-visible:outline-brand-cyan"
          aria-label={`Save faculty lead for ${summary.batch.name}`}
        >
          <Check className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-cyan"
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
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-brand-cyan"
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
  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap";
  const td = "px-3 py-2.5 align-top text-sm text-slate-700";

  return (
    <Card aria-labelledby="owner-batches-title">
      <CardHeader
        id="owner-batches-title"
        icon={Layers}
        title="Batches"
        subtitle="Latest test per batch, results and costs. Click a row to open its cohort dashboard."
      />
      {batches.length === 0 ? (
        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">No batches yet.</p>
      ) : (
        <div className="relative mt-4 -mx-5 overflow-x-auto sm:-mx-6">
          <table className="min-w-[1100px] w-full border-collapse">
            <caption className="sr-only">Batches with faculty lead, latest test, results and cost</caption>
            <thead className="border-y border-slate-200 bg-slate-50">
              <tr>
                <th scope="col" className={cn(th, "pl-5 sm:pl-6")}>Batch</th>
                <th scope="col" className={th}>Faculty lead</th>
                <th scope="col" className={th}>Latest test</th>
                <th scope="col" className={cn(th, "text-right")}>Students</th>
                <th scope="col" className={cn(th, "text-right")}>Avg %</th>
                <th scope="col" className={th} title={TREND_TOOLTIP}>Trend</th>
                <th scope="col" className={th}>Urgency</th>
                <th scope="col" className={cn(th, "text-right")}>Backlog</th>
                <th scope="col" className={cn(th, "text-right")}>Released</th>
                <th scope="col" className={th}>Top gap topic</th>
                <th scope="col" className={cn(th, "pr-5 text-right sm:pr-6")}>AI cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((s) => {
                const href = `/cohort?batch_id=${s.batch.id}`;
                return (
                  <tr
                    key={s.batch.id}
                    onClick={() => router.push(href)}
                    className="cursor-pointer transition-colors hover:bg-brand-cyan-50/50"
                  >
                    <td className={cn(td, "pl-5 sm:pl-6")}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 font-semibold text-brand-navy hover:underline focus-visible:outline-2 focus-visible:outline-brand-cyan"
                        >
                          {s.batch.name}
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                        {s.is_demo ? <DemoTag /> : null}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-600">
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
                          <p className="font-medium text-slate-800">
                            {s.latest_test.name} <span className="text-slate-500">{s.latest_test.version}</span>
                          </p>
                          <p className="text-xs text-slate-600">{fmtDate(s.latest_test_date)}</p>
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className={cn(td, "text-right tabular-nums")}>{s.students}</td>
                    <td className={cn(td, "text-right font-semibold tabular-nums text-brand-navy")}>
                      {pct(s.average_pct)}
                    </td>
                    <td className={td}>
                      <TrendDelta value={s.trend_delta_pct} />
                    </td>
                    <td className={cn(td, "min-w-32")}>
                      <UrgencyBar counts={s.urgency_counts} className="mt-1.5 h-2" />
                      <p className="mt-1 text-[11px] tabular-nums text-slate-600">
                        {s.urgency_counts.at_risk} at risk · {s.urgency_counts.needs_attention} attention
                      </p>
                    </td>
                    <td
                      className={cn(
                        td,
                        "text-right tabular-nums",
                        s.review_backlog > 0 && "font-semibold text-amber-800",
                      )}
                      title={`${s.review_backlog} awaiting OCR review · ${s.failed} failed`}
                    >
                      {s.review_backlog}
                      {s.failed > 0 ? <span className="block text-xs font-medium text-rose-700">{s.failed} failed</span> : null}
                    </td>
                    <td className={cn(td, "text-right tabular-nums")} title={`${s.provisional} provisional`}>
                      {s.released}
                      <span className="text-slate-500"> / {s.completed}</span>
                    </td>
                    <td className={td}>{s.top_gap_topic ?? <span className="text-slate-500">—</span>}</td>
                    <td className={cn(td, "pr-5 text-right whitespace-nowrap tabular-nums sm:pr-6")}>{inr(s.cost_inr)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-600">
        Avg % = completed results as a share of max marks (net of negative marking). Trend = change in points versus
        the previous test in the batch: different papers, indicative only. Released = released / completed results.
      </p>
    </Card>
  );
}
