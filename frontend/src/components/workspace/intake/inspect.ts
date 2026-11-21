// Client-side inspection of answer-sheet files before upload: magic-byte signature check,
// SHA-256 custody hash and the student name derived from the file / folder name.
// The API repeats every check on the bytes it receives; this only gives faculty early feedback.
import { extensionOf } from "../format";

export type SheetKind = "pdf" | "jpeg" | "png" | "webp" | "docx";

const KIND_LABEL: Record<SheetKind, string> = {
  pdf: "PDF",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WEBP",
  docx: "DOCX",
};

const EXTENSION_KIND: Record<string, SheetKind> = {
  ".pdf": "pdf",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
  ".docx": "docx",
};

export interface SignatureCheck {
  /** Type proven by the first bytes; null when the bytes match no accepted type. */
  kind: SheetKind | null;
  /** What the bytes look like ("PDF", "PNG", "ZIP", "unknown"). */
  detected: string;
  /** Problem that blocks the upload ("named .jpg but bytes are unknown"). */
  error: string | null;
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

/** What the leading bytes are (mirrors backend sniff_mime, plus the ZIP container of DOCX). */
export function sniffBytes(head: Uint8Array): string {
  if (containsAscii(head, "%PDF-", 1024)) return "PDF";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "JPEG";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "PNG";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return "WEBP";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "ZIP";
  if (startsWith(head, [0x49, 0x44, 0x33]) || startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) return "audio/video";
  return "unknown";
}

/** Compare the file name with what its bytes really are. */
export function checkSignature(fileName: string, head: Uint8Array): SignatureCheck {
  const ext = extensionOf(fileName);
  const named = EXTENSION_KIND[ext] ?? null;
  const detected = sniffBytes(head);
  const label = ext || "without an extension";
  const namedAs = ext ? `named ${ext}` : "has no extension";

  let kind: SheetKind | null = null;
  if (detected === "PDF") kind = "pdf";
  else if (detected === "JPEG") kind = "jpeg";
  else if (detected === "PNG") kind = "png";
  else if (detected === "WEBP") kind = "webp";
  else if (detected === "ZIP" && named === "docx") kind = "docx";

  if (kind === null) {
    const what =
      detected === "ZIP"
        ? "a ZIP archive (only Word .docx is accepted)"
        : detected === "audio/video"
          ? "audio/video (voice answers are Phase 2)"
          : "unknown";
    return { kind: null, detected, error: `${namedAs} but bytes are ${what}`, warning: null };
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
export function canHash(): boolean {
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
