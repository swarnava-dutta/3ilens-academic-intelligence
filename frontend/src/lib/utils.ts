import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Submission } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 0.1 -> "10%"; 0.125 -> "12.5%" */
export function formatWeight(fraction: number): string {
  const pct = fraction * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** 0.873 -> "87%" (confidence values are 0-1). */
export function formatConfidence(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

/** Mastery values are already 0-100. */
export function formatMastery(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}

export function formatScore(score: number | null | undefined, total: number): string {
  if (score === null || score === undefined) return "—";
  const s = Number.isInteger(score) ? score : Number(score.toFixed(1));
  return `${s} / ${total}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Why a HUMAN_REVIEW_REQUIRED sheet was held: "paper" = the same-paper check found another paper
 * or another code / set of it (error_message is that check's sentence); "confidence" = OCR
 * confidence or a page below the threshold; "other" = another reason in error_message (a mostly
 * blank sheet).
 */
export type ReviewHold = "paper" | "confidence" | "other";

export function reviewHold(
  sub: Pick<Submission, "ocr_confidence" | "flagged_pages" | "error_message">,
  threshold: number,
): ReviewHold {
  const message = sub.error_message ?? "";
  if (/rubric/i.test(message) && /(paper|code|set|version|order)/i.test(message)) return "paper";
  const low = (sub.ocr_confidence !== null && sub.ocr_confidence < threshold) || (sub.flagged_pages ?? []).length > 0;
  return low || !message.trim() ? "confidence" : "other";
}

/** Tailwind text colour for a mastery percentage. */
export function masteryTone(mastery: number): "good" | "ok" | "weak" {
  if (mastery >= 75) return "good";
  if (mastery >= 50) return "ok";
  return "weak";
}
