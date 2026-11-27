// Rubric helpers shared by the intake rubric source and the /cohort "Answer keys used" panel.
import type {
  MarkingPolicy,
  Rubric,
  RubricCompatibility,
  RubricContent,
  RubricQuestion,
  RubricSourceKind,
  RubricSourceRole,
} from "@/lib/types";
import { hasGenericCriteria } from "./answer-key-apply";

/** How a key's source file is labelled at intake and on the report. */
const SOURCE_ROLE_LABEL: Record<RubricSourceRole, string> = {
  question_paper: "Question paper",
  rubric_file: "Rubric file",
  marked_copy: "Marked copy (ticks are the key)",
  answer_key: "Answer key file",
};

/** What the file a key is drafted from is: a rubric as JSON / text, a teacher's marked copy, or the question paper. */
export function paperRole(fileName: string, ticksAreKey: boolean): RubricSourceRole {
  if (/\.(?:json|txt)$/i.test(fileName)) return "rubric_file";
  return ticksAreKey ? "marked_copy" : "question_paper";
}

/** A stored source file's label: its role, else (older entries) its kind. */
export function sourceLabel(kind: RubricSourceKind, role?: RubricSourceRole | null): string {
  if (role && role in SOURCE_ROLE_LABEL) return SOURCE_ROLE_LABEL[role];
  return kind === "key" ? SOURCE_ROLE_LABEL.answer_key : SOURCE_ROLE_LABEL.question_paper;
}

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

/**
 * Draft warnings an answer-key import settles (backend answer_keys._STALE / _RECHECKED): the old
 * "Fix before saving", missing-key and missing-criteria lines.
 */
export const STALE_AFTER_KEY =
  /^(?:Fix before saving: |No answer key for |Q\d+ is an MCQ without an answer key|No grading criteria for |Q\d+ has no grading criteria)/;

/** A small answer key in the JSON shape the intake accepts (one MCQ, one written answer). */
export const RUBRIC_TEMPLATE: RubricContent = {
  name: "Unit test 3 - Genetics",
  subject: "Biology",
  paper_code: "Set A",
  questions: [
    {
      question: 1,
      topic: "Mendelian inheritance",
      subject: "Biology",
      chapter: "Principles of Inheritance and Variation",
      max_marks: 4,
      question_type: "mcq",
      options: ["1:1", "3:1", "9:3:3:1", "1:2:1"],
      correct_option: "B",
      negative_marks: 1,
      expected_answer: "Option B: 3:1",
      grading_criteria: ["4 marks: option B"],
      effort_hours: 1,
    },
    {
      question: 2,
      topic: "Test cross",
      subject: "Biology",
      chapter: "Principles of Inheritance and Variation",
      max_marks: 5,
      prompt: "What is a test cross? Explain it with an example.",
      expected_answer: "A cross of an F1 individual with the homozygous recessive parent to find its genotype; e.g. Tt x tt gives 1:1.",
      grading_criteria: ["Defines a test cross (2)", "Gives a correct example with the cross (2)", "States the 1:1 ratio (1)"],
      effort_hours: 2,
    },
  ],
};

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
      // An empty list from the API means "unused" (null); the editor's empty list means "tick them".
      if (q.accepted_options?.length) copy.accepted_options = [...q.accepted_options];
      else delete copy.accepted_options;
      // An MCQ read from a printed paper may come without option texts (formulas printed as
      // images): give it blank options so the correct option can be picked; blank options are
      // dropped again by normalizeContent.
      if (isMcq(q) && (copy.options?.length ?? 0) < 2) {
        copy.options = blankOptions(q.correct_option, q.accepted_options);
      }
      if (q.marking_scheme) copy.marking_scheme = q.marking_scheme.map((step) => ({ ...step }));
      return copy;
    }),
  };
  if (content.marking_policy) out.marking_policy = { ...content.marking_policy };
  if (content.paper_code) out.paper_code = content.paper_code;
  return out;
}

/** Four blank options (more when the correct or an accepted option is E or F). */
function blankOptions(correct?: string | null, accepted?: string[] | null): string[] {
  const index = Math.max(
    letterIndex(correct),
    ...(accepted ?? []).map((letter) => letterIndex(letter)),
  );
  return Array.from({ length: Math.max(4, index + 1) }, () => "");
}

export function isMcq(q: Pick<RubricQuestion, "question_type">): boolean {
  return q.question_type === "mcq";
}

// --------------------------------------------------------------------------- //
// MCQ keys: one correct option, several accepted options, or a bonus question
// --------------------------------------------------------------------------- //
/**
 * How an MCQ is keyed (backend K1): "single" = correct_option; "several" = accepted_options (any of
 * 2-6 letters scores full marks, e.g. "2 or 3" in a publisher key); "bonus" = full marks to every
 * student whatever they marked.
 */
type McqKeyMode = "single" | "several" | "bonus";

export const MCQ_KEY_MODES: { value: McqKeyMode; label: string }[] = [
  { value: "single", label: "One correct option" },
  { value: "several", label: "Several accepted options" },
  { value: "bonus", label: "Bonus - full marks to everyone" },
];

