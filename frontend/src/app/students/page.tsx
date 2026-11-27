import type { Metadata } from "next";
import { Suspense } from "react";
import { StudentsSkeleton } from "@/components/students/students-skeleton";
import { StudentsView } from "@/components/students/students-view";

export const metadata: Metadata = {
  title: "Students",
  description: "Every student's latest paper, trend and next action, by batch and test.",
};

// StudentsView reads the scope, filters, tab and open student from the URL (useSearchParams), so under
// cacheComponents it sits inside <Suspense>; the skeleton is the prerendered static shell.
export default function StudentsPage() {
  return (
    <Suspense fallback={<StudentsSkeleton />}>
      <StudentsView />
    </Suspense>
  );
}
