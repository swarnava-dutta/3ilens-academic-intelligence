"use client";

import { useEffect, useRef, useState } from "react";
import {
  createRubricVersion,
  errorCode,
  errorMessage,
  errorStatus,
  extractAnswerKey,
  getReevaluationEstimate,
  parseRubric,
  reevaluateSubmission,
} from "@/lib/api";
import type {
  AnswerKeyExtraction,
  ReevaluationEstimate,
  RubricContent,
  RubricDraft,
  RubricSourceRole,
  Submission,
} from "@/lib/types";
import { answerKeyErrorMessage } from "./answer-key-import";
import { applyAnswerKey, keyApplySummary } from "./answer-key-apply";
import { cloneContent, normalizeContent, paperRole, STALE_AFTER_KEY, totalMarks, validateContent } from "./rubric-utils";

/** Where this intake's answer key comes from: dropped files (the key, the question paper or both) or pasted text. */
export type RubricMode = "file" | "paste";

/**
 * none: no source yet (uploads are disabled) · source: a source without a draft (pasted text, or a
 * failed draft) · drafting · fix: drafted, but the API would reject it (e.g. an MCQ without a
 * key) · ready: uploads are graded with it.
 */
export type KeyStatus = "none" | "source" | "drafting" | "fix" | "ready";

/** How a staged intake file became the rubric source. */
export type KeyOrigin = "key" | "paper" | "ticks";

/**
 * An answer-key file added next to the paper a draft exists (or is running) for: read on its own
 * (POST /api/rubrics/answer-key) and applied to the draft, or held until the running draft lands.
 * held: added while one file is drafted - not read yet: that draft's reply tells whether its file is
 * the answer key alone (then this one is the paper and both are drafted) or the paper.
 */
export interface KeyStep {
  file: File;
  step: "reading" | "waiting" | "held";
}

type Notice = { kind: "success" | "error"; message: string } | null;

/**
 * What one upload run sends: the snapshot's id (with its rubric_hash) while the server has this key,
 * else the key inline with the files it came from (the first upload, or the first after the key or
 * its files changed, creates a snapshot). The inline key is always there: a batch whose id the
 * server no longer knows (unknown_rubric) sends it instead.
 */
export interface RubricTarget {
  rubricId?: number;
  /** With rubricId: the snapshot's SHA-256 from the upload that created it (absent on older API builds). */
  rubricHash?: string;
  rubricJson: string;
  /**
   * With the inline key: the question paper / rubric file the key was drafted from and the separate
   * answer-key file, kept by the server with the new snapshot for the report's preview.
   */
  rubricSourceFile?: File;
  rubricKeyFile?: File;
  /** With rubricSourceFile: what that file is (the report labels it). */
  rubricSourceRole?: RubricSourceRole;
  /** The server created the snapshot from rubricJson: later uploads of this intake reuse its id. */
  created: (rubricId: number, rubricHash?: string | null) => void;
  /** The API no longer knows rubricId (unknown_rubric, e.g. after a data reset): send the key inline again. */
  lost: () => void;
}

/** The files the current key was drafted from (null when pasted text, or no draft). */
export interface KeySourceFiles {
  /** The question paper / key paper / JSON or text rubric file. */
  paper: File | null;
  /** What the paper file is (question paper, rubric file, marked copy); null without one. */
  role: RubricSourceRole | null;
  /**
   * The answer-key file: dropped with the paper (or on its own), or applied to the draft afterwards
   * with "Apply answer key from file" in the draft editor.
   */
  key: File | null;
}

const NO_SOURCES: KeySourceFiles = { paper: null, role: null, key: null };

function sameSources(a: KeySourceFiles, b: KeySourceFiles): boolean {
  return a.paper === b.paper && a.role === b.role && a.key === b.key;
}

/** This intake's key on the server: its id, the key text and the files the server keeps with it. */
interface Snapshot {
  id: number;
  hash: string | null;
  text: string;
  files: KeySourceFiles;
}

export interface RegradeState {
  /** "Re-grade with this key" is worth offering now. */
  offered: boolean;
  /** The snapshot the re-grade starts from (its cost estimate is confirmed first). */
  rubricId: number | null;
  /** The key was edited after sheets were graded with it. */
  edited: boolean;
  /** Sheets of this intake graded (or being graded) with this key or an earlier edit of it. */
  sheets: number;
  /** COMPLETED sheets a re-grade covers now. */
  completed: number;
  /** Sheets still being graded (they finish with the key they started with). */
  busy: number;
  /** Held for review or failed on an earlier edit of the key: they keep that key (not re-graded). */
  held: number;
  /**
   * Held for review or failed on the edited key's snapshot: saving the edit moves them to the new
   * version (approving or re-running them then uses it).
   */
  heldMoving: number;
  running: boolean;
  notice: Notice;
  run: () => Promise<void>;
  /** Cost of the re-grade, for its confirmation (rejects when the estimate cannot be loaded). */
  estimate: () => Promise<RegradeEstimate>;
}

/** The re-grade's confirmation: OCR is reused (0 vision calls), one grading call per live sheet. */
export interface RegradeEstimate {
  /**
   * Rs. Null while no sheet of this key has a recorded grading cost yet (e.g. the snapshot's sheets
   * are still being graded): "shown after the first sheet is graded" rather than a made-up Rs 0.00.
   */
  cost: number | null;
  /** Rs per live sheet (null as above). */
  perSheet: number | null;
  /** Only demo sheets: re-graded synthetically at Rs 0.00. */
  demoOnly: boolean;
  basis: string | null;
}

