"use client";

/**
 * <PreviewPair>: two <DocPreview>s side by side ("answer sheet vs question paper / answer key"),
 * stacked under 640px. Each side takes DocPreview's props (size defaults to "md").
 *
 *   import { PreviewPair } from "@/components/preview/preview-pair";
 *
 *   <PreviewPair
 *     caption="Check that the sheet was written against this paper"
 *     left={{ label: "Answer sheet", source: { kind: "file", file: sheet } }}
 *     right={{
 *       label: "Question paper",
 *       source: paperFile ? { kind: "file", file: paperFile } : null,
 *       emptyText: "No paper file on this rubric",
 *     }}
 *   />
 *
 *   // Report: stored answer-sheet pages next to the rubric's paper.
 *   left={{ label: "Answer sheet", name: s.original_filename,
 *           source: { kind: "url", pageUrl: (n) => pageImageUrl(s.id, n), pageCount: pages.length } }}
 *
 * Props: left, right (DocPreviewProps), caption (optional line above), className (merged onto the wrapper).
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DocPreview, type DocPreviewProps } from "./doc-preview";

interface PreviewPairProps {
  left: DocPreviewProps;
  right: DocPreviewProps;
  caption?: ReactNode;
  className?: string;
}

export function PreviewPair({ left, right, caption, className }: PreviewPairProps) {
  return (
    <div role="group" aria-label={`${left.label} and ${right.label}`} className={cn("min-w-0", className)}>
      {caption ? <p className="mb-2 text-xs text-slate-500">{caption}</p> : null}
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        <DocPreview size="md" {...left} />
        <DocPreview size="md" {...right} />
      </div>
    </div>
  );
}
