// Printed papers at intake: POST /api/intake/inspect tells an answer sheet from a printed MCQ
// question paper (a student's ticks are read as answers) and from a question paper that carries
// its own answer key (that one belongs in the rubric, not in the queue). Advisory only: the API
// repeats its checks on upload, and an API build without the endpoint just shows nothing.
import { errorStatus, inspectPaper } from "@/lib/api";
import type { PaperInspection } from "@/lib/types";
import type { SheetKind } from "./inspect";

/** Kinds worth inspecting: documents with pages and possibly a text layer. */
export function isPaperCandidate(kind: SheetKind | null | undefined): boolean {
  return kind === "pdf" || kind === "docx";
}

/** Set once the API answers 404 / 405 (an older build): stop asking for the rest of the session. */
let unsupported = false;

/** The inspection, or null when it is unavailable or failed (the upload repeats every check). */
export async function fetchInspection(file: File): Promise<PaperInspection | null> {
  if (unsupported) return null;
  try {
    return await inspectPaper(file);
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
