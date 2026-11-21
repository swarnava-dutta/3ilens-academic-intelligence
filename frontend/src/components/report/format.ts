// Report-only helpers (shared lib files are owned elsewhere).
import { masteryTone } from "@/lib/utils";

// Exam weightage comes from the API (Priority.weightage, StudyPlan topics' exam_marks and RoiBasis);
// nothing here hard-codes subject weights.

export type Tone = "good" | "ok" | "weak";

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

/** Clamp to 0-100 (NaN -> 0). */
export function clampPct(n: unknown): number {
  return Math.min(100, Math.max(0, safeNumber(n)));
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

/** Signed marks: +4, −1, 0 (real minus sign). */
export function fmtSigned(n: unknown, maxDigits = 1): string {
  const v = safeNumber(n);
  return v > 0 ? `+${fmtNumber(v, maxDigits)}` : fmtNumber(v, maxDigits);
}

/** Tooltip for a net total that went below zero. */
export const NET_TOTAL_TITLE = "Net of negative marking";

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

/** "Rs 0.42" (the lead's wording for costs, e.g. "OCR cache hit - no vision call (Rs 0.00)"). */
export function fmtInr(n: unknown, digits = 2): string {
  return typeof n === "number" && Number.isFinite(n) ? `Rs ${n.toFixed(digits)}` : "—";
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

/** Topic-screening colour groups (presentation aids, not psychometric mastery). */
export function priorityGroup(rank: number | null | undefined): { fill: string; label: string } {
  if (typeof rank === "number" && rank >= 1 && rank <= 2) return { fill: "bg-rose-500", label: `P${rank}` };
  if (typeof rank === "number" && rank >= 3 && rank <= 5) return { fill: "bg-amber-500", label: `P${rank}` };
  return { fill: "bg-sky-600", label: "Other" };
}
