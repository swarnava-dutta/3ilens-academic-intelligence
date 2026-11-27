"use client";

import { FileText, Loader2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { KeyFilesDrop, sourceFileLabel } from "@/components/rubrics/key-files-drop";
import { answerKeyErrorMessage } from "@/components/rubrics/answer-key-import";
import {
  applyKeyFile,
  draftOrder,
  holdsNoKey,
  mergeKeyFiles,
  sourcesFor,
  type KeySourceFiles,
} from "@/components/rubrics/use-rubric-source";
import { errorCode, errorMessage, errorStatus, extractAnswerKey, parseRubric } from "@/lib/api";
import type { RubricContent, RubricDraft, RubricQuestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice, btnSecondary } from "./dialog";
import { fmtNumber } from "./format";

const WARNINGS_SHOWN = 4;
const ACCEPTED_SHOWN = 6;

/** Friendly text for POST /api/rubrics/parse failures. */
function draftError(err: unknown): string {
  const code = errorCode(err);
  const status = errorStatus(err);
  if (code === "ai_not_configured" || status === 503) {
    return "Drafting a key from a paper needs AI, which is not configured on the server. A JSON answer key is read without AI.";
  }
  if (code === "unsupported_signature" || status === 415) {
    return "That file is not a PDF, Word (.docx), image, JSON or text file. Add the question paper as PDF or Word.";
  }
  if (code === "empty_rubric_source") {
    return "No question text was found in that file. Upload a PDF or Word question paper (a scan works as a PDF).";
  }
  if (code === "no_answer_key") {
    return 'No answer key was found in the answer-key file. Use a table such as "1-2, 2-4", a "Que. / Ans." grid or a paper with "Ans." lines.';
  }
  return errorMessage(err);
}

/** "Q3, Q7, Q12" (with "+5 more" past `limit`). */
export function questionRefs(numbers: number[], limit = 8): string {
  const shown = numbers.slice(0, limit).map((n) => `Q${n}`).join(", ");
  return numbers.length > limit ? `${shown} +${numbers.length - limit} more` : shown;
}

interface DraftFacts {
  questions: number;
  marks: number;
  mcqs: number;
  /** MCQs the key settles: one correct option, several accepted options, or a bonus. */
  keyed: number;
  /** MCQs that accept several options ("2 or 3" in the key): any of them scores full marks. */
  accepted: { question: number; options: string[] }[];
  /** Bonus MCQs: full marks to every student. */
  bonus: number[];
  /** MCQs with no answer in the key (the key cannot be used until each has one). */
  unkeyed: number[];
}

/** Distinct accepted option letters of an MCQ (A-F), in order. */
function acceptedOptions(q: RubricQuestion): string[] {
  const letters = (q.accepted_options ?? []).map((l) => String(l).trim().toUpperCase()).filter((l) => /^[A-F]$/.test(l));
  return [...new Set(letters)];
}

function draftFacts(content: RubricContent): DraftFacts {
  const questions = content.questions ?? [];
  const mcqs = questions.filter((q) => q.question_type === "mcq");
  const bonus = mcqs.filter((q) => q.bonus === true).map((q) => q.question);
  const accepted = mcqs
    .filter((q) => q.bonus !== true)
    .map((q) => ({ question: q.question, options: acceptedOptions(q) }))
    .filter((a) => a.options.length >= 2);
  const multi = new Set(accepted.map((a) => a.question));
  const unkeyed = mcqs
    .filter((q) => q.bonus !== true && !multi.has(q.question) && !(q.correct_option ?? "").trim())
    .map((q) => q.question);
  return {
    questions: questions.length,
    marks: questions.reduce((sum, q) => sum + (Number.isFinite(q.max_marks) ? q.max_marks : 0), 0),
    mcqs: mcqs.length,
    keyed: mcqs.length - unkeyed.length,
    accepted,
    bonus,
    unkeyed,
  };
}

interface KeyDraftState {
  /** The dropped files (the question paper, its answer key, or both), in the order they came. */
  files: File[];
  /** A file that was not taken, or the one a third file replaced. */
  note: { kind: "error" | "info"; message: string } | null;
  addFiles: (picked: File[]) => void;
  removeFile: (file: File) => void;
  /**
   * The drafted key (null until drafted, and again when a file changes - except an answer-key file
   * added next to the drafted paper, which is applied to it).
   */
  draft: RubricDraft | null;
  /** What the draft used each file as (with the draft). */
  sources: KeySourceFiles | null;
  /** Drafting, or reading an added answer-key file (`reading`): the key is not final yet. */
  drafting: boolean;
  /** The answer-key file being read alone (POST /api/rubrics/answer-key) to apply to the draft. */
  reading: File | null;
  error: string | null;
  run: () => Promise<void>;
}

/**
 * An answer key drafted on the fly for one sheet: one drop zone takes the question paper (the
 * student's printed paper works too), its answer key, or both - sent to POST /api/rubrics/parse as
 * file + key_file (the server puts them in the right order). An answer-key file added once the paper
 * is drafted is read alone (POST /api/rubrics/answer-key) and applied to the draft, as at intake -
 * the paper is not read again. Nothing is stored - the caller sends the drafted content with its
 * re-run / re-grade.
 */
export function useKeyDraft(): KeyDraftState {
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState<KeyDraftState["note"]>(null);
  const [draft, setDraft] = useState<{ result: RubricDraft; sources: KeySourceFiles } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<File | null>(null);
  // A reply for files that were changed meanwhile is dropped.
  const request = useRef(0);

  function change(next: File[]) {
    request.current += 1;
    setFiles(next);
    setDraft(null);
    setDrafting(false);
    setReading(null);
    setError(null);
  }

  /** An answer-key file added next to the drafted paper: read alone and applied to `base`. */
  async function readKey(file: File, next: File[], base: { result: RubricDraft; sources: KeySourceFiles }) {
    const id = ++request.current;
    setFiles(next);
    setReading(file);
    setError(null);
    try {
      const extraction = await extractAnswerKey({ file });
      if (request.current !== id) return;
      const applied = applyKeyFile(base.result.draft, base.result, file, extraction);
      setDraft({
        result: { ...(applied.draft ?? base.result), draft: applied.content },
        sources: { ...base.sources, key: file },
      });
      setNote({ kind: applied.differs ? "error" : "info", message: applied.message });
    } catch (err) {
      if (request.current !== id) return;
      if (holdsNoKey(err)) {
        // No key in it at all: it is a paper - the next draft reads both files.
        change(next);
        setNote({ kind: "info", message: `"${file.name}" holds no answer key - draft again to read both files together.` });
        return;
      }
      setFiles(next.filter((f) => f !== file));
      setNote({
        kind: "error",
        message: `"${file.name}" could not be read as the answer key, so it was not added: ${answerKeyErrorMessage(err)}`,
      });
    } finally {
      if (request.current === id) setReading(null);
    }
  }

  async function run() {
    if (!files.length) return;
    const id = ++request.current;
    const sent = draftOrder(files, false);
    setDrafting(true);
    setDraft(null);
    setError(null);
    try {
      const result = await parseRubric({ file: sent[0], keyFile: sent[1] });
      if (request.current === id) {
        setDraft({ result, sources: sourcesFor(sent, false, result.warnings, !!result.files_swapped) });
      }
    } catch (err) {
      if (request.current === id) setError(draftError(err));
    } finally {
      if (request.current === id) setDrafting(false);
    }
  }

  return {
    files,
    note,
    addFiles: (picked) => {
      // A third file replaces the answer key, not the paper (the drafted one, else the likelier one).
      const keep = draft?.sources.paper ?? (files.length ? draftOrder(files, false)[0] : null);
      const merged = mergeKeyFiles(files, picked, keep);
      setNote(merged.note);
      if (!merged.added) return;
      const added = merged.next.filter((f) => !files.includes(f));
      // The paper is drafted: one more file is its answer key, applied without reading the paper again.
      if (draft?.sources.paper && merged.next.includes(draft.sources.paper) && added.length === 1) {
        void readKey(added[0], merged.next, draft);
      } else change(merged.next);
    },
    removeFile: (file) => {
      setNote(null);
      change(files.filter((f) => f !== file));
    },
    draft: draft?.result ?? null,
    sources: draft?.sources ?? null,
    drafting: drafting || reading !== null,
    reading,
    error,
    run,
  };
}

/** The answer-key drop zone, the "Draft the key" button and a compact summary of the drafted key. */
export function KeyDraftFields({ state, disabled = false }: { state: KeyDraftState; disabled?: boolean }) {
  const ids = useId();
  const locked = disabled || state.drafting;
  return (
    <div className="space-y-2">
      <KeyFilesDrop
        id={`${ids}-files`}
        files={state.files}
        note={state.note}
        disabled={locked}
        hint="PDF, Word, image, text or JSON - the question paper (the student's printed paper works too), its answer key, or both."
        label={(file) =>
          (state.drafting && !state.reading) || file === state.reading
            ? "Reading…"
            : state.sources
              ? sourceFileLabel(state.sources, file)
              : "Not drafted yet"
        }
        onAdd={state.addFiles}
        onRemove={state.removeFile}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          className={cn(btnSecondary, "w-full sm:w-auto")}
          onClick={() => void state.run()}
          disabled={locked || !state.files.length}
        >
          {state.drafting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileText className="h-4 w-4" aria-hidden />}
          {state.reading
            ? "Reading the answer key…"
            : state.drafting
              ? "Drafting the key…"
              : state.draft
                ? "Draft again"
                : "Draft the key"}
        </button>
        <p className="text-xs text-slate-500" aria-live="polite">
          {state.reading
            ? `Reading the answer key from "${state.reading.name}" - it is applied to the drafted key (the paper is not read again).`
            : state.drafting
              ? "Reading the paper - a full printed paper can take a minute or two."
              : state.files.length
                ? null
                : "Add the question paper, its answer key, or both first."}
        </p>
      </div>
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.draft ? <KeyDraftSummary draft={state.draft} /> : null}
    </div>
  );
}

