import type { Metadata } from "next";
import { Suspense } from "react";
import { CohortDashboard } from "@/components/cohort/cohort-dashboard";
import { CohortSkeleton } from "@/components/cohort/states";

export const metadata: Metadata = {
  title: "Cohort dashboard",
  description:
    "Batch ranking, at-risk students, common errors, concept confusions, class interventions, operations and rubric versions.",
};

// Server Component shell. The dashboard is a Client Component that reads its filters from the URL
// (useSearchParams) and polls the FastAPI backend from the browser, so it sits in a Suspense
// boundary and the prerendered shell is the loading skeleton.
export default function CohortPage() {
  return (
    <Suspense fallback={<CohortSkeleton />}>
      <CohortDashboard />
    </Suspense>
  );
}
