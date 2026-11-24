"use client";

import { useEffect, useState } from "react";
import { createRubric, errorCode, errorMessage, errorStatus, getRubrics, parseRubric } from "@/lib/api";
import type { Rubric, RubricContent, RubricDraft } from "@/lib/types";
import {
  cloneContent,
  normalizeContent,
  parseCustomRubric,
  rubricLabel,
  validateContent,
  type CustomRubricFile,
} from "./rubric-utils";

export type RubricMode = "saved" | "paste" | "upload" | "json";

/** What an upload sends: a saved rubric id, or an inline rubric JSON. */
export interface RubricChoice {
  rubricId?: number;
  rubricJson?: string;
  label: string;
}

type Notice = { kind: "success" | "error"; message: string } | null;

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Friendly text for POST /api/rubrics/parse failures. */
export function parseErrorMessage(err: unknown): string {
  const code = errorCode(err);
  const status = errorStatus(err);
  if (code === "ai_not_configured" || status === 503) {
    return "AI drafting needs the Anthropic key in .env (ANTHROPIC_API_KEY). Until then use a saved rubric or upload the rubric as JSON.";
  }
  if (code === "unsupported_signature" || status === 415) {
    return "That file is not a PDF or Word (.docx) document. Upload the question paper / marking scheme as PDF or DOCX.";
  }
  if (code === "empty_rubric_source") {
    return "No question text was found. Paste the questions and marking scheme, or upload a text-based PDF/DOCX.";
  }
  if (!code && (status === 404 || status === 405)) {
    return "Rubric drafting is not available on this API build yet. Use a saved rubric or the JSON option.";
  }
  return errorMessage(err);
}

export interface RubricSourceState {
  mode: RubricMode;
  setMode: (mode: RubricMode) => void;
  rubrics: Rubric[] | null;
  rubricsError: string | null;
  selectedRubric: Rubric | null;
  selectRubric: (id: number) => void;
  custom: CustomRubricFile | null;
  customError: string | null;
  loadJsonFile: (file: File | undefined) => Promise<void>;
  clearCustom: () => void;
  pasteText: string;
  setPasteText: (text: string) => void;
  subjectHint: string;
  setSubjectHint: (text: string) => void;
  sourceFile: File | null;
  setSourceFile: (file: File | null) => void;
  parsing: boolean;
  /** The running draft reads a PDF (page by page on the server; a full paper takes minutes). */
  parsingPdf: boolean;
  /** Seconds since the running draft started (0 when idle). */
  parseElapsed: number;
  parseError: string | null;
  runParse: () => Promise<void>;
  /** Switch to PDF/DOCX mode with this file and start drafting (from an answer-key paper at intake). */
  /** keyFromMarks: the ticks on the paper mark the answer key (printed MCQ paper without a key). */
  draftFromFile: (file: File, options?: { keyFromMarks?: boolean }) => Promise<void>;
  /** Upload mode: the ticks / circles on the uploaded paper mark the correct options (reset when
   *  the source file changes, after saving and on discard - it belongs to one paper). */
  keyFromMarks: boolean;
  setKeyFromMarks: (value: boolean) => void;
  draft: RubricDraft | null;
  /** Bumped for every new draft, so the review editor starts fresh (view, open question, paging). */
  draftSerial: number;
  content: RubricContent | null;
  setContent: (content: RubricContent) => void;
  discardDraft: () => void;
  saving: boolean;
  approveAndSave: () => Promise<void>;
  notice: Notice;
  choice: RubricChoice | null;
}

/**
 * State for the intake "Rubric" control: Saved | Paste text | Upload PDF/DOCX | JSON.
 * Paste and upload draft a rubric with the AI (POST /api/rubrics/parse); faculty review it in
 * RubricDraftEditor and "Approve & save" creates a FACULTY_APPROVED rubric that is then selected.
 */
