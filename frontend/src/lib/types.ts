// Mirrors API_CONTRACT.md. Keep in sync with the FastAPI response shapes (backend/schemas.py).
//
// backend/tests/test_contract.py parses this file and checks every API payload against it,
// field by field. Keep to the subset its parser understands:
//   - `export interface X { ... }` and `export type X = "a" | "b";` (string-literal unions only)
//   - field types: string, number, boolean, null, a named interface/union, T[], T | null,
//     inline `{ a: T; b: U }` objects
//   - NOT allowed: Record<>, generics, unknown, any, (A | B)[], numeric literal types,
//     `type X = { ... }` aliases. Every literal union must be a named exported type.

// --------------------------------------------------------------------------- //
// Named unions
// --------------------------------------------------------------------------- //
export type SubmissionStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "HUMAN_REVIEW_REQUIRED";

/** >=70% on track, 55-70% needs attention, <55% at risk; one level worse when 2+ topics < 40%. */
export type Urgency = "on_track" | "needs_attention" | "at_risk";
export type QuestionOutcome = "FULL" | "PARTIAL" | "ZERO" | "BLANK";
export type ReleaseStatus = "PROVISIONAL" | "RELEASED";
export type RubricStatus = "AUTHOR_DRAFT" | "FACULTY_APPROVED";
export type NudgePriority = "high" | "medium" | "low";
export type ContentSource = "ai" | "template" | "faculty";
export type StrategyMode = "broad" | "focused" | "revision" | "consolidation";
export type Quadrant = "priority_focus" | "maintain" | "deprioritise" | "no_action";
export type PlanAction = "learn" | "drill" | "fix_errors" | "maintain" | "none";
export type CalendarActivity = "learn" | "drill" | "fix_errors" | "review" | "checkpoint";
export type EffortFlagKind = "over_investing" | "low_marginal_return";
export type RoadmapHorizon = "7" | "30" | "60" | "90";
/** WhatsApp is never really sent in this PoC. */
export type DeliveryStatus = "BLOCKED_TEMPLATE_PENDING" | "SIMULATED_NOT_SENT";
export type InvocationStatus = "ok" | "error" | "refusal" | "cache_hit";
export type InvocationPurpose = "ocr" | "evaluation" | "consistency" | "rubric_parse";
export type LanguageHint = "en" | "hi" | "ta" | "kn" | "te";
export type ReviewAction = "approve" | "correct" | "rescan";
export type RubricSource = "text" | "pdf" | "docx" | "json";
export type DemoSet = "genetics" | "mixed" | "all";

// --------------------------------------------------------------------------- //
// Core records
// --------------------------------------------------------------------------- //
export interface Institution {
  id: number;
  name: string;
}

export interface Batch {
  id: number;
  name: string;
  exam_type: string;
  /** Target exam, e.g. "NEET". */
  exam: string;
  /** ISO date of the exam (the configured default when the batch has none). */
  exam_date: string | null;
  /** True when exam_date is the assumed NEET_EXAM_DATE default, not a faculty-entered date. */
  exam_date_assumed: boolean;
  /** Days from today (IST) to exam_date; null when unknown or past. */
  days_to_exam: number | null;
  strategy_mode: StrategyMode | null;
}

export interface Health {
  status: string;
  ai_ready: boolean;
  vision_provider: string;
  missing_configuration: string[];
  /** Submissions with OCR confidence (sheet or any page) below this are routed to HUMAN_REVIEW_REQUIRED. */
  ocr_confidence_threshold: number;
  institution: Institution;
  batch: Batch;
  /** e.g. "anthropic vision (claude-sonnet-5-5) - PoC stand-in for Google Vision DOCUMENT_TEXT_DETECTION" */
  ocr_adapter: string;
  /** OCR cache by file SHA-256 (a cache hit makes no vision call: Rs 0.00). */
  ocr_cache_enabled: boolean;
  cost_target_inr: number;
  latency_target_seconds: number;
  batch_target_seconds: number;
  /** "blocked" | "simulate" - WhatsApp delivery is always simulated. */
  whatsapp_mode: string;
  max_upload_mb: number;
  /** e.g. ["pdf", "jpeg", "png", "webp", "docx"] */
  accepted_upload_types: string[];
}

