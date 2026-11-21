// Rubric helpers shared by the intake rubric source and the /cohort "Rubric versions" panel.
import type { Rubric, RubricCompatibility, RubricContent, RubricQuestion } from "@/lib/types";

export interface CustomRubricFile {
  fileName: string;
  text: string;
  name: string;
  questionCount: number;
  totalMarks: number;
}

/** Light client-side sanity check of an uploaded rubric JSON; the API performs the full validation. */
export function parseCustomRubric(fileName: string, text: string): CustomRubricFile | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return `"${fileName}" is not valid JSON (${err instanceof Error ? err.message : "parse error"}).`;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return 'The rubric must be a JSON object with a "questions" array.';
  }
  const obj = data as { name?: unknown; questions?: unknown };
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    return 'The rubric needs a non-empty "questions" array.';
  }
  let total = 0;
  for (const [i, q] of obj.questions.entries()) {
    const item = q as { question?: unknown; topic?: unknown; max_marks?: unknown } | null;
    if (!item || typeof item !== "object") return `Question #${i + 1} must be an object.`;
    if (typeof item.question !== "number") return `Question #${i + 1} needs a numeric "question" number.`;
    if (typeof item.topic !== "string" || !item.topic.trim()) return `Question ${item.question} needs a "topic".`;
    if (typeof item.max_marks !== "number" || item.max_marks <= 0) {
      return `Question ${item.question} needs a positive "max_marks".`;
    }
    total += item.max_marks;
  }
  return {
    fileName,
    text,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "Custom rubric",
    questionCount: obj.questions.length,
    totalMarks: total,
  };
}

export function versionLabel(version: string): string {
  return /^v\d/i.test(version) || /^custom/i.test(version) ? version : `v${version}`;
}

export function rubricLabel(r: Pick<Rubric, "name" | "version" | "total_marks">): string {
  return `${r.name} · ${versionLabel(r.version)} · ${r.total_marks} marks`;
}

export function rubricStatusLabel(status: string | null | undefined): string {
  return status === "FACULTY_APPROVED" ? "Faculty approved" : "Draft - teacher review pending";
}

export function downloadJson(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function blankQuestion(existing: RubricQuestion[], subject: string): RubricQuestion {
  const next = existing.reduce((max, q) => Math.max(max, Number.isFinite(q.question) ? q.question : 0), 0) + 1;
  return {
    question: next,
    topic: "",
    subject: subject && subject !== "Mixed" ? subject : (existing[existing.length - 1]?.subject ?? "Biology"),
    max_marks: 5,
    prompt: "",
    expected_answer: "",
    grading_criteria: [""],
    effort_hours: 2,
    chapter: "",
  };
}

/** Deep copy (edits never mutate a rubric that is still shown elsewhere). */
export function cloneContent(content: RubricContent): RubricContent {
  return {
    name: content.name ?? "",
    subject: content.subject ?? "",
    questions: (content.questions ?? []).map((q) => ({
      ...q,
      prompt: q.prompt ?? "",
      chapter: q.chapter ?? "",
      grading_criteria: [...(q.grading_criteria ?? [])],
    })),
  };
}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Trimmed copy ready for the API: blank criteria lines dropped, empty prompt/chapter removed. */
export function normalizeContent(content: RubricContent): RubricContent {
  return {
    name: squash(content.name),
    subject: squash(content.subject),
    questions: [...content.questions]
      .map((q) => {
        const out: RubricQuestion = {
          question: q.question,
          topic: squash(q.topic),
          subject: squash(q.subject),
          max_marks: q.max_marks,
          expected_answer: (q.expected_answer ?? "").trim(),
          grading_criteria: (q.grading_criteria ?? []).map((c) => c.trim()).filter(Boolean),
          effort_hours: q.effort_hours,
        };
        const prompt = (q.prompt ?? "").trim();
        const chapter = squash(q.chapter);
        if (prompt) out.prompt = prompt;
        if (chapter) out.chapter = chapter;
        return out;
      })
      .sort((a, b) => a.question - b.question),
  };
}

export function totalMarks(content: RubricContent | null | undefined): number {
  return (content?.questions ?? []).reduce((sum, q) => sum + (Number.isFinite(q.max_marks) ? q.max_marks : 0), 0);
}

export interface ContentIssues {
  general: string[];
  /** Problems per question index. */
  byIndex: Record<number, string[]>;
  count: number;
}

/** Mirrors the API's RubricContentIn rules so faculty see problems before saving. */
export function validateContent(content: RubricContent): ContentIssues {
  const general: string[] = [];
  const byIndex: Record<number, string[]> = {};
  if (!squash(content.name)) general.push("Give the rubric a name.");
  if (content.questions.length === 0) general.push("Add at least one question.");
  if (content.questions.length > 60) general.push("A rubric can have at most 60 questions.");
  const seen = new Map<number, number>();
  content.questions.forEach((q, i) => {
    const problems: string[] = [];
    if (!Number.isInteger(q.question) || q.question < 1 || q.question > 1000) problems.push("question number 1-1000");
    else if (seen.has(q.question)) problems.push(`duplicate question number ${q.question}`);
    else seen.set(q.question, i);
    if (!squash(q.topic)) problems.push("topic");
    if (!squash(q.subject)) problems.push("subject");
    if (!Number.isFinite(q.max_marks) || q.max_marks <= 0 || q.max_marks > 1000) problems.push("marks > 0");
    if (!Number.isFinite(q.effort_hours) || q.effort_hours <= 0 || q.effort_hours > 1000) problems.push("effort hours > 0");
    if (!(q.expected_answer ?? "").trim()) problems.push("expected answer");
    if (!(q.grading_criteria ?? []).some((c) => c.trim())) problems.push("at least one criterion");
    if (problems.length) byIndex[i] = problems;
  });
  const count = general.length + Object.keys(byIndex).length;
  return { general, byIndex, count };
}

const COMPARED: (keyof RubricQuestion)[] = [
  "topic",
  "subject",
  "chapter",
  "max_marks",
  "prompt",
  "expected_answer",
  "grading_criteria",
  "effort_hours",
];

function comparable(q: RubricQuestion, key: keyof RubricQuestion): string {
  const value = q[key];
  if (Array.isArray(value)) {
    return value.map((c) => squash(typeof c === "string" ? c : JSON.stringify(c))).filter(Boolean).join("\n");
  }
  if (typeof value === "number") return String(value);
  return squash(value as string | undefined);
}

/** Client-side preview of rubric_store.compatibility (the server response is authoritative). */
export function compareContents(before: RubricContent, after: RubricContent): RubricCompatibility {
  const old = new Map(before.questions.map((q) => [q.question, q]));
  const next = new Map(after.questions.map((q) => [q.question, q]));
  const added = [...next.keys()].filter((n) => !old.has(n)).sort((a, b) => a - b);
  const removed = [...old.keys()].filter((n) => !next.has(n)).sort((a, b) => a - b);
  const changed = [...next.keys()]
    .filter((n) => old.has(n))
    .filter((n) => COMPARED.some((key) => comparable(old.get(n)!, key) !== comparable(next.get(n)!, key)))
    .sort((a, b) => a - b);
  return { reusable: added.length === 0 && removed.length === 0, added, removed, changed };
}

export function questionList(numbers: number[]): string {
  return numbers.length ? numbers.map((n) => `Q${n}`).join(", ") : "none";
}