/** 0-5 for A-F (lower case and spaces tolerated), -1 otherwise. */
function letterIndex(letter: string | null | undefined): number {
  return (OPTION_LETTERS as readonly string[]).indexOf(squash(letter).toUpperCase());
}

export function mcqKeyMode(q: Pick<RubricQuestion, "bonus" | "accepted_options">): McqKeyMode {
  if (q.bonus) return "bonus";
  return Array.isArray(q.accepted_options) ? "several" : "single";
}

/** Option letters an MCQ offers: its options (2-6), A-F when it has no option list. */
function offeredCount(q: Pick<RubricQuestion, "options">): number {
  const count = q.options?.length ?? 0;
  return count >= 2 ? Math.min(count, OPTION_LETTERS.length) : OPTION_LETTERS.length;
}

/** The accepted letters, upper case, distinct, in A-F order (unknown letters dropped). */
export function acceptedLetters(q: Pick<RubricQuestion, "accepted_options">): string[] {
  const chosen = new Set((q.accepted_options ?? []).map((letter) => squash(letter).toUpperCase()));
  return OPTION_LETTERS.filter((letter) => chosen.has(letter));
}

/** "B or C", "A, B or C". */
function orList(letters: string[]): string {
  if (letters.length <= 1) return letters.join("");
  return `${letters.slice(0, -1).join(", ")} or ${letters[letters.length - 1]}`;
}

/** The single correct option when it is a letter within the options, else null. */
function singleKey(q: Pick<RubricQuestion, "correct_option" | "options">): string | null {
  const index = letterIndex(q.correct_option);
  return index >= 0 && index < offeredCount(q) ? OPTION_LETTERS[index] : null;
}

/** Problems with an MCQ's key (validateContent wording); [] when it is keyed. */
function mcqKeyProblems(q: RubricQuestion): string[] {
  const mode = mcqKeyMode(q);
  if (mode === "bonus") return [];
  if (mode === "single") return singleKey(q) ? [] : ["the correct option"];
  const raw = (q.accepted_options ?? []).map((letter) => squash(letter).toUpperCase());
  const problems: string[] = [];
  if (raw.some((letter) => letterIndex(letter) < 0)) problems.push("accepted options are letters A-F");
  else if (new Set(raw).size !== raw.length) problems.push("distinct accepted options");
  else if (raw.some((letter) => letterIndex(letter) >= offeredCount(q))) problems.push("accepted options within the options");
  if (new Set(raw).size < 2) problems.push("at least two accepted options");
  return problems;
}

/** The MCQ has a key the API accepts: a correct option, 2+ accepted options, or bonus. */
export function mcqKeySet(q: RubricQuestion): boolean {
  return isMcq(q) && mcqKeyProblems(q).length === 0;
}

/** Short key label for tables: "B", "B or C", "Bonus" ("" when not set). */
export function mcqKeyLabel(q: RubricQuestion): string {
  const mode = mcqKeyMode(q);
  if (mode === "bonus") return "Bonus";
  if (mode === "several") return orList(acceptedLetters(q));
  return singleKey(q) ?? "";
}

/** How an MCQ is scored, in one line ("+4 for B or C, -1 for any other option or several marked, 0 blank"). */
export function mcqScoringNote(q: RubricQuestion, policyNegative: number): string {
  const marks = Number.isFinite(q.max_marks) ? marksText(q.max_marks) : "?";
  const negative =
    typeof q.negative_marks === "number" && Number.isFinite(q.negative_marks) ? q.negative_marks : policyNegative;
  const mode = mcqKeyMode(q);
  if (mode === "bonus") return `Bonus question - full marks to everyone: +${marks} for every student, whatever they marked.`;
  if (mode === "several") {
    const letters = acceptedLetters(q);
    return letters.length >= 2
      ? `Accepted options ${orList(letters)}: +${marks} for any of them, −${negative} for any other option or several marked, 0 blank.`
      : "Tick at least two accepted options.";
  }
  return `Scored by letter: +${marks} correct, −${negative} wrong or multiple, 0 blank.`;
}

/** "4", "2.5", "0.25" (Python "{:g}" for the usual values). */
function marksText(marks: number): string {
  return String(Number(marks.toPrecision(6)));
}

/** An expected answer the editor or a draft wrote from the key ("Option B: 3:1", "Option B or C", "Bonus question"). */
const AUTO_ANSWER = /^(?:option\s+[A-F](?:\s*(?:,|\bor\b|\/)\s*[A-F])*(?:\s*:[\s\S]*)?|bonus(?:\s+question)?\b[\s\S]*)$/i;

/** Expected answer written from the key: "Option B: <text>", "Option B or C", "Bonus question" ("" when unset). */
function mcqAutoAnswer(q: RubricQuestion): string {
  const mode = mcqKeyMode(q);
  if (mode === "bonus") return "Bonus question";
  if (mode === "several") {
    const letters = acceptedLetters(q);
    return letters.length ? `Option ${orList(letters)}` : "";
  }
  const letter = singleKey(q);
  if (!letter) return "";
  const text = squash(q.options?.[letterIndex(letter)]);
  return text ? `Option ${letter}: ${text}` : `Option ${letter}`;
}

