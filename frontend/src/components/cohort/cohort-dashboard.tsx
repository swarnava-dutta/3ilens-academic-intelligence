"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { FilterX } from "lucide-react";
import { cn } from "@/lib/utils";
import { RubricVersionsPanel } from "@/components/rubrics/rubric-versions";
import { useDashboardFilters } from "@/components/shared/filter-bar";
import { hasDashboardFilters } from "@/components/workspace/use-submissions";
import { CohortToolbar } from "./cohort-actions";
import { CohortHeader, DemoNotice, StaleBanner } from "./cohort-header";
import { ConfusionsCard, CommonErrorsCard, InterventionsCard } from "./class-insights";
import { btnSecondary, Toast, type ToastMessage } from "./dialog";
import { CohortEmptyState } from "./empty-state";
import { ExamDateCard } from "./exam-date-card";
import { hasResults } from "./format";
import { InterventionEffect } from "./intervention-effect";
import { KpiGrid } from "./kpi-cards";
import { OperationsCard, ReleaseCard } from "./operations";
import { ExamBehaviourCard } from "./patterns";
import { PipelineHealth } from "./pipeline-health";
import { Priorities } from "./priorities";
import { ScoreDistribution } from "./score-distribution";
import { CohortErrorCard, CohortSkeleton } from "./states";
import { AtRiskCard, RankingCard } from "./student-lists";
import { TopicMastery } from "./topic-mastery";
import { UrgencyStrip } from "./urgency-strip";
import { useCohort } from "./use-cohort";

/**
 * Cohort Dashboard: GET /api/cohort with the URL filters (batch, test, urgency, topic), refreshed
 * every 10 s. Reads search params, so it must render inside <Suspense>.
 */
export function CohortDashboard() {
  const filters = useDashboardFilters();
  const pathname = usePathname();
  const { cohort, error, updatedLabel, refreshing, refresh } = useCohort(filters);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const filtered = hasDashboardFilters(filters);

  if (!cohort) {
    if (error) {
      return <CohortErrorCard message={error} onRetry={refresh} retrying={refreshing} />;
    }
    return <CohortSkeleton />;
  }

  const ready = hasResults(cohort);
  const denominator = cohort.completed ?? 0;
  const preferredRubricId = filters.rubric_id ?? cohort.rubric_versions?.[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <CohortHeader cohort={cohort} updatedLabel={updatedLabel} refreshing={refreshing} onRefresh={refresh} />
      <CohortToolbar cohort={cohort} filters={filters} />

      {error ? <StaleBanner message={error} updatedLabel={updatedLabel} /> : null}
      <DemoNotice cohort={cohort} />

      {ready ? (
        <>
          <KpiGrid cohort={cohort} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <UrgencyStrip cohort={cohort} />
            {cohort.batch ? (
              <ExamDateCard key={`${cohort.batch.id}-${cohort.batch.exam_date ?? ""}`} batch={cohort.batch} onSaved={refresh} />
            ) : null}
          </div>
          <PipelineHealth cohort={cohort} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <RankingCard ranking={cohort.ranking ?? []} mixed={cohort.mixed_rubrics ?? false} />
            <AtRiskCard rows={cohort.at_risk ?? []} />
          </div>
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-5">
            <TopicMastery topics={cohort.topic_mastery} className="lg:col-span-3" />
            <ScoreDistribution buckets={cohort.score_distribution} className="lg:col-span-2" />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <CommonErrorsCard errors={cohort.common_errors ?? []} denominator={denominator} />
            <div className="space-y-6">
              <ConfusionsCard clusters={cohort.confusion_clusters ?? []} denominator={denominator} />
              <InterventionsCard interventions={cohort.interventions ?? []} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <ExamBehaviourCard patterns={cohort.patterns} />
            </div>
            <InterventionEffect batchId={filters.batch_id} />
          </div>
          <Priorities priorities={cohort.top_priorities} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <OperationsCard cohort={cohort} />
            </div>
            <ReleaseCard cohort={cohort} />
          </div>
        </>
      ) : filtered ? (
        <>
          <section className="rounded-md border border-slate-200 bg-white p-5">
            <p className="text-base font-semibold text-brand-navy">No completed students match these filters</p>
            <p className="mt-1 max-w-xl text-sm text-slate-500">
              Sheets still in review, failed or processing are not counted. Change the filters above, or show the
              whole cohort.
            </p>
            <Link
              href={pathname}
              scroll={false}
              className={cn(btnSecondary, "mt-4")}
            >
              <FilterX className="h-4 w-4" aria-hidden />
              Clear filters
            </Link>
          </section>
          {(cohort.total_submissions ?? 0) > 0 ? <PipelineHealth cohort={cohort} /> : null}
        </>
      ) : (
        <>
          <CohortEmptyState cohort={cohort} onSeeded={refresh} />
          {(cohort.total_submissions ?? 0) > 0 ? <PipelineHealth cohort={cohort} /> : null}
          {cohort.batch ? (
            <ExamDateCard key={`${cohort.batch.id}-${cohort.batch.exam_date ?? ""}`} batch={cohort.batch} onSaved={refresh} />
          ) : null}
        </>
      )}

      <RubricVersionsPanel preferredRubricId={preferredRubricId} onRerunQueued={refresh} onToast={setToast} />
      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}
