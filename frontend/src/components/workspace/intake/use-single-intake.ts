"use client";

import { useEffect, useRef, useState } from "react";
import { errorCode, errorMessage, errorStatus, uploadSubmission } from "@/lib/api";
import type { LanguageHint, PaperInspection, Submission } from "@/lib/types";
import { isAudio, MAX_UPLOAD_BYTES, validateAnswerSheet } from "../format";
import { codeLabel, fallbackCode } from "./codes";
import { checkSignature, deriveStudentName, isVoiceKind, readHead, rollNoProblem, sha256Hex, type SignatureCheck } from "./inspect";
import { fetchInspection, isPaperCandidate, pageLimitProblem, RECHECK_DELAY_MS, rubricComparable } from "./paper";
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
 * rubricId: the saved rubric chosen for the upload - a printed paper is compared with it, again
 * whenever the choice changes.
 */
export function useSingleIntake(
  onUploaded: (submission: Submission) => void,
  maxBytes: number = MAX_UPLOAD_BYTES,
  voiceEnabled = true,
  rubricId: number | null = null,
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
  /** Saved rubric the inspection compared the paper with (null = none). */
  const [inspectedRubric, setInspectedRubric] = useState<number | null>(null);
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

  // A different saved rubric chosen while a printed paper is attached: compare it again. A reply
  // for an earlier file or an earlier choice is dropped.
  useEffect(() => {
    if (!file || !inspection || rubricId === null || inspectedRubric === rubricId) return;
    // Only printed papers with a text layer can be compared: nothing to ask the server for others
    // (matchChecking stays false for them).
    if (!rubricComparable(inspection)) return;
    const version = pickVersion.current;
    let cancelled = false;
    // Short delay so flicking through rubrics sends one request for the final choice.
    const timer = setTimeout(() => {
      void fetchInspection(file, rubricId).then((result) => {
        if (cancelled || version !== pickVersion.current) return;
        setInspection(result ?? { ...inspection, rubric_match: null });
        setInspectedRubric(rubricId);
      });
    }, RECHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [file, inspection, inspectedRubric, rubricId]);

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
    if (isPaperCandidate(check.kind)) void inspectDocument(next, version, rubricId);
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
  async function inspectDocument(target: File, version: number, against: number | null) {
    setInspecting(true);
    const result = await fetchInspection(target, against);
    if (version !== pickVersion.current) return;
    setInspection(result);
    setInspectedRubric(against);
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
  /** The comparison with the chosen rubric (null while it is re-checked or no saved rubric is chosen). */
  const current = !!inspection && rubricId !== null && inspectedRubric === rubricId;
  const rubricMatch = current ? (inspection?.rubric_match ?? null) : null;
  const matchChecking =
    !!file && rubricComparable(inspection) && rubricId !== null && inspectedRubric !== rubricId;

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
    rubricMatch,
    matchChecking,
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
