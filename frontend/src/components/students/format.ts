// Formatting helpers for /students (one place, so cards, tables, the drawer and the CSV agree).
import { urgencyOf } from "@/components/shared/urgency-badge";
import { plural } from "@/lib/format";
import type { InterventionKind, OutcomeStatus, RosterRow, Trend, Urgency } from "@/lib/types";

/** Backend roster.py constants (kept in sync by hand; the API does the classifying). */
export const TREND_PTS = 5;
export const SMALL_TEST_QUESTIONS = 10;
export const WEAK_MASTERY = 60;
const VERY_WEAK_MASTERY = 40;

const IST = "Asia/Kolkata";

/** "1 mark" / "2.5 marks" (number via fmtMarks). */
export function marksWord(n: number): string {
  return `${fmtMarks(n)} mark${Math.abs(n) === 1 ? "" : "s"}`;
}

/** Marks: 402 -> "402", 12.5 -> "12.5", negatives with a real minus sign. */
export function fmtMarks(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return String(Number(n.toFixed(2))).replace(/^-/, "−");
}

/** Signed delta with one decimal: +8.3, −7.2, 0.0 (always a sign or a zero). */
export function fmtDelta(n: number): string {
  const v = Number(n.toFixed(1));
  if (v > 0) return `+${v.toFixed(1)}`;
  if (v < 0) return `−${Math.abs(v).toFixed(1)}`;
  return "0.0";
}

/** "24 Nov" in India Standard Time. */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short" }).format(d);
}

/** ISO date (YYYY-MM-DD) in IST, for the CSV. */
export function isoDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Today in IST as YYYY-MM-DD (date inputs). */
export function todayIst(): string {
  return isoDay(new Date().toISOString());
}

/** Same rule as the backend (sittings.short_test_name): "NEET MCQ Practice - Mock 09 (sample)" ->
 * "Mock 09"; "Biology - Genetics" stays whole (its last part names a chapter). A trailing version
 * ("… v1", as outcome labels carry) is dropped too. */
export function shortTest(name: string): string {
  const text = name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+v\d+$/i, "")
    .replace(/\s*\((?:sample|demo)\)\s*$/i, "");
  const at = text.lastIndexOf(" - ");
  if (at > 0) {
    const tail = text.slice(at + 3).trim();
    if (/\d/.test(tail)) return tail;
  }
  return text;
}

/** The short label of a roster paper (server short_name, else derived). */
export function shortOf(p: { test_name: string; short_name?: string }): string {
  return p.short_name || shortTest(p.test_name);
}

/** Test name, plus the version only when several versions of that name are in scope. */
export function testLabel(name: string, version: string, versioned: Set<string>): string {
  return versioned.has(name) && version ? `${name} ${version}` : name;
}

/** Short test label for tight cells ("Mock 09", "Biology - Genetics"), versioned like testLabel. */
export function shortLabel(
  p: { test_name: string; short_name?: string; test_version: string },
  versioned: Set<string>,
): string {
  const short = shortOf(p);
  return versioned.has(p.test_name) && p.test_version ? `${short} ${p.test_version}` : short;
}

/** Test names that appear with 2+ versions among the given papers. */
export function versionedNames(rows: RosterRow[]): Set<string> {
  const versions = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.latest) continue;
    const set = versions.get(r.latest.test_name) ?? new Set<string>();
    set.add(r.latest.test_version);
    versions.set(r.latest.test_name, set);
  }
  return new Set([...versions].filter(([, v]) => v.size > 1).map(([name]) => name));
}

/** A student name that is really an uploaded file name ("2016 Editable (1)", "scan_04.pdf"). */
export function looksLikeFileName(name: string): boolean {
  return /(editable|scan|img|\(\d+\)|\.pdf)/i.test(name);
}

/** URL value of the drawer param: "ref" for real students, "demo:ref" for synthetic ones. */
export function studentParam(row: Pick<RosterRow, "student_ref" | "is_demo">): string {
  return row.is_demo ? `demo:${row.student_ref}` : row.student_ref;
}

export function rowKey(row: Pick<RosterRow, "student_ref" | "is_demo">): string {
  return `${row.is_demo ? "d" : "r"}:${row.student_ref}`;
}

export const URGENCY_DOT: Record<Urgency, string> = {
  at_risk: "bg-red-600",
  needs_attention: "bg-amber-500",
  on_track: "bg-brand-lime-600",
};

/** Hex for SVG marks (sparkline last dot). */
export const URGENCY_HEX: Record<Urgency, string> = {
  at_risk: "#dc2626",
  needs_attention: "#f59e0b",
  on_track: "#65a30d",
};

export const TREND_TEXT: Record<Trend, string> = {
  improving: "text-lime-800",
  slipping: "text-red-700",
  steady: "text-slate-600",
};

export const KIND_LABELS: Record<InterventionKind, string> = {
  nudge: "Nudge",
  study_focus: "Study focus",
  class_intervention: "Class intervention",
  custom: "Custom",
};

export const OUTCOME_LABELS: Record<OutcomeStatus, string> = {
  pending: "Pending",
  improved: "Improved",
  flat: "No change",
  declined: "Declined",
  not_assessed: "Not re-tested",
};

export const OUTCOME_STYLES: Record<OutcomeStatus, string> = {
  pending: "border-slate-300 text-slate-600",
  improved: "border-lime-300 bg-brand-lime-50 text-lime-800",
  flat: "border-slate-300 text-slate-700",
  declined: "border-red-200 bg-red-50 text-red-700",
  not_assessed: "border-slate-300 text-slate-600",
};

/** Mastery tone square colour, on the page's own cut-offs: below 40% (very weak) rose, below
 * 60% (weak) amber, else lime - so a square's colour always agrees with the "below 60%" counts. */
export function masteryFill(mastery: number): string {
  if (mastery >= WEAK_MASTERY) return "bg-brand-lime";
  if (mastery >= VERY_WEAK_MASTERY) return "bg-amber-400";
  return "bg-rose-500";
}

/** "2 topics below 40%" only when that rule moved the status (the score alone decides it
 * otherwise, and the score is already in the row); "" when the score band decided. */
export function shortReason(row: RosterRow): string {
  if (!row.latest) return "";
  if (row.latest.urgency !== urgencyOf(row.latest.pct)) {
    return `${plural(row.very_weak_count, "topic")} below ${VERY_WEAK_MASTERY}%`;
  }
  return "";
}

/** "Mock 08 · 12 Qs, 48 marks" for a previous paper of a different kind. */
export function previousKind(p: { test_name: string; short_name?: string; questions: number; total_marks: number }): string {
  return `${shortOf(p)} · ${p.questions} Qs, ${fmtMarks(p.total_marks)} marks`;
}
