"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getCohort, type DashboardQuery } from "@/lib/api";
import type { Cohort, Urgency } from "@/lib/types";

export const COHORT_REFRESH_MS = 10_000;

interface CohortState {
  cohort: Cohort | null;
  error: string | null;
  /** Locale time of the last successful fetch, formatted when it landed (never during render). */
  updatedLabel: string | null;
}

type FilterTuple = [number | null, number | null, Urgency | null, string | null];

function filtersKey(query: DashboardQuery | null | undefined): string {
  const tuple: FilterTuple = [query?.batch_id ?? null, query?.rubric_id ?? null, query?.urgency ?? null, query?.topic ?? null];
  return JSON.stringify(tuple);
}

function queryFromKey(key: string): DashboardQuery {
  const [batch_id, rubric_id, urgency, topic] = JSON.parse(key) as FilterTuple;
  return { batch_id, rubric_id, urgency, topic };
}

/**
 * Polls GET /api/cohort (with the dashboard filters) every `intervalMs` while the tab is
 * visible. A failed refresh keeps the last good data and only records the error, so the
 * dashboard never flashes back to a skeleton or blanks out mid-demo. Changing a filter
 * fetches immediately; a response for an older filter set is ignored.
 */
export function useCohort(filters?: DashboardQuery | null, intervalMs = COHORT_REFRESH_MS) {
  const [state, setState] = useState<CohortState>({
    cohort: null,
    error: null,
    updatedLabel: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const latestRequest = useRef(0);
  const inFlight = useRef(0);
  const key = filtersKey(filters);
  const keyRef = useRef(key);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    inFlight.current += 1;
    try {
      const cohort = await getCohort(queryFromKey(keyRef.current));
      if (requestId !== latestRequest.current) return; // a newer request superseded this one
      setState({
        cohort,
        error: null,
        updatedLabel: new Date().toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      });
    } catch (err) {
      if (requestId !== latestRequest.current) return;
      setState((prev) => ({ ...prev, error: errorMessage(err) }));
    } finally {
      inFlight.current -= 1;
    }
  }, []);

  useEffect(() => {
    keyRef.current = key;
    void load();
    const tick = () => {
      if (document.visibilityState === "hidden" || inFlight.current > 0) return;
      void load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, intervalMs, key]);

  /** Manual refresh (button, after seeding or a rubric re-run): always fires, shows a spinner. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return { ...state, refreshing, refresh };
}