export function useRubricSource(apiOnline: boolean): RubricSourceState {
  const [mode, setModeState] = useState<RubricMode>("saved");
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  const [rubricsError, setRubricsError] = useState<string | null>(null);
  const [rubricId, setRubricId] = useState<number | null>(null);
  const [custom, setCustom] = useState<CustomRubricFile | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [subjectHint, setSubjectHint] = useState("");
  const [keyFromMarks, setKeyFromMarks] = useState(false);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsingPdf, setParsingPdf] = useState(false);
  const [parseStartedAt, setParseStartedAt] = useState<number | null>(null);
  const [parseElapsed, setParseElapsed] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RubricDraft | null>(null);
  const [draftSerial, setDraftSerial] = useState(0);
  const [content, setContentState] = useState<RubricContent | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // The tab that was open when an intake notice started a draft (draftFromFile switches to
  // PDF/DOCX). While that draft is open, uploads keep using that tab's rubric (e.g. a custom JSON),
  // and discarding the draft goes back to it. Cleared by an explicit tab change or a save.
  const [heldMode, setHeldMode] = useState<RubricMode | null>(null);

  // Load rubrics on mount and again whenever the API comes back online.
  useEffect(() => {
    let cancelled = false;
    getRubrics()
      .then((list) => {
        if (cancelled) return;
        setRubrics(list);
        setRubricsError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRubricsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [apiOnline]);

  // Elapsed-time counter while a draft runs (a full question paper takes a few minutes).
  useEffect(() => {
    if (parseStartedAt === null) return;
    const timer = window.setInterval(
      () => setParseElapsed(Math.max(0, Math.round((Date.now() - parseStartedAt) / 1000))),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [parseStartedAt]);

  const selectedId =
    rubricId !== null && rubrics?.some((r) => r.id === rubricId) ? rubricId : (rubrics?.[0]?.id ?? null);
  const selectedRubric = rubrics?.find((r) => r.id === selectedId) ?? null;

  let choice: RubricChoice | null = null;
  if ((mode === "json" || heldMode === "json") && custom) {
    choice = { rubricJson: custom.text, label: `${custom.name} (custom JSON, ${custom.totalMarks} marks)` };
  } else if (selectedRubric) {
    choice = { rubricId: selectedRubric.id, label: rubricLabel(selectedRubric) };
  }

  function setMode(next: RubricMode) {
    setModeState(next);
    setHeldMode(null);
    setParseError(null);
    setNotice(null);
  }

  async function loadJsonFile(file: File | undefined) {
    setNotice(null);
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setCustom(null);
      setCustomError("Rubric JSON files must be under 1 MB.");
      return;
    }
    try {
      const parsed = parseCustomRubric(file.name, await file.text());
      if (typeof parsed === "string") {
        setCustom(null);
        setCustomError(parsed);
      } else {
        setCustom(parsed);
        setCustomError(null);
      }
    } catch (err) {
      setCustom(null);
      setCustomError(errorMessage(err));
    }
  }

  function clearCustom() {
    setCustom(null);
    setCustomError(null);
  }

  /** Draft from pasted text or a file; `file` wins over the state (draftFromFile passes it directly). */
  async function draftRubric(source: { text?: string; file?: File; keyFromMarks?: boolean }) {
    setParsing(true);
    setParsingPdf(!!source.file && isPdfFile(source.file));
    setParseElapsed(0);
    setParseStartedAt(Date.now());
    try {
      const result = await parseRubric({
        text: source.text,
        file: source.file,
        subject: subjectHint.trim() || undefined,
        exam: "NEET",
        keySource: source.file && source.keyFromMarks ? "marks" : undefined,
      });
      setDraft(result);
      setDraftSerial((n) => n + 1);
      setContentState(cloneContent(result.draft));
    } catch (err) {
      setParseError(parseErrorMessage(err));
    } finally {
      setParsing(false);
      setParsingPdf(false);
      setParseStartedAt(null);
      setParseElapsed(0);
    }
  }

  async function runParse() {
    if (parsing) return;
    setParseError(null);
    setNotice(null);
    const text = pasteText.trim();
    if (mode === "paste" && text.length < 20) {
      setParseError("Paste the questions with their marks and marking scheme (at least a few lines).");
      return;
    }
    if (mode === "upload" && !sourceFile) {
      setParseError("Choose the question paper / marking scheme (PDF or DOCX).");
      return;
    }
    await draftRubric(
      mode === "paste"
        ? { text }
        : { file: sourceFile ?? undefined, keyFromMarks: keyFromMarks && !!sourceFile && isPdfFile(sourceFile) },
    );
  }

  /** A new source file starts unticked: "ticks mark the key" belongs to one paper. */
  function chooseSourceFile(file: File | null) {
    setSourceFile(file);
    setKeyFromMarks(false);
  }

  async function draftFromFile(file: File, options?: { keyFromMarks?: boolean }) {
    if (mode !== "upload" && heldMode === null) setHeldMode(mode);
    setModeState("upload");
    if (parsing) {
      setParseError(`A draft is already running - draft "${file.name}" again when it finishes.`);
      return;
    }
    const fromMarks = !!options?.keyFromMarks;
    setSourceFile(file);
    setKeyFromMarks(fromMarks);
    setParseError(null);
    setNotice(null);
    await draftRubric({ file, keyFromMarks: fromMarks });
  }

  function discardDraft() {
    setDraft(null);
    setContentState(null);
    setParseError(null);
    setKeyFromMarks(false);
    if (heldMode !== null) {
      setModeState(heldMode);
      setHeldMode(null);
    }
  }

  async function approveAndSave() {
    if (!content || saving) return;
    const issues = validateContent(content);
    if (issues.count > 0) {
      setNotice({ kind: "error", message: "Fix the highlighted rows before saving the rubric." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await createRubric({
        content: normalizeContent(content),
        parent_id: null,
        change_note: `Drafted from ${draft?.source ?? mode} and approved in the intake review table`,
        approved: true,
      });
      setRubrics((prev) => [...(prev ?? []).filter((r) => r.id !== saved.id), saved]);
      setRubricId(saved.id);
      setModeState("saved");
      setHeldMode(null);
      setKeyFromMarks(false);
      setDraft(null);
      setContentState(null);
      setPasteText("");
      setSourceFile(null);
      setNotice({
        kind: "success",
        message: `Saved "${saved.name}" (${saved.version}, faculty approved) and selected it for this upload.`,
      });
    } catch (err) {
      const status = errorStatus(err);
      setNotice({
        kind: "error",
        message:
          !errorCode(err) && (status === 404 || status === 405)
            ? "Saving rubrics is not available on this API build yet. Download the draft as JSON and use the JSON option."
            : errorMessage(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return {
    mode,
    setMode,
    rubrics,
    rubricsError,
    selectedRubric,
    selectRubric: setRubricId,
    custom,
    customError,
    loadJsonFile,
    clearCustom,
    pasteText,
    setPasteText,
    subjectHint,
    setSubjectHint,
    keyFromMarks,
    setKeyFromMarks,
    sourceFile,
    setSourceFile: chooseSourceFile,
    parsing,
    parsingPdf,
    parseElapsed,
    parseError,
    runParse,
    draftFromFile,
    draft,
    draftSerial,
    content,
    setContent: setContentState,
    discardDraft,
    saving,
    approveAndSave,
    notice,
    choice,
  };
}
