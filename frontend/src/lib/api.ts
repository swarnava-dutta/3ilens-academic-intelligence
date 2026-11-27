import axios, { AxiosError } from "axios";
import type {
  AnswerKeyExtraction,
  ApiKey,
  ApiKeyCreated,
  ApiKeyInput,
  Batch,
  BatchPatchInput,
  BloomDetectInput,
  BloomDetection,
  Cohort,
  CohortSitting,
  ConsistencyCheck,
  DashboardFilters,
  Delivery,
  DeliveryInput,
  Health,
  HistoryEntry,
  Institution,
  IntakeBatchStatus,
  InterventionEffectiveness,
  InterventionInput,
  InterventionRecord,
  LanguageHint,
  LlmChainStatus,
  LlmDrillInput,
  LlmDrillResult,
  LmsInfo,
  LmsResultRow,
  ModelInvocation,
  OcrReviewData,
  OwnerDashboard,
  PageRef,
  PaperInspection,
  ReevaluateInput,
  ReevaluationEstimate,
  RerunInput,
  ReleaseInfo,
  ReleaseInput,
  Result,
  ResultVersion,
  ResultPending,
  ReviewInput,
  Rubric,
  RubricDraft,
  RubricSourceFile,
  RubricSourceKind,
  RubricSourceRole,
  RubricVersionInput,
  RubricVersionResult,
  StudentRoster,
  StudyPlan,
  Submission,
  Urgency,
  VoiceTranscript,
  WhatIfInput,
  WhatIfOptions,
  WhatIfResult,
} from "./types";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
});

/** Calls that wait on a live Claude request (grading can take minutes at effort "high"). */
const AI_TIMEOUT_MS = 400_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** Rubric drafting: a long question-paper PDF is read page by page (a full paper takes minutes). */
const RUBRIC_PARSE_TIMEOUT_MS = 600_000;
/** POST /api/intake/inspect reads the text layer locally (no AI). */
const INSPECT_TIMEOUT_MS = 30_000;
/** Answer-key import: a scanned key is read from page images (minutes for a long one). */
const ANSWER_KEY_TIMEOUT_MS = 600_000;

/** Human-readable message from an axios/FastAPI error (uses FastAPI's `detail`). */
export function errorMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    if (!err.response) {
      return `Cannot reach the 3iLens API at ${API_BASE_URL}. Is the FastAPI server running?`;
    }
    const detail = (err.response.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (typeof d === "object" && d && "msg" in d ? String(d.msg) : String(d)))
        .join("; ");
    }
    return `Request failed (HTTP ${err.response.status}).`;
  }
  return err instanceof Error ? err.message : "Unexpected error.";
}

/**
 * Machine-readable error code from a coded API error body `{detail, code}` (snake_case,
 * e.g. "invalid_language", "unsupported_signature", "ai_not_configured"). Null otherwise.
 */
export function errorCode(err: unknown): string | null {
  if (err instanceof AxiosError && err.response) {
    const code = (err.response.data as { code?: unknown } | undefined)?.code;
    return typeof code === "string" && code ? code : null;
  }
  return null;
}

/** HTTP status of an axios error (null for network errors / non-axios errors). */
export function errorStatus(err: unknown): number | null {
  return err instanceof AxiosError && err.response ? err.response.status : null;
}

// --------------------------------------------------------------------------- //
// Query helpers
// --------------------------------------------------------------------------- //
/** Dashboard filters shared by /students, /cohort and the queue (URL search params). */
export interface DashboardQuery {
  batch_id?: number | null;
  rubric_id?: number | null;
  urgency?: Urgency | null;
  topic?: string | null;
}

type QueryValue = string | number | boolean | null | undefined;

/** Plain params object with empty values (null, undefined, "") omitted. */
export function queryParams(query?: Record<string, QueryValue> | DashboardQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) out[key] = text;
  }
  return out;
}

function withQuery(path: string, query?: Record<string, QueryValue> | DashboardQuery): string {
  const search = new URLSearchParams(queryParams(query)).toString();
  return search ? `${path}?${search}` : path;
}

