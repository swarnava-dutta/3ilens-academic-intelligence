// Client-side inspection of answer-sheet files before upload: magic-byte signature check,
// SHA-256 custody hash and the student name derived from the file / folder name.
// The API repeats every check on the bytes it receives; this only gives faculty early feedback.
import { extensionOf, VOICE_DISABLED_TEXT } from "../format";

type DocumentKind = "pdf" | "jpeg" | "png" | "webp" | "docx";
/** Voice answers (FR-2.8). */
type VoiceKind = "mp3" | "wav" | "m4a" | "ogg";
export type SheetKind = DocumentKind | VoiceKind;

const KIND_LABEL: Record<SheetKind, string> = {
  pdf: "PDF",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WEBP",
  docx: "DOCX",
  mp3: "MP3",
  wav: "WAV",
  m4a: "M4A",
  ogg: "OGG",
};

const EXTENSION_KIND: Record<string, SheetKind> = {
  ".pdf": "pdf",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
  ".docx": "docx",
  ".mp3": "mp3",
  ".wav": "wav",
  ".m4a": "m4a",
  ".ogg": "ogg",
};

/** sniffBytes label -> accepted kind (DOCX needs the .docx name on top of the ZIP bytes). */
const DETECTED_KIND: Record<string, SheetKind> = {
  PDF: "pdf",
  JPEG: "jpeg",
  PNG: "png",
  WEBP: "webp",
  MP3: "mp3",
  WAV: "wav",
  M4A: "m4a",
  OGG: "ogg",
};

const VOICE_KINDS: ReadonlySet<SheetKind> = new Set<SheetKind>(["mp3", "wav", "m4a", "ogg"]);

/** True for an audio (voice answer) kind. */
export function isVoiceKind(kind: SheetKind | null | undefined): kind is VoiceKind {
  return !!kind && VOICE_KINDS.has(kind);
}

export interface SignatureCheck {
  /** Type proven by the first bytes; null when the bytes match no accepted type. */
  kind: SheetKind | null;
  /** What the bytes look like ("PDF", "PNG", "ZIP", "MP3", "unknown"). */
  detected: string;
  /** Problem that blocks the upload ("named .jpg but bytes are unknown"). */
  error: string | null;
  /** Upload error code of that problem: unsupported_signature, unsupported_audio or voice_disabled. */
  code?: string | null;
  /** Non-blocking mismatch ("named .jpg but bytes are PNG"). */
  warning: string | null;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function containsAscii(bytes: Uint8Array, text: string, limit: number): boolean {
  const needle = Array.from(text, (c) => c.charCodeAt(0));
  const end = Math.min(bytes.length, limit) - needle.length;
  for (let i = 0; i <= end; i += 1) {
    if (needle.every((b, j) => bytes[i + j] === b)) return true;
  }
  return false;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** ISO-BMFF brands that hold audio only (M4A, M4B audiobook, F4A). */
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "F4A "]);

/**
 * What the leading bytes are (mirrors backend sniff_mime, plus the ZIP container of DOCX and
 * the voice-answer audio formats). Unsupported audio reads "AMR" / "FLAC"; any other
 * ISO-BMFF brand (mp4, isom, qt) reads "video".
 */
function sniffBytes(head: Uint8Array): string {
  if (containsAscii(head, "%PDF-", 1024)) return "PDF";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "JPEG";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "PNG";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return "WEBP";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x41, 0x56, 0x45], 8)) return "WAV";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "ZIP";
  if (startsWith(head, [0x49, 0x44, 0x33])) return "MP3"; // ID3 tag
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "MP3"; // MPEG frame sync
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) return AUDIO_BRANDS.has(ascii(head, 8, 4)) ? "M4A" : "video";
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return "OGG"; // OggS
  if (startsWith(head, [0x23, 0x21, 0x41, 0x4d, 0x52])) return "AMR"; // #!AMR
  if (startsWith(head, [0x66, 0x4c, 0x61, 0x43])) return "FLAC"; // fLaC
  return "unknown";
}

/**
 * Compare the file name with what its bytes really are. Audio bytes make a voice answer; with
 * `voiceEnabled` false (Health.voice_enabled) audio is rejected before upload.
 */