const PAPER_EXTENSIONS = [".pdf", ".docx", ".json", ".txt", ".png", ".jpg", ".jpeg", ".webp"];
/** An answer-key file: a question paper or key paper (PDF / Word, drafted by the AI), a photo of the key, or the key as JSON / text. */
export const PAPER_ACCEPT =
  ".pdf,.docx,.json,.txt,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/json,text/plain,image/png,image/jpeg,image/webp";

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Types the server keeps as a key source (PDF, Word, JPEG / PNG / WEBP, text): others are not sent. */
const SOURCE_EXTENSIONS = /\.(?:pdf|docx|jpe?g|png|webp|txt|json)$/i;

function isPreviewableSource(file: File): boolean {
  return SOURCE_EXTENSIONS.test(file.name);
}

function isPaperFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return PAPER_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The answer-key drop zone takes the key and the question paper: a third file replaces the answer key file. */
export const MAX_KEY_FILES = 2;

/** The draft's note when the server built it from a key-only file (backend _key_only_draft). */
const KEY_ALONE = /^Built from the answer key alone/;

/** How much a file looks like the answer key rather than the question paper (its name, then its type). */
function keyScore(file: File): number {
  const name = file.name.toLowerCase();
  const named = /answer[\s_-]*key|anskey|(?:^|[^a-z])(?:key|ans|solutions?)(?:[^a-z]|$)/.test(name);
  return (named ? 2 : 0) + (/\.(?:txt|png|jpe?g|webp)$/.test(name) ? 1 : 0);
}

/**
 * Two files go to the parse as [question paper, answer key] (file and key_file): the staged paper a
 * draft came from stays first, else the one that looks less like a key goes first.
 */
export function draftOrder(files: File[], pinFirst: boolean): File[] {
  return pinFirst ? files : [...files].sort((a, b) => keyScore(a) - keyScore(b));
}

/**
 * What each file of a draft stands for: two are [question paper, answer key] as sent, or [answer
 * key, question paper] when the server swapped them (RubricDraft.files_swapped) - the first an
 * answer key too when the server built the draft from it alone (both were keys); one is the answer
 * key when the server built the draft from it alone (before its reply: when its name says so - only
 * a label: changeFiles waits for the reply), else the paper the key is drafted from (a question
 * paper, a JSON / text key, or a copy whose ticks are the key).
 */
export function sourcesFor(files: File[], ticks: boolean, warnings: string[] | null, swapped = false): KeySourceFiles {
  const [first, second] = files;
  if (!first) return NO_SOURCES;
  if (second) {
    const [paper, key] = swapped ? [second, first] : [first, second];
    // Both were keys: the drafted one was read as a key alone too.
    const keyAlone = !!warnings?.some((w) => KEY_ALONE.test(w));
    return { paper, role: keyAlone ? "answer_key" : paperRole(paper.name, false), key };
  }
  const keyAlone = !ticks && (warnings ? warnings.some((w) => KEY_ALONE.test(w)) : keyScore(first) >= 2);
  return keyAlone ? { paper: null, role: null, key: first } : { paper: first, role: paperRole(first.name, ticks), key: null };
}

/**
 * Files picked or dropped into an answer-key drop zone: two at most, a third replaces the oldest
 * file that is not `keep` (the question paper the key comes from). note: files not taken / replaced.
 */
export function mergeKeyFiles(
  files: File[],
  picked: File[],
  keep: File | null,
): { next: File[]; added: boolean; note: { kind: "error" | "info"; message: string } | null } {
  const bad = picked.filter((f) => !isPaperFileName(f.name));
  const fresh = picked.filter(
    (f) => isPaperFileName(f.name) && !files.some((g) => g.name === f.name && g.size === f.size),
  );
  const all = [...files, ...fresh];
  const replaced = all.filter((f) => f !== keep).slice(0, Math.max(0, all.length - MAX_KEY_FILES));
  const next = all.filter((f) => !replaced.includes(f));
  const names = (list: File[]) => list.map((f) => `"${f.name}"`).join(", ");
  const notes = [
    bad.length ? `${names(bad)} ${bad.length === 1 ? "is" : "are"} not a PDF, Word (.docx), image, JSON or text file.` : null,
    replaced.length ? `Two files at most: ${names(replaced)} ${replaced.length === 1 ? "was" : "were"} replaced.` : null,
  ].filter(Boolean);
  return {
    next,
    added: fresh.length > 0,
    note: notes.length ? { kind: bad.length ? "error" : "info", message: notes.join(" ") } : null,
  };
}

/**
 * An answer-key file read alone (POST /api/rubrics/answer-key) set on a drafted key: its MCQ keys go
 * on `content` (hand edits kept), the draft's missing-key notes and the AI-drafted marks of the
 * questions it keys are dropped (stale), and `message` says what changed. differs: the key names
 * another paper code than the draft.
 */
