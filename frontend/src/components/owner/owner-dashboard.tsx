"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { IllustrativePill } from "@/components/shared/illustrative-pill";
import { getOwnerDashboard, updateBatch } from "@/lib/api";
import type { OwnerDashboard as OwnerData } from "@/lib/types";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { AttentionList, type AttentionHandle } from "./attention-list";
import { BatchesTable } from "./batches-table";
import { EffectivenessCard } from "./effectiveness-card";
import { OwnerKpis, stripCls } from "./kpis";
import { clockText, periodText } from "./owner-ui";
import { OwnerTabs, parseOwnerTab, type OwnerTab, type OwnerTabsHandle } from "./owner-tabs";
import { btnQuiet, ErrorNote, focusRing } from "./states";
import { WhatIfSimulator } from "./what-if";

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-sm bg-slate-100 motion-reduce:animate-none", className)} />;
}

/** Loading placeholder shaped like the page: header, 4 tiles, 5 attention rows, 3 batch rows. */
export function OwnerSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <span role="status" className="sr-only">
        Loading owner overview…
      </span>
      <div aria-hidden className="space-y-6">
        <div className="border-b border-slate-200 pb-4">
          <Bone className="h-3 w-28" />
          <Bone className="mt-2 h-7 w-64 max-w-full" />
          <Bone className="mt-2 h-3 w-96 max-w-full" />
        </div>
        <div className={cn(stripCls, "grid-cols-2 md:grid-cols-4")}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="bg-white px-4 py-3">
              <Bone className="h-3 w-20" />
              <Bone className="mt-2 h-6 w-16" />
              <Bone className="mt-2 h-3 w-28" />
            </div>
          ))}
        </div>
        <div className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          <div className="px-4 py-3">
            <Bone className="h-4 w-44" />
          </div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-l-[3px] border-l-slate-200 px-4 py-3">
              <Bone className="h-4 w-4" />
              <div className="flex-1">
                <Bone className="h-3 w-80 max-w-full" />
                <Bone className="mt-1.5 h-3 w-48 max-w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-4 sm:p-5">
          <Bone className="h-4 w-24" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Bone key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      </div>
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

function OwnerHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {title !== "Owner overview" ? (
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Owner overview</p>
        ) : null}
        <h1 className="mt-0.5 text-[22px] font-semibold leading-tight text-brand-navy sm:text-2xl">{title}</h1>
        {meta ? <p className="mt-1 text-sm text-slate-600">{meta}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * Institute-owner overview (FR-5.9): 4 figures, what needs attention, batches, then detail tabs
 * (progress, topics, exam behaviour, faculty, interventions, what-if, cost). Every count is of
 * students by their latest test unless it says sheets. No login in this PoC.
 */
export function OwnerDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseOwnerTab(searchParams.get("tab"));
  const [institutionId, setInstitutionId] = useState<number | null>(null);
  const fetcher = useCallback(() => getOwnerDashboard(institutionId), [institutionId]);
  const { data, error, loading, reload, setData } = useAsync(fetcher);
  const attention = useRef<AttentionHandle>(null);
  const tabs = useRef<OwnerTabsHandle>(null);

  const setTab = useCallback(
    (next: OwnerTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "progress") params.delete("tab");
      else params.set("tab", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const openTab = useCallback(
    (next: OwnerTab) => {
      setTab(next);
      tabs.current?.focus(next);
    },
    [setTab],
  );

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
          <OwnerHeader title="Owner overview" />
          <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} prefix="Could not load the owner dashboard" />
          {/* These two sections have their own endpoints, so they still work when the dashboard call fails. */}
          <EffectivenessCard institutionId={institutionId} variant="owner" hideCalibration />
          <WhatIfSimulator institutionId={institutionId} />
        </div>
      );
    }
    return <OwnerSkeleton />;
  }

  const t = data.totals;
  const empty = (t?.completed ?? 0) === 0;
  const instId = data.institution?.id ?? institutionId;
  const period = periodText(data.period?.first, data.period?.last);
  const signals = data.signals ?? [];
  // "from N tests" only when the API sends it and something is graded (older APIs lack tests).
  const tests = typeof t.tests === "number" && t.tests > 0 && t.completed > 0 ? t.tests : null;
  const meta = [
    `${t.batches} batch${t.batches === 1 ? "" : "es"}`,
    `${t.students} student${t.students === 1 ? "" : "s"}`,
    `${t.completed} graded sheet${t.completed === 1 ? "" : "s"}` +
      (tests !== null ? ` from ${tests} test${tests === 1 ? "" : "s"}` : ""),
    period,
    `updated ${clockText(data.generated_at)}`,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <OwnerHeader
        title={data.institution?.name ?? "Institution"}
        meta={<span className="tabular-nums">{meta.join(" · ")}</span>}
        actions={
          <>
            {data.institutions?.length > 1 ? (
              <label className="text-sm">
                <span className="sr-only">Institution</span>
                <select
                  value={instId ?? ""}
                  onChange={(e) => setInstitutionId(e.target.value ? Number(e.target.value) : null)}
                  className={cn("h-10 rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-700 sm:h-8", focusRing)}
                >
                  {data.institutions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {data.is_demo ? (
              <IllustrativePill
                label={`${data.demo_count} of ${t.submissions} sheets are sample data`}
                title="Synthetic sample records (is_demo), generated locally without AI calls - not real students."
                className="h-8 whitespace-normal"
              />
            ) : null}
            <button type="button" onClick={() => void reload()} disabled={loading} className={cn(btnQuiet, "h-10 sm:h-8")}>
              <RotateCw className={cn("h-4 w-4", loading && "motion-safe:animate-spin")} aria-hidden />
              Refresh
            </button>
            <span aria-live="polite" className="sr-only">
              {loading ? "Refreshing" : `Updated ${clockText(data.generated_at)}`}
            </span>
          </>
        }
      />

      {error ? <ErrorNote error={error} onRetry={() => void reload()} retrying={loading} prefix="Refresh failed (showing the last data)" /> : null}

      {empty ? (
        <>
          <section className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-brand-navy">No graded sheets in this institution yet</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Upload the answer key and the ticked papers on Intake. Progress, topics and faculty figures appear here once
                sheets are graded; you can set each batch&apos;s faculty lead below now.
              </p>
            </div>
            <Link href="/" className={cn(btnQuiet, "h-10 shrink-0 sm:h-8")}>
              Go to Intake
            </Link>
          </section>
          {(data.batches ?? []).length ? (
            <BatchesTable batches={data.batches ?? []} samePaper={[]} onSaveLead={saveLead} />
          ) : null}
        </>
      ) : (
        <>
          <OwnerKpis
            data={data}
            onJump={(key) => attention.current?.open(key)}
            canJump={(key) => signals.some((s) => s.key === key)}
          />
          {data.signals ? (
            <AttentionList
              ref={attention}
              signals={signals}
              atRisk={data.at_risk_students ?? []}
              release={data.release ?? null}
              generatedAt={data.generated_at}
              onOpenTab={openTab}
            />
          ) : null}
          <BatchesTable batches={data.batches ?? []} samePaper={data.same_paper ?? []} onSaveLead={saveLead} />
          <OwnerTabs ref={tabs} data={data} institutionId={instId} tab={tab} onTab={setTab} />
        </>
      )}

      <p className="text-xs text-slate-500">
        No login in this PoC: anyone with the link sees the owner view. Counts are students by their latest test unless
        they say sheets.
      </p>
    </div>
  );
}
