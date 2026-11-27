"use client";

import type { ReactNode } from "react";
import { useOcrThreshold } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { formatConfidence, formatDateTime } from "@/lib/format";
import type { Submission } from "@/lib/types";
import { reviewHold } from "@/lib/utils";
import { humanizeStep } from "./format";
import { SectionCard } from "./primitives";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-[13px] text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-slate-700 sm:text-right">{children}</dd>
    </div>
  );
}

export function SubmissionDetailsCard({
  submission,
  rubricLabel,
  className,
}: {
  submission: Submission;
  rubricLabel?: string;
  className?: string;
}) {
  const threshold = useOcrThreshold();
  // Held with no answers: the sheet confidence is the page legibility, and a stored 0 (a voice
  // answer, or a row held by an older build) means nothing was measured - not a 0% reading.
  const noAnswers =
    submission.status === "HUMAN_REVIEW_REQUIRED" && reviewHold(submission, threshold) === "no_answers";
  const unmeasured = noAnswers && (submission.ocr_confidence === null || submission.ocr_confidence === 0);
  const confidenceLabel = noAnswers && !unmeasured && submission.input_kind !== "voice" ? "Page legibility" : "OCR confidence";
  return (
    <SectionCard
      id="submission-details"
      title="Submission details"
      description="Governed record for this answer sheet."
      className={className}
    >
      <dl>
        <Row label="Student">{submission.student_name}</Row>
        <Row label="Status">
          <StatusBadge status={submission.status} />
        </Row>
        <Row label="File">
          <span className="font-mono text-xs">{submission.original_filename}</span>
        </Row>
        <Row label="Rubric">{rubricLabel ?? `Rubric ${submission.rubric_id}`}</Row>
        <Row label="Current step">{submission.current_step ? humanizeStep(submission.current_step) : "—"}</Row>
        <Row label={confidenceLabel}>
          {unmeasured ? "Not measured (no answers)" : formatConfidence(submission.ocr_confidence)}
          <span className="text-slate-500"> (threshold {Math.round(threshold * 100)}%)</span>
        </Row>
        <Row label="Submitted">{formatDateTime(submission.created_at)}</Row>
        <Row label="Last update">{formatDateTime(submission.updated_at)}</Row>
        <Row label="Data source">{submission.is_demo ? "Synthetic demo record" : "Live upload"}</Row>
      </dl>
    </SectionCard>
  );
}
