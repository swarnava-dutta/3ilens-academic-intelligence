import type { Metadata } from "next";
import { Suspense } from "react";
import { OwnerDashboard } from "@/components/owner/owner-dashboard";
import { CardSkeleton } from "@/components/owner/states";

export const metadata: Metadata = {
  title: "Owner dashboard",
  description:
    "Institute-owner view: batches, faculty, trends, weakest topics, intervention effectiveness and an illustrative what-if simulator. No login in this PoC.",
};

// Server Component shell; the dashboard is a Client Component that fetches from the FastAPI backend
// in the browser, so the prerendered shell is the loading skeleton.
export default function OwnerPage() {
  return (
    <Suspense fallback={<CardSkeleton rows={6} label="Loading owner dashboard…" />}>
      <OwnerDashboard />
    </Suspense>
  );
}
