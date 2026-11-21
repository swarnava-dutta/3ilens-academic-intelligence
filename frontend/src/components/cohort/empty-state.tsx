"use client";

import Link from "next/link";
import { useState } from "react";
import { ChartColumn, FlaskConical, Loader2, Upload } from "lucide-react";
import { errorMessage, seedDemoCohort } from "@/lib/api";
import type { Cohort } from "@/lib/types";
import { plural } from "./format";

export function CohortEmptyState({
  cohort,
  onSeeded,
}: {
  cohort: Cohort;
  onSeeded: () => Promise<void>;
}) {
  const [seeding, setSeeding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inPipeline = cohort.total_submissions ?? 0;

  async function loadDemo() {
    setSeeding(true);
    setError(null);
    setMessage(null);
    try {
      const res = await seedDemoCohort("all");
      setMessage(res?.message || "Demo cohort loaded.");
      await onSeeded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  }

  return (
    <section
      aria-labelledby="cohort-empty-title"
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm sm:px-12 sm:py-14"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-linear-to-r from-brand-cyan via-brand-cyan to-brand-lime"
      />
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-cyan-50 text-brand-cyan-600">
        <ChartColumn className="h-7 w-7" aria-hidden />
      </span>
      <h2 id="cohort-empty-title" className="mt-5 text-xl font-semibold text-brand-navy">
        No evaluated answer sheets yet
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-600">
        Cohort insights (topic mastery, score distribution and preparation priorities) appear here as
        soon as answer sheets finish AI evaluation.
        {inPipeline > 0
          ? ` ${plural(inPipeline, "submission is", "submissions are")} in the pipeline right now; this page refreshes automatically.`
          : " Upload handwritten answer sheets in the Faculty Workspace to get started."}
      </p>

      <div className="mt-7 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <Link
          href="/#upload"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-navy-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan"
        >
          <Upload className="h-4 w-4" aria-hidden />
          Upload answer sheets
        </Link>
        <button
          type="button"
          onClick={loadDemo}
          disabled={seeding}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-amber-800 ring-1 ring-inset ring-amber-300 transition hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:cursor-wait disabled:opacity-70"
        >
          {seeding ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <FlaskConical className="h-4 w-4" aria-hidden />
          )}
          {seeding ? "Loading demo cohort…" : "Load demo cohort"}
        </button>
      </div>

      <p className="mx-auto mt-4 max-w-md text-xs text-slate-500">
        The demo cohort is synthetic sample data, inserted without any AI calls. It stays clearly
        labelled as demo data on every screen.
      </p>

      <div aria-live="polite" className="mt-3 min-h-5 text-sm">
        {error ? (
          <p role="alert" className="font-medium text-rose-700">
            Could not load the demo cohort: {error}
          </p>
        ) : message ? (
          <p className="font-medium text-lime-700">{message}</p>
        ) : null}
      </div>
    </section>
  );
}
