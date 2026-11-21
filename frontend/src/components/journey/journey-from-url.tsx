"use client";

import { useSearchParams } from "next/navigation";
import { JourneyExplorer } from "./journey-explorer";
import { stepIndexFrom } from "./steps";

/** Selected step from ?step= (an id like "ocr" or a 1-based number). Render inside <Suspense>. */
export function JourneyFromUrl() {
  const searchParams = useSearchParams();
  return <JourneyExplorer activeIndex={stepIndexFrom(searchParams.get("step"))} />;
}