/** One-line criterion written from the key ("4 marks: option B or C"); null when the key is unset. */
function mcqAutoCriterion(q: RubricQuestion): string | null {
  const marks = marksText(Number.isFinite(q.max_marks) && q.max_marks > 0 ? q.max_marks : 4);
  const mode = mcqKeyMode(q);
  if (mode === "bonus") return `${marks} marks to every student (bonus question)`;
  const label = mode === "several" ? orList(acceptedLetters(q)) : singleKey(q);
  return label ? `${marks} marks: option ${label}` : null;
}

/**
 * A key change for an MCQ (`patch` sets correct_option / accepted_options / bonus), with the
 * expected answer and criteria rewritten when they are still the ones written from the key (blank,
 * "Option B: ...", "4 marks: option B"); text faculty wrote themselves is kept.
 */
export function withKeyTexts(q: RubricQuestion, patch: Partial<RubricQuestion>): Partial<RubricQuestion> {
  const after: RubricQuestion = { ...q, ...patch };
  const out: Partial<RubricQuestion> = { ...patch };
  const expected = squash(q.expected_answer);
  if (!expected || AUTO_ANSWER.test(expected)) out.expected_answer = mcqAutoAnswer(after);
  if (hasGenericCriteria(q.grading_criteria)) {
    const criterion = mcqAutoCriterion(after);
    out.grading_criteria = criterion ? [criterion] : [""];
  }
  return out;
}

/** Fields that switch an MCQ to another key mode (the single option is kept to switch back). */
export function keyModePatch(q: RubricQuestion, mode: McqKeyMode): Partial<RubricQuestion> {
  if (mode === "bonus") return { bonus: true, accepted_options: undefined };
  if (mode === "several") {
    const keep = acceptedLetters(q);
    const single = singleKey(q);
    return { bonus: undefined, accepted_options: keep.length ? keep : single ? [single] : [] };
  }
  return {
    bonus: undefined,
    accepted_options: undefined,
    correct_option: singleKey(q) ?? acceptedLetters(q)[0] ?? q.correct_option,
  };
}

/** "Q51, Q53, Q111-Q112 and 2 more" -> [51, 53, 111, 112] (the listed ones). */
function listedQuestions(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(/\bQ(\d{1,4})(?:\s*[-–]\s*Q?(\d{1,4}))?\b/g)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (end < start || end - start > 1000) continue;
    for (let n = start; n <= end; n += 1) numbers.push(n);
  }
  return numbers;
}

/** A draft warning about keys with several accepted answers or bonus questions. */
const SPECIAL_KEY_WARNING = /more than one accepted|several accepted|accepted (?:answers|options)|\bbonus\b/i;

/**
 * The draft warning names MCQs with several accepted answers or bonus questions, and every one it
 * lists is now keyed that way in the draft (it becomes informational).
 */
export function settledKeyWarning(warning: string, content: RubricContent): boolean {
  if (!SPECIAL_KEY_WARNING.test(warning)) return false;
  const numbers = listedQuestions(warning);
  if (!numbers.length) return false;
  const byNumber = new Map(content.questions.map((q) => [q.question, q]));
  return numbers.every((n) => {
    const q = byNumber.get(n);
    return !!q && isMcq(q) && mcqKeyMode(q) !== "single" && mcqKeySet(q);
  });
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
          // Only the key of the chosen mode goes to the API (a bonus question needs no letter).
          const mode = mcqKeyMode(q);
          if (mode === "bonus") out.bonus = true;
          else if (mode === "several") out.accepted_options = acceptedLetters(q);
          else if (q.correct_option) out.correct_option = q.correct_option;
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

interface ContentIssues {
  general: string[];
  /** Problems per question index. */
  byIndex: Record<number, string[]>;
  count: number;
}

/** Mirrors the API's RubricContentIn rules so faculty see problems before grading. */
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
      // A correct option, 2-6 accepted options within the options, or a bonus question.
      problems.push(...mcqKeyProblems(q));
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
  "accepted_options",
  "bonus",
  "negative_marks",
  "bloom_level",
  "concept",
  "marking_scheme",
  "partial_credit",
  "mark_step",
];

function comparable(q: RubricQuestion, key: keyof RubricQuestion): string {
  // The MCQ key as normalizeContent sends it: only the chosen mode's field counts.
  if (key === "correct_option" || key === "accepted_options" || key === "bonus") {
    const mode = isMcq(q) ? mcqKeyMode(q) : null;
    if (key === "correct_option") return mode === "single" ? squash(q.correct_option).toUpperCase() : "";
    if (key === "accepted_options") return mode === "several" ? acceptedLetters(q).join(",") : "";
    return mode === "bonus" ? "true" : "";
  }
  const value = q[key];
  if (Array.isArray(value)) {
    return value.map((c) => squash(typeof c === "string" ? c : JSON.stringify(c))).filter(Boolean).join("\n");
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "";
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