export function applyKeyFile(
  content: RubricContent,
  base: RubricDraft | null,
  file: File,
  extraction: AnswerKeyExtraction,
): { content: RubricContent; draft: RubricDraft | null; differs: boolean; message: string } {
  const { content: next, report } = applyAnswerKey(content, extraction);
  const draft = base && {
    ...base,
    warnings: base.warnings.filter((w) => !STALE_AFTER_KEY.test(w)),
    ai_drafted_questions: base.ai_drafted_questions.filter((n) => !report.keyed.includes(n)),
  };
  const { key: code, rubric, differs } = report.paperCode;
  const message = `Answer key from "${file.name}" applied to the draft (the paper was not read again): ${keyApplySummary(report)}.${
    differs ? ` The key is for paper code ${code}, the draft is ${rubric} - check it is this paper's key.` : ""
  }`;
  return { content: next, draft, differs, message };
}

/** POST /api/rubrics/answer-key found no key at all in the file (not one it cannot use): it is a paper. */
export function holdsNoKey(err: unknown): boolean {
  return errorCode(err) === "no_answer_key" && /^No answer key was found/.test(errorMessage(err));
}

function draftLabel(files: File[]): string {
  return files.map((f) => f.name).join(" and ");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Friendly text for POST /api/rubrics/parse failures. */
export function parseErrorMessage(err: unknown): string {
  const code = errorCode(err);
  const status = errorStatus(err);
  if (code === "ai_not_configured" || status === 503) {
    return "AI drafting needs the Anthropic key in .env (ANTHROPIC_API_KEY). Until then add the answer key as a JSON rubric file (the Template link shows the shape).";
  }
  if (code === "unsupported_signature" || status === 415) {
    return "That file is not a PDF, Word (.docx), image, JSON or text file. Add the answer key or the question paper in one of those formats.";
  }
  if (code === "empty_rubric_source") {
    return "No question text was found. Paste the questions and answer key, or add a text-based PDF/DOCX.";
  }
  if (code === "no_answer_key") {
    return 'No answer key was found in that file. Use a clear photo or a table such as "1-2, 2-4", a "Que. / Ans." grid or a paper with "Ans." lines - or add the question paper too.';
  }
  if (!code && (status === 404 || status === 405)) {
    return "Drafting the answer key is not available on this API build.";
  }
  return errorMessage(err);
}

function regradeErrorMessage(err: unknown): string {
  const code = errorCode(err);
  if (code === "ai_not_configured" || errorStatus(err) === 503) {
    return "Re-grading needs the Anthropic key in .env (ANTHROPIC_API_KEY).";
  }
  if (code === "unknown_rubric") {
    return "This intake's answer key is no longer on the server (the data was reset). Upload the sheets again.";
  }
  return errorMessage(err);
}

const ACTIVE = new Set(["PENDING", "PROCESSING"]);
const HELD = new Set(["HUMAN_REVIEW_REQUIRED", "FAILED"]);

/**
 * The intake's answer key, drafted on the fly with POST /api/rubrics/parse from one or two dropped
 * files (the answer key, the question paper, or both - two go as file + key_file; a key file added
 * once the paper's draft exists or runs is read alone with POST /api/rubrics/answer-key and applied
 * to that draft; a file added while one file is still being drafted waits for that reply, which says
 * which file is the key) or pasted text. Nothing is kept in a rubric library: the first upload
 * sends the draft inline (rubric_json, with the files it came from) and the server stores it as this
 * intake's snapshot; later uploads reuse that snapshot's id while the key and its files stay the
 * same. Any change after that (an edit, a file added or removed, a key file applied, a new draft) makes the next
 * upload send the key inline again with the current files, and offers "Re-grade with this key" for
 * the sheets graded before it.
 *
 * submissions: the polled queue (to find this intake's sheets for a re-grade).
 */
export function useRubricSource(submissions: Submission[] | null, onQueueChanged?: () => void) {
  const [mode, setModeState] = useState<RubricMode>("file");
  const [pasteText, setPasteText] = useState("");
  const [subjectHint, setSubjectHint] = useState("");
  /** The dropped files in the order they came (at most MAX_KEY_FILES). */
  const [files, setFilesState] = useState<File[]>([]);
  const [keyFromMarks, setKeyFromMarks] = useState(false);
  /** How a staged intake file became the source; it is then files[0]. */
  const [origin, setOrigin] = useState<KeyOrigin | null>(null);
  /** A file that was not taken, or the one a third file replaced. */
  const [filesNote, setFilesNote] = useState<{ kind: "error" | "info"; message: string } | null>(null);

  const [parsing, setParsing] = useState(false);
  const [parsingPdf, setParsingPdf] = useState(false);
  const [parseStartedAt, setParseStartedAt] = useState<number | null>(null);
  const [parseElapsed, setParseElapsed] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  /** Label of the source being drafted / last drafted ("paper.pdf", "pasted text"). */
  const [draftFrom, setDraftFrom] = useState<string | null>(null);

  const [sources, setSourcesState] = useState<KeySourceFiles>(NO_SOURCES);
  const [draft, setDraftState] = useState<RubricDraft | null>(null);
  const [draftSerial, setDraftSerial] = useState(0);
  const [content, setContentState] = useState<RubricContent | null>(null);
  /** Hand edits of the key (sheets queued before one wait for a click, not the keystroke). */
  const [edits, setEdits] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);

  /** The server's snapshot of this key (created by the first upload) and every version of it this session. */
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lineage, setLineage] = useState<number[]>([]);
  const [regrading, setRegrading] = useState(false);
  const [regradeNotice, setRegradeNotice] = useState<Notice>(null);

  // Mirrors for async work (a draft finishing minutes later sees the current values).
  const contentRef = useRef<RubricContent | null>(null);
  const draftRef = useRef<RubricDraft | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const sourcesRef = useRef<KeySourceFiles>(NO_SOURCES);
  /** Bumped per draft: a reply for an earlier draft is dropped. */
  const draftRun = useRef(0);
  /** Bumped when the key starts over (another paper, discard): replies for the old key are dropped. */
  const epoch = useRef(0);
  /** The pasted text the last paste draft came from: drafting other text is another paper. */
  const pastedText = useRef<string | null>(null);
  /** An answer-key file read next to the draft's paper (no re-draft of the paper). */
  const [keyStep, setKeyStep] = useState<KeyStep | null>(null);
  /** Bumped per key read (and per draft, discard): a reply for an earlier read is dropped. */
  const keyRun = useRef(0);
  /** A key read while the paper was still being drafted: applied when that draft lands (latest wins). */
  const pendingKey = useRef<{ file: File; extraction: AnswerKeyExtraction } | null>(null);
  /** The file a running draft reads alone: only its reply tells whether it is the answer key or the paper. */
  const roleOpen = useRef<File | null>(null);
  /** A file added while that draft runs (keyStep "held"), taken when it lands. */
  const heldFile = useRef<{ file: File; pinFirst: boolean } | null>(null);
  const parsingRef = useRef(false);
  /** The upload creating this key's server copy now: other uploads wait for it, then reuse its id. */
  const creating = useRef<Promise<void> | null>(null);

  // Elapsed-time counter while a draft runs (a full question paper takes a few minutes).
  useEffect(() => {
    if (parseStartedAt === null) return;
    const timer = window.setInterval(
      () => setParseElapsed(Math.max(0, Math.round((Date.now() - parseStartedAt) / 1000))),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [parseStartedAt]);

  function putContent(next: RubricContent | null) {
    contentRef.current = next;
    setContentState(next);
  }

  function putDraft(next: RubricDraft | null) {
    draftRef.current = next;
    setDraftState(next);
  }

  function putSources(next: KeySourceFiles) {
    sourcesRef.current = next;
    setSourcesState(next);
  }

  function putSnapshot(next: Snapshot | null) {
    snapshotRef.current = next;
    setSnapshot(next);
  }

  function putParsing(next: boolean) {
    parsingRef.current = next;
    setParsing(next);
  }

  /** Drop a key read in flight or held for the running draft. */
  function dropKeyStep() {
    keyRun.current += 1;
    pendingKey.current = null;
    heldFile.current = null;
    setKeyStep(null);
  }

  /** Another paper: its key starts without a snapshot (the earlier sheets keep theirs). */
  function startOver() {
    epoch.current += 1;
    putSnapshot(null);
    setLineage([]);
    setRegradeNotice(null);
  }

  function stopDrafting() {
    draftRun.current += 1;
    roleOpen.current = null;
    dropKeyStep();
    putParsing(false);
    setParsingPdf(false);
    setParseStartedAt(null);
    setParseElapsed(0);
  }

  // ---------------------------------------------------------------- derived
  const text = content ? JSON.stringify(normalizeContent(content)) : null;
  const issues = content ? validateContent(content) : null;
  let status: KeyStatus;
  // A key file being read for the draft: uploads wait for it (it changes the MCQ keys).
  if (parsing || keyStep?.step === "reading") status = "drafting";
  else if (content) status = issues && issues.count > 0 ? "fix" : "ready";
  else if ((mode === "file" && files.length > 0) || (mode === "paste" && pasteText.trim().length >= 20)) status = "source";
  else status = "none";
  const dirty = !!snapshot && text !== null && text !== snapshot.text;
  const ready = status === "ready";

  /** "Q12 (the correct option), Q45 (the correct option)" for the questions that block grading. */
  const fixList = (() => {
    if (!content || !issues || issues.count === 0) return null;
    const rows = Object.entries(issues.byIndex).map(([index, problems]) => {
      const q = content.questions[Number(index)];
      const label = q && Number.isFinite(q.question) ? `Q${q.question}` : `row ${Number(index) + 1}`;
      return `${label} (${problems.join(", ")})`;
    });
    const shown = [...issues.general, ...rows.slice(0, 4)];
    return rows.length > 4 ? `${shown.join("; ")}; +${rows.length - 4} more` : shown.join("; ");
  })();
  const fixCount = issues ? issues.count : 0;

  // This intake's sheets: every submission on the snapshot or an earlier version of it.
  const sheets = lineage.length ? (submissions ?? []).filter((s) => lineage.includes(s.rubric_id)) : [];
  const onEarlier = sheets.filter((s) => !snapshot || s.rubric_id !== snapshot.id);
  const regradeNow = (dirty ? sheets : onEarlier).filter((s) => s.status === "COMPLETED");
  // Held / failed sheets on the snapshot move with an edit to its new version (the API does it);
  // those on an earlier edit keep that key.
  const heldSheets = sheets.filter((s) => HELD.has(s.status));
  const regrade: RegradeState = {
    offered: ready && !!snapshot && (dirty ? sheets.length > 0 : regradeNow.length > 0),
    rubricId: snapshot?.id ?? null,
    edited: dirty,
    sheets: sheets.length,
    completed: regradeNow.length,
    busy: (dirty ? sheets : onEarlier).filter((s) => ACTIVE.has(s.status)).length,
    held: heldSheets.filter((s) => !snapshot || s.rubric_id !== snapshot.id).length,
    heldMoving: dirty && snapshot ? heldSheets.filter((s) => s.rubric_id === snapshot.id).length : 0,
    running: regrading,
    notice: regradeNotice,
    run: runRegrade,
    estimate: estimateRegrade,
  };

  let usesLabel: string;
  if (status === "drafting") usesLabel = `the key being drafted from ${draftFrom ?? "the paper"}`;
  else if (content) {
    const name = content.name.trim() || "the drafted key";
    usesLabel = `${name} · ${plural(content.questions.length, "question")} · ${totalMarks(content)} marks${
      draftFrom ? ` (from ${draftFrom})` : ""
    }`;
  } else usesLabel = "none yet - add the answer key or the question paper";

  /** Why a click on Upload queues instead of sending (null when the key is ready or there is no source). */
  let waitingNote: string | null = null;
  if (status === "drafting") waitingNote = "The answer key is still being drafted.";
  else if (status === "fix") waitingNote = `The drafted key needs ${plural(fixCount, "fix", "fixes")} first: ${fixList}.`;
  else if (status === "source") {
    waitingNote = mode === "paste" ? "The answer key is drafted from the pasted text first." : "The answer key is drafted first.";
  }

  // ---------------------------------------------------------------- drafting
  /** files: [question paper, answer key] (draftOrder), or one file of either kind. */
  async function startDraft(source: { text?: string; files?: File[]; keyFromMarks?: boolean; label: string }) {
    const run = ++draftRun.current;
    const list = source.files ?? [];
    const [file, keyFile] = list;
    const ticks = !!source.keyFromMarks && !keyFile;
    // This draft reads every file it is given: a key file read or held for an earlier draft is dropped.
    dropKeyStep();
    roleOpen.current = file && !keyFile && !ticks ? file : null;
    putParsing(true);
    setParsingPdf(!!file && isPdfFile(file));
    setParseElapsed(0);
    setParseStartedAt(Date.now());
    setParseError(null);
    setNotice(null);
    setDraftFrom(source.label);
    putSources(sourcesFor(list, ticks, null));
    let keyAlone: boolean | null = null;
    try {
      const result = await parseRubric({
        text: source.text,
        file,
        subject: subjectHint.trim() || undefined,
        exam: "NEET",
        keySource: file && ticks ? "marks" : undefined,
        keyFile,
      });
      if (run !== draftRun.current) return;
      const found = sourcesFor(list, ticks, result.warnings, !!result.files_swapped);
      keyAlone = !found.paper;
      putSources(found);
      putDraft(result);
      putContent(cloneContent(result.draft));
      setDraftSerial((n) => n + 1);
    } catch (err) {
      if (run !== draftRun.current) return;
      setParseError(parseErrorMessage(err));
    } finally {
      if (run === draftRun.current) {
        // A key file added while this draft ran goes on it now (or on the earlier draft, kept on a failure).
        const held = pendingKey.current;
        pendingKey.current = null;
        if (held && contentRef.current) applyKey(held.file, held.extraction);
        else if (held) setKeyStep(null);
        const added = heldFile.current;
        heldFile.current = null;
        roleOpen.current = null;
        putParsing(false);
        setParsingPdf(false);
        setParseStartedAt(null);
        setParseElapsed(0);
        // A file added while this one was drafted: the reply tells which of the two is the key.
        if (added && file) {
          const both = [file, added.file];
          if (keyAlone === false) {
            // This file is the paper: the added one is read as its answer key and applied.
            void readKey(added.file, both, added.pinFirst);
          } else {
            // This file was the answer key alone (or its draft failed): both are drafted, the paper first.
            putDraft(null);
            putContent(null);
            setKeyFromMarks(false);
            void startDraft({ files: keyAlone ? [added.file, file] : draftOrder(both, added.pinFirst), label: draftLabel(both) });
          }
        }
      }
    }
  }

  /**
   * "Draft" / "Draft again": the current source with the current options. Drafting the same source
   * again keeps this intake's snapshot (the new draft is an edit of it); another source starts over.
   */
  async function runParse() {
    setNotice(null);
    if (mode === "paste") {
      const value = pasteText.trim();
      if (value.length < 20) {
        setParseError("Paste the questions with their marks and answer key (at least a few lines).");
        return;
      }
      if (draftFrom !== "pasted text" || pastedText.current !== value) startOver();
      pastedText.current = value;
      await startDraft({ text: value, label: "pasted text" });
      return;
    }
    if (!files.length) {
      setParseError("Add the answer key or the question paper (PDF, Word, image, JSON or text).");
      return;
    }
    const label = draftLabel(files);
    if (draftFrom !== label) startOver();
    await startDraft({
      files: draftOrder(files, origin !== null),
      keyFromMarks: keyFromMarks && files.length === 1 && isPdfFile(files[0]),
      label,
    });
  }

  /** Draft the key from these files (the whole paper is read again). */
  function redraft(next: File[], pinFirst: boolean) {
    putDraft(null);
    putContent(null);
    // The ticks are the key only for a paper on its own: faculty tick the box again for the new set.
    setKeyFromMarks(false);
    void startDraft({ files: draftOrder(next, pinFirst), label: draftLabel(next) });
  }

  /**
   * An answer-key file read on the draft: its MCQ keys (one option, accepted options, bonus) are set
   * on the key as it is now, hand edits kept. The paper is not drafted again.
   */
  function applyKey(file: File, extraction: AnswerKeyExtraction) {
    setKeyStep(null);
    const current = contentRef.current;
    if (!current) return;
    // The draft's missing-key notes are stale now (the live checks show what is still missing).
    const applied = applyKeyFile(current, draftRef.current, file, extraction);
    putContent(applied.content);
    if (applied.draft) putDraft(applied.draft);
    putSources({ ...sourcesRef.current, key: file });
    setNotice({ kind: applied.differs ? "error" : "success", message: applied.message });
  }

  /**
   * A file added next to the paper a draft exists (or is running) for: read on its own as an answer
   * key and applied to that draft (held until a running draft lands). When it holds no answer key
   * (no_answer_key) it is a paper too: both files are drafted.
   */
  async function readKey(file: File, next: File[], pinFirst: boolean) {
    const run = ++keyRun.current;
    pendingKey.current = null;
    setKeyStep({ file, step: "reading" });
    try {
      const extraction = await extractAnswerKey({ file });
      if (run !== keyRun.current) return;
      if (parsingRef.current) {
        pendingKey.current = { file, extraction };
        setKeyStep({ file, step: "waiting" });
      } else if (contentRef.current) {
        applyKey(file, extraction);
      } else {
        // The draft failed meanwhile: the next draft reads both files.
        setKeyStep(null);
      }
    } catch (err) {
      if (run !== keyRun.current) return;
      setKeyStep(null);
      // No key in it at all (not a key that cannot be used, such as one of NTA question IDs or one
      // answer column per paper code): it is a paper, drafted with the other file.
      if (holdsNoKey(err)) {
        redraft(next, pinFirst);
        return;
      }
      const rest = next.filter((f) => f !== file);
      setFilesState(rest);
      setDraftFrom(draftLabel(rest));
      setFilesNote({
        kind: "error",
        message: `"${file.name}" could not be read as the answer key, so it was not added: ${answerKeyErrorMessage(err)}`,
      });
    }
  }

  /**
   * The drop zone's files changed. While a draft exists (or runs) for a paper that stays, an added
   * file is read as its answer key and applied to the draft (no new paper draft), and a removed key
   * file leaves the draft as it is. Anything else - the first file, another question paper, a draft
   * built from a key alone - is drafted at once (a 19-page paper takes minutes). The same paper keeps
   * this intake's snapshot (the changed key is an edit of it, offered as a re-grade); a new set of
   * files starts over.
   */
  function changeFiles(next: File[]) {
    if (!next.length) {
      discardDraft();
      return;
    }
    const firstKept = next[0] === files[0];
    const pinFirst = firstKept && origin !== null;
    const paper = sources.paper;
    const added = next.filter((f) => !files.includes(f));
    const removed = files.filter((f) => !next.includes(f));
    const open = roleOpen.current;
    if (open && next.includes(open) && added.length <= 1) {
      // The running draft reads one file and only its reply tells whether that file is the answer key
      // alone or the paper (a name such as IMG_1234.jpg says neither): a file added meanwhile is held
      // until that reply lands (startDraft takes it then); one removed meanwhile is dropped.
      setFilesState(next);
      setDraftFrom(draftLabel(next));
      dropKeyStep();
      if (added.length) {
        heldFile.current = { file: added[0], pinFirst };
        setKeyStep({ file: added[0], step: "held" });
      }
      return;
    }
    const keepPaper =
      (!!content || parsing) &&
      !!paper &&
      next.includes(paper) &&
      added.length <= 1 &&
      // A file the running draft reads cannot be taken out of it: that paper is drafted again.
      removed.every((f) => !parsing || f === keyStep?.file);
    setFilesState(next);
    if (!keepPaper) {
      if (!next.some((f) => files.includes(f))) startOver();
      if (!firstKept) setOrigin(null);
      redraft(next, pinFirst);
      return;
    }
    setDraftFrom(draftLabel(next));
    if (keyStep && removed.includes(keyStep.file)) dropKeyStep();
    const removedKey = removed.find((f) => f === sources.key);
    if (removedKey) {
      putSources({ ...sourcesRef.current, key: null });
      const message = `The keys read from "${removedKey.name}" stay in the draft until it is drafted again (Draft again).`;
      setFilesNote((prev) => ({ kind: prev?.kind ?? "info", message: prev ? `${prev.message} ${message}` : message }));
    }
    if (added.length) void readKey(added[0], next, pinFirst);
  }

  /**
   * Files dropped or picked in the drop zone: two at most (a third replaces the answer key file, or
   * the file held for a running one-file draft).
   */
  function addFiles(picked: File[]) {
    const { next, added, note } = mergeKeyFiles(files, picked, roleOpen.current ?? sources.paper);
    setFilesNote(note);
    if (added) changeFiles(next);
  }

  function removeFile(file: File) {
    setFilesNote(null);
    changeFiles(files.filter((f) => f !== file));
  }

  /** From a staged intake file: an answer-key paper, a printed question paper, or a copy whose ticks are the key. */
  function draftFromFile(file: File, options?: { keyFromMarks?: boolean; origin?: KeyOrigin }) {
    const marks = !!options?.keyFromMarks;
    setModeState("file");
    setFilesNote(null);
    startOver();
    putDraft(null);
    putContent(null);
    setFilesState([file]);
    setKeyFromMarks(marks);
    setOrigin(options?.origin ?? null);
    void startDraft({ files: [file], keyFromMarks: marks, label: file.name });
  }

  function setMode(next: RubricMode) {
    setModeState(next);
    setParseError(null);
    setFilesNote(null);
    setNotice(null);
  }

  function setContent(next: RubricContent) {
    putContent(next);
    setEdits((n) => n + 1);
  }

  /**
   * "Apply answer key from file" in the draft editor applied this file (or its Undo restored the one
   * before): it now stands behind the key and goes with the next upload.
   */
  function setSourceKeyFile(file: File | null) {
    putSources({ ...sourcesRef.current, key: file });
  }

  /** Start over: no key, no snapshot (sheets already uploaded keep the key they were graded with). */
  function discardDraft() {
    stopDrafting();
    startOver();
    putDraft(null);
    putContent(null);
    setParseError(null);
    setNotice(null);
    setFilesState([]);
    setFilesNote(null);
    setKeyFromMarks(false);
    setOrigin(null);
    setDraftFrom(null);
    putSources(NO_SOURCES);
  }

  /** A click on Upload with a source that has no draft yet starts the draft. */
  function ensureDraft() {
    if (status === "source") void runParse();
  }

  // ---------------------------------------------------------------- uploads
  function recordSnapshot(textSent: string, id: number, at: number, files: KeySourceFiles, hash: string | null) {
    if (at !== epoch.current) return;
    putSnapshot({ id, hash, text: textSent, files });
    setLineage((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  /**
   * What the next upload run sends, or null when the key is not ready. The snapshot's id while the
   * key and its files are what the server has; otherwise (the first upload, an edit, a key file
   * applied or replaced, a new draft) the key goes inline again with the current files, so the new
   * snapshot carries both and the report previews the right ones.
   */
  function uploadTarget(): RubricTarget | null {
    const current = contentRef.current;
    if (!current || validateContent(current).count > 0) return null;
    const textNow = JSON.stringify(normalizeContent(current));
    const files = sourcesRef.current;
    const at = epoch.current;
    const snap = snapshotRef.current;
    const known = snap && snap.text === textNow && sameSources(snap.files, files) ? snap : null;
    const paper = files.paper && isPreviewableSource(files.paper) ? files.paper : undefined;
    return {
      rubricId: known?.id,
      rubricHash: known?.hash ?? undefined,
      rubricJson: textNow,
      rubricSourceFile: paper,
      rubricSourceRole: paper ? (files.role ?? undefined) : undefined,
      rubricKeyFile: files.key && isPreviewableSource(files.key) ? files.key : undefined,
      created: (id, hash) => recordSnapshot(textNow, id, at, files, hash ?? null),
      lost: () => {
        // Only the snapshot this upload named (a later one, e.g. re-created inline, stays).
        if (at !== epoch.current || (known && snapshotRef.current?.id !== known.id)) return;
        putSnapshot(null);
        setLineage([]);
      },
    };
  }

  /**
   * Runs one upload (a sheet, a batch run, a retry) with the key as it is when it starts; false when
   * the key is not valid then. One upload at a time sends the key inline: the others wait until it
   * created the server copy (or gave up), then reuse that copy's id - concurrent clicks make one
   * copy. A wait can be long (the first sheet uploads with the key): the caller shows its sheets as
   * waiting from the click, takes one click per sheet, and send reads the state of the moment it
   * runs (refs), not of the click.
   */
  async function upload(send: (target: RubricTarget) => Promise<void>): Promise<boolean> {
    while (creating.current) await creating.current;
    const target = uploadTarget();
    if (!target) return false;
    if (target.rubricId !== undefined) {
      await send(target);
      return true;
    }
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settle = () => {
      if (creating.current === mine) creating.current = null;
      release();
    };
    creating.current = mine;
    try {
      await send({
        ...target,
        created: (id, hash) => {
          target.created(id, hash);
          settle();
        },
      });
    } finally {
      settle();
    }
    return true;
  }

  // ---------------------------------------------------------------- re-grade
  /**
   * What the re-grade costs. The API prices a rubric's live COMPLETED sheets and answers Rs 0 per
   * sheet when it has none (e.g. the snapshot's sheets are still being graded, or only an earlier
   * edit's sheets finished), so every version this re-grade touches is asked and the per-sheet cost
   * comes from one that has live sheets.
   */
  async function estimateRegrade(): Promise<RegradeEstimate> {
    const snap = snapshotRef.current;
    if (!snap) throw new Error("This intake's answer key is not on the server yet.");
    const edited = dirty;
    const earlier = lineage.filter((id) => id !== snap.id).reverse();
    const [own, ...rest] = await Promise.all([
      getReevaluationEstimate(snap.id),
      ...earlier.map((id) => getReevaluationEstimate(id).catch(() => null)),
    ]);
    const found = [own, ...rest].filter((e): e is ReevaluationEstimate => e !== null);
    const priced = found.find((e) => e.live_students > 0 && e.estimated_cost_per_student_inr > 0) ?? null;
    // Sheets re-graded: the snapshot's (an edit makes a version that re-grades them) and the ones that
    // finished with an earlier edit. Live ones cost a grading call each; demo ones Rs 0.00.
    const covered = [...(edited ? [own] : []), ...rest.filter((e): e is ReevaluationEstimate => e !== null)];
    const allKnown = rest.every((e) => e !== null);
    const ownPart = edited ? own.students : 0;
    const demo = covered.reduce((n, e) => n + e.demo_students, 0);
    let live = allKnown
      ? covered.reduce((n, e) => n + e.live_students, 0)
      : (edited ? own.live_students : 0) + Math.max(0, regradeNow.length - ownPart);
    if (live === 0 && demo > 0) {
      return { cost: 0, perSheet: 0, demoOnly: true, basis: own.basis || null };
    }
    // The queue already shows sheets the API does not count yet (a poll ahead of it): count them live.
    if (live === 0) live = regradeNow.length;
    if (!priced) return { cost: null, perSheet: null, demoOnly: false, basis: null };
    const perSheet = priced.estimated_cost_per_student_inr;
    return { cost: Math.round(perSheet * live * 100) / 100, perSheet, demoOnly: false, basis: priced.basis || null };
  }

  async function runRegrade() {
    const snap = snapshotRef.current;
    const current = contentRef.current;
    if (!snap || !current || regrading || validateContent(current).count > 0) return;
    const textNow = JSON.stringify(normalizeContent(current));
    const at = epoch.current;
    setRegrading(true);
    setRegradeNotice(null);
    try {
      let targetId = snap.id;
      const queued: number[] = [];
      const edited = textNow !== snap.text;
      if (edited) {
        // Version of this intake's key; the API re-grades every COMPLETED sheet on the snapshot (OCR reused).
        const result = await createRubricVersion(snap.id, {
          content: JSON.parse(textNow) as RubricContent,
          change_note: "Answer key edited at intake - sheets re-graded",
          reprocess: true,
        });
        // The version keeps the snapshot's files on the server: if they changed since, the next
        // upload still sends the key inline with the current ones.
        recordSnapshot(textNow, result.rubric.id, at, snap.files, result.rubric.rubric_hash || null);
        targetId = result.rubric.id;
        queued.push(...result.queued_submission_ids);
      }
      // Sheets that finished with an earlier edit of the key: re-grade them one by one.
      const rest = sheets.filter(
        (s) =>
          s.status === "COMPLETED" &&
          s.rubric_id !== targetId &&
          !(edited && s.rubric_id === snap.id) &&
          !queued.includes(s.id),
      );
      let failed = 0;
      for (const s of rest) {
        try {
          await reevaluateSubmission(s.id, { rubric_id: targetId });
          queued.push(s.id);
        } catch {
          failed += 1;
        }
      }
      const busy = sheets.filter((s) => ACTIVE.has(s.status)).length;
      // Saving an edit moves the snapshot's held / failed sheets to the new version (API); those on an
      // earlier edit keep that key.
      const moved = edited ? sheets.filter((s) => HELD.has(s.status) && s.rubric_id === snap.id).length : 0;
      const held = sheets.filter(
        (s) => HELD.has(s.status) && s.rubric_id !== targetId && !(edited && s.rubric_id === snap.id),
      ).length;
      const parts = [
        queued.length
          ? `Re-grading ${plural(queued.length, "sheet")} with this key - the OCR text is reused (no new scan) and the earlier results are archived.`
          : "This key is used from now on.",
      ];
      if (busy) parts.push(`${plural(busy, "sheet")} still being graded finish with the key they started with - re-grade them when they finish.`);
      if (moved) {
        parts.push(
          `${plural(moved, "sheet")} held for review or failed ${moved === 1 ? "now uses" : "now use"} this key - approve or re-run ${moved === 1 ? "it" : "them"} from ${moved === 1 ? "its" : "their"} report.`,
        );
      }
      if (held) {
        parts.push(
          `${plural(held, "sheet")} held for review or failed under an earlier edit ${held === 1 ? "keeps" : "keep"} that key - re-run ${held === 1 ? "it" : "them"} from ${held === 1 ? "its" : "their"} report.`,
        );
      }
      if (failed) parts.push(`${plural(failed, "sheet")} could not be queued - open them from the queue.`);
      setRegradeNotice({ kind: failed ? "error" : "success", message: parts.join(" ") });
      onQueueChanged?.();
    } catch (err) {
      setRegradeNotice({ kind: "error", message: regradeErrorMessage(err) });
    } finally {
      setRegrading(false);
    }
  }

  return {
    mode,
    setMode,
    status,
    /** Uploads can be sent now (the key is ready). */
    ready,
    pasteText,
    setPasteText,
    subjectHint,
    setSubjectHint,
    /** The dropped files, in the order they came. */
    files,
    filesNote,
    addFiles,
    removeFile,
    keyFromMarks,
    setKeyFromMarks,
    origin,
    parsing,
    parsingPdf,
    parseElapsed,
    parseError,
    runParse,
    ensureDraft,
    draftFromFile,
    draftFrom,
    draft,
    draftSerial,
    content,
    setContent,
    /** Hand edits of the key so far. */
    edits,
    /** An answer-key file added next to the draft's paper, being read or held for the running draft. */
    keyStep,
    setSourceKeyFile,
    discardDraft,
    fixCount,
    fixList,
    waitingNote,
    usesLabel,
    notice,
    upload,
    /** The files the key in use was drafted from (previews next to the draft; sent with the first upload). */
    sources,
    /** The snapshot printed papers are compared with (null before the first upload or while edited). */
    inspectRubricId: snapshot && !dirty ? snapshot.id : null,
    regrade,
  };
}

export type RubricSourceState = ReturnType<typeof useRubricSource>;
