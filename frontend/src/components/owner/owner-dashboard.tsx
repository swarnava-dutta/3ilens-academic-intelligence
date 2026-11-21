"use client";

import { useCallback, useState } from "react";
import { Building2, FlaskConical, Loader2, LockOpen, RotateCw } from "lucide-react";
import { getOwnerDashboard, seedDemoCohort, updateBatch } from "@/lib/api";
import type { DemoSet, OwnerDashboard as OwnerData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BatchesTable } from "./batches-table";
import { EffectivenessCard } from "./effectiveness-card";
import { FacultyTable } from "./faculty-table";
import { fmtDateTime } from "./format";
import { OwnerKpis, OwnerUrgencyStrip } from "./kpis";
import { CardSkeleton, ErrorNote, SamplePill } from "./states";
import { TrendChart } from "./trend-chart";
import { useAsync } from "./use-async";
import { WeakestTopics } from "./weakest-topics";
import { WhatIfSimulator } from "./what-if";

const SEEDS: { set: DemoSet; label: string; busy: string }[] = [
  { set: "all", label: "Load sample cohorts", busy: "Loading sample cohorts…" },
  { set: "insights", label: "Load insights sample (MCQ papers, interventions)", busy: "Loading insights sample…" },
];

/** Seed buttons: set=all (Genetics + mixed), then set=insights (NEET-C, MCQ papers, interventions). */
export function SeedButtons({ onSeeded, only }: { onSeeded: () => Promise<void>; only?: DemoSet[] }) {
  const [busy, setBusy] = useState<DemoSet | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function seed(set: DemoSet) {
    setBusy(set);
    setMessage(null);
    setError(null);
    try {
      const res = await seedDemoCohort(set);
      setMessage(res?.message || "Sample data loaded.");
      await onSeeded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {SEEDS.filter((s) => !only || only.includes(s.set)).map((s) => (
          <button
            key={s.set}
            type="button"
            onClick={() => void seed(s.set)}
            disabled={busy !== null}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-amber-800 ring-1 ring-inset ring-amber-300 transition hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:cursor-wait disabled:opacity-70"
          >
            {busy === s.set ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
            {busy === s.set ? s.busy : s.label}
          </button>
        ))}
      </div>
      <div aria-live="polite" className="mt-2 min-h-5 text-sm">
        {error ? <ErrorNote error={error} prefix="Could not load the sample" /> : null}
        {message && !error ? <p className="font-medium text-lime-800">{message}</p> : null}
      </div>
    </div>
  );
}

function OwnerSkeleton() {
  return (
    <div className="space-y-6">
      <CardSkeleton rows={1} label="Loading owner dashboard…" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-200/60" />
        ))}
      </div>
      <CardSkeleton rows={4} label="Loading batches…" />
    </div>
  );
}

function patchLead(data: OwnerData | null, batchId: number, lead: string | null): OwnerData | null {
  if (!data) return data;
  return {
    ...data,
    batches: data.batches.map((s) => (s.batch.id === batchId ? { ...s, batch: { ...s.batch, faculty_lead: lead } } : s)),
  };
}

/**
 * Institute-owner dashboard (FR-5.9): totals, batches, faculty, trend, weakest topics,
 * intervention effectiveness (FR-4.13) and the what-if simulator (FR-4.14). No login in this PoC.
 */
export function OwnerDashboard() {
  const [institutionId, setInstitutionId] = useState<number | null>(null);
  const fetcher = useCallback(() => getOwnerDashboard(institutionId), [institutionId]);
  const { data, error, loading, reload, setData } = useAsync(fetcher);

  const saveLead = useCallback(
    async (batchId: number, lead: string | null) => {
      const before = data?.batches.find((s) => s.batch.id === batchId)?.batch.faculty_lead ?? null;
      setData((d) => patchLead(d, batchId, lead));
      try {
        const saved = await updateBatch(batchId, { faculty_lead: lead });
        setData((d) => patchLead(d, batchId, saved.faculty_lead));
      } catch (err) {
        setData((d) => patchLead(d, batchId, before));
        throw err;
      }
    },
    [data, setData],
  );

  if (!data) {
    if (error) {
      return (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold tracking-tight text-brand-navy">Owner dashboard</h1>
          <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} prefix="Could not load the owner dashboard" />
          {/* These two sections have their own endpoints, so they still work when the dashboard call fails. */}
          <EffectivenessCard institutionId={institutionId} />
          <WhatIfSimulator institutionId={institutionId} />
        </div>
      );
    }
    return <OwnerSkeleton />;
  }

  const empty = (data.totals?.submissions ?? 0) === 0;
  // The badge already says it; drop the same sentence from the start of the API's role note.
  const roleNote = (data.role_note ?? "").replace(/^owner view - no login in this poc[.\s]*/i, "");
  const instId = data.institution?.id ?? institutionId;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-cyan-600">Institute owner</p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">
            <Building2 className="h-7 w-7 text-brand-navy/70" aria-hidden />
            {data.institution?.name ?? "Institution"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Generated {fmtDateTime(data.generated_at)} · {data.real_count} live · {data.demo_count} sample results
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.is_demo ? <SamplePill /> : null}
          {data.institutions?.length > 1 ? (
            <label className="text-sm">
              <span className="sr-only">Institution</span>
              <select
                value={instId ?? ""}
                onChange={(e) => setInstitutionId(e.target.value ? Number(e.target.value) : null)}
                className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-700 shadow-sm focus:border-brand-cyan focus:outline-none focus:ring-2 focus:ring-brand-cyan/30"
              >
                {data.institutions.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-cyan disabled:opacity-60"
          >
            <RotateCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden />
            Refresh
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-300">
          <LockOpen className="h-3.5 w-3.5" aria-hidden />
          Owner view - no login in this PoC
        </span>
        <span>{roleNote}</span>
      </div>

      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} prefix="Refresh failed (showing the last data)" /> : null}

      {empty ? (
        <section className="rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-brand-navy">No submissions in this institution yet</h2>
          <p className="mx-auto mt-1 max-w-xl text-sm text-slate-600">
            Upload answer sheets on the Intake page, or load the labelled sample data: first the sample cohorts, then
            the insights sample (NEET MCQ papers, batch NEET-C (sample) and logged interventions). Both are synthetic and
            make no AI calls.
          </p>
          <div className="mt-5 flex justify-center">
            <SeedButtons onSeeded={reload} />
          </div>
        </section>
      ) : (
        <>
          <OwnerKpis data={data} />
          <OwnerUrgencyStrip data={data} />
          {data.interventions?.records === 0 ? (
            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-inset ring-slate-200">
              <p className="mb-2">
                No interventions logged yet, so effectiveness and calibration are empty. The insights sample adds NEET-C
                (sample) with MCQ papers and logged interventions.
              </p>
              <SeedButtons onSeeded={reload} only={["insights"]} />
            </div>
          ) : null}
          <BatchesTable batches={data.batches ?? []} onSaveLead={saveLead} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <TrendChart trend={data.trend ?? []} />
            </div>
            <WeakestTopics topics={data.weakest_topics ?? []} />
          </div>
          <FacultyTable faculty={data.faculty ?? []} />
          <EffectivenessCard institutionId={instId} />
          <WhatIfSimulator key={instId ?? "all"} institutionId={instId} />
        </>
      )}
    </div>
  );
}