export interface RubricQuestion {
  question: number;
  topic: string;
  subject: string;
  max_marks: number;
  /** Question text shown to the student (optional for custom rubrics). */
  prompt?: string;
  expected_answer: string;
  grading_criteria: string[];
  effort_hours: number;
  /** Syllabus chapter (maps the topic onto the weightage matrix). */
  chapter?: string;
}

export interface RubricContent {
  name: string;
  subject: string;
  questions: RubricQuestion[];
}

export interface Rubric {
  id: number;
  version: string;
  name: string;
  total_marks: number;
  content: RubricContent;
  status: RubricStatus;
  rubric_hash: string;
  parent_id: number | null;
  change_note: string | null;
  created_at: string;
}

export interface RubricRef {
  id: number;
  version: string;
  name: string;
  total_marks: number;
  status: RubricStatus;
  rubric_hash: string;
}

export interface Submission {
  id: number;
  student_name: string;
  original_filename: string;
  status: SubmissionStatus;
  ocr_confidence: number | null;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  current_step: string;
  is_demo: boolean;
  total_score: number | null;
  total_marks: number;
  rubric_id: number;
  batch_id: number;
  /** SHA-256 of the uploaded bytes, taken while streaming (null for demo/legacy rows). */
  file_sha256: string | null;
  file_size: number | null;
  page_count: number | null;
  language_hints: LanguageHint[];
  /** Roll number (upper-cased) or a slug of the name - links a student's assessments. */
  student_ref: string;
  intake_batch_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
  flagged_pages: number[];
  ocr_cache_hit: boolean;
  /** Null unless COMPLETED. */
  urgency: Urgency | null;
  percentage: number | null;
  started_at: string | null;
  completed_at: string | null;
  release_status: ReleaseStatus | null;
  llm_cost_inr: number | null;
}

// --------------------------------------------------------------------------- //
// Result (GET /api/results/{id})
// --------------------------------------------------------------------------- //
export interface TopicMastery {
  topic: string;
  subject: string;
  score: number;
  max_marks: number;
  mastery: number; // 0-100
  weightage: number; // fraction of the exam, e.g. 0.1 = 10%
  effort_hours: number;
  chapter: string | null;
  questions: number[];
  n: number;
  full: number;
  partial: number;
  zero: number;
  blank: number;
  priority_rank: number | null;
}

export interface Intervention {
  teach: string;
  practice: string;
  check_criterion: string;
  source: ContentSource;
}

export interface Priority {
  topic: string;
  subject: string;
  roi: number;
  weightage: number;
  gain_potential: number; // 0-100
  effort_hours: number;
  rationale: string;
  mastery: number; // 0-100
  /** Illustrative, exam-scale marks (not a calibrated forecast). */
  projected_gain_marks: number | null;
  target_mastery: number | null;
  gain_low: number | null;
  gain_high: number | null;
  trigger_questions: number[];
  intervention: Intervention | null;
  qualitative_rank: number | null;
  calibrated: boolean;
}

export interface UncertainWord {
  text: string;
  confidence: number;
}

export interface QuestionEvaluation {
  question: number;
  topic: string;
  estimated_marks: number;
  max_marks: number;
  evidence: string;
  strengths: string[];
  gaps: string[];
  student_answer: string;
  confidence: number; // 0-1
  outcome: QuestionOutcome;
  source_pages: number[];
  uncertain_words: UncertainWord[];
  corrected_by_faculty: boolean;
}

export interface ProcessingLogEntry {
  step: string;
  message: string;
  timestamp: string;
}

export interface TeachingNudge {
  priority: NudgePriority;
  label: string;
  text: string;
  topic: string | null;
  question_refs: number[];
  source: ContentSource;
}

export interface Confusion {
  concept_a: string;
  concept_b: string;
  question: number | null;
  evidence: string;
}

export interface OutcomeCounts {
  full: number;
  partial: number;
  zero: number;
  blank: number;
  mapped: number;
  total_questions: number;
}

