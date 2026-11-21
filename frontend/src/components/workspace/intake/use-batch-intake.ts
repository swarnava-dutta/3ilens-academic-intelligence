"use client";

import { useState } from "react";
import { errorCode, errorMessage, errorStatus, uploadSubmission } from "@/lib/api";
import type { LanguageHint, Submission } from "@/lib/types";
import { hasAcceptedType, MAX_UPLOAD_BYTES } from "../format";
import { codeLabel, fallbackCode } from "./codes";
import type { PickedFile } from "./collect";
import {
  checkSignature,
  deriveStudentName,
  randomId,
  readHead,
  rollNoProblem,
  sha256Hex,
  skipReason,
  type SignatureCheck,
} from "./inspect";

/** Concurrent uploadSubmission calls in a batch run. */
export const UPLOAD_CONCURRENCY = 3;
/** Above this many files the UI notes that production uses the queue API. */
export const QUEUE_API_NOTE_THRESHOLD = 100;
/** Most rows one staging session holds (the browser hashes every file). */
export const MAX_STAGED = 300;

export type RowPhase = "checking" | "ready" | "uploading" | "queued" | "rejected";

export interface StagedRow {
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
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface UploadContext {
  rubricId?: number;
  rubricJson?: string;
  languages: LanguageHint[];
  batchId: number | null;
  onUploaded: (submission: Submission) => void;
  onIntakeStarted?: (intakeBatchId: string) => void;
}

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
}

function clientBlock(row: StagedRow, maxBytes: number): { code: string; message: string } | null {
  if (row.file.size === 0) return { code: "empty_file", message: "The file is empty." };
  if (row.file.size > maxBytes) {
    return { code: "too_large", message: `Larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.` };
  }
  if (row.signature?.error) return { code: "unsupported_signature", message: row.signature.error };
  return null;
}

function nameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return "Student name is required";
  if (value.length > 120) return "Name: max 120 characters";
  return null;
}

