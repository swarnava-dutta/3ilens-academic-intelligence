import type { Metadata } from "next";
import { FacultyWorkspace } from "@/components/workspace/faculty-workspace";

export const metadata: Metadata = {
  title: "Intake · Faculty workspace",
  description:
    "Upload handwritten answer sheets or printed MCQ papers singly or as a folder, draft rubrics from question papers, and track OCR, grading and reports.",
};

export default function Page() {
  return <FacultyWorkspace />;
}