export interface SubjectRollup {
  subject: string;
  questions: number;
  full: number;
  partial: number;
  zero: number;
  blank: number;
  score: number;
  max_marks: number;
  pct: number;
}

export interface ScoringControls {
  marking_rule: string;
  rubric_version: string;
  rubric_status: RubricStatus;
  rubric_hash: string;
  item_sum: number;
  reported_total: number;
  parity: boolean;
  llm_total_used: boolean;
}

export interface RoiBasis {
  calculation_version: string;
  matrix_version: string;
  weightage_source: string;
  effort_source: string;
  forecast_status: string;
  reason: string;
  calibrated: boolean;
}

export interface ReportMeta {
  run_id: string;
  institution: Institution;
  batch: Batch;
  executed_at: string;
  timezone: string;
  student_ref: string;
  is_demo: boolean;
}

export interface ReleaseInfo {
  status: ReleaseStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  note: string | null;
}

export interface Custody {
  sha256: string;
  size_bytes: number;
  page_count: number | null;
  mime_type: string;
  detected_by: string;
  verified: boolean;
  verified_at: string | null;
}

export interface PageConfidence {
  page: number;
  confidence: number;
}

export interface Extraction {
  mapped: number;
  total_questions: number;
  unattempted: number[];
  dropped: number[];
  mean_confidence: number | null;
  min_confidence: number | null;
  below_threshold: number;
  threshold: number;
  flagged_pages: number[];
  page_confidences: PageConfidence[];
  ocr_adapter: string;
  ocr_cache_hit: boolean;
  language_hints: LanguageHint[];
  corrected_by_faculty: boolean;
}

export interface CostSummary {
  llm_cost_inr: number | null;
  ocr_inr: number | null;
  evaluation_inr: number | null;
  other_inr: number | null;
  target_inr: number;
  within_target: boolean | null;
  calls: number;
  ocr_cache_hit: boolean;
  /** Demo rows: no AI call was made. */
  synthetic: boolean;
  usd_inr: number;
}

export interface StageDuration {
  step: string;
  seconds: number;
}

export interface LatencySummary {
  seconds: number | null;
  target_seconds: number;
  within_target: boolean | null;
  stages: StageDuration[];
}

export interface HistoryEntry {
  submission_id: number;
  date: string;
  batch_name: string;
  rubric_name: string;
  rubric_version: string;
  subjects: string[];
  score: number;
  total_marks: number;
  pct: number;
  urgency: Urgency;
  outcome_counts: OutcomeCounts;
  current: boolean;
}

export interface EvaluationVersion {
  version: number;
  rubric_id: number;
  rubric_version: string;
  rubric_hash: string | null;
  total_score: number;
  total_marks: number;
  created_at: string;
  superseded_at: string | null;
  current: boolean;
}

export interface Delivery {
  id: number;
  submission_id: number;
  channel: string;
  recipient_masked: string | null;
  template_name: string;
  status: DeliveryStatus;
  detail: string;
  /** Relative path (/api/download/{token}); build the full URL with downloadUrl(). */
  download_url: string | null;
  link_expires_at: string | null;
  created_at: string;
}

// --------------------------------------------------------------------------- //
// Study plan (illustrative ROI engine v2)
// --------------------------------------------------------------------------- //
export interface PlanTopic {
  topic: string;
  subject: string;
  chapter: string | null;
  mastery: number;
  exam_marks: number;
  gain_marks: number;
  gain_low: number;
  gain_high: number;
  target_mastery: number;
  effort_hours: number;
  time_factor: number;
  roi: number;
  quadrant: Quadrant;
  quadrant_reason: string;
  action: PlanAction;
  allocated_hours: number;
  rank: number | null;
  question_refs: number[];
}

export interface Deprioritised {
  topic: string;
  reason: string;
}

export interface EffortFlag {
  topic: string;
  kind: EffortFlagKind;
  message: string;
}

export interface ProjectedScore {
  current: number;
  expected: number;
  low: number;
  high: number;
  scale_max: number;
  label: string;
}

export interface CalendarBlock {
  topic: string;
  minutes: number;
  activity: CalendarActivity;
  note: string;
}

