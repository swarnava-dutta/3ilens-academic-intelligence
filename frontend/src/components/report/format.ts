// Report-only helpers (generic helpers live in src/lib).
import { clampPct } from "@/lib/format";
import type { ResultKind } from "@/lib/types";
import { masteryTone } from "@/lib/utils";

// Exam weightage comes from the API (Priority.weightage, StudyPlan topics' exam_marks and RoiBasis);
// nothing here hard-codes subject weights.

type Tone = "good" | "ok" | "weak";

/** Visual tokens per mastery tone. Text always uses dark ink, fills carry the tone. */
export const TONE: Record<
  Tone,
  { label: string; fill: string; track: string; stroke: string; trackStroke: string; pill: string; text: string }
> = {
  good: {
    label: "Strong",
    fill: "bg-brand-lime",
    track: "bg-lime-100",
    stroke: "text-brand-lime",
    trackStroke: "text-lime-100",
    pill: "bg-brand-lime-50 text-lime-800 ring-brand-lime/50",
    text: "text-lime-700",
  },
  ok: {
    label: "Developing",
    fill: "bg-amber-400",
    track: "bg-amber-100",
    stroke: "text-amber-400",
    trackStroke: "text-amber-100",
    pill: "bg-amber-50 text-amber-800 ring-amber-200",
    text: "text-amber-700",
  },
  weak: {
    label: "Needs focus",
    fill: "bg-rose-500",
    track: "bg-rose-100",
    stroke: "text-rose-500",
    trackStroke: "text-rose-100",
    pill: "bg-rose-50 text-rose-700 ring-rose-200",
    text: "text-rose-700",
  },
};

export function toneFor(masteryPct: number): Tone {
  return masteryTone(safeNumber(masteryPct));
}

/** OCR confidence (0-1) tone: at/above the auto-grade threshold (useOcrThreshold) is good. */
export function confidenceTone(confidence: number | null | undefined, threshold: number): Tone {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return "ok";
  if (confidence >= threshold) return "good";
  return confidence >= 0.5 ? "ok" : "weak";
}

export function safeNumber(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** score / max as 0-100. */
export function ratioPct(score: unknown, max: unknown): number {
  const m = safeNumber(max);
  return m > 0 ? clampPct((safeNumber(score) / m) * 100) : 0;
}

/** Locale number; negatives carry a real minus sign (U+2212), e.g. "−3" for net marks. */
export function fmtNumber(n: unknown, maxDigits = 1): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: maxDigits }).replace(/^-/, "−");
}

/**
 * The report's one percentage format: 1 decimal, computed from score and max (never from a stored
 * rounded value): 402/720 -> "55.8%", 72/180 -> "40.0%". "—" when max is 0.
 */
export function fmtPct1(score: unknown, max: unknown): string {
  const m = safeNumber(max);
  if (m <= 0) return "—";
  return fmtPctValue((safeNumber(score) / m) * 100);
}

/** A percentage the server already computed (0-100), in the same 1-decimal format: 55.833 -> "55.8%". */
export function fmtPctValue(pct: unknown): string {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "—";
  // Round half away from zero on the decimal string, not the binary value (85.05 -> 85.1).
  const abs = Math.abs(pct);
  const shifted = Number(`${abs}e1`);
  const rounded = Math.round(Number.isFinite(shifted) ? shifted : abs * 10) / 10;
  return `${pct < 0 && rounded !== 0 ? "−" : ""}${rounded.toFixed(1)}%`;
}

/** A 0-1 fraction as a 1-decimal percentage: 0.802 -> "80.2%". */
export function fmtFraction1(fraction: unknown): string {
  return typeof fraction === "number" && Number.isFinite(fraction) ? fmtPctValue(fraction * 100) : "—";
}

/** Marks: whole numbers when whole, else 1 decimal; real minus sign ("−8"). */
export function fmtMarks(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const v = Math.round(n * 10) / 10;
  const text = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  return `${v < 0 ? "−" : ""}${text}`;
}