export function describeRows(rows: StagedRow[], maxBytes: number): RowView[] {
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
    return {
      row,
      index,
      duplicateOf,
      blocked,
      nameProblem: nameProblem(row.studentName),
      rollProblem: rollNoProblem(row.rollNo),
      uploadable: row.phase === "ready" && !blocked && !skippedAsDuplicate,
      skippedAsDuplicate: row.phase === "ready" && skippedAsDuplicate,
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
    if (v.row.phase === "queued") bump("queued", "good");
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
 * intake_batch_id. A rejected file never blocks the others.
 */
export function useBatchIntake(maxBytes: number = MAX_UPLOAD_BYTES) {
  const [rows, setRows] = useState<StagedRow[]>([]);
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [intakeBatchId, setIntakeBatchId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Rubric the server created from an inline JSON rubric in this session (reused by later uploads). */
  const [jsonRubric, setJsonRubric] = useState<{ text: string; id: number } | null>(null);

  function patchRow(key: string, patch: Partial<StagedRow>, version?: number) {
    setRows((prev) =>
      prev.map((r) => (r.key === key && (version === undefined || r.version === version) ? { ...r, ...patch } : r)),
    );
  }

  async function inspect(key: string, version: number, file: File) {
    let signature: SignatureCheck | null = null;
    let hash: string | null = null;
    try {
      signature = checkSignature(file.name, await readHead(file));
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
    patchRow(key, { signature, hash, phase: "ready" }, version);
  }

  /** Stage picked files; non-answer-sheets are listed as skipped with a reason. */
  async function addFiles(picked: PickedFile[]) {
    setMessage(null);
    const newRows: StagedRow[] = [];
    const newSkipped: SkippedFile[] = [];
    let room = MAX_STAGED - rows.length;
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
      });
    }
    setRows((prev) => [...prev, ...newRows]);
    setSkipped((prev) => [...prev, ...newSkipped]);
    if (picked.length > 0 && newRows.length === 0) {
      setMessage("None of those files is an answer sheet (PDF, JPG, PNG, WEBP or DOCX).");
    }
    // Inspect one file at a time: hashing reads the whole file into memory.
    for (const row of newRows) {
      await inspect(row.key, row.version, row.file);
    }
  }

  function updateRow(key: string, patch: Pick<Partial<StagedRow>, "studentName" | "rollNo" | "includeDuplicate">) {
    patchRow(key, patch);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key || r.phase === "uploading"));
  }

  async function replaceFile(key: string, file: File) {
    setMessage(null);
    const current = rows.find((r) => r.key === key);
    if (!current || current.phase === "uploading" || current.phase === "queued") return;
    if (!hasAcceptedType(file)) {
      setMessage(`"${file.name}" is not an answer sheet (PDF, JPG, PNG, WEBP or DOCX).`);
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
    });
    await inspect(key, version, file);
  }

  function rubricFor(ctx: UploadContext): { id?: number; json?: string } {
    if (ctx.rubricJson && jsonRubric?.text === ctx.rubricJson) return { id: jsonRubric.id };
    return { id: ctx.rubricId, json: ctx.rubricJson };
  }

  async function uploadRow(row: StagedRow, ctx: UploadContext, intakeId: string, rubric: { id?: number; json?: string }) {
    patchRow(row.key, { phase: "uploading", percent: 0, errorCode: null, errorDetail: null });
    try {
      const submission = await uploadSubmission({
        file: row.file,
        studentName: row.studentName.trim(),
        rollNo: row.rollNo.trim() || undefined,
        rubricId: rubric.json ? undefined : rubric.id,
        rubricJson: rubric.json,
        languageHints: ctx.languages,
        batchId: ctx.batchId ?? undefined,
        intakeBatchId: intakeId,
        onProgress: (percent) => patchRow(row.key, { percent }),
      });
      patchRow(row.key, { phase: "queued", percent: 100, submission });
      ctx.onUploaded(submission);
      return submission;
    } catch (err) {
      patchRow(row.key, {
        phase: "rejected",
        errorCode: errorCode(err) ?? fallbackCode(errorStatus(err)),
        errorDetail: errorMessage(err),
      });
      return null;
    }
  }

  /** Upload every ready row (3 at a time). Returns false when validation blocked the run. */
  async function start(ctx: UploadContext): Promise<boolean> {
    if (running) return false;
    setMessage(null);
    const views = describeRows(rows, maxBytes);
    const todo = views.filter((v) => v.uploadable);
    if (todo.length === 0) {
      setMessage("Nothing to upload: add answer sheets, or fix / replace the rejected ones.");
      return false;
    }
    const invalid = todo.filter((v) => v.nameProblem || v.rollProblem);
    if (invalid.length > 0) {
      setMessage(
        `${invalid.length} ${invalid.length === 1 ? "sheet needs" : "sheets need"} a student name or a valid roll no (rows ${invalid
          .map((v) => v.index + 1)
          .join(", ")}).`,
      );
      return false;
    }
    if (!ctx.rubricId && !ctx.rubricJson) {
      setMessage("Choose a rubric first.");
      return false;
    }

    const intakeId = intakeBatchId ?? randomId();
    if (!intakeBatchId) setIntakeBatchId(intakeId);
    ctx.onIntakeStarted?.(intakeId);
    setRunning(true);
    try {
      const queue = todo.map((v) => v.row);
      let rubric = rubricFor(ctx);
      // An inline JSON rubric would create one custom rubric per upload: send it with the first
      // file only, then reuse the rubric id the server created for the rest of the batch.
      while (rubric.json && queue.length > 0) {
        const first = queue.shift()!;
        const created = await uploadRow(first, ctx, intakeId, rubric);
        if (created) {
          setJsonRubric({ text: rubric.json, id: created.rubric_id });
          rubric = { id: created.rubric_id };
        }
      }
      await runPool(queue, UPLOAD_CONCURRENCY, async (row) => {
        await uploadRow(row, ctx, intakeId, rubric);
      });
    } finally {
      setRunning(false);
    }
    return true;
  }

  /** Re-upload one rejected (or replaced) row with the same intake id. */
  async function retryRow(key: string, ctx: UploadContext) {
    const view = describeRows(rows, maxBytes).find((v) => v.row.key === key);
    if (!view || view.row.phase === "uploading" || view.row.phase === "queued" || view.row.phase === "checking") return;
    if (view.blocked) {
      setMessage(`Row ${view.index + 1}: ${view.blocked.message} Replace the file first.`);
      return;
    }
    if (view.nameProblem || view.rollProblem) {
      setMessage(`Row ${view.index + 1}: ${view.nameProblem ?? view.rollProblem}.`);
      return;
    }
    if (!ctx.rubricId && !ctx.rubricJson) {
      setMessage("Choose a rubric first.");
      return;
    }
    setMessage(null);
    const intakeId = intakeBatchId ?? randomId();
    if (!intakeBatchId) setIntakeBatchId(intakeId);
    ctx.onIntakeStarted?.(intakeId);
    const rubric = rubricFor(ctx);
    const created = await uploadRow(view.row, ctx, intakeId, rubric);
    if (created && rubric.json) setJsonRubric({ text: rubric.json, id: created.rubric_id });
  }

  function clear() {
    if (running) return;
    setRows([]);
    setSkipped([]);
    setIntakeBatchId(null);
    setMessage(null);
    setJsonRubric(null);
  }

  const views = describeRows(rows, maxBytes);
  return {
    rows,
    views,
    skipped,
    intakeBatchId,
    running,
    message,
    addFiles,
    updateRow,
    removeRow,
    replaceFile,
    start,
    retryRow,
    clear,
  };
}

export type BatchIntake = ReturnType<typeof useBatchIntake>;
