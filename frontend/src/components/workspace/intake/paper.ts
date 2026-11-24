// Printed papers at intake: POST /api/intake/inspect tells an answer sheet from a printed MCQ
// question paper (a student's ticks are read as answers) and from a question paper that carries
// its own answer key (that one belongs in the rubric, not in the queue). With a saved rubric chosen
// it also compares the printed questions with that rubric (rubric_match: the same paper, another
// code / set, or a different paper). Advisory only: the API repeats its checks on upload (a sheet
// that does not match is held for faculty review, never rejected), and an API build without the
// endpoint just shows nothing.
import { errorStatus, inspectPaper } from "@/lib/api";
import type { PaperInspection, RubricMatch } from "@/lib/types";
import type { SheetKind } from "./inspect";

/** Kinds worth inspecting: documents with pages and possibly a text layer. */
export function isPaperCandidate(kind: SheetKind | null | undefined): boolean {
  return kind === "pdf" || kind === "docx";
}

/** Set once the API answers 404 / 405 (an older build): stop asking for the rest of the session. */
let unsupported = false;

/**
 * The inspection, or null when it is unavailable or failed (the upload repeats every check).
 * rubricId: compare the printed questions with that saved rubric (rubric_match).
 */
export async function fetchInspection(file: File, rubricId?: number | null): Promise<PaperInspection | null> {
  if (unsupported) return null;
  try {
    const inspection = await inspectPaper(file, rubricId);
    // Older API builds leave rubric_match out.
    return { ...inspection, rubric_match: inspection.rubric_match ?? null };
  } catch (err) {
    const status = errorStatus(err);
    if (status === 404 || status === 405) unsupported = true;
    return null;
  }
}

/**
 * "45 pages - the limit is 40 pages" when the file is over the server's page limit, else null.
 * pages is null for a Word file too long to lay out: "Longer than the 40-page limit".
 */
