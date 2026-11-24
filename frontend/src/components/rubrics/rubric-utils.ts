// Rubric helpers shared by the intake rubric source and the /cohort "Rubric versions" panel.
import type { MarkingPolicy, Rubric, RubricCompatibility, RubricContent, RubricQuestion } from "@/lib/types";

/** Option letters of an MCQ (2-6 options). */
export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
/** Allowed mark steps (backend marking.MARK_STEPS). */
export const MARK_STEPS = [0.25, 0.5, 1, 2] as const;
export const MAX_SCHEME_STEPS = 20;
/** Backend schemas.MAX_RUBRIC_QUESTIONS: a full printed paper fits in one rubric (NEET 180, JEE 90). */
export const MAX_RUBRIC_QUESTIONS = 200;
/** Above this many questions the draft editor opens on the dense answer-key table. */
export const ANSWER_KEY_VIEW_THRESHOLD = 20;
/** Backend RubricContentIn.paper_code max length. */
export const MAX_PAPER_CODE = 60;

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

/** Deep copy (edits never mutate a rubric that is still shown elsewhere). Keeps the MCQ, marking-scheme and Bloom fields. */
export function cloneContent(content: RubricContent): RubricContent {
  const out: RubricContent = {
    name: content.name ?? "",
    subject: content.subject ?? "",
    questions: (content.questions ?? []).map((q) => {
      const copy: RubricQuestion = {
        ...q,
        prompt: q.prompt ?? "",
        chapter: q.chapter ?? "",
        grading_criteria: [...(q.grading_criteria ?? [])],
      };
      if (q.options) copy.options = [...q.options];
      // An MCQ read from a printed paper may come without option texts (formulas printed as
      // images): give it blank options so the correct option can be picked; blank options are
      // dropped again by normalizeContent.
      if (isMcq(q) && (copy.options?.length ?? 0) < 2) copy.options = blankOptions(q.correct_option);
      if (q.marking_scheme) copy.marking_scheme = q.marking_scheme.map((step) => ({ ...step }));
      return copy;
    }),
  };
  if (content.marking_policy) out.marking_policy = { ...content.marking_policy };
  if (content.paper_code) out.paper_code = content.paper_code;
  return out;
}

/** Four blank options (more when the correct option is E or F). */
export function blankOptions(correct?: string | null): string[] {
  const index = (OPTION_LETTERS as readonly string[]).indexOf(correct ?? "");
  return Array.from({ length: Math.max(4, index + 1) }, () => "");
}

export function isMcq(q: Pick<RubricQuestion, "question_type">): boolean {
  return q.question_type === "mcq";
}

/** Sum of a question's marking-scheme step marks. */
export function schemeTotal(q: Pick<RubricQuestion, "marking_scheme">): number {
  return (q.marking_scheme ?? []).reduce((sum, step) => sum + (Number.isFinite(step.marks) ? step.marks : 0), 0);
}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Trimmed copy ready for the API: blank criteria lines dropped, empty prompt/chapter removed. */
export function normalizeContent(content: RubricContent): RubricContent {
  const paperCode = squash(content.paper_code);
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
        // --- only the fields that apply to the question type (the API rejects the rest) ---
        if (isMcq(q)) {
          out.question_type = "mcq";
          const options = (q.options ?? []).map((o) => squash(o));
          if (options.some(Boolean)) out.options = options;
          if (q.correct_option) out.correct_option = q.correct_option;
          if (typeof q.negative_marks === "number" && Number.isFinite(q.negative_marks)) out.negative_marks = q.negative_marks;
        } else {
          if (q.question_type === "descriptive") out.question_type = "descriptive";
          if (q.marking_scheme && q.marking_scheme.length) {
            out.marking_scheme = q.marking_scheme.map((step) => {
              const s: { criterion: string; marks: number; required?: boolean } = {
                criterion: squash(step.criterion),
                marks: step.marks,
              };
              if (step.required) s.required = true;
              return s;
            });
          }
          if (q.partial_credit) out.partial_credit = q.partial_credit;
          if (typeof q.mark_step === "number" && Number.isFinite(q.mark_step)) out.mark_step = q.mark_step;
        }
        if (q.bloom_level) {
          out.bloom_level = q.bloom_level;
          out.bloom_source = q.bloom_source ?? "faculty";
        }
        const concept = squash(q.concept);
        if (concept) out.concept = concept;
        return out;
      })
      .sort((a, b) => a.question - b.question),
    ...(content.marking_policy ? { marking_policy: normalizePolicy(content.marking_policy) } : {}),
    ...(paperCode ? { paper_code: paperCode } : {}),
  };
}

/** Trimmed paper code / set ("" when none). */
export function paperCodeOf(content: RubricContent | null | undefined): string {
  return squash(content?.paper_code);
}

