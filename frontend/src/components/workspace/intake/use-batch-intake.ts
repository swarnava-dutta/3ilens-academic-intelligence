"use client";

import { useEffect, useRef, useState } from "react";
import { errorCode, errorMessage, errorStatus, uploadSubmission } from "@/lib/api";
import type { LanguageHint, PaperInspection, RubricMatch, RubricSourceRole, Submission } from "@/lib/types";
import { hasAcceptedType, MAX_UPLOAD_BYTES } from "../format";
import { codeLabel, fallbackCode } from "./codes";
import type { PickedFile } from "./collect";
import {
  checkSignature,
  deriveStudentName,
  isVoiceKind,
  randomId,
  readHead,
  rollNoProblem,
  sha256Hex,
  skipReason,
  type SignatureCheck,
} from "./inspect";
import {
  createLimiter,
  fetchInspection,
  isPaperCandidate,
  pageLimitProblem,
  RECHECK_DELAY_MS,
  rubricComparable,
  shownMatch,
} from "./paper";
import { voiceQuestionFor } from "./voice-fields";

/** Concurrent uploadSubmission calls in a batch run. */
export const UPLOAD_CONCURRENCY = 3;
/** Above this many files the UI notes that production uses the queue API. */
export const QUEUE_API_NOTE_THRESHOLD = 100;
/** Most rows one staging session holds (the browser hashes every file). */
const MAX_STAGED = 300;
/** Concurrent POST /api/intake/inspect calls while staging PDFs / DOCX. */
const INSPECT_CONCURRENCY = 3;
/** Shown when an upload has no answer key (the API answers 422 rubric_required). */
export const NO_KEY_MESSAGE =
  "Add the question paper or the answer key first - every upload needs its own answer key (rubric).";
/** Refusals of the answer key itself (not of one sheet): a run stops at the first. */
const KEY_REFUSALS = new Set(["unknown_rubric", "invalid_rubric", "rubric_required"]);

type RowPhase = "checking" | "ready" | "uploading" | "queued" | "rejected";

interface StagedRow {
  key: string;
  /** Bumped when the file is replaced, so a late inspection of the old file is ignored. */
  version: number;
  file: File;
  path: string;
  studentName: string;
  rollNo: string;
  signature: SignatureCheck | null;
  /** Hex SHA-256 computed in the browser (null while checking or when Web Crypto is unavailable). */
  hash: string | null;
  phase: RowPhase;
  percent: number;
  submission: Submission | null;
  errorCode: string | null;
  errorDetail: string | null;
  /** Upload even though the bytes duplicate an earlier row. */
  includeDuplicate: boolean;
  /** Voice answers: the rubric question a per-question recording answers (null = whole recording). */
  voiceQuestion: number | null;
  /** PDF / DOCX: what the server reads from its text layer (answer key paper, printed MCQ paper); advisory. */
  paper: PaperInspection | null;
  paperChecking: boolean;
  /** Answer-key snapshot `paper.rubric_match` was compared with (null = none). */
  paperRubric: number | null;
}

/** The staged file is a voice answer (its bytes are MP3 / WAV / M4A / OGG). */
export function isVoiceRow(row: StagedRow): boolean {
  return isVoiceKind(row.signature?.kind);
}

interface SkippedFile {
  path: string;
  reason: string;
}

export interface UploadContext {
  /** The intake's answer-key snapshot (created by an earlier upload of this key), with its hash... */
  rubricId?: number;
  rubricHash?: string;
  /**
   * ...or the key itself, inline: sent with the first upload only, the rest reuse its snapshot (with
   * rubricId too: sent once when the server no longer knows that id).
   */
  rubricJson?: string;
  /** With the inline key (the first upload): the files the key was drafted from (report preview). */
  rubricSourceFile?: File;
  rubricKeyFile?: File;
  /** With rubricSourceFile: what that file is (question paper, rubric file, marked copy). */
  rubricSourceRole?: RubricSourceRole;
  /** The first upload created the snapshot from rubricJson. */
  onRubricCreated?: (rubricId: number, rubricHash?: string | null) => void;
  /** 422 unknown_rubric: the snapshot is gone (data reset) - the key goes inline again. */
  onRubricLost?: () => void;
  languages: LanguageHint[];
  batchId: number | null;
  /** Question numbers of the answer key (a voice_question outside them is not sent). */
  questionNumbers?: number[];
  onUploaded: (submission: Submission) => void;
  onIntakeStarted?: (intakeBatchId: string) => void;
}