export interface CalendarDay {
  day: number;
  date: string | null;
  blocks: CalendarBlock[];
}

export interface RoadmapStage {
  horizon: RoadmapHorizon;
  title: string;
  days_label: string;
  tasks: string[];
  checkpoint: string;
  condition: string;
  applicable: boolean;
}

export interface RoiInputs {
  exam_marks: number;
  mastery: number;
  target_mastery: number;
  time_factor: number;
  effort_hours: number;
  roi: number;
}

export interface RoiExplanation {
  topic: string;
  formula: string;
  arithmetic: string;
  inputs: RoiInputs;
}

export interface StudyPlan {
  calculation_version: string;
  matrix_version: string;
  exam: string;
  exam_date: string | null;
  days_to_exam: number | null;
  strategy_mode: StrategyMode;
  strategy_title: string;
  strategy_text: string;
  study_hours: number;
  calibrated: boolean;
  topics: PlanTopic[];
  focus: PlanTopic[];
  deprioritised: Deprioritised[];
  effort_flags: EffortFlag[];
  projected_score: ProjectedScore;
  weekly_calendar: CalendarDay[];
  roadmap: RoadmapStage[];
  explanation: RoiExplanation | null;
  allocation_note: string;
}

export interface Result {
  submission: Submission;
  total_score: number;
  total_marks: number;
  overall_mastery: number; // 0-100
  ocr_confidence: number | null;
  topic_mastery: TopicMastery[];
  roi_recommendations: Priority[];
  strengths_gaps: { strengths: string[]; gaps: string[] };
  question_evaluations: QuestionEvaluation[];
  processing_log: ProcessingLogEntry[];
  rubric: RubricRef;
  urgency: Urgency;
  urgency_reasons: string[];
  percentage: number;
  /** AI narrative (call 2); null for older rows. */
  summary: string | null;
  /** Deterministic paragraphs built only from computed numbers. */
  executive_summary: string[];
  teaching_nudges: TeachingNudge[];
  confusions: Confusion[];
  outcome_counts: OutcomeCounts;
  subject_rollup: SubjectRollup[];
  scoring_controls: ScoringControls;
  roi_basis: RoiBasis;
  report_meta: ReportMeta;
  release: ReleaseInfo;
  /** Null for demo rows and rows uploaded before hashing existed. */
  custody: Custody | null;
  extraction: Extraction;
  cost: CostSummary;
  latency: LatencySummary;
  history: HistoryEntry[];
  versions: EvaluationVersion[];
  deliveries: Delivery[];
  study_plan: StudyPlan;
}

/** Body of a 202 from GET /api/results/{id} (pending, processing, human review, failed). */
export interface ResultPending {
  status: SubmissionStatus;
  detail: string;
  submission: Submission;
  /** Audit trail so far (same entries as Result.processing_log). */
  processing_log: ProcessingLogEntry[];
}

// --------------------------------------------------------------------------- //
// Cohort (GET /api/cohort)
// --------------------------------------------------------------------------- //
export interface CohortFilters {
  batch_id: number | null;
  rubric_id: number | null;
  urgency: Urgency | null;
  topic: string | null;
}

export interface UrgencyCounts {
  on_track: number;
  needs_attention: number;
  at_risk: number;
}

export interface RankingRow {
  rank: number;
  submission_id: number;
  student_name: string;
  student_ref: string;
  score: number;
  total_marks: number;
  pct: number;
  urgency: Urgency;
}

export interface AtRiskRow {
  submission_id: number;
  student_name: string;
  pct: number;
  reasons: string[];
  top_gap: string | null;
}

export interface CommonError {
  question: number;
  topic: string;
  error: string;
  count: number;
  denominator: number;
  students: string[];
}

export interface ClassIntervention {
  topic: string;
  action: string;
  students_count: number;
  rationale: string;
}

export interface ConfusionCluster {
  concept_a: string;
  concept_b: string;
  count: number;
  students: string[];
}

export interface ExcludedStudents {
  review: string[];
  failed: string[];
  processing: string[];
}

