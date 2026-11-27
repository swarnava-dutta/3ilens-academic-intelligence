// Display formatters shared by every page. Wording and tables that only one area uses stay in
// components/<area>/format.ts.
import { numOrNull } from "./coerce";

/** Typographic minus (U+2212) so negative numbers never read as a hyphen. */
export const MINUS = "−";

/** Clamp to 0-100 for widths and heights (null, NaN or a non-number -> 0). */
export function clampPct(value: unknown): number {
  return Math.min(100, Math.max(0, numOrNull(value) ?? 0));
}

/** 62.6 -> "62.6%" (always one decimal); "—" when unknown. */
export function pct1(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

/** "1 topic" / "3 topics" / "2 entries". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Rupees, e.g. "Rs 4.12" ("Rs 0.00" for a free OCR-cache hit; a negative value gets a real minus). */
export function inr(value: number | null | undefined, digits = 2): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  return `Rs ${v < 0 ? MINUS : ""}${Math.abs(v).toFixed(digits)}`;
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
