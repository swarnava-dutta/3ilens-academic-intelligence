// Answer-key import: the entries read by POST /api/rubrics/answer-key are applied in the browser to
// the rubric being edited (nothing is stored until faculty save it), by the server's rules
// (answer_keys.apply, used for a key_file sent with POST /api/rubrics/parse):
// - an entry sets the correct option of the MCQ with that number when the letter is within its
//   options (any letter when the option texts are unknown);
// - a key that is new or changed rewrites the expected answer ("Option C: <option text>") and,
//   when they are the generic one-line MCQ criteria, the criteria ("4 marks: option C");
// - a key that is already the same only fills an empty expected answer / empty criteria.
// Self-contained (type imports only).
import type { AnswerKeyExtraction, AnswerKeyMethod, RubricContent, RubricQuestion } from "@/lib/types";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
/** Backend RubricContentIn.paper_code max length. */
const MAX_PAPER_CODE = 60;

export interface KeyChange {
  question: number;
  from: string;
  to: string;
}

export interface KeyApplyReport {
  /** MCQs whose correct option now comes from the key (newly set, changed or already the same). */
  set: number;
  /** Their question numbers. */
  keyed: number[];
  /** MCQs that had no key before. */
  added: number[];
  /** MCQs that had a different key before. */
  changed: KeyChange[];
  /** Entries for question numbers the rubric does not have. */
  notInRubric: number[];
  /** Entries for questions that are not MCQs. */
  notMcq: number[];
  /** Entries beyond the question's options (E on a 4-option MCQ): not set. */
  outOfRange: number[];
  /** MCQs still without a correct option after the import. */
  stillMissing: number[];
  /** Paper code / set printed on the key and named by the rubric (before the import). */
  paperCode: { key: string | null; rubric: string | null; filled: boolean; differs: boolean };
}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function isMcq(q: RubricQuestion): boolean {
  return q.question_type === "mcq";
}

/** "B", "b", "(b)", "2" -> "B" (digits 1-6 read as A-F); null for anything else. */
function letterOf(raw: string | null | undefined): string | null {
  const token = squash(raw).replace(/^\(\s*|\s*\)$/g, "").toUpperCase();
  if (LETTERS.includes(token)) return token;
  const digit = Number(token);
  return /^[1-6]$/.test(token) ? LETTERS[digit - 1] : null;
}

/** Option texts not transcribed: every option blank (the editor gives such MCQs blank options). */
function optionsUnknown(q: RubricQuestion): boolean {
  return !(q.options ?? []).some((o) => squash(o));
}

/** The MCQ's current key letter, or null when missing / outside its options. */
function currentKey(q: RubricQuestion): string | null {
  const letter = letterOf(q.correct_option);
  if (letter === null) return null;
  const count = q.options && q.options.length >= 2 ? Math.min(q.options.length, LETTERS.length) : LETTERS.length;
  return LETTERS.indexOf(letter) < count ? letter : null;
}

/** answer_keys._GENERIC_CRITERION: "4 marks: option B", "4 marks for the correct option; ...". */
const GENERIC_CRITERION = /^\s*\d+(?:\.\d+)?\s*marks?\b\W*(?:for\s+)?(?:the\s+)?(?:correct\s+)?option\b(?:\s+[A-F]\b)?/i;
/** A placeholder option text written when the option was not transcribed. */
const PLACEHOLDER_OPTION = /^\(option [A-F] - not transcribed\)$/;

/** No criteria, or only the one-line MCQ criteria a draft writes. */
export function hasGenericCriteria(lines: string[] | null | undefined): boolean {
  return (lines ?? []).filter((line) => line.trim()).every((line) => GENERIC_CRITERION.test(line));
}

/** max_marks as Python formats "{:g}" for the usual values (4, 2.5, 0.25); 4 when unset. */
function marksText(q: RubricQuestion): string {
  const marks = Number.isFinite(q.max_marks) && q.max_marks > 0 ? q.max_marks : 4;
  return String(Number(marks.toPrecision(6)));
}