export interface Operations {
  calls: number;
  total_cost_inr: number;
  avg_cost_per_student_inr: number | null;
  ocr_cache_hits: number;
  avg_latency_seconds: number | null;
  p95_latency_seconds: number | null;
  over_latency_target: number;
  dlq_count: number;
  mean_ocr_confidence: number | null;
  target_inr: number;
  target_latency_seconds: number;
}

export interface ReleaseCounts {
  provisional: number;
  released: number;
}

export interface Cohort {
  institution: Institution;
  batch: Batch;
  total_submissions: number;
  completed: number;
  processing: number;
  human_review: number;
  failed: number;
  average_score: number | null;
  average_mastery: number | null;
  total_marks: number;
  topic_mastery: { topic: string; mastery: number }[];
  score_distribution: { label: string; count: number }[];
  top_priorities: Priority[];
  is_demo: boolean;
  demo_count: number;
  real_count: number;
  filters: CohortFilters;
  rubric_versions: RubricRef[];
  /** True when the completed set mixes different rubrics (compared by percentage). */
  mixed_rubrics: boolean;
  urgency_counts: UrgencyCounts;
  ranking: RankingRow[];
  at_risk: AtRiskRow[];
  common_errors: CommonError[];
  interventions: ClassIntervention[];
  confusion_clusters: ConfusionCluster[];
  excluded: ExcludedStudents;
  operations: Operations;
  release_counts: ReleaseCounts;
}

// --------------------------------------------------------------------------- //
// Students & dashboard filters
// --------------------------------------------------------------------------- //
export interface TopicPoint {
  topic: string;
  subject: string;
  mastery: number;
}

export interface FocusItem {
  topic: string;
  roi: number;
  rank: number;
  projected_gain_marks: number | null;
  quadrant: Quadrant;
}

export interface StudentCard {
  submission_id: number;
  student_name: string;
  student_ref: string;
  batch: Batch;
  test: RubricRef;
  status: SubmissionStatus;
  score: number | null;
  total_marks: number;
  percentage: number | null;
  urgency: Urgency | null;
  strengths: string[];
  gaps: string[];
  nudges: TeachingNudge[];
  topic_mastery: TopicPoint[];
  top_focus: FocusItem[];
  release_status: ReleaseStatus | null;
  is_demo: boolean;
  created_at: string;
}

export interface TestOption {
  rubric_id: number;
  name: string;
  version: string;
  status: RubricStatus;
  batch_ids: number[];
}

export interface DashboardFilters {
  batches: Batch[];
  tests: TestOption[];
  urgencies: Urgency[];
  topics: string[];
}

// --------------------------------------------------------------------------- //
// OCR review, pages & operations
// --------------------------------------------------------------------------- //
export interface PageRef {
  page_number: number;
  /** Relative API path of the processed page image; build the URL with pageImageUrl(). */
  url: string;
  original_url: string | null;
  media_type: string;
  width: number | null;
  height: number | null;
}

export interface ReviewAnswer {
  question: number;
  topic: string;
  prompt: string | null;
  answer: string;
  confidence: number | null;
  source_pages: number[];
  uncertain_words: UncertainWord[];
}

export interface OcrReview {
  id: number;
  reviewer: string;
  action: ReviewAction;
  note: string | null;
  changed_questions: number[];
  created_at: string;
}

export interface OcrReviewData {
  submission_id: number;
  status: SubmissionStatus;
  threshold: number;
  has_transcript: boolean;
  answers: ReviewAnswer[];
  page_confidences: PageConfidence[];
  flagged_pages: number[];
  pages: PageRef[];
  reviews: OcrReview[];
}

export interface ModelInvocation {
  id: number;
  submission_id: number | null;
  purpose: InvocationPurpose;
  provider: string;
  model_requested: string;
  model_served: string | null;
  request_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  image_count: number;
  latency_ms: number;
  status: InvocationStatus;
  error_code: string | null;
  fell_back: boolean;
  cost_usd: number | null;
  cost_inr: number | null;
  created_at: string;
}

