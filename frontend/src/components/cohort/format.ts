// Cohort-only presentation helpers. Shared formatters live in @/lib/format.
import { numOrNull } from "@/lib/coerce";
import { clampPct, MINUS } from "@/lib/format";
import { masteryTone } from "@/lib/utils";

/** 12 -> "12", 12.345 -> "12.3" (drops trailing zeros). */
export function formatNumber(value: number | null | undefined, digits = 1): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  return String(Number(v.toFixed(digits)));
}

/** Share of a whole as a 0-100 number; null when the whole is 0. */
export function shareOf(part: number, whole: number): number | null {
  const p = numOrNull(part);
  const w = numOrNull(whole);
  if (p === null || w === null || w <= 0) return null;
  return (p / w) * 100;
}

export function formatPct(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${Math.round(v)}%`;
}

export function formatRoi(value: number | null | undefined): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  return v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function formatHours(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${formatNumber(v)} h`;
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

// --------------------------------------------------------------------------- //
// Cohort page formatting (one decimal in tiles and sentences, whole numbers in tables)
// --------------------------------------------------------------------------- //
/** 5.9 -> "+5.9", -1.5 -> "−1.5" (real minus sign). */
export function signed1(value: number | null | undefined): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  const text = Math.abs(v).toFixed(1);
  return v > 0 ? `+${text}` : v < 0 ? `${MINUS}${text}` : text;
}

/** Signed change in percentage points: "+5.9 pts". */
export function pts(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${signed1(v)} pts`;
}

/** Marks lost as a negative number with the real minus: 39 -> "−39". */
export function lost(value: number | null | undefined): string {
  const v = numOrNull(value);
  if (v === null) return "—";
  return v === 0 ? "0" : `${MINUS}${formatNumber(Math.abs(v))}`;
}

const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata" };

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "24 Nov" (IST, like the owner page). */
export function dayMonth(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? d.toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short" }) : "—";
}

/** "24 Nov 2026" (IST). */
export function fullDate(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? d.toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short", year: "numeric" }) : "—";
}

/** "n of N students". */
export function nOf(n: number, total: number, word = "student"): string {
  return `${n} of ${total} ${total === 1 ? word : `${word}s`}`;
}

/** Bins of the class distribution: [0,20) [20,40) [40,60) [60,80) [80,100]. */
export const BINS = [
  { label: "<20%", lo: 0, hi: 20 },
  { label: "20–39%", lo: 20, hi: 40 },
  { label: "40–59%", lo: 40, hi: 60 },
  { label: "60–79%", lo: 60, hi: 80 },
  { label: "80%+", lo: 80, hi: 101 },
] as const;

export function binOf(pct: number): number {
  return BINS.findIndex((b) => pct >= b.lo && pct < b.hi);
}

export const RETEACH_LINE = 60;

/** The urgency rule in the page's words (chapters, not topics). */
export const COHORT_URGENCY_RULE =
  "70% or more: on track · 55% to under 70%: needs attention · below 55%: at risk. One level worse when 2 or more chapters are below 40%";

/** At least a third of the students who sat a chapter (2 or more) below the re-teach line. */
export const RETEACH_RULE = `a third or more of the students who sat it (2 or more) below ${RETEACH_LINE}%`;

/** Link text with AA contrast on white and on cyan-50 (brand-cyan-600 is 3.8:1 - fills only). */
export const LINK_TEXT = "text-cyan-700 hover:text-cyan-800";
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700";

/** The shared Popover's panel on this page: flat (a border, no shadow), sized for a short form or note. */
export const POPOVER_PANEL =
  "min-w-0 w-[min(22rem,calc(100vw-2rem))] border-slate-300 p-3 text-sm text-slate-700 shadow-none print:block";

const LOW_CHAPTER = 40;

export type ChapterTone = "low" | "under" | "ok";

/**
 * Chapter colours on the cohort page follow the re-teach line, so a 58% chapter reads as "below
 * the line" (red below 40%, amber 40-59%, lime 60% and above). The 50 / 75 mastery bands stay on
 * the student report.
 */
export const CHAPTER_TONES: Record<ChapterTone, { label: string; bar: string; chip: string }> = {
  low: { label: `Below ${LOW_CHAPTER}%`, bar: "bg-red-600", chip: "bg-red-50 text-red-800 ring-red-200" },
  under: { label: `${LOW_CHAPTER}–${RETEACH_LINE - 1}%`, bar: "bg-amber-500", chip: "bg-amber-50 text-amber-900 ring-amber-200" },
  ok: { label: `${RETEACH_LINE}% or more`, bar: "bg-brand-lime-600", chip: "bg-brand-lime-50 text-lime-800 ring-brand-lime/50" },
};


function chapterToneKey(value: number | null | undefined): ChapterTone {
  const v = clampPct(value);
  return v < LOW_CHAPTER ? "low" : v < RETEACH_LINE ? "under" : "ok";
}

export function chapterTone(value: number | null | undefined) {
  return CHAPTER_TONES[chapterToneKey(value)];
}

/** NEET chapter weight (0-1 share of the exam) as "3.3%"; "—" when not in the chapter table. */
export function neetWeight(value: number | null | undefined): string {
  const v = numOrNull(value);
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}
