"use client";

import { useEffect, useRef, useState } from "react";
import { errorCode, errorMessage, errorStatus, uploadSubmission } from "@/lib/api";
import type { LanguageHint, PaperInspection, RubricSourceRole, Submission } from "@/lib/types";
import { isAudio, MAX_UPLOAD_BYTES, validateAnswerSheet } from "../format";
import { codeLabel, fallbackCode } from "./codes";
import { checkSignature, deriveStudentName, isVoiceKind, readHead, rollNoProblem, sha256Hex, type SignatureCheck } from "./inspect";
import { fetchInspection, isPaperCandidate, pageLimitProblem, RECHECK_DELAY_MS, rubricComparable } from "./paper";
import { voiceQuestionFor } from "./voice-fields";

type SingleNotice = { kind: "success" | "error"; message: string; submission?: Submission };

interface SingleUploadSettings {
  /** The intake's answer-key snapshot (created by an earlier upload of this key), with its hash... */
  rubricId?: number;
  rubricHash?: string;
  /** ...or (without rubricId) the key itself, inline (the server stores it as the snapshot). */
  rubricJson?: string;
  /** With the inline key only: the files the key was drafted from (kept for the report's preview). */
  rubricSourceFile?: File;
  rubricKeyFile?: File;
  /** With rubricSourceFile: what that file is (question paper, rubric file, marked copy). */
  rubricSourceRole?: RubricSourceRole;
  languages: LanguageHint[];
  batchId: number | null;
  /** Question numbers of the answer key (a voice_question outside them is not sent). */
  questionNumbers?: number[];
  /** The upload created the snapshot from rubricJson. */
  onRubricCreated?: (rubricId: number, rubricHash?: string | null) => void;
  /** 422 unknown_rubric: the snapshot is gone (data reset) - the next upload sends the key inline. */
  onRubricLost?: () => void;
}

/**
 * One answer sheet, one student: pick or drop a file, check its signature and SHA-256 in the
 * browser, then POST /api/upload with progress. The server repeats every check on the bytes.
 * rubricId: this intake's answer-key snapshot (null until the first upload created it) - a printed
 * paper is compared with it, again whenever it changes.
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
  /** Answer-key snapshot the inspection compared the paper with (null = none). */
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
  const uploadingRef = useRef(false);
  /**
   * Upload was clicked and waits to start (another upload is saving the answer key on the server):
   * the sheet shows it and its controls are disabled. One click at a time.
   */
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<SingleNotice | null>(null);
  /** Bumped per pick so a slow inspection of an earlier file is ignored. */
  const pickVersion = useRef(0);

  // Another answer-key snapshot while a printed paper is attached: compare it again. A reply for an
  // earlier file or an earlier snapshot is dropped.
  useEffect(() => {
    if (!file || !inspection || rubricId === null || inspectedRubric === rubricId) return;
    // Only printed papers with a text layer can be compared: nothing to ask the server for others
    // (matchChecking stays false for them).
    if (!rubricComparable(inspection)) return;
    const version = pickVersion.current;
    let cancelled = false;
    // Short delay so quick changes send one request for the final snapshot.
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
    // The audio player's source (documents and images get a DocPreview thumbnail).
    setPreviewUrl(isAudio(next) ? URL.createObjectURL(next) : null);
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

  function putUploading(next: boolean) {
    uploadingRef.current = next;
    setUploading(next);
  }

  function putWaiting(next: boolean) {
    waitingRef.current = next;
    setWaiting(next);
  }

  /** An Upload click: false when this sheet is already uploading or waiting for an earlier click. */
  function hold(): boolean {
    if (uploadingRef.current || waitingRef.current) return false;
    putWaiting(true);
    return true;
  }

  /** The held upload starts (or gave up). */
  function release() {
    if (waitingRef.current) putWaiting(false);
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
  /** The comparison with the answer key (null while it is re-checked or before its snapshot exists). */
  const current = !!inspection && rubricId !== null && inspectedRubric === rubricId;
  const rubricMatch = current ? (inspection?.rubric_match ?? null) : null;
  const matchChecking =
    !!file && rubricComparable(inspection) && rubricId !== null && inspectedRubric !== rubricId;

  /** Client checks before an upload (also before queueing it while the key is drafted). */
  function check(): boolean {
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
    return !invalid;
  }

  async function submit(settings: SingleUploadSettings): Promise<Submission | null> {
    if (uploadingRef.current) return null;
    const name = studentName.trim();
    if (!check() || !file || checking) return null;

    putUploading(true);
    setProgress(0);
    setNotice(null);
    const inline = settings.rubricId === undefined;
    try {
      const submission = await uploadSubmission({
        file,
        studentName: name,
        rollNo: rollNo.trim() || undefined,
        rubricId: settings.rubricId,
        rubricHash: settings.rubricHash,
        rubricJson: inline ? settings.rubricJson : undefined,
        rubricSourceFile: inline ? settings.rubricSourceFile : undefined,
        rubricKeyFile: inline ? settings.rubricKeyFile : undefined,
        rubricSourceRole: inline ? settings.rubricSourceRole : undefined,
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
      if (inline) settings.onRubricCreated?.(submission.rubric_id, submission.rubric_hash);
      onUploaded(submission);
      return submission;
    } catch (err) {
      const code = errorCode(err) ?? fallbackCode(errorStatus(err));
      if (code === "unknown_rubric") settings.onRubricLost?.();
      setNotice({ kind: "error", message: `Rejected (${codeLabel(code)}): ${errorMessage(err)}` });
      return null;
    } finally {
      putUploading(false);
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
    /** Upload was clicked and waits to start. */
    waiting,
    /** Uploading or waiting to: the sheet's file, name and options are fixed. */
    locked: uploading || waiting,
    hold,
    release,
    progress,
    notice,
    chooseFile,
    clearFile,
    check,
    submit,
  };
}

export type SingleIntake = ReturnType<typeof useSingleIntake>;
