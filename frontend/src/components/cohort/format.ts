// Cohort-only presentation helpers. Shared formatters live in @/lib/utils.
import type { Batch, Cohort } from "@/lib/types";
import { masteryTone } from "@/lib/utils";

/** Finite number or null (guards against NaN / undefined from an evolving backend). */
export function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Clamp to 0-100 for widths/heights. */
export function clampPct(value: number | null | undefined): number {
  const v = num(value);
  if (v === null) return 0;
  return Math.min(100, Math.max(0, v));
}

/** 12 -> "12", 12.345 -> "12.3" (drops trailing zeros). */
export function formatNumber(value: number | null | undefined, digits = 1): string {
  const v = num(value);
  if (v === null) return "—";
  return String(Number(v.toFixed(digits)));
}

/** Share of a whole as a 0-100 number; null when the whole is 0. */
export function shareOf(part: number, whole: number): number | null {
  const p = num(part);
  const w = num(whole);
  if (p === null || w === null || w <= 0) return null;
  return (p / w) * 100;
}

export function formatPct(value: number | null | undefined): string {
  const v = num(value);
  return v === null ? "—" : `${Math.round(v)}%`;
}

export function formatRoi(value: number | null | undefined): string {
  const v = num(value);
  if (v === null) return "—";
  return v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function formatHours(value: number | null | undefined): string {
  const v = num(value);
  return v === null ? "—" : `${formatNumber(v)} h`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "NEET-A" + "Mock-07" -> "NEET-A Mock-07" without duplicating when the name already includes it. */
export function batchLabel(batch: Batch | null | undefined): string {
  const name = batch?.name?.trim() ?? "";
  const exam = batch?.exam_type?.trim() ?? "";
  if (!exam) return name || "Active batch";
  if (!name) return exam;
  if (name.toLowerCase().includes(exam.toLowerCase())) return name;
  return `${name} ${exam}`; // "NEET-A Mock-07", as in the spec and the app shell
}

/** True when there is at least one evaluated result to chart. */
export function hasResults(cohort: Cohort): boolean {
  return (cohort.total_submissions ?? 0) > 0 && num(cohort.average_score) !== null;
}

export type Tone = "good" | "ok" | "weak";

export const TONES: Record<
  Tone,
  { label: string; range: string; bar: string; dot: string; chip: string }
> = {
  weak: {
    label: "Needs focus",
    range: "below 50%",
    bar: "bg-rose-500",
    dot: "bg-rose-500",
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
  },
  ok: {
    label: "Developing",
    range: "50–74%",
    bar: "bg-amber-500",
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  good: {
    label: "Strong",
    range: "75% and above",
    bar: "bg-brand-lime-600",
    dot: "bg-brand-lime-600",
    chip: "bg-brand-lime-50 text-lime-800 ring-brand-lime/50",
  },
};

export function toneFor(mastery: number | null | undefined) {
  return TONES[masteryTone(clampPct(mastery))];
}

/** Threshold used for the "strong" reference line (matches masteryTone in @/lib/utils). */
export const MASTERY_TARGET = 75;
