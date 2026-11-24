"use client";

import { useEffect, useRef, useState } from "react";
import { errorCode, errorMessage, errorStatus, uploadSubmission } from "@/lib/api";
import type { LanguageHint, PaperInspection, Submission } from "@/lib/types";
import { isAudio, MAX_UPLOAD_BYTES, validateAnswerSheet } from "../format";
import { codeLabel, fallbackCode } from "./codes";
import { checkSignature, deriveStudentName, isVoiceKind, readHead, rollNoProblem, sha256Hex, type SignatureCheck } from "./inspect";
import { fetchInspection, isPaperCandidate, pageLimitProblem } from "./paper";
import { voiceQuestionFor } from "./voice-fields";

export type SingleNotice = { kind: "success" | "error"; message: string; submission?: Submission };

export interface SingleUploadSettings {
  rubricId?: number;
  rubricJson?: string;
  languages: LanguageHint[];
  batchId: number | null;
  /** Question numbers of the chosen rubric (a voice_question outside them is not sent). */
  questionNumbers?: number[];
}

/**
 * One answer sheet, one student: pick or drop a file, check its signature and SHA-256 in the
 * browser, then POST /api/upload with progress. The server repeats every check on the bytes.
 */
export function useSingleIntake(
  onUploaded: (submission: Submission) => void,
  maxBytes: number = MAX_UPLOAD_BYTES,
  voiceEnabled = true,
) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [signature, setSignature] = useState<SignatureCheck | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [fileMessage, setFileMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  /** What the server reads from the document's text layer (printed paper / answer key); advisory. */
  const [inspection, setInspection] = useState<PaperInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  /** Faculty chose to upload an answer-key paper as a student sheet anyway. */
  const [paperNoticeDismissed, setPaperNoticeDismissed] = useState(false);

  const [studentName, setStudentNameState] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [rollNo, setRollNo] = useState("");
  /** Voice answers: the rubric question a per-question recording answers (null = whole recording). */
  const [voiceQuestion, setVoiceQuestion] = useState<number | null>(null);

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
    const problem = validateAnswerSheet(next, maxBytes, voiceEnabled);
    if (problem) {
      setFileMessage({ tone: "error", text: problem });
      return;
    }
    const version = ++pickVersion.current;
    setFile(next);
    setSignature(null);
    setHash(null);
    setInspection(null);
    setInspecting(false);
    setPaperNoticeDismissed(false);
    setChecking(true);
    setFileMessage(extraNote ? { tone: "info", text: extraNote } : null);
    setPreviewUrl(next.type.startsWith("image/") || isAudio(next) ? URL.createObjectURL(next) : null);
    if (!nameTouched || !studentName.trim()) {
      setStudentNameState(deriveStudentName(next.name));
      setNameTouched(false);
    }

    let check: SignatureCheck;
    try {
      check = checkSignature(next.name, await readHead(next), voiceEnabled);
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
    if (isPaperCandidate(check.kind)) void inspectDocument(next, version);
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

  /** One inspection in flight per pick; a result for an earlier file is dropped. */
  async function inspectDocument(target: File, version: number) {
    setInspecting(true);
    const result = await fetchInspection(target);
    if (version !== pickVersion.current) return;
    setInspection(result);
    setInspecting(false);
  }

  function clearFile() {
    pickVersion.current += 1;
    setFile(null);
    setPreviewUrl(null);
    setSignature(null);
    setHash(null);
    setInspection(null);
    setInspecting(false);
    setPaperNoticeDismissed(false);
    setChecking(false);
    setFileMessage(null);
    setVoiceQuestion(null);
  }

  /** The attached file is a voice answer (by its bytes once checked, else by its name/type). */
  const isVoice = file !== null && (signature?.kind ? isVoiceKind(signature.kind) : isAudio(file));
  /** Over the server's page limit (from the inspection): blocks the upload like other client checks. */
  const pageProblem = file ? pageLimitProblem(inspection) : null;

  async function submit(settings: SingleUploadSettings) {
    if (uploading) return;
    const name = studentName.trim();
    let invalid = false;
    if (!file) {
      setFileMessage({ tone: "error", text: "Choose an answer sheet (PDF, image or Word) or a voice answer to upload." });
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
    if (pageProblem) {
      setFileMessage({ tone: "error", text: `"${file?.name ?? "This file"}" has ${pageProblem}.` });
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
        voiceQuestion: isVoice ? voiceQuestionFor(voiceQuestion, settings.questionNumbers) : undefined,
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
    isVoice,
    voiceQuestion,
    setVoiceQuestion,
    previewUrl,
    signature,
    hash,
    checking,
    inspection,
    inspecting,
    pageProblem,
    paperNoticeDismissed,
    dismissPaperNotice: () => setPaperNoticeDismissed(true),
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