/** The key one upload sends: inline with the files it was drafted from (the first upload), or a snapshot id. */
interface RowRubric {
  id?: number;
  hash?: string;
  json?: string;
  sourceFile?: File;
  keyFile?: File;
  sourceRole?: RubricSourceRole;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Rows an upload click holds until its upload starts: the ready rows (Upload), the rejected rows
 * (Retry rejected) or one row (its Retry).
 */
type HoldScope = "uploadable" | "rejected" | { key: string };

/** A row's display status after client checks and duplicate detection. */
export interface RowView {
  row: StagedRow;
  index: number;
  /** Index of the earlier row with the same SHA-256, or null. */
  duplicateOf: number | null;
  /** Blocked before upload by a client check (code + message), or null. */
  blocked: { code: string; message: string } | null;
  nameProblem: string | null;
  rollProblem: string | null;
  /** Ready and not skipped: part of the next upload run. */
  uploadable: boolean;
  skippedAsDuplicate: boolean;
  /** How the printed paper compares with the answer key (null: unknown, none or re-checking). */
  rubricMatch: RubricMatch | null;
  /** The paper is being compared with the answer key's snapshot. */
  matchChecking: boolean;
  /**
   * Its upload was clicked and waits to start (another upload is saving the answer key on the
   * server): it shows "waiting" and its buttons are disabled.
   */
  waiting: boolean;
}

function clientBlock(row: StagedRow, maxBytes: number): { code: string; message: string } | null {
  if (row.file.size === 0) return { code: "empty_file", message: "The file is empty." };
  if (row.file.size > maxBytes) {
    return { code: "too_large", message: `Larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.` };
  }
  if (row.signature?.error) return { code: row.signature.code ?? "unsupported_signature", message: row.signature.error };
  const pages = pageLimitProblem(row.paper);
  if (pages) return { code: "too_many_pages", message: `${pages[0].toUpperCase()}${pages.slice(1)}.` };
  return null;
}

function nameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return "Student name is required";
  if (value.length > 120) return "Name: max 120 characters";
  return null;
}

/** Patch one row (only while it still holds the same file version, when given). */
function patchRows(rows: StagedRow[], key: string, patch: Partial<StagedRow>, version?: number): StagedRow[] {
  return rows.map((r) => (r.key === key && (version === undefined || r.version === version) ? { ...r, ...patch } : r));
}

function describeRows(
  rows: StagedRow[],
  maxBytes: number,
  rubricId: number | null = null,
  waiting: ReadonlySet<string> = NO_KEYS,
): RowView[] {
  const firstByHash = new Map<string, number>();
  return rows.map((row, index) => {
    let duplicateOf: number | null = null;
    if (row.hash) {
      const first = firstByHash.get(row.hash);
      if (first === undefined) firstByHash.set(row.hash, index);
      else duplicateOf = first;
    }
    const blocked = row.phase === "checking" ? null : clientBlock(row, maxBytes);
    const skippedAsDuplicate = duplicateOf !== null && !row.includeDuplicate;
    const compared = !!row.paper && rubricId !== null && row.paperRubric === rubricId;
    const held = waiting.has(row.key) && (row.phase === "ready" || row.phase === "rejected");
    return {
      row,
      index,
      duplicateOf,
      blocked,
      nameProblem: nameProblem(row.studentName),
      rollProblem: rollNoProblem(row.rollNo),
      uploadable: row.phase === "ready" && !blocked && !skippedAsDuplicate && !held,
      skippedAsDuplicate: row.phase === "ready" && skippedAsDuplicate,
      rubricMatch: compared ? shownMatch(row.paper?.rubric_match) : null,
      matchChecking:
        rubricComparable(row.paper) &&
        !row.paperChecking &&
        rubricId !== null &&
        row.paperRubric !== rubricId &&
        !settled(row),
      waiting: held,
    };
  });
}

