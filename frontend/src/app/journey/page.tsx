import type { Metadata } from "next";
import { Suspense } from "react";
import { JourneyExplorer } from "@/components/journey/journey-explorer";
import { JourneyFromUrl } from "@/components/journey/journey-from-url";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The 12-step 3iLens journey from onboarding to the learning loop, and what this proof of concept implements, stands in for or mocks at each step.",
};

// The selected step lives in ?step= (read with useSearchParams), so that part sits in a Suspense
// boundary. The fallback is the same walkthrough opened at step 1; its links work without JS.
export default function JourneyPage() {
  return (
    <Suspense fallback={<JourneyExplorer activeIndex={0} />}>
      <JourneyFromUrl />
    </Suspense>
  );
}
