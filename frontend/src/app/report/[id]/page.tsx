import type { Metadata } from "next";
import { Suspense } from "react";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { ReportView } from "@/components/report/report-view";

export const metadata: Metadata = {
  title: "Student Academic Intelligence Report",
  description:
    "Question-linked academic diagnostic from the uploaded answer sheet: provisional marks, topic screening, teacher action plan, Preparation ROI Lab, evidence trace and original pages.",
};

// The report is fetched in the browser (GET /api/results/{id}, polled while processing).
// ReportView reads the id with useParams(); under cacheComponents that hook suspends for
// params not known at build time, so it sits inside <Suspense> and the skeleton is the
// prerendered static shell.
export default function ReportPage() {
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ReportView />
    </Suspense>
  );
}
