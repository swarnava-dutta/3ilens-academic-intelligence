import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Submission } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Mastery values are already 0-100. */
export function formatMastery(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}

/**
 * Why a HUMAN_REVIEW_REQUIRED sheet was held, for the review panel and the queue row:
 * "paper" = another paper / the wrong rubric, or another code / set of the paper (error_message is
 * the check's sentence); "confidence" = the sheet or a page below the OCR threshold; "no_answers" =
 * no rubric question has an answer although the pages read clearly (usually the wrong rubric);
 * "other" = another reason in error_message (a mostly blank sheet).
 */
export type ReviewHold = "paper" | "confidence" | "no_answers" | "other";

export function reviewHold(
  sub: Pick<Submission, "ocr_confidence" | "flagged_pages" | "error_message" | "review_reason">,
  threshold: number,
): ReviewHold {
  switch (sub.review_reason) {
    case "paper_mismatch":
    case "paper_reordered":
      return "paper";
    case "low_confidence":
    case "low_page_confidence":
      return "confidence";
    case "no_answers":
      return "no_answers";
    case "mostly_blank":
      return "other";
  }
  // Older API builds (no review_reason): read the stored sentence and numbers.
  const message = sub.error_message ?? "";
  if (/rubric/i.test(message) && /(paper|code|set|version|order)/i.test(message)) return "paper";
  const flagged = (sub.flagged_pages ?? []).length > 0;
  // Exactly 0 with no page below the threshold was the old default when no rubric question had an
  // answer (the mean of no answer confidences), not a low reading.
  if (!flagged && sub.ocr_confidence === 0) return "no_answers";
  const low = (sub.ocr_confidence !== null && sub.ocr_confidence < threshold) || flagged;
  return low || !message.trim() ? "confidence" : "other";
}

/** Tailwind text colour for a mastery percentage. */
export function masteryTone(mastery: number): "good" | "ok" | "weak" {
  if (mastery >= 75) return "good";
  if (mastery >= 50) return "ok";
  return "weak";
}