/** Apply an extracted key to a rubric's content (a new object; the input is not changed). */
export function applyAnswerKey(
  content: RubricContent,
  extraction: Pick<AnswerKeyExtraction, "entries" | "paper_code">,
): { content: RubricContent; report: KeyApplyReport } {
  const questions = content.questions.slice();
  const indexOf = new Map<number, number>();
  questions.forEach((q, index) => {
    if (Number.isInteger(q.question) && !indexOf.has(q.question)) indexOf.set(q.question, index);
  });

  const report: KeyApplyReport = {
    set: 0,
    keyed: [],
    added: [],
    changed: [],
    notInRubric: [],
    notMcq: [],
    outOfRange: [],
    stillMissing: [],
    paperCode: { key: null, rubric: null, filled: false, differs: false },
  };
  // One entry per question (the last one wins, as in the server's dict), in question order.
  const entries = new Map<number, string>();
  for (const entry of extraction.entries ?? []) {
    if (Number.isInteger(entry.question)) entries.set(entry.question, entry.option);
  }
  for (const [number, raw] of [...entries.entries()].sort((a, b) => a[0] - b[0])) {
    const letter = letterOf(raw);
    if (letter === null) continue;
    const index = indexOf.get(number);
    if (index === undefined) {
      report.notInRubric.push(number);
      continue;
    }
    const q = questions[index];
    if (!isMcq(q)) {
      report.notMcq.push(number);
      continue;
    }
    const position = LETTERS.indexOf(letter);
    const unknown = optionsUnknown(q);
    const options = q.options ?? [];
    if (!unknown && position >= options.length) {
      report.outOfRange.push(number);
      continue;
    }
    const before = currentKey(q);
    const text = unknown ? "" : squash(options[position]);
    const answer = text && !PLACEHOLDER_OPTION.test(text) ? `Option ${letter}: ${text}` : `Option ${letter}`;
    const criteria = [`${marksText(q)} marks: option ${letter}`];
    const next: RubricQuestion = { ...q, correct_option: letter };
    // Blank options of an MCQ whose texts are unknown grow to the keyed letter (E or F).
    if (unknown && options.length < position + 1) next.options = Array.from({ length: position + 1 }, () => "");
    report.set += 1;
    report.keyed.push(number);
    if (before === letter) {
      if (!squash(q.expected_answer)) next.expected_answer = answer;
      if (!(q.grading_criteria ?? []).some((c) => c.trim())) next.grading_criteria = criteria;
      const same =
        q.correct_option === letter && next.expected_answer === q.expected_answer &&
        next.grading_criteria === q.grading_criteria && next.options === q.options;
      if (!same) questions[index] = next;
      continue;
    }
    if (before === null) report.added.push(number);
    else report.changed.push({ question: number, from: before, to: letter });
    next.expected_answer = answer;
    if (hasGenericCriteria(q.grading_criteria)) next.grading_criteria = criteria;
    questions[index] = next;
  }
  report.stillMissing = questions.filter((q) => isMcq(q) && currentKey(q) === null).map((q) => q.question);

  const next: RubricContent = { ...content, questions };
  const keyCode = squash(extraction.paper_code).slice(0, MAX_PAPER_CODE) || null;
  const rubricCode = squash(content.paper_code) || null;
  report.paperCode = {
    key: keyCode,
    rubric: rubricCode,
    filled: !!keyCode && !rubricCode,
    differs: codesDiffer(normaliseCode(keyCode), normaliseCode(rubricCode)),
  };
  if (report.paperCode.filled && keyCode) next.paper_code = keyCode;
  return { content: next, report };
}

// Paper codes, as backend paper_match.normalise_code / codes_differ read them: a code is an
// upper-case letter with up to 2 digits ("A", "E1") or a number of up to 3 digits, several joined
// by "/" ("A/P/W"); "CODE - 45", "Code 045" and "45" are the same code.
const CODE_TOKEN = String.raw`(?:[A-Z]\d{0,2}|\d{1,3})`;
const CODE_VALUE = String.raw`${CODE_TOKEN}(?:[ \t]*\/[ \t]*${CODE_TOKEN})*`;
const BARE_CODE = new RegExp(String.raw`^\s*(${CODE_VALUE})\s*$`);
const KEYWORD_CODE = new RegExp(
  String.raw`(?:^|[^\w.])(?:(?:TEST[ \t]+)?BOOKLET[ \t]+CODE|(?:QUESTION[ \t]+)?PAPER[ \t]+CODE|Q\.?[ \t]*P\.?[ \t]*CODE|CODE|` +
    String.raw`(?:PAPER[ \t]+)?SET(?:[ \t]+NO\.?)?|VERSION)(?![\w])[ \t]*(?:[:#\-–—.][ \t]*)*(${CODE_VALUE})(?![\w/])`,
);

function codeTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const raw of value.split("/")) {
    let token = raw.trim().toUpperCase();
    if (/^\d+$/.test(token)) token = String(Number(token));
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/** "Code A" -> "A", "CODE - 45" -> "45", "045" -> "45", "A / P / W" -> "A/P/W"; null when no code. */
export function normaliseCode(value: string | null | undefined): string | null {
  const text = squash(value).toUpperCase();
  if (!text) return null;
  const match = BARE_CODE.exec(text) ?? KEYWORD_CODE.exec(text);
  if (!match) return null;
  const tokens = codeTokens(match[1]);
  return tokens.length ? tokens.join("/") : null;
}

/** Both codes known and no code in common ("A" vs "A/P/W" is the same booklet family). */
export function codesDiffer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const other = new Set(b.split("/"));
  return !a.split("/").some((token) => other.has(token));
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Q3, Q7" (the first `limit`, then "+N more"). */
export function questionNumbers(numbers: number[], limit = 8): string {
  const shown = numbers.slice(0, limit).map((n) => `Q${n}`).join(", ");
  return numbers.length > limit ? `${shown} +${numbers.length - limit} more` : shown;
}

/** "Set 178 keys · 2 changed (Q3, Q7) · 2 entries not in this rubric · 0 MCQs still without a key". */
export function keyApplySummary(report: KeyApplyReport): string {
  const parts = [`Set ${plural(report.set, "key")}`];
  const changed = report.changed.map((c) => c.question);
  parts.push(changed.length ? `${changed.length} changed (${questionNumbers(changed)})` : "0 changed");
  if (report.notInRubric.length) parts.push(`${plural(report.notInRubric.length, "entry", "entries")} not in this rubric`);
  if (report.outOfRange.length) {
    parts.push(`${plural(report.outOfRange.length, "entry", "entries")} beyond the options (${questionNumbers(report.outOfRange)})`);
  }
  if (report.notMcq.length) {
    parts.push(`${plural(report.notMcq.length, "entry", "entries")} for questions that are not MCQs`);
  }
  parts.push(`${plural(report.stillMissing.length, "MCQ")} still without a key`);
  return parts.join(" · ");
}

/** "read from the text" / "read from the page images". */
export function methodLabel(method: AnswerKeyMethod): string {
  return method === "ai" ? "read from the page images" : "read from the text";
}
