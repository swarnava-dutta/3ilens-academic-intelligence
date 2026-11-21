import type { Metadata } from "next";
import { Suspense } from "react";
import { IntegrationsView } from "@/components/integrations/integrations-view";
import { CardSkeleton } from "@/components/owner/states";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "LMS export API (JSON / CSV, API keys stored hashed) and the AI provider chain with a Claude -> GPT-4o fallback drill.",
};

// Server Component shell; the cards are Client Components that call the FastAPI backend from the browser.
export default function IntegrationsPage() {
  return (
    <Suspense fallback={<CardSkeleton rows={6} label="Loading integrations…" />}>
      <IntegrationsView />
    </Suspense>
  );
}
