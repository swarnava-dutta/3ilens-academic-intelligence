import type { Metadata } from "next";
import { Suspense } from "react";
import { StudentsSkeleton } from "@/components/students/students-skeleton";
import { StudentsView } from "@/components/students/students-view";

export const metadata: Metadata = {
  title: "Students",
  description:
    "Per-student cards, teaching nudges and preparation focus across batches and tests, filterable by urgency and topic.",
};

// StudentsView reads the filters and the active tab from the URL (useSearchParams), so under
// cacheComponents it sits inside <Suspense>; the skeleton is the prerendered static shell.
export default function StudentsPage() {
  return (
    <Suspense fallback={<StudentsSkeleton />}>
      <StudentsView />
    </Suspense>
  );
}