/** Absolute URL for links the browser opens directly (PDF/ZIP downloads, page images). */
function absolute(path: string): string {
  return `${API_BASE_URL.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

// --------------------------------------------------------------------------- //
// Core
// --------------------------------------------------------------------------- //
export async function getHealth(): Promise<Health> {
  return (await api.get<Health>("/api/health")).data;
}

export async function getRubrics(): Promise<Rubric[]> {
  return (await api.get<Rubric[]>("/api/rubrics")).data;
}

/** GET /api/submissions (newest first), optionally filtered. */
export async function getSubmissions(
  filters?: DashboardQuery & { intake_batch_id?: string | null },
): Promise<Submission[]> {
  return (await api.get<Submission[]>("/api/submissions", { params: queryParams(filters) })).data;
}

export async function uploadSubmission(input: {
  file: File;
  studentName: string;
  rollNo?: string;
  rubricId?: number;
  /**
   * With rubricId: the snapshot's rubric_hash from the upload that created it - after a data reset
   * the id may name another intake's key, and the server answers 422 unknown_rubric on a mismatch.
   */
  rubricHash?: string;
  rubricJson?: string;
  /**
   * With rubricJson only (the first upload of an intake): the question paper / rubric file the key
   * was drafted from and the separate answer-key file. The server keeps them with the new snapshot
   * (GET /api/rubrics/{id}/sources) so the report can preview them; ignored with rubricId.
   */
  rubricSourceFile?: File;
  rubricKeyFile?: File;
  /** With rubricSourceFile: what that file is (question paper, rubric file, marked copy) - the report labels it. */
  rubricSourceRole?: RubricSourceRole;
  /** Answer languages, e.g. ["en", "hi"] (default en). */
  languageHints?: LanguageHint[];
  batchId?: number;
  /** Shared id for a folder/batch intake (letters, digits, hyphens; max 64). */
  intakeBatchId?: string;
  /** Voice answers: the rubric question a per-question recording answers (omit for a whole-paper recording). */
  voiceQuestion?: number;
  onProgress?: (percent: number) => void;
}): Promise<Submission> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("student_name", input.studentName);
  if (input.rollNo) form.append("roll_no", input.rollNo);
  if (input.rubricId !== undefined) form.append("rubric_id", String(input.rubricId));
  if (input.rubricId !== undefined && input.rubricHash) form.append("rubric_hash", input.rubricHash);
  if (input.rubricJson) {
    form.append("rubric_json", input.rubricJson);
    if (input.rubricSourceFile) {
      form.append("rubric_source_file", input.rubricSourceFile);
      if (input.rubricSourceRole) form.append("rubric_source_role", input.rubricSourceRole);
    }
    if (input.rubricKeyFile) form.append("rubric_key_file", input.rubricKeyFile);
  }
  if (input.languageHints && input.languageHints.length) {
    form.append("language_hints", input.languageHints.join(","));
  }
  if (input.batchId !== undefined) form.append("batch_id", String(input.batchId));
  if (input.intakeBatchId) form.append("intake_batch_id", input.intakeBatchId);
  if (input.voiceQuestion !== undefined) form.append("voice_question", String(input.voiceQuestion));
  try {
    const res = await api.post<Submission>("/api/upload", form, {
      timeout: UPLOAD_TIMEOUT_MS,
      onUploadProgress: (e) => {
        if (input.onProgress && e.total) input.onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return res.data;
  } catch (err) {
    // The key's source files are kept only for the report's preview: one the server refuses
    // ("Question paper file: ..." / "Answer key file: ...") must not keep the sheet from grading.
    // The upload goes again without that file only - the other one is still kept.
    const refused = input.rubricJson ? refusedSourceFile(err) : null;
    if (refused === "key" && input.rubricKeyFile) {
      return uploadSubmission({ ...input, rubricKeyFile: undefined });
    }
    if (refused === "paper" && input.rubricSourceFile) {
      return uploadSubmission({ ...input, rubricSourceFile: undefined, rubricSourceRole: undefined });
    }
    throw err;
  }
}

/**
 * Which source file a 4xx refused: the server prefixes the detail with the file's label ("Answer key
 * file: ..." for rubric_key_file; "Question paper file: ..." - or a rubric / marked-copy label - for
 * rubric_source_file). Null for any other error.
 */
function refusedSourceFile(err: unknown): RubricSourceKind | null {
  const status = errorStatus(err);
  if (status === null || status < 400 || status >= 500) return null;
  const detail = errorMessage(err);
  if (/^Answer key file:/i.test(detail)) return "key";
  if (/^(?:Question paper|Rubric|Marked copy)\b[^:]{0,60}\bfile:/i.test(detail)) return "paper";
  return null;
}

/**
 * What an intake file looks like (answer sheet, printed MCQ paper or a paper with its answer key),
 * read locally from its text layer - no AI call, nothing stored.
 * With rubricId the printed questions are also compared with that rubric (rubric_match).
 */
export async function inspectPaper(file: File, rubricId?: number | null): Promise<PaperInspection> {
  const form = new FormData();
  form.append("file", file);
  if (rubricId !== undefined && rubricId !== null) form.append("rubric_id", String(rubricId));
  return (await api.post<PaperInspection>("/api/intake/inspect", form, { timeout: INSPECT_TIMEOUT_MS })).data;
}

export type ResultResponse =
  | { kind: "ready"; result: Result }
  | { kind: "pending"; pending: ResultPending };

/** GET /api/results/{id}: 200 => Result, 202 => {status, detail, submission}. 404 throws. */
export async function getResult(id: number | string): Promise<ResultResponse> {
  const res = await api.get<Result | ResultPending>(`/api/results/${id}`);
  if (res.status === 202) return { kind: "pending", pending: res.data as ResultPending };
  return { kind: "ready", result: res.data as Result };
}

/** Archived versions + the current one, oldest first. */
export async function getResultVersions(id: number | string): Promise<ResultVersion[]> {
  return (await api.get<ResultVersion[]>(`/api/results/${id}/versions`)).data;
}

/** An archived (superseded) snapshot of a result: superseded is true on it. */
export async function getResultVersion(id: number | string, version: number): Promise<Result> {
  return (await api.get<Result>(`/api/results/${id}/versions/${version}`)).data;
}

export async function getInstitutions(): Promise<Institution[]> {
  return (await api.get<Institution[]>("/api/institutions")).data;
}

export async function getCohort(filters?: DashboardQuery): Promise<Cohort> {
  return (await api.get<Cohort>("/api/cohort", { params: queryParams(filters) })).data;
}

/** Scope of the cohort page: one test (any key version id) of one batch, or each student's latest test. */
export interface CohortViewQuery {
  batch_id?: number | null;
  /** Any version id of the test; null = each student's latest test. */
  test_id?: number | null;
}

function cohortViewParams(query?: CohortViewQuery) {
  return { batch_id: query?.batch_id, test_id: query?.test_id, per_student: true };
}

/** GET /api/cohort?per_student=true: one row per student plus the cohort page fields. */
export async function getCohortView(query?: CohortViewQuery): Promise<Cohort> {
  return (await api.get<Cohort>("/api/cohort", { params: queryParams(cohortViewParams(query)) })).data;
}

/** Every (batch, test) sitting, newest first (is_class: 3+ students). */
export async function getCohortSittings(batchId?: number | null): Promise<CohortSitting[]> {
  return (await api.get<CohortSitting[]>("/api/cohort/sittings", { params: queryParams({ batch_id: batchId }) })).data;
}

/** Cohort PDF / reports ZIP with the same student set as the cohort page. */
export function cohortViewPdfUrl(query?: CohortViewQuery): string {
  return absolute(withQuery("/api/cohort/pdf", cohortViewParams(query)));
}

export function cohortViewBundleUrl(query?: CohortViewQuery): string {
  return absolute(withQuery("/api/reports/bundle.zip", cohortViewParams(query)));
}

// --------------------------------------------------------------------------- //
// Pipeline operations (retry, re-evaluate, OCR review, pages, cost)
// --------------------------------------------------------------------------- //
/** Set the student's name (1-120 characters; 422 invalid_student_name). The student ref is kept. */
export async function renameSubmission(id: number, studentName: string): Promise<Submission> {
  return (await api.patch<Submission>(`/api/submissions/${id}`, { student_name: studentName })).data;
}

/** Re-drive a FAILED submission from the dead-letter queue (202). */
export async function retrySubmission(id: number): Promise<Submission> {
  return (await api.post<Submission>(`/api/submissions/${id}/retry`)).data;
}

/**
 * Re-grade a COMPLETED submission from its stored transcript (no new reading): with its own key,
 * `rubric_id` (an existing snapshot) or `rubric` (a key drafted on the fly; stored as a new snapshot
 * the sheet moves to - one call, no POST /api/rubrics first).
 */
export async function reevaluateSubmission(id: number, input: ReevaluateInput = { rubric_id: null }): Promise<Submission> {
  return (await api.post<Submission>(`/api/submissions/${id}/reevaluate`, input)).data;
}

/**
 * Full re-run of a HUMAN_REVIEW_REQUIRED or FAILED sheet from the stored upload (202): the sheet
 * is read again from the start (the stored reading is reused when this exact file was already read
 * with these questions), then the paper check and grading - with the same key, or with `rubric`, a
 * key drafted on the fly from the right question paper (the sheet moves to a new snapshot of it).
 */
export async function rerunSubmission(id: number, input: RerunInput = {}): Promise<Submission> {
  return (await api.post<Submission>(`/api/submissions/${id}/rerun`, input)).data;
}

export async function getOcrReview(id: number): Promise<OcrReviewData> {
  return (await api.get<OcrReviewData>(`/api/submissions/${id}/ocr`)).data;
}

/** Faculty approve/correct of a HUMAN_REVIEW_REQUIRED transcript; grading follows (202). */
export async function submitOcrReview(id: number, input: ReviewInput): Promise<Submission> {
  return (await api.post<Submission>(`/api/submissions/${id}/review`, input)).data;
}

export async function rescanSubmission(
  id: number,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Submission> {
  const form = new FormData();
  form.append("file", file);
  const res = await api.post<Submission>(`/api/submissions/${id}/rescan`, form, {
    timeout: UPLOAD_TIMEOUT_MS,
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return res.data;
}

export async function getPages(id: number): Promise<PageRef[]> {
  return (await api.get<PageRef[]>(`/api/submissions/${id}/pages`)).data;
}

/** Absolute URL of a page image (processed = what the vision model saw; original = before enhancement). */
export function pageImageUrl(id: number, pageNumber: number, variant: "processed" | "original" = "processed"): string {
  return absolute(withQuery(`/api/submissions/${id}/pages/${pageNumber}`, { variant }));
}

/**
 * GET /api/rubrics/{id}/sources: the question paper and the separate answer-key file the key was
 * drafted from at upload ([] when it was pasted or sent as JSON). Older API builds answer 404.
 */
export async function getRubricSources(rubricId: number): Promise<RubricSourceFile[]> {
  return (await api.get<RubricSourceFile[]>(`/api/rubrics/${rubricId}/sources`)).data;
}

/** Image URL of page `page` (1-based) of a stored key file; 404 code no_source when it is not stored. */
export function rubricSourcePreviewUrl(rubricId: number, kind: RubricSourceKind, page: number, width = 960): string {
  return absolute(withQuery(`/api/rubrics/${rubricId}/sources/${kind}/preview`, { page, width }));
}

export async function getInvocations(id: number): Promise<ModelInvocation[]> {
  return (await api.get<ModelInvocation[]>(`/api/submissions/${id}/invocations`)).data;
}

export async function getIntakeBatch(intakeBatchId: string): Promise<IntakeBatchStatus> {
  return (await api.get<IntakeBatchStatus>(`/api/intake-batches/${encodeURIComponent(intakeBatchId)}`)).data;
}

/** Save an edited rubric as the next version (v1 -> v2); reprocess queues re-grades. */
export async function createRubricVersion(rubricId: number, input: RubricVersionInput): Promise<RubricVersionResult> {
  return (await api.post<RubricVersionResult>(`/api/rubrics/${rubricId}/versions`, input)).data;
}

/**
 * Students and estimated cost of re-grading every COMPLETED submission on a rubric.
 * Show it in the confirmation step BEFORE createRubricVersion(..., {reprocess: true}).
 */
export async function getReevaluationEstimate(rubricId: number): Promise<ReevaluationEstimate> {
  return (await api.get<ReevaluationEstimate>(`/api/rubrics/${rubricId}/reevaluation-estimate`)).data;
}

// --------------------------------------------------------------------------- //
// Analytics (study plan, batches, consistency, rubric authoring)
// --------------------------------------------------------------------------- //
export async function getStudyPlan(
  id: number,
  options: { daysToExam?: number; studyHours?: number } = {},
): Promise<StudyPlan> {
  const params = queryParams({ days_to_exam: options.daysToExam, study_hours: options.studyHours });
  return (await api.get<StudyPlan>(`/api/results/${id}/plan`, { params })).data;
}

/** Set the exam / exam date of a batch (exam_date null = back to the assumed default). */
export async function updateBatch(id: number, input: BatchPatchInput): Promise<Batch> {
  return (await api.patch<Batch>(`/api/batches/${id}`, input)).data;
}

/** Re-grade once and compare with the stored marks (FR-3.5). Makes a live Claude call. */
export async function runConsistencyCheck(id: number): Promise<ConsistencyCheck> {
  return (await api.post<ConsistencyCheck>(`/api/results/${id}/consistency-check`, null, { timeout: AI_TIMEOUT_MS }))
    .data;
}

/** Draft a rubric from pasted text or an uploaded PDF/DOCX/JSON (AI-drafted parts are flagged). */
export async function parseRubric(input: {
  file?: File;
  text?: string;
  subject?: string;
  exam?: string;
  /** "marks": faculty confirm that the ticks on the paper mark the answer key. */
  keySource?: "auto" | "marks";
  /** A separate answer key for the paper (PDF, image, Word or text), sent as key_file. */
  keyFile?: File;
}): Promise<RubricDraft> {
  const form = new FormData();
  if (input.file) form.append("file", input.file);
  if (input.text) form.append("text", input.text);
  if (input.subject) form.append("subject", input.subject);
  if (input.exam) form.append("exam", input.exam);
  if (input.keySource) form.append("key_source", input.keySource);
  if (input.keyFile) form.append("key_file", input.keyFile);
  return (await api.post<RubricDraft>("/api/rubrics/parse", form, { timeout: RUBRIC_PARSE_TIMEOUT_MS })).data;
}

/**
 * Read an answer key from a key-only file (PDF, Word, image, text) or pasted text: a table such as
 * "1-2, 2-4", a "Que. / Ans." grid, or a question paper with "Ans." lines. Nothing is stored; the
 * caller applies the entries to the rubric it is editing. A scan is read from page images (AI).
 */
export async function extractAnswerKey(input: { file?: File; text?: string }): Promise<AnswerKeyExtraction> {
  const form = new FormData();
  if (input.file) form.append("file", input.file);
  if (input.text) form.append("text", input.text);
  return (await api.post<AnswerKeyExtraction>("/api/rubrics/answer-key", form, { timeout: ANSWER_KEY_TIMEOUT_MS }))
    .data;
}

// --------------------------------------------------------------------------- //
// Outputs (PDF, release, simulated delivery, students, filters)
// --------------------------------------------------------------------------- //
/** Student report PDF (attachment). version = an archived evaluation version. */
export function reportPdfUrl(id: number, version?: number): string {
  return absolute(withQuery(`/api/reports/${id}/pdf`, { version }));
}

/** Filters the bundle accepts (same as /api/cohort). */
function outputFilters(filters?: DashboardQuery) {
  return {
    batch_id: filters?.batch_id,
    rubric_id: filters?.rubric_id,
    urgency: filters?.urgency,
    topic: filters?.topic,
  };
}

export function bundleZipUrl(filters?: DashboardQuery): string {
  return absolute(withQuery("/api/reports/bundle.zip", outputFilters(filters)));
}

export async function releaseResult(id: number, input: ReleaseInput): Promise<ReleaseInfo> {
  return (await api.post<ReleaseInfo>(`/api/results/${id}/release`, input)).data;
}

export async function revokeResult(id: number, input: ReleaseInput): Promise<ReleaseInfo> {
  return (await api.post<ReleaseInfo>(`/api/results/${id}/revoke`, input)).data;
}

/** SIMULATED WhatsApp delivery: never sends; returns BLOCKED / SIMULATED_NOT_SENT rows + signed links. */
export async function createDeliveries(input: DeliveryInput): Promise<Delivery[]> {
  return (await api.post<Delivery[]>("/api/deliveries", input)).data;
}

/** Absolute URL for a Delivery.download_url (relative /api/download/{token}). */
export function downloadUrl(relativePath: string): string {
  return /^https?:\/\//i.test(relativePath) ? relativePath : absolute(relativePath);
}

/** Roster scope: batch + test + demo (false = real records only, true = demo only, null = both).
 * urgency / topic narrow the rows only; summary and topics always describe the scope. */
export interface RosterQuery {
  batch_id?: number | null;
  rubric_id?: number | null;
  demo?: boolean | null;
  urgency?: Urgency | null;
  topic?: string | null;
}

/** One row per student (student_ref + is_demo) with the latest paper, trend and actions. */
export async function getStudentRoster(query?: RosterQuery): Promise<StudentRoster> {
  return (await api.get<StudentRoster>("/api/students/roster", { params: queryParams({ ...query }) })).data;
}

/** Dated history for one learner. demo=true: synthetic records only; false: real only;
 * omitted: real records when any exist, else the demo ones (the two are never mixed). */
export async function getStudentHistory(studentRef: string, demo?: boolean): Promise<HistoryEntry[]> {
  return (
    await api.get<HistoryEntry[]>(`/api/students/${encodeURIComponent(studentRef)}/history`, {
      params: queryParams({ demo }),
    })
  ).data;
}

export async function getFilters(): Promise<DashboardFilters> {
  return (await api.get<DashboardFilters>("/api/filters")).data;
}

// =========================================================================== //
// Contract v3 - voice, LLM chain, Bloom, patterns, interventions, owner, LMS (API_CONTRACT.md)
// =========================================================================== //

// --- Voice answers (FR-2.8) ------------------------------------------------- //
/** Absolute URL of a voice submission's audio (inline; 404 no_audio for sample rows). */
export function audioUrl(id: number): string {
  return absolute(`/api/submissions/${id}/audio`);
}

export async function getTranscript(id: number): Promise<VoiceTranscript> {
  return (await api.get<VoiceTranscript>(`/api/submissions/${id}/transcript`)).data;
}

// --- LLM chain (FR-3.10) and Bloom detection (FR-3.9) ----------------------- //
export async function getLlmChain(): Promise<LlmChainStatus> {
  return (await api.get<LlmChainStatus>("/api/ops/llm-chain")).data;
}

/** Fallback drill: makes REAL provider calls (simulate_outage skips Claude so the fallback runs). */
export async function runLlmDrill(input: LlmDrillInput): Promise<LlmDrillResult> {
  return (await api.post<LlmDrillResult>("/api/ops/llm-chain/drill", input, { timeout: AI_TIMEOUT_MS })).data;
}

/** Suggested Bloom K1-K5 levels for a rubric (never modifies it). mode "ai" makes a live call. */
export async function detectBloomLevels(rubricId: number, input: BloomDetectInput): Promise<BloomDetection> {
  return (
    await api.post<BloomDetection>(`/api/rubrics/${rubricId}/bloom-levels`, input, { timeout: AI_TIMEOUT_MS })
  ).data;
}

// --- Interventions (FR-4.13) and what-if (FR-4.14) -------------------------- //
export async function createIntervention(input: InterventionInput): Promise<InterventionRecord> {
  return (await api.post<InterventionRecord>("/api/interventions", input)).data;
}

/** Newest first. */
export async function getInterventions(filters?: {
  batch_id?: number | null;
  student_ref?: string | null;
  submission_id?: number | null;
  institution_id?: number | null;
}): Promise<InterventionRecord[]> {
  return (await api.get<InterventionRecord[]>("/api/interventions", { params: queryParams(filters) })).data;
}

export async function deleteIntervention(id: number): Promise<void> {
  await api.delete(`/api/interventions/${id}`);
}

export async function getInterventionEffectiveness(filters?: {
  batch_id?: number | null;
  institution_id?: number | null;
}): Promise<InterventionEffectiveness> {
  return (
    await api.get<InterventionEffectiveness>("/api/interventions/effectiveness", { params: queryParams(filters) })
  ).data;
}

export async function runWhatIf(input: WhatIfInput): Promise<WhatIfResult> {
  return (await api.post<WhatIfResult>("/api/whatif", input)).data;
}

export async function getWhatIfOptions(filters?: {
  batch_id?: number | null;
  institution_id?: number | null;
}): Promise<WhatIfOptions> {
  return (await api.get<WhatIfOptions>("/api/whatif/options", { params: queryParams(filters) })).data;
}

// --- Owner dashboard (FR-5.9) - no login in this PoC ------------------------ //
export async function getOwnerDashboard(institutionId?: number | null): Promise<OwnerDashboard> {
  return (
    await api.get<OwnerDashboard>("/api/owner/dashboard", { params: queryParams({ institution_id: institutionId }) })
  ).data;
}

// --- LMS export (FR-5.10) --------------------------------------------------- //
export async function getLmsInfo(): Promise<LmsInfo> {
  return (await api.get<LmsInfo>("/api/lms/info")).data;
}

export async function getApiKeys(): Promise<ApiKey[]> {
  return (await api.get<ApiKey[]>("/api/lms/keys")).data;
}

/** The returned secret is shown ONCE (only its SHA-256 is stored); never persist it in the browser. */
export async function createApiKey(input: ApiKeyInput): Promise<ApiKeyCreated> {
  return (await api.post<ApiKeyCreated>("/api/lms/keys", input)).data;
}

export async function revokeApiKey(id: number): Promise<ApiKey> {
  return (await api.post<ApiKey>(`/api/lms/keys/${id}/revoke`)).data;
}

/** Query params of the LMS export endpoints (released results only unless include_provisional). */
export interface LmsQuery {
  batch_id?: number | null;
  rubric_id?: number | null;
  /** ISO date or datetime */
  since?: string | null;
  include_provisional?: boolean | null;
  include_demo?: boolean | null;
  limit?: number | null;
  offset?: number | null;
}

function lmsParams(query?: LmsQuery): Record<string, string> {
  return queryParams({
    batch_id: query?.batch_id,
    rubric_id: query?.rubric_id,
    since: query?.since,
    include_provisional: query?.include_provisional,
    include_demo: query?.include_demo,
    limit: query?.limit,
    offset: query?.offset,
  });
}

/** Preview GET /api/lms/v1/results with a key (sent as X-API-Key; never stored). */
export async function lmsPreview(secret: string, query?: LmsQuery): Promise<LmsResultRow[]> {
  return (
    await api.get<LmsResultRow[]>("/api/lms/v1/results", {
      params: lmsParams(query),
      headers: { "X-API-Key": secret },
    })
  ).data;
}

/** Absolute URL of an LMS export path, e.g. lmsUrl("/api/lms/v1/results.csv") - for curl examples. */
export function lmsUrl(path: string, query?: LmsQuery): string {
  const search = new URLSearchParams(lmsParams(query)).toString();
  return absolute(search ? `${path}?${search}` : path);
}
