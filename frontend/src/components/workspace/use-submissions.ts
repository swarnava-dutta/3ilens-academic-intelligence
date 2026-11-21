"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getSubmissions, type DashboardQuery } from "@/lib/api";
import type { Submission, Urgency } from "@/lib/types";

export const QUEUE_POLL_MS = 3_000;

export interface QueueState {
  /** Last good list (null until the first successful load). */
  submissions: Submission[] | null;
  /** errorMessage() of the latest failed poll; cleared on the next success. */
  error: string | null;
  /** Client clock (ms) captured when the list was last fetched; used for relative times. */
  fetchedAt: number | null;
}

/** True when any dashboard filter (batch, test, urgency, topic) is set. */
export function hasDashboardFilters(query: DashboardQuery | null | undefined): boolean {
  if (!query) return false;
  return Object.values(query).some((v) => v !== null && v !== undefined && v !== "");
}

type FilterTuple = [number | null, number | null, Urgency | null, string | null];

/** Stable string key for a filter object (the polling effect re-runs only when a value changes). */
function filtersKey(query: DashboardQuery | null): string {
  const tuple: FilterTuple = [query?.batch_id ?? null, query?.rubric_id ?? null, query?.urgency ?? null, query?.topic ?? null];
  return JSON.stringify(tuple);
}

function queryFromKey(key: string): DashboardQuery {
  const [batch_id, rubric_id, urgency, topic] = JSON.parse(key) as FilterTuple;
  return { batch_id, rubric_id, urgency, topic };
}

/**
 * Polls GET /api/submissions every 3 s, optionally filtered (batch, test, urgency). Pass
 * `enabled = false` to pause it. Never overlaps requests (a refresh requested while one is in
 * flight runs right after it), keeps the last good data on transient errors, and pauses while
 * the tab is hidden.
 */
export function useSubmissions(filters: DashboardQuery | null = null, enabled = true) {
  const [state, setState] = useState<QueueState>({ submissions: null, error: null, fetchedAt: null });
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const key = filtersKey(filters);
  const keyRef = useRef(key);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        rerun.current = false;
        const requestKey = keyRef.current;
        try {
          const submissions = await getSubmissions(queryFromKey(requestKey));
          // Filters changed while this request was in flight: fetch again with the new ones.
          if (requestKey !== keyRef.current) {
            rerun.current = true;
            continue;
          }
          setState({ submissions, error: null, fetchedAt: Date.now() });
        } catch (err) {
          setState((prev) => ({ ...prev, error: errorMessage(err) }));
        }
      } while (rerun.current);
    } finally {
      inFlight.current = false;
    }
  }, []);

  /** Show a just-uploaded submission immediately, before the next poll lands. */
  const addOptimistic = useCallback((submission: Submission) => {
    setState((prev) => {
      const list = prev.submissions ?? [];
      if (list.some((s) => s.id === submission.id)) return prev;
      return { ...prev, submissions: [submission, ...list] };
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    keyRef.current = key;
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, QUEUE_POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, key, enabled]);

  return { ...state, refresh, addOptimistic };
}

export type SubmissionsQueue = ReturnType<typeof useSubmissions>;
