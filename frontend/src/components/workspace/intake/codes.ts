// Short labels for upload error codes (API_CONTRACT.md "Upload error codes"), used in the
// per-file status chip ("rejected: corrupt") and the grouped intake summary.

const CODE_LABELS: Record<string, string> = {
  corrupt_pdf: "corrupt",
  corrupt_image: "corrupt",
  corrupt_docx: "corrupt",
  unsupported_signature: "unsupported type",
  too_large: "too large",
  docx_too_large: "too large",
  empty_file: "empty",
  password_pdf: "password-protected",
  too_many_pages: "too many pages",
  no_pages: "no pages",
  macro_docx: "macro-enabled DOCX",
  voice_phase2: "voice (Phase 2)",
  invalid_student_name: "invalid name",
  invalid_roll_no: "invalid roll no",
  invalid_language: "invalid language",
  unknown_batch: "unknown batch",
  invalid_intake_batch: "invalid intake id",
  invalid_rubric: "invalid rubric",
  unknown_rubric: "unknown rubric",
  missing_file: "missing file",
  network: "network error",
  server_error: "server error",
  duplicate: "duplicate",
};

/** "corrupt_pdf" -> "corrupt"; unknown codes are humanised ("some_code" -> "some code"). */
export function codeLabel(code: string | null | undefined): string {
  if (!code) return "error";
  return CODE_LABELS[code] ?? code.replace(/_/g, " ");
}

/** Code for an upload failure without a coded body (network / HTTP status). */
export function fallbackCode(status: number | null): string {
  if (status === null) return "network";
  if (status === 413) return "too_large";
  if (status === 415) return "unsupported_signature";
  if (status >= 500) return "server_error";
  return `http_${status}`;
}
