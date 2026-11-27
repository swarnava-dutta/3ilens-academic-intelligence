"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getFilters, type DashboardQuery } from "@/lib/api";
import type { DashboardFilters, Urgency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { URGENCIES, URGENCY_LABELS } from "./urgency-badge";

export type FilterKey = "batch" | "test" | "urgency" | "topic";

/** URL search-param name for each filter. */
export const FILTER_PARAMS: Record<FilterKey, "batch_id" | "rubric_id" | "urgency" | "topic"> = {
  batch: "batch_id",
  test: "rubric_id",
  urgency: "urgency",
  topic: "topic",
};

const ALL_FILTERS: FilterKey[] = ["batch", "test", "urgency", "topic"];

function positiveId(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** DashboardQuery from URL search params (invalid values are ignored). */
export function readDashboardQuery(params: { get(name: string): string | null }): DashboardQuery {
  const urgency = params.get("urgency");
  const topic = params.get("topic")?.trim();
  return {
    batch_id: positiveId(params.get("batch_id")),
    rubric_id: positiveId(params.get("rubric_id")),
    urgency: urgency && (URGENCIES as string[]).includes(urgency) ? (urgency as Urgency) : null,
    topic: topic ? topic : null,
  };
}

/**
 * Current dashboard filters from the URL (?batch_id&rubric_id&urgency&topic). Pass the
 * result straight to getStudents / getCohort / getSubmissions. Uses useSearchParams, so the
 * calling component must render inside <Suspense>.
 */
export function useDashboardFilters(): DashboardQuery {
  const searchParams = useSearchParams();
  const key = searchParams.toString();
  return useMemo(() => readDashboardQuery(new URLSearchParams(key)), [key]);
}

const selectClass =
  "h-9 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-800 " +
  "focus-visible:border-brand-cyan";

/**
 * Batch / test / urgency / topic selects backed by GET /api/filters. State lives in the URL
 * search params, so views are shareable and survive reloads. Must be rendered inside
 * <Suspense>; renders nothing while /api/filters is loading or unavailable.
 */
export function FilterBar({ show = ALL_FILTERS, className }: { show?: FilterKey[]; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useDashboardFilters();
  const [options, setOptions] = useState<DashboardFilters | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFilters()
      .then((data) => {
        if (!cancelled) setOptions(data);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setParam = useCallback(
    (key: FilterKey, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      const param = FILTER_PARAMS[key];
      if (value) next.set(param, value);
      else next.delete(param);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const clearAll = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    for (const key of show) next.delete(FILTER_PARAMS[key]);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams, show]);

  if (unavailable || !options) return null;

  const tests = (options.tests ?? []).filter(
    (t) => query.batch_id === null || query.batch_id === undefined || (t.batch_ids ?? []).includes(query.batch_id),
  );
  const active = show.some((key) => {
    const value = query[FILTER_PARAMS[key]];
    return value !== null && value !== undefined && value !== "";
  });

  return (
    <div
      role="group"
      aria-label="Filters"
      className={cn("flex flex-wrap items-center gap-2 print:hidden", className)}
    >
      {show.includes("batch") ? (
        <label className="min-w-0">
          <span className="sr-only">Batch</span>
          <select
            className={selectClass}
            value={query.batch_id ?? ""}
            onChange={(e) => setParam("batch", e.target.value || null)}
          >
            <option value="">All batches</option>
            {(options.batches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {show.includes("test") ? (
        <label className="min-w-0">
          <span className="sr-only">Test</span>
          <select
            className={selectClass}
            value={query.rubric_id ?? ""}
            onChange={(e) => setParam("test", e.target.value || null)}
          >
            <option value="">All tests</option>
            {tests.map((t) => (
              <option key={t.rubric_id} value={t.rubric_id}>
                {t.name} · {t.version}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {show.includes("urgency") ? (
        <label className="min-w-0">
          <span className="sr-only">Urgency</span>
          <select
            className={selectClass}
            value={query.urgency ?? ""}
            onChange={(e) => setParam("urgency", e.target.value || null)}
          >
            <option value="">Any urgency</option>
            {(options.urgencies?.length ? options.urgencies : URGENCIES).map((u) => (
              <option key={u} value={u}>
                {URGENCY_LABELS[u] ?? u}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {show.includes("topic") ? (
        <label className="min-w-0">
          <span className="sr-only">Topic</span>
          <select
            className={selectClass}
            value={query.topic ?? ""}
            onChange={(e) => setParam("topic", e.target.value || null)}
          >
            <option value="">All topics</option>
            {(options.topics ?? []).map((topic) => (
              <option key={topic} value={topic}>
                {topic}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {active ? (
        <button
          type="button"
          onClick={clearAll}
          className="h-9 rounded-md px-2 text-sm font-medium text-brand-cyan-600 transition-colors duration-150 hover:text-brand-navy"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