export function checkSignature(fileName: string, head: Uint8Array, voiceEnabled = true): SignatureCheck {
  const ext = extensionOf(fileName);
  const named = EXTENSION_KIND[ext] ?? null;
  const detected = sniffBytes(head);
  const label = ext || "without an extension";
  const namedAs = ext ? `named ${ext}` : "has no extension";

  let kind: SheetKind | null = DETECTED_KIND[detected] ?? null;
  if (detected === "ZIP" && named === "docx") kind = "docx";

  if (kind === null) {
    if (detected === "AMR" || detected === "FLAC") {
      return {
        kind: null,
        detected,
        code: "unsupported_audio",
        error: `${namedAs} but bytes are ${detected} audio - unsupported audio; record as MP3, WAV, M4A or OGG`,
        warning: null,
      };
    }
    const what =
      detected === "ZIP"
        ? "a ZIP archive (only Word .docx is accepted)"
        : detected === "video"
          ? "unsupported video (a voice answer must be MP3, WAV, M4A or OGG audio)"
          : "unknown";
    return { kind: null, detected, code: "unsupported_signature", error: `${namedAs} but bytes are ${what}`, warning: null };
  }
  if (isVoiceKind(kind) && !voiceEnabled) {
    return { kind: null, detected, code: "voice_disabled", error: VOICE_DISABLED_TEXT, warning: null };
  }
  if (named !== null && named !== kind) {
    return {
      kind,
      detected,
      error: null,
      warning: `${namedAs} but bytes are ${KIND_LABEL[kind]} - processed as ${KIND_LABEL[kind]}`,
    };
  }
  if (named === null) {
    return { kind, detected, error: null, warning: `File ${label}; bytes are ${KIND_LABEL[kind]}` };
  }
  return { kind, detected, error: null, warning: null };
}

export async function readHead(file: File, length = 1024): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, length).arrayBuffer());
}

/** True when the browser can hash locally (crypto.subtle needs a secure context: localhost/https). */
function canHash(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
}

/** Hex SHA-256 of the whole file (null when Web Crypto is unavailable). */
export async function sha256Hex(file: File): Promise<string | null> {
  if (!canHash()) return null;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Random id: crypto.randomUUID when available (secure contexts), else a time + random fallback. */
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

function titleCase(text: string): string {
  return text
    .split(" ")
    .filter(Boolean)
    .map((word) => (/^[a-z]/.test(word) ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function cleanName(raw: string): string {
  return titleCase(
    raw
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 120);
}

/**
 * Student name for a staged file: the parent sub-folder name when the file sits one level
 * inside the dropped folder ("Batch/Aarav Sharma/page1.jpg"), else the file name without its
 * extension and an "answer_sheet_" prefix ("answer_sheet_aarav_sharma.png" -> "Aarav Sharma").
 */
export function deriveStudentName(fileName: string, relativePath?: string | null): string {
  const parts = (relativePath || "").split("/").filter(Boolean);
  if (parts.length >= 3) {
    const folder = cleanName(parts[parts.length - 2]);
    if (folder) return folder;
  }
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const withoutPrefix = stem.replace(/^(answer[\s_-]*sheet|answersheet|sheet|scan)[\s_-]*/i, "");
  return cleanName(withoutPrefix || stem);
}

const SYSTEM_FILES = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;

/** Why a picked file is not staged at all (null = stage it). */
export function skipReason(fileName: string, accepted: boolean): string | null {
  if (SYSTEM_FILES.test(fileName) || fileName.startsWith(".") || fileName.startsWith("~$")) return "system file";
  if (!accepted) return "not an answer sheet";
  return null;
}

/** Roll numbers the API accepts (max 40 letters, digits, spaces or - _ . /). */
export function rollNoProblem(roll: string): string | null {
  const value = roll.trim();
  if (!value) return null;
  if (value.length > 40 || !/^[A-Za-z0-9/_.\- ]+$/.test(value)) {
    return "Roll no: max 40 letters, digits, spaces or - _ . /";
  }
  return null;
}
