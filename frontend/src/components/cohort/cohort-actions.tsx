"use client";

import { useState } from "react";
import { AlertTriangle, FileArchive, FileDown, MessageCircle } from "lucide-react";
import { useHealth } from "@/components/app-shell";
import { FilterBar } from "@/components/shared/filter-bar";
import { bundleZipUrl, cohortPdfUrl, type DashboardQuery } from "@/lib/api";
import type { Cohort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WhatsAppDialog } from "./whatsapp-dialog";

const actionClass =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium ring-1 ring-inset transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-cyan";

/**
 * Filters (batch, test, urgency, topic in the URL) plus the batch outputs: cohort PDF, ZIP of every
 * report and the simulated WhatsApp send. Uses useSearchParams via FilterBar: render in <Suspense>.
 */
export function CohortToolbar({ cohort, filters }: { cohort: Cohort; filters: DashboardQuery }) {
  const { health } = useHealth();
  const [whatsAppOpen, setWhatsAppOpen] = useState(false);
  const ranking = cohort.ranking ?? [];
  const completedIds = ranking.map((r) => r.submission_id);
  const names = new Map(ranking.map((r) => [r.submission_id, r.student_name]));
  const hasCompleted = (cohort.completed ?? 0) > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <FilterBar show={["batch", "test", "urgency", "topic"]} />
        <div className="flex flex-wrap gap-2">
          <a
            href={cohortPdfUrl(filters)}
            download
            aria-disabled={!hasCompleted}
            className={cn(
              actionClass,
              "bg-brand-navy text-white ring-brand-navy hover:bg-brand-navy-700",
              !hasCompleted && "pointer-events-none opacity-50",
            )}
          >
            <FileDown className="h-4 w-4" aria-hidden />
            Cohort PDF
          </a>
          <a
            href={bundleZipUrl(filters)}
            download
            aria-disabled={!hasCompleted}
            className={cn(
              actionClass,
              "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50",
              !hasCompleted && "pointer-events-none opacity-50",
            )}
            title="Every completed student PDF plus the cohort PDF, for the current filters"
          >
            <FileArchive className="h-4 w-4" aria-hidden />
            All reports (ZIP)
          </a>
          <button
            type="button"
            onClick={() => setWhatsAppOpen(true)}
            disabled={completedIds.length === 0}
            className={cn(actionClass, "bg-white text-emerald-800 ring-emerald-300 hover:bg-emerald-50 disabled:opacity-50")}
          >
            <MessageCircle className="h-4 w-4" aria-hidden />
            WhatsApp batch <span className="text-xs font-normal text-emerald-700/80">(simulated)</span>
          </button>
        </div>
      </div>

      {cohort.mixed_rubrics ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            <span className="font-semibold">Mixing tests - compared by percentage; pick a test to compare like with like.</span>{" "}
            {(cohort.rubric_versions ?? []).length > 0 ? (
              <span className="text-amber-800">
                In this view: {(cohort.rubric_versions ?? []).map((r) => `${r.name} ${r.version}`).join(" · ")}.
              </span>
            ) : null}
          </span>
        </p>
      ) : null}

      <WhatsAppDialog
        open={whatsAppOpen}
        onClose={() => setWhatsAppOpen(false)}
        submissionIds={completedIds}
        names={names}
        whatsappMode={health?.whatsapp_mode ?? null}
      />
    </div>
  );
}
