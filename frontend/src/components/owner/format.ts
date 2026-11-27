// Formatting helpers for the aggregate surfaces (owner, integrations, cohort patterns).
import { numOrNull } from "@/lib/coerce";
import { MINUS } from "@/lib/format";

/** 3 -> "3", -3 -> "−3", 2.25 -> "2.3" (digits = max decimals, trailing zeros dropped). */
export function fmt(value: number | null | undefined, digits = 1): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  const text = String(Number(Math.abs(v).toFixed(digits)));
  return v < 0 && text !== "0" ? `${MINUS}${text}` : text;
}

/** Signed delta: +3.2 / −1.5 / 0 ("—" when unknown). */
export function signed(value: number | null | undefined, digits = 1): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  const text = fmt(v, digits);
  return v > 0 && text !== "0" ? `+${text}` : text;
}

/** 0-100 percentage, e.g. "62%" / "62.5%" (digits = max decimals). */
export function pct(value: number | null | undefined, digits = 0): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${fmt(v, digits)}%`;
}

/** 0-1 share as a percentage, e.g. 0.5 -> "50%". */
export function share(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** "2026-11-20" or an ISO datetime -> "20 Nov 2026" (input returned unchanged when unparsable). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

/** ISO datetime -> "20 Nov, 14:05". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Short date for chart axes: "20 Nov". */
export function fmtShortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/** Tooltip shown on every total that may be negative. */
export const NET_TOOLTIP = "Net of negative marking (NEET MCQs: +4 correct, -1 wrong, 0 blank)";

/** Label shown next to every pattern threshold. */
export const THRESHOLD_NOTE = "default - confirm with academic lead";
