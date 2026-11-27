"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorCode, errorMessage, getCohortView, type CohortViewQuery } from "@/lib/api";
import type { Cohort } from "@/lib/types";

/** While any sheet is still being read. */
const COHORT_FAST_MS = 10_000;
/** Otherwise: a quiet refresh, plus one on focus / when the tab becomes visible again. */
const COHORT_SLOW_MS = 60_000;
const FOCUS_MIN_GAP_MS = 5_000;

interface CohortState {
  cohort: Cohort | null;
  /** Scope key the cohort on screen was loaded for. */
  loadedKey: string | null;
  error: string | null;
  /** API error code of the last failure ("unknown_test", "unknown_batch", ...), null otherwise. */
  errorCode: string | null;
  /** Scope key the last failure was for. */
  errorKey: string | null;
  /** When the data on screen last changed (formatted once, never during render). */
  updatedLabel: string | null;
}

function scopeKey(query: CohortViewQuery | null): string | null {
  return query ? JSON.stringify([query.batch_id ?? null, query.test_id ?? null]) : null;
}

function queryFromKey(key: string): CohortViewQuery {
  const [batch_id, test_id] = JSON.parse(key) as [number | null, number | null];
  return { batch_id, test_id };
}

function timeLabel(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * GET /api/cohort?per_student=true for one scope. Polls every 10 s while sheets are being read,
 * every 60 s otherwise, and on window focus / tab visibility. A response whose data_version is
 * unchanged does not re-render the page. A failed refresh keeps the last good data (the page
 * never flashes back to a skeleton); a scope change keeps the old data on screen until the new
 * scope lands, and a response for an older scope is ignored. `query` null = do not fetch yet.
 */
export function useCohort(query: CohortViewQuery | null) {
  const [state, setState] = useState<CohortState>({
    cohort: null,
    loadedKey: null,
    error: null,
    errorCode: null,
    errorKey: null,
    updatedLabel: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const key = scopeKey(query);
  const keyRef = useRef(key);
  const latestRequest = useRef(0);
  const inFlight = useRef(0);
  const lastLoad = useRef(0);
  const versionRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    const current = keyRef.current;
    if (current === null) return false;
    const requestId = ++latestRequest.current;
    inFlight.current += 1;
    lastLoad.current = Date.now();
    try {
      const cohort = await getCohortView(queryFromKey(current));
      if (requestId !== latestRequest.current) return false; // a newer request superseded this one
      const version = cohort.data_version ? `${current}|${cohort.data_version}` : null;
      if (version !== null && version === versionRef.current) {
        // Same data: clear a stale error only, so nothing below re-renders.
        setState((prev) => (prev.error ? { ...prev, error: null, errorCode: null, errorKey: null } : prev));
        return true;
      }
      versionRef.current = version;
      setState({ cohort, loadedKey: current, error: null, errorCode: null, errorKey: null, updatedLabel: timeLabel() });
      return true;
    } catch (err) {
      if (requestId !== latestRequest.current) return false;
      setState((prev) => ({ ...prev, error: errorMessage(err), errorCode: errorCode(err), errorKey: current }));
      return false;
    } finally {
      inFlight.current -= 1;
    }
  }, []);

  const processing = state.loadedKey === key ? (state.cohort?.processing ?? 0) : 0;
  const intervalMs = processing > 0 ? COHORT_FAST_MS : COHORT_SLOW_MS;

  // Fetch when the scope changes.
  useEffect(() => {
    keyRef.current = key;
    if (key !== null) void load();
  }, [key, load]);

  // Poll (adaptive), and refresh on focus / visibility.
  useEffect(() => {
    if (key === null) return;
    const tick = () => {
      if (document.visibilityState === "hidden" || inFlight.current > 0) return;
      void load();
    };
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoad.current < FOCUS_MIN_GAP_MS) return;
      tick();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [key, load, intervalMs]);

  /** Manual refresh (button, after a key re-grade or a logged intervention): announces "Updated". */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setAnnouncement("");
    try {
      const ok = await load();
      if (ok) setAnnouncement(`Updated at ${timeLabel()}`);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return {
    cohort: state.cohort,
    error: state.error,
    /** "unknown_test" / "unknown_batch" for the scope asked for now (a stale link), else null. */
    scopeGone:
      state.errorKey === key && (state.errorCode === "unknown_test" || state.errorCode === "unknown_batch")
        ? (state.errorCode === "unknown_test" ? "test" : "batch") as "test" | "batch"
        : null,
    updatedLabel: state.updatedLabel,
    /** True while the data on screen belongs to a previous scope. */
    switching: state.cohort !== null && key !== null && state.loadedKey !== key,
    refreshing,
    refresh,
    announcement,
    pollSeconds: Math.round(intervalMs / 1000),
  };
}
