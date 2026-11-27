import type { Metadata } from "next";
import { Suspense } from "react";
import { OwnerDashboard, OwnerSkeleton } from "@/components/owner/owner-dashboard";

export const metadata: Metadata = {
  title: "Owner overview",
  description:
    "Institute-owner overview: what needs attention, batches, same-student progress, topics, exam behaviour, faculty follow-through, interventions, an illustrative what-if simulator and AI spend. No login in this PoC.",
};

// Server Component shell; the dashboard is a Client Component that fetches from the FastAPI backend
// in the browser (and reads ?tab= with useSearchParams), so the prerendered shell is the skeleton.
export default function OwnerPage() {
  return (
    <Suspense fallback={<OwnerSkeleton />}>
      <OwnerDashboard />
    </Suspense>
  );
}
