"use client";

import { useEffect, useRef, useState } from "react";
import { errorCode, errorMessage, errorStatus, uploadSubmission } from "@/lib/api";
import type { LanguageHint, Submission } from "@/lib/types";
import { MAX_UPLOAD_BYTES, validateAnswerSheet } from "../format";
import { codeLabel, fallbackCode } from "./codes";
import { checkSignature, deriveStudentName, readHead, rollNoProblem, sha256Hex, type SignatureCheck } from "./inspect";

export type SingleNotice = { kind: "success" | "error"; message: string; submission?: Submission };

export interface SingleUploadSettings {
  rubricId?: number;
  rubricJson?: string;
  languages: LanguageHint[];
  batchId: number | null;
}

/**
 * One answer sheet, one student: pick or drop a file, check its signature and SHA-256 in the
 * browser, then POST /api/upload with progress. The server repeats every check on the bytes.
 */
export function useSingleIntake(onUploaded: (submission: Submission) => void, maxBytes: number = MAX_UPLOAD_BYTES) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [signature, setSignature] = useState<SignatureCheck | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [fileMessage, setFileMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const [studentName, setStudentNameState] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [rollNo, setRollNo] = useState("");

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<SingleNotice | null>(null);
  /** Bumped per pick so a slow inspection of an earlier file is ignored. */
  const pickVersion = useRef(0);

  // Revoke image preview URLs when replaced or on unmount.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function setStudentName(value: string) {
    setStudentNameState(value);
    setNameTouched(true);
    if (nameError && value.trim()) setNameError(null);
  }

  async function chooseFile(next: File | null, extraNote?: string) {
    setNotice(null);
    if (!next) return;
    const problem = validateAnswerSheet(next, maxBytes);
    if (problem) {
      setFileMessage({ tone: "error", text: problem });
      return;
    }
    const version = ++pickVersion.current;
    setFile(next);
    setSignature(null);
    setHash(null);
    setChecking(true);
    setFileMessage(extraNote ? { tone: "info", text: extraNote } : null);
    setPreviewUrl(next.type.startsWith("image/") ? URL.createObjectURL(next) : null);
    if (!nameTouched || !studentName.trim()) {
      setStudentNameState(deriveStudentName(next.name));
      setNameTouched(false);
    }

    let check: SignatureCheck;
    try {
      check = checkSignature(next.name, await readHead(next));
    } catch {
      check = { kind: null, detected: "unreadable", error: "the browser could not read this file", warning: null };
    }
    if (version !== pickVersion.current) return;
    setSignature(check);
    if (check.error) {
      setChecking(false);
      setFileMessage({ tone: "error", text: `"${next.name}" was not attached: ${check.error}.` });
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    let digest: string | null = null;
    try {
      digest = await sha256Hex(next);
    } catch {
      digest = null;
    }
    if (version !== pickVersion.current) return;
    setHash(digest);
    setChecking(false);
  }

  function clearFile() {
    pickVersion.current += 1;
    setFile(null);
    setPreviewUrl(null);
    setSignature(null);
    setHash(null);
    setChecking(false);
    setFileMessage(null);
  }

  async function submit(settings: SingleUploadSettings) {
    if (uploading) return;
    const name = studentName.trim();
    let invalid = false;
    if (!file) {
      setFileMessage({ tone: "error", text: "Choose an answer sheet (PDF, image or Word) to upload." });
      invalid = true;
    }
    if (!name) {
      setNameError("Student name is required.");
      invalid = true;
    }
    const rollProblem = rollNoProblem(rollNo);
    if (rollProblem) {
      setNotice({ kind: "error", message: rollProblem });
      invalid = true;
    }
    if (invalid || !file || checking) return;

    setUploading(true);
    setProgress(0);
    setNotice(null);
    try {
      const submission = await uploadSubmission({
        file,
        studentName: name,
        rollNo: rollNo.trim() || undefined,
        rubricId: settings.rubricJson ? undefined : settings.rubricId,
        rubricJson: settings.rubricJson,
        languageHints: settings.languages,
        batchId: settings.batchId ?? undefined,
        onProgress: setProgress,
      });
      setNotice({
        kind: "success",
        message: `Queued ${submission.student_name || name} (#${submission.id}) - processing started`,
        submission,
      });
      clearFile();
      setStudentNameState("");
      setNameTouched(false);
      setRollNo("");
      setNameError(null);
      onUploaded(submission);
    } catch (err) {
      const code = errorCode(err) ?? fallbackCode(errorStatus(err));
      setNotice({ kind: "error", message: `Rejected (${codeLabel(code)}): ${errorMessage(err)}` });
    } finally {
      setUploading(false);
    }
  }

  return {
    file,
    previewUrl,
    signature,
    hash,
    checking,
    fileMessage,
    studentName,
    setStudentName,
    nameError,
    rollNo,
    setRollNo,
    uploading,
    progress,
    notice,
    chooseFile,
    clearFile,
    submit,
  };
}

export type SingleIntake = ReturnType<typeof useSingleIntake>;