export function pageLimitProblem(inspection: PaperInspection | null | undefined): string | null {
  if (!inspection || inspection.within_page_limit) return null;
  const pages = inspection.pages;
  if (pages === null) return `Longer than the ${inspection.max_pdf_pages}-page limit`;
  return `${pages} ${pages === 1 ? "page" : "pages"} - the limit is ${inspection.max_pdf_pages} pages`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Question paper with its answer key - 45 questions, 43 answers found." */
export function answerKeyLine(inspection: PaperInspection): string {
  return (
    `Question paper with its answer key - ${plural(inspection.numbered_questions, "question")}, ` +
    `${plural(inspection.answer_markers, "answer")} found.`
  );
}

/**
 * "19 pages, about 175 questions." - the notice's tag already says "Printed MCQ paper". The page
 * count is left out when it is unknown (a Word file too long to lay out).
 */
export function printedPaperLine(inspection: PaperInspection): string {
  const questions = `about ${plural(inspection.numbered_questions, "question")}.`;
  if (inspection.pages === null) return questions.charAt(0).toUpperCase() + questions.slice(1);
  return `${plural(inspection.pages, "page")}, ${questions}`;
}

export interface PaperTag {
  label: string;
  tone: "amber" | "neutral";
  hint: string;
}

/** Quiet per-row tag in batch staging (null for answer sheets / unknown). */
export function paperTag(inspection: PaperInspection | null | undefined): PaperTag | null {
  if (!inspection) return null;
  if (inspection.role === "answer_key_paper") {
    return {
      label: "Answer key paper",
      tone: "amber",
      hint: "Looks like a question paper with its key, not a student sheet - remove it or draft the rubric from it.",
    };
  }
  if (inspection.role === "question_paper") {
    return {
      label: "Printed MCQ paper",
      tone: "neutral",
      hint: "Ticked, circled or shaded options are read as the student's answers.",
    };
  }
  return null;
}

/** A rubric_match worth showing: match, reordered or mismatch (unknown says nothing). */
export function shownMatch(match: RubricMatch | null | undefined): RubricMatch | null {
  return match && match.verdict !== "unknown" ? match : null;
}

/** "Matches the selected rubric (38 of 40 questions compared)". */
export function matchLine(match: RubricMatch): string {
  return `Matches the selected rubric (${match.matched} of ${match.compared} questions compared)`;
}

/** "Sheet: Code P · Rubric: Code A" (null when neither side names a code / set). */
export function codesLine(match: RubricMatch): string | null {
  const parts = [
    match.sheet_code ? `Sheet: ${match.sheet_code}` : null,
    match.rubric_code ? `Rubric: ${match.rubric_code}` : null,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** Both sides name a code / set and they share none ("A" and "A/P/W" are one booklet family). */
export function codesDiffer(match: RubricMatch): boolean {
  if (!match.sheet_code || !match.rubric_code) return false;
  const rubric = new Set(match.rubric_code.toUpperCase().split("/"));
  return !match.sheet_code.toUpperCase().split("/").some((code) => rubric.has(code));
}

/** Up to 3 example lines from the comparison. */
export function matchExamples(match: RubricMatch): string[] {
  return (match.examples ?? []).filter((e) => e && e.trim()).slice(0, 3);
}

/** The server's sentence, or a plain fallback when it sent none. */
export function matchMessage(match: RubricMatch): string {
  if (match.message && match.message.trim()) return match.message.trim();
  if (match.verdict === "reordered") {
    return `${match.moved} of ${match.compared} questions are printed under other numbers - another code / set of this paper.`;
  }
  return `Only ${match.matched} of ${match.compared} printed questions match the rubric's questions.`;
}

/** Delay before re-comparing staged papers with a newly chosen rubric (quick switches send one request). */
export const RECHECK_DELAY_MS = 300;

/** Only a printed paper with a text layer can be compared with a rubric (the server returns null otherwise). */
export function rubricComparable(paper: PaperInspection | null | undefined): boolean {
  return !!paper && paper.text_layer && (paper.role === "question_paper" || paper.role === "answer_key_paper");
}

/** Shown under a sheet that does not match when the server will hold it (printed-MCQ reader path). */
export const MATCH_HOLD_NOTE =
  "You can still upload it: the sheet is held for faculty review instead of being graded against this rubric.";
/** Shown when the server's paper check may not run for this sheet: no hold is promised. */
export const MATCH_CHECK_NOTE = "Check the rubric before uploading: this sheet would be graded against it.";

/** Mirrors the backend's printed-MCQ reader rule (mcq_marks.mcq_heavy): 10+ questions, at least 80% MCQs. */
export function mcqHeavyRubric(
  content: { questions?: { question_type?: string | null }[] } | null | undefined,
): boolean {
  const questions = content?.questions ?? [];
  if (questions.length < 10) return false;
  const mcqs = questions.filter((q) => q.question_type === "mcq").length;
  return mcqs >= 0.8 * questions.length;
}

/**
 * True when the server will hold a non-matching sheet for faculty review: the paper check only runs
 * on the printed-MCQ reader path (a PDF graded with an MCQ-heavy rubric; a rubric_match is only
 * returned for printed papers).
 */
export function mismatchHeld(inspection: { file_type?: string | null } | null | undefined, mcqRubric: boolean): boolean {
  return mcqRubric && inspection?.file_type === "pdf";
}

export interface MatchTag {
  label: string;
  tone: "rose" | "amber";
  /** One short line for the row. */
  hint: string;
  /** The server's sentence, codes and examples (tooltip). */
  detail: string;
}

/** Batch row tag for a sheet that is another paper or another code / set of it (null otherwise). */
export function matchTag(match: RubricMatch | null | undefined, held = false): MatchTag | null {
  const shown = shownMatch(match);
  if (!shown || shown.verdict === "match") return null;
  const codes = codesLine(shown);
  const detail = [matchMessage(shown), codes, ...matchExamples(shown)].filter(Boolean).join("\n");
  const after = held ? "held for faculty review on upload" : "check the rubric before uploading";
  return shown.verdict === "mismatch"
    ? { label: "Different paper", tone: "rose", hint: `Not the selected rubric's paper${codes ? ` (${codes})` : ""} - ${after}.`, detail }
    : { label: "Other code / set", tone: "amber", hint: `Same questions, other numbers${codes ? ` (${codes})` : ""} - ${after}.`, detail };
}

/** Runs at most `limit` tasks at once; extra tasks wait in order. */
export function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