export interface CostGroup {
  key: string;
  calls: number;
  cost_inr: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface OpsCosts {
  group_by: string;
  groups: CostGroup[];
  total_cost_inr: number;
  calls: number;
  students: number;
  avg_cost_per_student_inr: number | null;
  ocr_cache_hits: number;
  target_inr: number;
  usd_inr: number;
}

export interface IntakeBatchStatus {
  intake_batch_id: string;
  total: number;
  completed: number;
  human_review: number;
  failed: number;
  processing: number;
  started_at: string | null;
  elapsed_seconds: number | null;
  eta_seconds: number | null;
  target_seconds: number;
}

// --------------------------------------------------------------------------- //
// Rubrics, re-evaluation, consistency & weightage
// --------------------------------------------------------------------------- //
export interface RubricDraft {
  draft: RubricContent;
  warnings: string[];
  source: RubricSource;
  ai_drafted_questions: number[];
}

export interface RubricCompatibility {
  /** True when the question-number sets are identical (stored OCR can be reused as-is). */
  reusable: boolean;
  added: number[];
  removed: number[];
  changed: number[];
}

export interface RubricVersionResult {
  rubric: Rubric;
  compatibility: RubricCompatibility;
  queued_submission_ids: number[];
}

/** GET /api/rubrics/{id}/reevaluation-estimate - shown in the confirm step before a bulk re-run. */
export interface ReevaluationEstimate {
  rubric_id: number;
  submission_ids: number[];
  students: number;
  live_students: number;
  demo_students: number;
  /** One grading call per live student; OCR is reused (0 vision calls). */
  evaluation_calls: number;
  ocr_calls: number;
  estimated_cost_inr: number;
  estimated_cost_per_student_inr: number;
  basis: string;
}

export interface ConsistencyDelta {
  question: number;
  original: number;
  regrade: number;
  delta: number;
}

export interface ConsistencyCheck {
  submission_id: number;
  runs: number;
  tolerance: number;
  total_original: number;
  total_regrade: number;
  max_abs_delta_total: number;
  within_tolerance: boolean;
  deltas: ConsistencyDelta[];
  checked_at: string;
}

/** Hours to reach about 85% starting from mastery 0-40 / 40-70 / 70-90. */
export interface EffortBands {
  from_low: number;
  from_mid: number;
  from_high: number;
}

export interface ChapterWeight {
  subject: string;
  chapter: string;
  aliases: string[];
  avg_questions_per_paper: number;
  avg_marks: number;
  weightage_rank: number;
  effort_hours: EffortBands;
  historic_error_rate: number | null;
  confidence: number;
}

export interface WeightageMatrix {
  exam: string;
  version: string;
  source: string;
  confidence: number;
  /** Always true in this PoC: sample matrix, not licensed past-paper data. */
  illustrative: boolean;
  total_marks: number;
  chapters: ChapterWeight[];
}

export interface ExamOption {
  exam: string;
  enabled: boolean;
  note: string;
}

export interface DemoSeedResult {
  message: string;
  created: number;
}

/** Error body: {detail, code?}. Codes are snake_case (see API_CONTRACT.md). */
export interface ApiErrorBody {
  detail: string;
  code?: string;
}

// --------------------------------------------------------------------------- //
// Request bodies
// --------------------------------------------------------------------------- //
export interface ReviewInput {
  reviewer: string;
  /** Only "approve" or "correct" are accepted here (rescan is its own endpoint). */
  action: ReviewAction;
  answers: { question: number; answer: string }[];
  note: string | null;
}

export interface ReevaluateInput {
  rubric_id: number | null;
}

export interface RubricCreateInput {
  content: RubricContent;
  parent_id: number | null;
  change_note: string | null;
  approved: boolean;
}

export interface RubricVersionInput {
  content: RubricContent;
  change_note: string | null;
  reprocess: boolean;
}

export interface BatchPatchInput {
  exam?: string;
  /** null resets to the assumed default (NEET_EXAM_DATE). */
  exam_date?: string | null;
}

export interface ReleaseInput {
  reviewer_name: string;
  note: string | null;
}

export interface DeliveryInput {
  submission_ids: number[];
  /** "whatsapp" only (simulated). */
  channel: string;
  recipient: string | null;
}