/** Name, questions, marks, keyed MCQs and the drafting warnings of a drafted key. */
function KeyDraftSummary({ draft, className }: { draft: RubricDraft; className?: string }) {
  const content = draft.draft;
  const facts = draftFacts(content);
  const code = (content.paper_code ?? "").trim();
  const warnings = (draft.warnings ?? []).filter((w) => w.trim());
  const aiDrafted = draft.ai_drafted_questions ?? [];
  const mcqText = !facts.mcqs
    ? "no MCQs"
    : facts.keyed === facts.mcqs
      ? `all ${fmtNumber(facts.mcqs)} MCQs keyed`
      : `${fmtNumber(facts.keyed)} of ${fmtNumber(facts.mcqs)} MCQs keyed`;
  return (
    <div className={cn("rounded-md border border-slate-200 bg-white p-3 text-sm", className)} aria-live="polite">
      <p className="break-words font-medium text-slate-800">
        {content.name || "Untitled paper"}
        {code ? <span className="font-normal text-slate-600"> · {code}</span> : null}
      </p>
      <p className="mt-0.5 text-xs text-slate-600">
        {content.subject ? `${content.subject} · ` : ""}
        {fmtNumber(facts.questions)} question{facts.questions === 1 ? "" : "s"} · {fmtNumber(facts.marks, 2)} marks ·{" "}
        {mcqText}
      </p>
      {facts.accepted.length ? (
        <p className="mt-1 text-xs text-slate-600">
          More than one answer accepted (any of them scores full marks):{" "}
          {facts.accepted
            .slice(0, ACCEPTED_SHOWN)
            .map((a) => `Q${a.question} (${a.options.join(" or ")})`)
            .join(", ")}
          {facts.accepted.length > ACCEPTED_SHOWN ? ` +${facts.accepted.length - ACCEPTED_SHOWN} more` : ""}.
        </p>
      ) : null}
      {facts.bonus.length ? (
        <p className="mt-1 text-xs text-slate-600">
          Bonus (full marks to everyone): {questionRefs(facts.bonus)}.
        </p>
      ) : null}
      {facts.unkeyed.length ? (
        <p className="mt-1 text-xs text-amber-800">
          No answer in the key for {questionRefs(facts.unkeyed)}. Add the answer-key file - the key cannot be used
          until every MCQ has an answer, accepted options or a bonus.
        </p>
      ) : null}
      {aiDrafted.length ? (
        <p className="mt-1 text-xs text-slate-500">
          Expected answers drafted by AI for {questionRefs(aiDrafted)} - check them in the report.
        </p>
      ) : null}
      {warnings.length ? <DraftWarnings warnings={warnings} /> : null}
    </div>
  );
}

function DraftWarnings({ warnings }: { warnings: string[] }) {
  const rest = warnings.slice(WARNINGS_SHOWN);
  const item = (w: string, i: number) => (
    <li key={i} className={cn("break-words", /^fix before/i.test(w) ? "text-rose-800" : "text-amber-900")}>
      {w}
    </li>
  );
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
      <p className="font-medium text-amber-900">
        {warnings.length === 1 ? "Note from drafting" : `${warnings.length} notes from drafting`}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">{warnings.slice(0, WARNINGS_SHOWN).map(item)}</ul>
      {rest.length ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-amber-900 underline-offset-2 hover:underline">
            {rest.length} more
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{rest.map((w, i) => item(w, i + WARNINGS_SHOWN))}</ul>
        </details>
      ) : null}
    </div>
  );
}
