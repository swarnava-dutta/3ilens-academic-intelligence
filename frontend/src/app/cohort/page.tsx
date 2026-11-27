import type { Metadata } from "next";
import { Suspense } from "react";
import { CohortDashboard } from "@/components/cohort/cohort-dashboard";
import { CohortSkeleton } from "@/components/cohort/states";

export const metadata: Metadata = {
  title: "Cohort",
  description:
    "Class results for one test: who needs help, what to re-teach, which questions to check, and the change since the last test.",
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