function normalizePolicy(policy: MarkingPolicy): MarkingPolicy {
  const out: MarkingPolicy = {
    partial_credit: policy.partial_credit,
    mark_step: policy.mark_step,
    negative_marks: policy.negative_marks,
  };
  const name = squash(policy.scheme_name);
  if (name) out.scheme_name = name;
  return out;
}

/** Stable text of the rubric-level marking policy (to detect a policy-only change). */
export function policyKey(content: RubricContent | null | undefined): string {
  return content?.marking_policy ? JSON.stringify(normalizePolicy(content.marking_policy)) : "";
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
  if (squash(content.paper_code).length > MAX_PAPER_CODE) {
    general.push(`Paper code / set: at most ${MAX_PAPER_CODE} characters.`);
  }
  if (content.questions.length === 0) general.push("Add at least one question.");
  if (content.questions.length > MAX_RUBRIC_QUESTIONS) {
    general.push(`A rubric can have at most ${MAX_RUBRIC_QUESTIONS} questions.`);
  }
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
    if (isMcq(q)) {
      // MCQ: the API fills "Option X" and a criterion when they are blank.
      const options = q.options ?? [];
      const filled = options.filter((o) => o.trim()).length;
      if (options.length < 2 || options.length > 6) problems.push("2-6 options");
      else if (filled > 0 && filled < options.length) problems.push("text for every option (or leave all blank)");
      const index = (OPTION_LETTERS as readonly string[]).indexOf(q.correct_option ?? "");
      if (index < 0 || (options.length >= 2 && index >= options.length)) problems.push("the correct option");
      const neg = q.negative_marks;
      if (neg !== undefined && (!Number.isFinite(neg) || neg < 0 || neg > q.max_marks)) {
        problems.push("negative marks between 0 and the question marks");
      }
    } else {
      if (!(q.expected_answer ?? "").trim()) problems.push("expected answer");
      const scheme = q.marking_scheme ?? [];
      // A marking scheme stands in for the criteria (the API derives one criterion per step).
      if (!scheme.length && !(q.grading_criteria ?? []).some((c) => c.trim())) problems.push("at least one criterion");
      if (scheme.length) {
        if (scheme.length > MAX_SCHEME_STEPS) problems.push("at most " + MAX_SCHEME_STEPS + " scheme steps");
        if (scheme.some((step) => !step.criterion.trim())) problems.push("a criterion for every scheme step");
        if (scheme.some((step) => !Number.isFinite(step.marks) || step.marks <= 0)) problems.push("marks > 0 for every scheme step");
        const total = schemeTotal(q);
        if (Number.isFinite(q.max_marks) && Math.abs(total - q.max_marks) > 0.01) {
          problems.push("scheme marks " + total + " must add up to " + q.max_marks);
        }
      }
      if (q.mark_step !== undefined && Number.isFinite(q.max_marks) && q.mark_step > q.max_marks) {
        problems.push("mark step no larger than the question marks");
      }
    }
    if (problems.length) byIndex[i] = problems;
  });
  const policy = content.marking_policy;
  if (policy && (!Number.isFinite(policy.negative_marks) || policy.negative_marks < 0 || policy.negative_marks > 100)) {
    general.push("Marking policy: negative marks must be 0-100.");
  }
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
  "question_type",
  "options",
  "correct_option",
  "negative_marks",
  "bloom_level",
  "concept",
  "marking_scheme",
  "partial_credit",
  "mark_step",
];

function comparable(q: RubricQuestion, key: keyof RubricQuestion): string {
  const value = q[key];
  if (Array.isArray(value)) {
    return value.map((c) => squash(typeof c === "string" ? c : JSON.stringify(c))).filter(Boolean).join("\n");
  }
  if (typeof value === "number") return String(value);
  if (key === "question_type") return value === "mcq" ? "mcq" : "descriptive";
  return squash(value as string | undefined);
}

/** Client-side preview of rubric_store.compatibility (the server response is authoritative). */
export function compareContents(before: RubricContent, after: RubricContent): RubricCompatibility {
  const old = new Map(before.questions.map((q) => [q.question, q]));
  const next = new Map(after.questions.map((q) => [q.question, q]));
  const added = [...next.keys()].filter((n) => !old.has(n)).sort((a, b) => a - b);
  const removed = [...old.keys()].filter((n) => !next.has(n)).sort((a, b) => a - b);
  // A changed rubric-wide marking policy re-scores every question present in both versions.
  const policyChanged = policyKey(before) !== policyKey(after);
  const changed = [...next.keys()]
    .filter((n) => old.has(n))
    .filter(
      (n) => policyChanged || COMPARED.some((key) => comparable(old.get(n)!, key) !== comparable(next.get(n)!, key)),
    )
    .sort((a, b) => a - b);
  return { reusable: added.length === 0 && removed.length === 0, added, removed, changed };
}

export function questionList(numbers: number[]): string {
  return numbers.length ? numbers.map((n) => `Q${n}`).join(", ") : "none";
}
