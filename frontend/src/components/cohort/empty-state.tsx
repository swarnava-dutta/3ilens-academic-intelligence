"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { errorMessage, seedDemoCohort } from "@/lib/api";
import type { Cohort, DemoSet } from "@/lib/types";
import { btnPrimary, btnSecondary } from "./dialog";
import { plural } from "./format";

export function CohortEmptyState({
  cohort,
  onSeeded,
}: {
  cohort: Cohort;
  onSeeded: () => Promise<void>;
}) {
  const [seeding, setSeeding] = useState<DemoSet | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inPipeline = cohort.total_submissions ?? 0;

  /** set=all: Genetics + mixed demo cohorts; set=insights: the insights sample (NEET-C, MCQ papers, interventions). */
  async function loadDemo(set: DemoSet) {
    setSeeding(set);
    setError(null);
    setMessage(null);
    try {
      const res = await seedDemoCohort(set);
      setMessage(res?.message || "Demo cohort loaded.");
      await onSeeded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSeeding(null);
    }
  }

  return (
    <section aria-labelledby="cohort-empty-title" className="rounded-md border border-slate-200 bg-white p-5 sm:p-6">
      <h2 id="cohort-empty-title" className="text-base font-semibold text-brand-navy">
        No evaluated answer sheets yet
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        Topic mastery, score distribution and preparation priorities appear here once answer sheets finish evaluation.
        {inPipeline > 0
          ? ` ${plural(inPipeline, "submission is", "submissions are")} in the pipeline now; this page refreshes automatically.`
          : " Upload handwritten answer sheets in the Faculty Workspace to start."}
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link href="/#upload" className={btnPrimary}>
          <Upload className="h-4 w-4" aria-hidden />
          Upload answer sheets
        </Link>
        <button type="button" onClick={() => void loadDemo("all")} disabled={seeding !== null} className={btnSecondary}>
          {seeding === "all" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {seeding === "all" ? "Loading demo cohort…" : "Load demo cohort"}
        </button>
        <button type="button" onClick={() => void loadDemo("insights")} disabled={seeding !== null} className={btnSecondary}>
          {seeding === "insights" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {seeding === "insights" ? "Loading insights sample…" : "Load insights sample (MCQ papers, interventions)"}
        </button>
      </div>

      <p className="mt-3 max-w-2xl text-xs text-slate-500">
        The demo cohort and the insights sample (NEET-C (sample), NEET MCQ papers, logged interventions) are synthetic
        sample data, inserted without any model calls, and stay labelled as demo data on every screen.
      </p>

      <div aria-live="polite" className="mt-2 min-h-5 text-sm">
        {error ? (
          <p role="alert" className="font-medium text-red-700">
            Could not load the demo cohort: {error}
          </p>
        ) : message ? (
          <p className="text-slate-700">{message}</p>
        ) : null}
      </div>
    </section>
  );
}
