import type { Batch, Submission, SubmissionStatus } from "@/lib/types";

/** Shown when GET /api/health is unavailable (matches the seeded mock data). */
export const FALLBACK_INSTITUTION = "Instit-42";
export const FALLBACK_BATCH = "NEET-A";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Health.max_pdf_pages when the API has not answered yet (backend MAX_PDF_PAGES default). */
export const DEFAULT_MAX_PDF_PAGES = 40;
/** Files above this are fine in the PoC (one streamed POST); production would use S3 presigned multipart. */
export const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".docx"] as const;
export const ACCEPTED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", DOCX_MIME] as const;
/** Voice answers (FR-2.8): accepted when the server has VOICE_ANSWERS on (Health.voice_enabled). */
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg"] as const;
export const ACCEPT_ATTR = [...ACCEPTED_EXTENSIONS, ...ACCEPTED_MIME_TYPES, ...AUDIO_EXTENSIONS, "audio/*"].join(",");
/** Human list used in copy ("PDF, image or Word"). */
export const ACCEPTED_LABEL = "PDF, image (JPG, PNG, WEBP), Word (.docx) or a voice answer (MP3, WAV, M4A, OGG)";
export const VOICE_DISABLED_TEXT = "Voice answers are switched off on this server";

/** Voice-answer settings from /api/health (null health = assume on; the server decides). */
export interface VoiceSettings {
  enabled: boolean;
  /** enabled AND an OpenAI key is configured. */
  ready: boolean;
  /** e.g. "gpt-transcribe". */
  model: string;
}

export const DEFAULT_VOICE: VoiceSettings = { enabled: true, ready: true, model: "gpt-transcribe" };

/** True for an audio file by extension or browser-reported MIME type. */
export function isAudio(file: File): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(file.name)) || file.type.startsWith("audio/");
}

/** 75 -> "1:15" (m:ss); null/invalid -> null. */
export function formatClock(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A batch's name ("NEET-A"). Never batch.exam_type: a legacy label ("Mock-07") that matches no test. */
export function batchLabel(batch: Batch | null | undefined): string | null {
  return batch?.name?.trim() || null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || extensionOf(file.name) === ".pdf";
}

export function isDocx(file: File): boolean {
  return file.type === DOCX_MIME || extensionOf(file.name) === ".docx";
}

/** True when the extension or the browser-reported MIME type is one the API accepts (documents or audio). */
export function hasAcceptedType(file: File): boolean {
  return (
    (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(file.name)) ||
    (ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type) ||
    isAudio(file)
  );
}

/** "PDF document" / "Word document" / "Image" for a file chip. */
export function fileKindLabel(file: File): string {
  if (isPdf(file)) return "PDF document";
  if (isDocx(file)) return "Word document (read via PDF -> vision)";
  if (isAudio(file)) return "Voice answer (audio)";
  return "Image";
}

/**
 * Client-side guard mirroring the API rules (type + size). Returns an error message or null.
 * The server still decides by the file's bytes (magic-number sniffing), not by its name.
 */
export function validateAnswerSheet(file: File, maxBytes: number = MAX_UPLOAD_BYTES, voiceEnabled = true): string | null {
  if (!hasAcceptedType(file)) {
    return `"${file.name}" is not supported. Upload a ${ACCEPTED_LABEL} answer sheet.`;
  }
  if (isAudio(file) && !voiceEnabled) return `"${file.name}" was not attached: ${VOICE_DISABLED_TEXT}.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > maxBytes) {
    return `"${file.name}" is ${formatBytes(file.size)} - the limit is ${formatBytes(maxBytes)}.`;
  }
  return null;
}

/** Relative time ("just now", "4 min ago") using a caller-supplied clock (never Date.now() in render). */
export function formatRelative(iso: string, now: number | null): string | null {
  if (now === null) return null;
  const t = new Date(toUtcIso(iso)).getTime();
  if (Number.isNaN(t)) return null;
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** Backend timestamps are ISO UTC; tolerate a missing zone designator. */
export function toUtcIso(iso: string): string {
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
}

export type QueueFilter = "ALL" | "PROCESSING" | "COMPLETED" | "HUMAN_REVIEW_REQUIRED" | "FAILED";

export function matchesFilter(status: SubmissionStatus, filter: QueueFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "PROCESSING") return status === "PENDING" || status === "PROCESSING";
  return status === filter;
}

export function countByFilter(submissions: Submission[]): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = {
    ALL: submissions.length,
    PROCESSING: 0,
    COMPLETED: 0,
    HUMAN_REVIEW_REQUIRED: 0,
    FAILED: 0,
  };
  for (const s of submissions) {
    if (s.status === "PENDING" || s.status === "PROCESSING") counts.PROCESSING += 1;
    else if (s.status in counts) counts[s.status as QueueFilter] += 1;
  }
  return counts;
}

/**
 * The seven processing stages of the per-row progress meter (Ingest .. Persist). The pipeline
 * strip adds an eighth, post-processing stage ("Report & delivery").
 */
export const PIPELINE_STEP_COUNT = 7;

const STEP_KEYWORDS: [number, RegExp][] = [
  [6, /persist|saving|storing|database/i],
  [5, /insight|roi|priorit|mastery/i],
  [4, /evaluat|grad(e|ing)|rubric|score/i],
  [3, /ocr|vision|extract|structur|transcri/i],
  [2, /pre-?process|deskew|contrast|dpi|render|prepar/i],
  [1, /queue|pending|wait/i],
  [0, /ingest|upload|receiv/i],
];

/** Best-effort mapping of the backend's free-text current_step to a 0-based stage index (-1 if unknown). */
export function pipelineStepIndex(step: string | null | undefined): number {
  if (!step) return -1;
  for (const [index, pattern] of STEP_KEYWORDS) {
    if (pattern.test(step)) return index;
  }
  return -1;
}

/** 95 -> "1 min 35 s"; 3700 -> "1 h 2 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) {
    const rest = s % 60;
    return rest && minutes < 10 ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** First characters of a SHA-256, as shown in the custody column ("3f9a1c2b…"). */
export function shortHash(hash: string | null | undefined, length = 8): string | null {
  return hash ? `${hash.slice(0, length)}…` : null;
}
