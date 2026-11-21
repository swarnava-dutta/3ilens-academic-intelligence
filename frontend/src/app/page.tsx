import type { Metadata } from "next";
import { FacultyWorkspace } from "@/components/workspace/faculty-workspace";

export const metadata: Metadata = {
  title: "Intake · Faculty Workspace",
  description:
    "Upload handwritten answer sheets one at a time or as a folder, author rubrics, and track AI OCR, rubric evaluation and insights in real time.",
};

export default function Page() {
  return <FacultyWorkspace />;
}