/** "Physics", "Rotational motion" -> "physics", "rotational-motion" (matches the server's evidence anchors). */
export function slug(text: string): string {
  return (
    String(text ?? "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

const normName = (s: string) => s.replace(/[_\s]+/g, " ").trim().toLowerCase();

/**
 * The student's name, or null while it is only the uploaded file's name ("2016 Editable (1)" for
 * "2016_Editable (1).pdf"): a file name is never shown as a student's name.
 */
export function studentName(sub: { student_name: string; original_filename?: string | null }): string | null {
  const name = (sub.student_name ?? "").trim();
  const stem = (sub.original_filename ?? "").trim().replace(/\.[A-Za-z0-9]{1,5}$/, "");
  if (!name || (stem && normName(name) === normName(stem))) return null;
  return name;
}

/** "A or B", "A, B or C". */
export function orJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Signed marks: +4, −1, 0 (real minus sign). */
export function fmtSigned(n: unknown, maxDigits = 1): string {
  const v = safeNumber(n);
  return v > 0 ? `+${fmtNumber(v, maxDigits)}` : fmtNumber(v, maxDigits);
}

/** Tooltip for a net total that went below zero. */
export const NET_TOTAL_TITLE = "Net of negative marking";

/** A rule's cut point as a percentage: "20%" when whole (break-even, the 70% line), else 1 decimal. */
export function fmtRulePct(pct: number): string {
  const r = Math.round(pct * 10) / 10;
  return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
}

/** "4 h 15 min" (45 -> "45 min", 120 -> "2 h"). */
function fmtMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** "255 min (4 h 15 min)": the study plan's planned time (planned_minutes_total), one format everywhere. */
export function plannedMinutesText(minutes: number): string {
  const total = Math.round(minutes);
  return total >= 60 ? `${total} min (${fmtMinutes(total)})` : `${total} min`;
}

export function fmtHours(h: unknown): string {
  return typeof h === "number" && Number.isFinite(h) ? `${fmtNumber(h, 1)} h` : "—";
}

export function fmtRoi(roi: unknown): string {
  return typeof roi === "number" && Number.isFinite(roi)
    ? roi.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
}

/** Time of day with seconds, for the audit trail. */
export function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDuration(fromIso: string | undefined, toIso: string | undefined): string | null {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

const ACRONYMS: Record<string, string> = { ocr: "OCR", roi: "ROI", ai: "AI", dlq: "DLQ", pdf: "PDF", llm: "LLM", json: "JSON" };

/** "ocr_extraction" -> "OCR extraction"; already-readable labels ("Pre-processing") are kept as-is. */
export function humanizeStep(step: string): string {
  const raw = String(step ?? "").trim();
  if (/\s|[A-Z]/.test(raw)) return raw;
  const words = raw
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (words.length === 0) return "Step";
  const [first, ...rest] = words;
  const head = first === first.toUpperCase() ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(" ");
}

// --------------------------------------------------------------------------- //
// SAIR report helpers (contract v2)
// --------------------------------------------------------------------------- //

const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const IST_ISO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // Plain ISO dates ("2027-05-02") are calendar dates: read them at IST noon so they never shift a day.
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T12:00:00+05:30`) : Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "20 Nov 2026, 21:01 IST" (India Standard Time, as the SAIR run metadata). */
export function fmtIST(iso: string | null | undefined): string {
  const t = parseTime(iso);
  return t === null ? (iso ?? "—") || "—" : `${IST_DATE_TIME.format(t)} IST`;
}

/** "20 Nov 2026" in IST. */
export function fmtISTDate(iso: string | null | undefined): string {
  const t = parseTime(iso);
  return t === null ? (iso ?? "—") || "—" : IST_DATE.format(t);
}

/** "2026-11-20" (the IST calendar date). */
export function isoDateIST(iso: string | null | undefined): string {
  const t = parseTime(iso);
  return t === null ? (iso ?? "") : IST_ISO_DATE.format(t);
}

export function fmtBytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 42 -> "42 s"; 192 -> "3 min 12 s". */
export function fmtSeconds(s: unknown): string {
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0) return "—";
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** "3.5/4" */
export function fraction(score: unknown, max: unknown): string {
  return `${fmtNumber(safeNumber(score))}/${fmtNumber(safeNumber(max))}`;
}

/** First 12 and last 6 hex characters of a SHA-256. */
export function shortHash(hash: string | null | undefined, head = 12, tail = 6): string {
  const h = String(hash ?? "").trim();
  if (!h) return "—";
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** "Q3" chips sort numerically and drop duplicates / non-numbers. */
export function uniqueSorted(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)))].sort(
    (a, b) => a - b,
  );
}

/** The grader's note on an MCQ bonus question (backend marking.BONUS_NOTE: "Bonus question - full marks to everyone"). */
export function isBonusNote(note: string | null | undefined): boolean {
  return /\bbonus question\b/i.test(note ?? "");
}

export const OUTCOME_LOOK: Record<
  "FULL" | "PARTIAL" | "ZERO" | "BLANK",
  { label: string; short: string; pill: string; fill: string; dot: string }
> = {
  FULL: {
    label: "Full credit",
    short: "Full",
    pill: "bg-brand-lime-50 text-lime-800 ring-brand-lime/50",
    fill: "bg-brand-lime",
    dot: "bg-brand-lime",
  },
  PARTIAL: {
    label: "Partial credit",
    short: "Partial",
    pill: "bg-amber-50 text-amber-800 ring-amber-200",
    fill: "bg-amber-400",
    dot: "bg-amber-400",
  },
  ZERO: { label: "Zero marks", short: "Zero", pill: "bg-rose-50 text-rose-700 ring-rose-200", fill: "bg-rose-500", dot: "bg-rose-500" },
  BLANK: {
    label: "Not attempted",
    short: "Blank",
    pill: "bg-slate-100 text-slate-600 ring-slate-300",
    fill: "bg-slate-400",
    dot: "bg-slate-400",
  },
};

/**
 * How one question went, keyed by result_kind (the paper's vocabulary): MCQ papers say right / wrong /
 * blank / bonus ("Wrong −1", never "Zero marks"); written answers keep full / partial / zero / blank.
 * `pill` pairs a tint with text, so colour is never the only cue.
 */
export const RESULT_LOOK: Record<ResultKind, { label: string; pill: string }> = {
  right: { label: "Right", pill: "bg-blue-50 text-[#1E40AF] ring-blue-200" },
  wrong: { label: "Wrong", pill: "bg-red-50 text-red-700 ring-red-200" },
  blank: { label: "Blank", pill: "bg-slate-100 text-slate-700 ring-slate-300" },
  bonus: { label: "Bonus", pill: "bg-sky-50 text-sky-800 ring-sky-200" },
  partial: { label: "Partial credit", pill: "bg-amber-50 text-amber-800 ring-amber-200" },
  zero: { label: "Zero marks", pill: "bg-red-50 text-red-700 ring-red-200" },
};

/** "Wrong −1", "Right +4", "Bonus +4", "Blank 0"; written answers: "Full credit", "Partial credit"... */
export function resultLabel(q: { result_kind?: ResultKind; question_type: string; estimated_marks: number; outcome: string }): string {
  const kind = q.result_kind ?? "partial";
  if (q.question_type !== "mcq") {
    if (q.outcome === "FULL") return "Full credit";
    if (q.outcome === "BLANK") return "Not attempted";
    return RESULT_LOOK[kind].label;
  }
  const marks = q.estimated_marks;
  return `${RESULT_LOOK[kind].label} ${marks > 0 ? `+${fmtMarks(marks)}` : fmtMarks(marks)}`;
}

/**
 * Options an MCQ key accepts, read from the grader's note when the API has no accepted_options:
 * "Marked A, accepted B or C (-1)", "Accepted options A or D (+4)".
 */
export function acceptedFromNote(note: string | null | undefined): string[] {
  const match = /[Aa]ccepted(?: options?:?)?\s+([A-F](?:\s*(?:,|or|\/)\s*[A-F])+)/.exec(note ?? "");
  return match ? [...new Set(match[1].match(/[A-F]/g) ?? [])] : [];
}

export const NUDGE_LOOK: Record<"high" | "medium" | "low", { label: string; pill: string }> = {
  high: { label: "High priority", pill: "bg-rose-50 text-rose-700 ring-rose-200" },
  medium: { label: "Medium priority", pill: "bg-amber-50 text-amber-800 ring-amber-200" },
  low: { label: "Low priority", pill: "bg-slate-100 text-slate-600 ring-slate-200" },
};

export const SOURCE_LABEL: Record<"ai" | "template" | "faculty", string> = {
  ai: "AI-drafted",
  template: "Rule template",
  faculty: "Faculty",
};