/** "10 queued · 1 corrupt · 1 duplicate skipped" groups for the intake summary. */
export function summarize(views: RowView[], skipped: SkippedFile[]): { label: string; count: number; tone: "good" | "bad" | "muted" }[] {
  const groups = new Map<string, { count: number; tone: "good" | "bad" | "muted" }>();
  const bump = (label: string, tone: "good" | "bad" | "muted") => {
    const g = groups.get(label) ?? { count: 0, tone };
    g.count += 1;
    groups.set(label, g);
  };
  for (const v of views) {
    if (v.waiting) bump("waiting", "muted");
    else if (v.row.phase === "queued") bump("queued", "good");
    else if (v.row.phase === "rejected") bump(codeLabel(v.row.errorCode), "bad");
    else if (v.blocked) bump(codeLabel(v.blocked.code), "bad");
    else if (v.skippedAsDuplicate) bump("duplicate skipped", "muted");
    else if (v.row.phase === "uploading") bump("uploading", "muted");
    else if (v.row.phase === "ready") bump("ready", "muted");
  }
  if (skipped.length) {
    for (const s of skipped) bump(s.reason === "system file" ? "system file skipped" : "not an answer sheet", "muted");
  }
  return [...groups.entries()].map(([label, g]) => ({ label, ...g }));
}

