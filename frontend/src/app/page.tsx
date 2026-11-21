import type { Metadata } from "next";
import { FacultyWorkspace } from "@/components/workspace/faculty-workspace";

export const metadata: Metadata = {
  title: "Intake · Faculty workspace",
  description:
    "Upload handwritten answer sheets singly or as a folder, manage rubrics, and track OCR, grading and reports.",
};

export default function Page() {
  return <FacultyWorkspace />;
}
