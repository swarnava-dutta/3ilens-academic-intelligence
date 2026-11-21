"use client";

import { isAxiosError } from "axios";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { errorMessage, getResult } from "@/lib/api";
import type { Result, ResultPending, SubmissionStatus } from "@/lib/types";
import { ReadyReport } from "./ready-report";
import { ReportErrorBoundary } from "./report-error-boundary";
import { ReportSkeleton } from "./report-skeleton";
import { ReportLoadError, ReportNotFound } from "./report-states";
import { ConnectionBanner, StatusView } from "./status-view";

const POLL_MS = 3000;

/** Statuses that are still moving. A COMPLETED 202 means the result row is still being written. */
const IN_FLIGHT: ReadonlySet<SubmissionStatus> = new Set<SubmissionStatus>(["PENDING", "PROCESSING", "COMPLETED"]);

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; result: Result }
  | { kind: "pending"; pending: ResultPending }
  | { kind: "notfound" }
  | { kind: "error"; message: string };

/**
 * Student Academic Intelligence Report for /report/[id]. Reads the id with useParams(), so the page
 * must render it inside <Suspense> (cacheComponents: the param is only known at request time).
 */
export function ReportView() {
  const params = useParams<{ id: string }>();
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (!id || !/^\d+$/.test(id)) return <ReportNotFound id={id} />;

  // Keyed by id so navigating between reports starts from a clean loading state.
  return (
    <ReportErrorBoundary key={id}>
      <ReportLoader id={id} />
    </ReportErrorBoundary>
  );
}

function ReportLoader({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Once a submission is known to be in flight, transient network errors keep polling.
    let inFlight = false;

    async function load() {
      try {
        const res = await getResult(id);
        if (cancelled) return;
        if (res.kind === "ready") {
          if (!res.result?.submission) throw new Error("The API returned an incomplete report.");
          setConnectionError(null);
          setState({ kind: "ready", result: res.result });
          return;
        }
        const pending = res.pending;
        if (!pending?.submission) throw new Error("The API returned an unexpected status payload.");
        setConnectionError(null);
        setState({ kind: "pending", pending });
        inFlight = IN_FLIGHT.has(pending.status ?? pending.submission.status);
      } catch (err) {
        if (cancelled) return;
        const httpStatus = isAxiosError(err) ? err.response?.status : undefined;
        if (httpStatus === 404 || httpStatus === 422) {
          setState({ kind: "notfound" });
          return;
        }
        if (!inFlight) {
          setState({ kind: "error", message: errorMessage(err) });
          return;
        }
        setConnectionError(errorMessage(err));
      }
      if (inFlight && !cancelled) timer = setTimeout(load, POLL_MS);
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, attempt]);

  const retry = () => {
    setState({ kind: "loading" });
    setConnectionError(null);
    setAttempt((a) => a + 1);
  };

  // After a re-run is queued: fetch again without the skeleton; a 202 switches to the
  // progress view, which keeps polling until the new result is ready.
  const reload = () => {
    setConnectionError(null);
    setAttempt((a) => a + 1);
  };

  switch (state.kind) {
    case "loading":
      return <ReportSkeleton />;
    case "notfound":
      return <ReportNotFound id={id} />;
    case "error":
      return <ReportLoadError message={state.message} onRetry={retry} />;
    case "pending":
      return (
        <div className="space-y-4">
          {connectionError ? <ConnectionBanner message={connectionError} /> : null}
          <StatusView pending={state.pending} onChanged={reload} />
        </div>
      );
    case "ready":
      return <ReadyReport key={`${id}-${attempt}`} result={state.result} onReload={reload} />;
  }
}