/** Uploaded (or uploading): its paper check is the server's now. */
function settled(row: StagedRow): boolean {
  return row.phase === "queued" || row.phase === "uploading";
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Batch / folder intake: stage files (one row per answer sheet), inspect each in the browser
 * (magic bytes + SHA-256), then upload with a pool of 3 concurrent requests that share one
 * intake_batch_id. A rejected file never blocks the others. rubricId: the intake's answer-key
 * snapshot (null until the first upload created it) - printed papers are compared with it.
 */
export function useBatchIntake(maxBytes: number = MAX_UPLOAD_BYTES, voiceEnabled = true, rubricId: number | null = null) {
  const [rows, setRows] = useState<StagedRow[]>([]);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [intakeBatchId, setIntakeBatchId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** At most INSPECT_CONCURRENCY paper inspections in flight across the staging session. */
  const inspectLimit = useRef(createLimiter(INSPECT_CONCURRENCY));
  /** Re-comparisons in flight ("row key:file version:rubric id"), so each is asked for once. */
  const rechecks = useRef(new Set<string>());
  /** The snapshot now: a re-comparison for an earlier one is dropped. */
  const chosenRubric = useRef<number | null>(rubricId);
  // Mirrors kept in step with every change (not with the render): an upload that waited for the
  // key's server copy, or a queued re-check, runs later and must see the rows as they are then.
  const rowsRef = useRef<StagedRow[]>([]);
  const runningRef = useRef(false);
  const intakeIdRef = useRef<string | null>(null);
  /** Rows an upload click holds until its upload starts (one click per row). */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(NO_KEYS);
  const waitingRef = useRef<ReadonlySet<string>>(NO_KEYS);
  /** An Upload / Retry rejected click waits to start its run (a second one is not taken). */
  const [pendingRun, setPendingRun] = useState(false);
  const pendingRunRef = useRef(false);

  function changeRows(next: (prev: StagedRow[]) => StagedRow[]) {
    rowsRef.current = next(rowsRef.current);
    setRows(rowsRef.current);
  }

  function patchRow(key: string, patch: Partial<StagedRow>, version?: number) {
    changeRows((prev) => patchRows(prev, key, patch, version));
  }

  function putRunning(next: boolean) {
    runningRef.current = next;
    setRunning(next);
  }

  function putWaiting(next: ReadonlySet<string>) {
    waitingRef.current = next;
    setWaiting(next);
  }

  function putPendingRun(next: boolean) {
    pendingRunRef.current = next;
    setPendingRun(next);
  }

  /** This staging session's intake batch id (made by its first upload). */
  function ensureIntakeId(): string {
    if (!intakeIdRef.current) {
      intakeIdRef.current = randomId();
      setIntakeBatchId(intakeIdRef.current);
    }
    return intakeIdRef.current;
  }

  /** The rows as they are now (not as of the last render). */
  function viewsNow(): RowView[] {
    return describeRows(rowsRef.current, maxBytes, null, waitingRef.current);
  }

  /**
   * An upload click: its rows show "waiting" (their buttons disabled) until the upload starts - at
   * once, or after another upload saved the answer key on the server. Returns the rows held now: a
   * row another click already holds is not taken again, nor a run while one waits or runs.
   */
  function hold(scope: HoldScope): string[] {
    const run = typeof scope === "string";
    if (run && (pendingRunRef.current || runningRef.current)) return [];
    const keys = viewsNow()
      .filter((v) =>
        scope === "uploadable"
          ? v.uploadable
          : !v.waiting &&
            v.row.phase === "rejected" &&
            !v.blocked &&
            (scope === "rejected" || v.row.key === scope.key),
      )
      .map((v) => v.row.key);
    if (keys.length === 0) return [];
    putWaiting(new Set([...waitingRef.current, ...keys]));
    if (run) putPendingRun(true);
    return keys;
  }

  /** The held rows' upload starts (or gave up): they are ordinary rows again. run: an Upload / Retry rejected hold. */
  function release(keys: string[], run: boolean) {
    if (run && pendingRunRef.current) putPendingRun(false);
    if (!keys.some((k) => waitingRef.current.has(k))) return;
    const next = new Set(waitingRef.current);
    for (const k of keys) next.delete(k);
    putWaiting(next);
  }

  // A new answer-key snapshot: compare every inspected printed paper with it (through the same
  // 3-at-a-time limiter). Rows still on their first inspection are left to it; uploaded rows too.
  useEffect(() => {
    chosenRubric.current = rubricId;
    // During a run the rows are being uploaded (the server checks them): none is re-sent here.
    if (rubricId === null || running) return;
    // Rows that cannot be compared (no text layer, not a printed paper) are never re-sent: the
    // server would return no comparison for them (describeRows shows no check for them either).
    const timer = setTimeout(() => {
      if (chosenRubric.current !== rubricId) return;
      for (const row of rowsRef.current) {
        if (!row.paper || row.paperChecking || row.paperRubric === rubricId || !rubricComparable(row.paper)) continue;
        if (settled(row)) continue;
        const id = `${row.key}:${row.version}:${rubricId}`;
        if (rechecks.current.has(id)) continue;
        rechecks.current.add(id);
        const { key, version, file, paper } = row;
        void inspectLimit.current(async () => {
          // Queued behind other inspections: skip it when the choice changed or the row went away.
          const live = rowsRef.current.some((r) => r.key === key && r.version === version);
          if (chosenRubric.current !== rubricId || !live) {
            rechecks.current.delete(id);
            return;
          }
          const next = await fetchInspection(file, rubricId);
          rechecks.current.delete(id);
          if (chosenRubric.current !== rubricId) return;
          changeRows((prev) =>
            patchRows(prev, key, { paper: next ?? { ...paper, rubric_match: null }, paperRubric: rubricId }, version),
          );
        });
      }
    }, RECHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rows, rubricId, running]);

  async function inspect(key: string, version: number, file: File) {
    let signature: SignatureCheck | null = null;
    let hash: string | null = null;
    try {
      signature = checkSignature(file.name, await readHead(file), voiceEnabled);
    } catch {
      signature = { kind: null, detected: "unreadable", error: "the browser could not read this file", warning: null };
    }
    if (!signature.error && file.size > 0 && file.size <= maxBytes) {
      try {
        hash = await sha256Hex(file);
      } catch {
        hash = null;
      }
    }
    const paperCandidate = !signature.error && isPaperCandidate(signature.kind) && file.size > 0 && file.size <= maxBytes;
    patchRow(key, { signature, hash, phase: "ready", paper: null, paperChecking: paperCandidate }, version);
    if (paperCandidate) {
      const against = rubricId;
      void inspectLimit.current(async () => {
        const paper = await fetchInspection(file, against);
        patchRow(key, { paper, paperChecking: false, paperRubric: against }, version);
      });
    }
  }

  /** Stage picked files; non-answer-sheets are listed as skipped with a reason. */
  async function addFiles(picked: PickedFile[]) {
    setMessage(null);
    const newRows: StagedRow[] = [];
    const newSkipped: SkippedFile[] = [];
    let room = MAX_STAGED - rowsRef.current.length;
    for (const { file, path } of picked) {
      const reason = skipReason(file.name, hasAcceptedType(file));
      if (reason) {
        newSkipped.push({ path, reason });
        continue;
      }
      if (room <= 0) {
        newSkipped.push({ path, reason: `over the ${MAX_STAGED}-file staging limit` });
        continue;
      }
      room -= 1;
      newRows.push({
        key: randomId(),
        version: 0,
        file,
        path,
        studentName: deriveStudentName(file.name, path),
        rollNo: "",
        signature: null,
        hash: null,
        phase: "checking",
        percent: 0,
        submission: null,
        errorCode: null,
        errorDetail: null,
        includeDuplicate: false,
        voiceQuestion: null,
        paper: null,
        paperChecking: false,
        paperRubric: null,
      });
    }
    changeRows((prev) => [...prev, ...newRows]);
    setSkipped((prev) => [...prev, ...newSkipped]);
    if (picked.length > 0 && newRows.length === 0) {
      setMessage("None of those files is an answer sheet (PDF, JPG, PNG, WEBP or DOCX) or a voice answer (MP3, WAV, M4A, OGG).");
    }
    // Inspect one file at a time: hashing reads the whole file into memory.
    for (const row of newRows) {
      await inspect(row.key, row.version, row.file);
    }
  }

  function updateRow(
    key: string,
    patch: Pick<Partial<StagedRow>, "studentName" | "rollNo" | "includeDuplicate" | "voiceQuestion">,
  ) {
    patchRow(key, patch);
  }

  function removeRow(key: string) {
    changeRows((prev) => prev.filter((r) => r.key !== key || r.phase === "uploading" || waitingRef.current.has(r.key)));
  }

  async function replaceFile(key: string, file: File) {
    setMessage(null);
    const current = rowsRef.current.find((r) => r.key === key);
    if (!current || current.phase === "uploading" || current.phase === "queued" || waitingRef.current.has(key)) return;
    if (!hasAcceptedType(file)) {
      setMessage(`"${file.name}" is not an answer sheet (PDF, JPG, PNG, WEBP or DOCX) or a voice answer (MP3, WAV, M4A, OGG).`);
      return;
    }
    const version = current.version + 1;
    patchRow(key, {
      version,
      file,
      path: file.name,
      signature: null,
      hash: null,
      phase: "checking",
      percent: 0,
      submission: null,
      errorCode: null,
      errorDetail: null,
      paper: null,
      paperChecking: false,
      paperRubric: null,
    });
    await inspect(key, version, file);
  }

  /** The snapshot id while the server has the key (inline: false), else the key inline. */
  function rubricFor(ctx: UploadContext, inline = false): RowRubric {
    return ctx.rubricId !== undefined && !inline
      ? { id: ctx.rubricId, hash: ctx.rubricHash }
      : { json: ctx.rubricJson, sourceFile: ctx.rubricSourceFile, keyFile: ctx.rubricKeyFile, sourceRole: ctx.rubricSourceRole };
  }

  async function uploadRow(
    row: StagedRow,
    ctx: UploadContext,
    intakeId: string,
    rubric: RowRubric,
  ): Promise<{ submission: Submission | null; code: string | null; detail: string | null }> {
    patchRow(row.key, { phase: "uploading", percent: 0, errorCode: null, errorDetail: null });
    try {
      const submission = await uploadSubmission({
        file: row.file,
        studentName: row.studentName.trim(),
        rollNo: row.rollNo.trim() || undefined,
        rubricId: rubric.json ? undefined : rubric.id,
        rubricHash: rubric.json ? undefined : rubric.hash,
        rubricJson: rubric.json,
        rubricSourceFile: rubric.json ? rubric.sourceFile : undefined,
        rubricKeyFile: rubric.json ? rubric.keyFile : undefined,
        rubricSourceRole: rubric.json ? rubric.sourceRole : undefined,
        languageHints: ctx.languages,
        batchId: ctx.batchId ?? undefined,
        intakeBatchId: intakeId,
        voiceQuestion: isVoiceRow(row) ? voiceQuestionFor(row.voiceQuestion, ctx.questionNumbers) : undefined,
        onProgress: (percent) => patchRow(row.key, { percent }),
      });
      patchRow(row.key, { phase: "queued", percent: 100, submission });
      ctx.onUploaded(submission);
      return { submission, code: null, detail: null };
    } catch (err) {
      const code = errorCode(err) ?? fallbackCode(errorStatus(err));
      const detail = errorMessage(err);
      if (code === "unknown_rubric") ctx.onRubricLost?.();
      patchRow(row.key, { phase: "rejected", errorCode: code, errorDetail: detail });
      return { submission: null, code, detail };
    }
  }

  /** Why the ready rows cannot be uploaded (null when they can). */
  function problem(views: RowView[]): string | null {
    const todo = views.filter((v) => v.uploadable);
    if (todo.length === 0) return "Nothing to upload: add answer sheets, or fix / replace the rejected ones.";
    const invalid = todo.filter((v) => v.nameProblem || v.rollProblem);
    if (invalid.length > 0) {
      return `${invalid.length} ${invalid.length === 1 ? "sheet needs" : "sheets need"} a student name or a valid roll no (rows ${invalid
        .map((v) => v.index + 1)
        .join(", ")}).`;
    }
    return null;
  }

  /** Client checks before a run (also before queueing it while the answer key is drafted). */
  function check(): boolean {
    const found = problem(viewsNow());
    setMessage(found);
    return found === null;
  }

  /**
   * Upload every ready row (3 at a time) - with retry, the rejected rows instead (as if ready); with
   * only, just those of them. Rows another click holds are left to it. The rows are read as they are
   * now, so a run that waited for the key's server copy never sends a row twice. Returns false when
   * validation blocked the run.
   */
  async function start(ctx: UploadContext, retry = false, only?: string[]): Promise<boolean> {
    if (runningRef.current) return false;
    const staged = rowsRef.current;
    const again = retry
      ? new Set(staged.filter((r) => r.phase === "rejected" && (!only || only.includes(r.key))).map((r) => r.key))
      : null;
    const views = describeRows(
      again ? staged.map((r) => (again.has(r.key) ? { ...r, phase: "ready" as const } : r)) : staged,
      maxBytes,
      null,
      waitingRef.current,
    ).filter((v) => !again || again.has(v.row.key));
    const found = problem(views);
    setMessage(found);
    if (found) return false;
    const todo = views.filter((v) => v.uploadable);
    if (!ctx.rubricId && !ctx.rubricJson) {
      setMessage(NO_KEY_MESSAGE);
      return false;
    }

    const runId = ensureIntakeId();
    ctx.onIntakeStarted?.(runId);
    putRunning(true);
    try {
      const queue = todo.map((v) => v.row);
      let rubric = rubricFor(ctx);
      // A refusal of the key itself: the rest would be refused too - they stay ready.
      let refused = null as { code: string; detail: string | null } | null;
      /** unknown_rubric already answered by sending the key inline once more. */
      let relinked = false;
      while (queue.length > 0 && !refused) {
        if (rubric.json) {
          // The inline key would create one snapshot per upload: send it with one file at a time
          // until the server keeps it, then reuse that snapshot's id for the rest of the batch.
          const { submission, code, detail } = await uploadRow(queue.shift()!, ctx, runId, rubric);
          if (submission) {
            ctx.onRubricCreated?.(submission.rubric_id, submission.rubric_hash);
            rubric = { id: submission.rubric_id, hash: submission.rubric_hash ?? undefined };
          } else if (code && KEY_REFUSALS.has(code)) refused = { code, detail };
          continue;
        }
        const lost: StagedRow[] = [];
        await runPool(queue.splice(0), UPLOAD_CONCURRENCY, async (row) => {
          if (refused || lost.length) {
            queue.push(row);
            return;
          }
          const { code, detail } = await uploadRow(row, ctx, runId, rubric);
          if (code === "unknown_rubric" && !relinked && ctx.rubricJson) lost.push(row);
          else if (code && KEY_REFUSALS.has(code)) refused = { code, detail };
        });
        if (lost.length) {
          // The server no longer knows the snapshot (data reset): the key goes inline once more.
          relinked = true;
          rubric = rubricFor(ctx, true);
          queue.unshift(...lost);
        }
      }
      if (refused) {
        const left = queue.length ? ` - ${queue.length} ${queue.length === 1 ? "sheet was" : "sheets were"} not sent` : "";
        setMessage(`The server refused the answer key (${codeLabel(refused.code)}), so the run stopped${left}: ${refused.detail ?? ""}`);
      }
    } finally {
      putRunning(false);
    }
    return true;
  }

  /** Re-upload one rejected (or replaced) row with the same intake id - as the row is now. */
  async function retryRow(key: string, ctx: UploadContext) {
    const view = viewsNow().find((v) => v.row.key === key);
    if (
      !view ||
      view.waiting ||
      view.row.phase === "uploading" ||
      view.row.phase === "queued" ||
      view.row.phase === "checking"
    ) {
      return;
    }
    if (view.blocked) {
      setMessage(`Row ${view.index + 1}: ${view.blocked.message} Replace the file first.`);
      return;
    }
    if (view.nameProblem || view.rollProblem) {
      setMessage(`Row ${view.index + 1}: ${view.nameProblem ?? view.rollProblem}.`);
      return;
    }
    if (!ctx.rubricId && !ctx.rubricJson) {
      setMessage(NO_KEY_MESSAGE);
      return;
    }
    setMessage(null);
    const runId = ensureIntakeId();
    ctx.onIntakeStarted?.(runId);
    const rubric = rubricFor(ctx);
    const { submission } = await uploadRow(view.row, ctx, runId, rubric);
    if (submission && rubric.json) ctx.onRubricCreated?.(submission.rubric_id, submission.rubric_hash);
  }

  function clear() {
    if (runningRef.current || pendingRunRef.current || waitingRef.current.size > 0) return;
    changeRows(() => []);
    setSkipped([]);
    intakeIdRef.current = null;
    setIntakeBatchId(null);
    setMessage(null);
  }

  const views = describeRows(rows, maxBytes, rubricId, waiting);
  return {
    rows,
    views,
    skipped,
    intakeBatchId,
    running,
    /** An Upload / Retry rejected click waits to start its run (another one is not taken meanwhile). */
    pendingRun,
    /** Rows whose upload was clicked and has not started yet. */
    waitingCount: views.filter((v) => v.waiting).length,
    message,
    addFiles,
    updateRow,
    removeRow,
    replaceFile,
    check,
    start,
    retryRow,
    hold,
    release,
    clear,
  };
}

export type BatchIntake = ReturnType<typeof useBatchIntake>;
