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

/**
 * Why a HUMAN_REVIEW_REQUIRED sheet was held: the sheet or a page below the OCR threshold, no rubric
 * question answered although the pages read clearly (usually the wrong rubric), fewer than half
 * answered, another paper / the wrong rubric (same-paper or shape check), or the same paper in
 * another code / set.
 */
export type ReviewReason =
  | "low_confidence"
  | "low_page_confidence"
  | "no_answers"
  | "mostly_blank"
  | "paper_mismatch"
  | "paper_reordered";

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
export type InvocationPurpose =
  | "ocr"
  | "evaluation"
  | "consistency"
  | "rubric_parse"
  | "transcription"
  | "voice_mapping"
  | "bloom_detect"
  | "llm_drill";
export type LanguageHint = "en" | "hi" | "ta" | "kn" | "te";
export type ReviewAction = "approve" | "correct" | "rescan";
export type RubricSource = "text" | "pdf" | "docx" | "json" | "image";
/** What an intake file looks like (POST /api/intake/inspect, read from its text layer, no AI). */
export type PaperRole = "answer_key_paper" | "question_paper" | "answer_sheet" | "unknown";
/**
 * How a printed paper's questions line up with a rubric: match = same paper; reordered = the same
 * questions under other numbers (another code / set); mismatch = a different paper; unknown = too
 * little text to tell.
 */
export type RubricMatchVerdict = "match" | "reordered" | "mismatch" | "unknown";
/** What an answer-key import read (POST /api/rubrics/answer-key). */
export type AnswerKeySource = "text" | "pdf" | "docx" | "image";
/** parsed = read from the text with no AI call; ai = read from page images. */
export type AnswerKeyMethod = "parsed" | "ai";
/** "insights" = the insights sample set (MCQ papers, NEET-C (sample), interventions); not part of "all". */
export type DemoSet = "genetics" | "mixed" | "all" | "insights";
// --- contract v3 ---
export type QuestionType = "descriptive" | "mcq";
/** Bloom's taxonomy: K1 Remember, K2 Understand, K3 Apply, K4 Analyse, K5 Evaluate. */
export type BloomLevel = "K1" | "K2" | "K3" | "K4" | "K5";
/** Who set a Bloom level: faculty, AI suggestion (accepted), or the verb heuristic. */
export type BloomSource = "faculty" | "ai" | "heuristic";
export type PartialCreditMode = "steps" | "proportional" | "all_or_nothing";
export type InputKind = "document" | "voice";
export type RiskLevel = "low" | "medium" | "high";
export type TransferClass = "memorisation" | "transferable" | "foundational_gap" | "inconsistent" | "developing";
export type InterventionKind = "nudge" | "study_focus" | "class_intervention" | "custom";
export type OutcomeStatus = "pending" | "improved" | "flat" | "declined" | "not_assessed";
export type BloomDetectMode = "ai" | "heuristic";
export type LlmRole = "primary" | "fallback";

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
  /** Free-text faculty lead (no users table in the PoC); PATCH /api/batches/{id}. */
  faculty_lead: string | null;
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
  /** MAX_PDF_PAGES: most pages one PDF / DOCX answer sheet may have (default 40, a full printed paper). */
  max_pdf_pages: number;
  /** e.g. ["pdf", "jpeg", "png", "webp", "docx"] */
  accepted_upload_types: string[];
  /** VOICE_ANSWERS switch (OpenAI transcription - not residency-approved, PoC only). */
  voice_enabled: boolean;
  /** voice_enabled AND an OpenAI key is configured. */
  voice_ready: boolean;
  /** e.g. "gpt-transcribe" (stand-in for Whisper large-v3 / Sarvam Saarika). */
  transcription_model: string;
  /** ["mp3", "wav", "m4a", "ogg"] - reported separately from accepted_upload_types. */
  accepted_voice_types: string[];
  /** The fallback model name (e.g. "gpt-4o", announced shutdown 2027-01-14), or "off". */
  llm_fallback: string;
  lms_api_enabled: boolean;
  /** INTERVENTION_DEFAULT_HOURS: default study hours for a logged intervention (0.5-40). */
  intervention_default_hours: number;
}

/** One step of a per-question marking scheme (FR-3.8). Step marks add up to max_marks. */
export interface MarkingStep {
  criterion: string;
  marks: number;
  /** Required step: below 50% of its marks the whole question scores 0. */
  required?: boolean;
}

/** Rubric-wide marking policy. Questions may override partial_credit / mark_step. */
export interface MarkingPolicy {
  partial_credit: PartialCreditMode;
  /** 0.25 | 0.5 | 1 | 2 */
  mark_step: number;
  /** Marks deducted for a wrong / multi-marked MCQ (e.g. 1 for NEET +4/-1). */
  negative_marks: number;
  scheme_name?: string;
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
  // --- MCQ, Bloom and marking-scheme fields (absent on older rubrics) ---
  question_type?: QuestionType;
  /** MCQ option texts (2-6), lettered A-F. */
  options?: string[];
  /** MCQ correct option letter (A-F). */
  correct_option?: string;
  /**
   * MCQ whose key accepts several options (2-6 distinct letters within its options; "2 or 3" in a
   * publisher key): any of them scores full marks. null / absent when unused; correct_option is then
   * null or one of these.
   */
  accepted_options?: string[] | null;
  /** MCQ bonus question: full marks to every student whatever they marked (correct_option may be null). */
  bonus?: boolean;
  /** MCQ only: overrides marking_policy.negative_marks. */
  negative_marks?: number;
  bloom_level?: BloomLevel;
  bloom_source?: BloomSource;
  /** Concept group for memorisation-vs-transfer (else chapter, else topic). */
  concept?: string;
  /** Descriptive only: per-step marks, adding up to max_marks. */
  marking_scheme?: MarkingStep[];
  partial_credit?: PartialCreditMode;
  mark_step?: number;
}

export interface RubricContent {
  name: string;
  subject: string;
  questions: RubricQuestion[];
  /** Absent = the default rule (0.5-mark steps, no negative marking). */
  marking_policy?: MarkingPolicy;
  /** Printed paper code / set / version ("Code A", "Set 2", "Code 45"); absent or null when unknown. */
  paper_code?: string | null;
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
  /** SHA-256 of the answer key (rubric_id's content); absent on older API builds. */
  rubric_hash?: string | null;
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
  /** "voice" for audio answers (FR-2.8); older rows read as "document". */
  input_kind: InputKind;
  audio_seconds: number | null;
  /** Per-question voice recording: the rubric question it answers. */
  voice_question: number | null;
  detected_languages: string[];
  /** Set only while HUMAN_REVIEW_REQUIRED; absent on older API builds (read as null). */
  review_reason?: ReviewReason | null;
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
  // --- contract v3 (filled at read time for older rows) ---
  question_type: QuestionType;
  bloom_level: BloomLevel | null;
  bloom_source: BloomSource | null;
  /** Level the answer actually showed (AI grader); null for MCQs and blanks. */
  demonstrated_level: BloomLevel | null;
  concept: string | null;
  /** Marks deducted (MCQ negative marking); estimated_marks is already net of it. */
  penalty: number;
  /** MCQ: letter, "MULTI", "UNKNOWN" or null (blank). */
  selected_option: string | null;
  correct_option: string | null;
  marking_breakdown: MarkingAward[];
  marking_note: string | null;
  /**
   * MCQ bonus question (full marks to everyone, attempted or not): set at read time from outcome
   * "BONUS", a bonus flag or the bonus marking note; its outcome then reads FULL.
   */
  bonus?: boolean;
  /** MCQ: every option the key accepts (["B", "C"] for a multi-answer key); correct_option is the first. */
  accepted_options?: string[];
  /** What happened on this question, in the paper's vocabulary (MCQ: right/wrong/blank/bonus). */
  result_kind?: ResultKind;
}

/** right / wrong / blank / bonus on MCQ papers; partial and zero on written answers. */
export type ResultKind = "right" | "wrong" | "blank" | "bonus" | "partial" | "zero";

/** Marks awarded for one marking-scheme step (recomputed server-side). */
export interface MarkingAward {
  criterion: string;
  marks: number;
  awarded: number;
  required: boolean;
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
  /** Non-bonus questions scored right (FULL). */
  right?: number;
  /** Non-bonus MCQs answered wrong (a penalty was applied or no marks for a marked option). */
  wrong?: number;
  /** Bonus questions (full marks to everyone); counted inside `full`. */
  bonus?: number;
  /** Non-bonus MCQs answered (right + wrong). */
  attempted?: number;
}

/** How a subject lost its marks: mostly blanks, mostly wrong answers, both, or neither (>= 70%). */
export type SubjectDiagnosis = "skipping" | "wrong_answers" | "mixed" | "solid";

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
  // --- report redesign (optional: older API builds omit them; normalize fills them) ---
  right?: number;
  wrong?: number;
  /** Blank non-bonus questions. */
  blank_scorable?: number;
  bonus?: number;
  bonus_marks?: number;
  /** Non-bonus questions answered. */
  attempted?: number;
  /** attempted / (questions - bonus), 0-1. */
  attempt_rate?: number | null;
  /** right / attempted, 0-1. */
  accuracy_attempted?: number | null;
  /** Marks deducted by negative marking. */
  penalty?: number;
  /** max_marks - score. */
  marks_dropped?: number;
  /** max(0, 0.85 x max_marks - score). */
  gain_to_target?: number;
  band?: Urgency;
  diagnosis?: SubjectDiagnosis;
}

// --------------------------------------------------------------------------- //
// Report redesign: key insights, the score band and the focus list (server-built)
// --------------------------------------------------------------------------- //
export interface KeyInsightFigure {
  key: string;
  label: string;
  value: number | string;
  unit?: string | null;
  /** How the figure was computed, e.g. "sum of max_marks over 47 non-bonus blanks = 47 x 4". */
  formula?: string | null;
}

export type InsightEvidenceKind = "questions" | "subject" | "topic";
export type InsightEvidenceFilter = "wrong" | "blank";
export type InsightId = "attempts" | "subjects" | "gain";
export type InsightTone = "good" | "warn" | "neutral";
export type TargetSource = "on_track_line" | "batch_target";
export type FocusLevel = "chapter" | "subject";

export interface KeyInsightEvidence {
  kind: InsightEvidenceKind;
  filter?: InsightEvidenceFilter | null;
  refs: number[];
  subject?: string | null;
  topic?: string | null;
  /** Element id on the report page, e.g. "questions", "subject-physics", "focus-physics". */
  anchor: string;
}

export interface KeyInsight {
  id: InsightId | string;
  tone: InsightTone;
  headline: string;
  detail: string;
  figures: KeyInsightFigure[];
  evidence: KeyInsightEvidence | null;
  /** The number in `detail` to highlight ("+35", "518/720"). */
  highlight?: string | null;
}

export interface ScoreBandRange {
  key: Urgency;
  label: string;
  from_marks: number;
  to_marks: number;
  from_pct: number;
  to_pct: number;
}

export interface ScoreBand {
  key: Urgency;
  label: string;
  pct: number;
  thresholds: ScoreBandRange[];
  target_marks: number;
  target_pct: number;
  target_source: TargetSource;
  marks_to_target: number;
  right_answers_to_target: number;
  /** Batch median (marks), only when the batch has 5 or more other graded students. */
  batch_median_marks?: number | null;
}

/** Learn (mostly unseen), drill / fix errors (mostly wrong answers) or review (>= 70%). */
export type FocusAction = "learn" | "drill" | "fix_errors" | "review";

export interface FocusTopicRow {
  topic: string;
  subject: string;
  n: number;
  score: number;
  max_marks: number;
  mastery: number;
  right: number;
  wrong: number;
  blank: number;
  marks_dropped: number;
  /** max(0, target% x max_marks - score) (FocusTopics.target_pct), the same formula as the "gain" key insight. */
  gain: number;
  /** From the diagnosis: skipped -> learn, wrong answers -> drill, 70%+ -> review. */
  action: FocusAction;
  what_to_study: string;
  /** Blank first for "learn", else wrong first. */
  question_refs: number[];
  wrong_refs?: number[];
  blank_refs?: number[];
  /** Fewer than 3 questions behind the row. */
  low_evidence: boolean;
}

export interface FocusKeepWarm {
  topic: string;
  subject: string;
  mastery: number;
}

export interface FocusTopics {
  level: FocusLevel;
  chapters_available: boolean;
  reason: string;
  /** The score card's target (On track line or batch target) while below it, else the 85% stretch. */
  target_pct?: number;
  rows: FocusTopicRow[];
  /** Areas already at the target: "keep warm". */
  keep_warm?: FocusKeepWarm[];
  keep_warm_more?: number;
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
  /** "placeholder" when effort hours are the rubric default (1.0 h), not the chapter matrix: ROI per hour is hidden. */
  effort_source_kind?: string | null;
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
  /** "voice" rows are oral checks (listed apart from papers). Optional: older API builds omit it. */
  input_kind?: InputKind;
  /** The test (rubric) id, so repeats of the same test can be labelled. */
  rubric_id?: number | null;
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

/** GET /api/results/{id}/versions (archived versions + the current one, oldest first). */
export interface ResultVersion {
  version: number;
  created_at: string;
  rubric_id: number;
  rubric_version: string;
  total_score: number;
  total_marks: number;
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
  /** Minutes this topic gets in the weekly calendar (sum of its blocks). */
  minutes?: number | null;
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
  /** Sum of the weekly calendar's block minutes: the one planned-time figure on the page. */
  planned_minutes_total?: number | null;
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
  // --- contract v3 (guarded extension hooks: a failure falls back to the empty value) ---
  llm_routes: LlmRoute[];
  patterns: StudentPatterns;
  interventions: InterventionRecord[];
  /** Null for document uploads. */
  voice: VoiceInfo | null;
  /** True on an archived snapshot from GET /api/results/{id}/versions/{version}. */
  superseded?: boolean;
  /** Version number that replaced this snapshot (null when unknown or current). */
  superseded_by?: number | null;
  // --- report redesign (optional: older API builds omit them; normalize defaults them) ---
  /** Exactly three deterministic insights (attempts, subjects, gain); [] on older payloads. */
  key_insights?: KeyInsight[];
  /** The one band system (urgency thresholds) with the bullet chart's ranges and target. */
  score_band?: ScoreBand | null;
  /** Top chapters (or subjects when no chapters were read) by expected gain. */
  focus_topics?: FocusTopics | null;
  /** Student-facing summary paragraphs (no OCR/coverage line, no question lists). */
  student_summary?: string[];
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
  /** Cohort page: students who sat a test on which this confusion was seen (count's denominator). */
  denominator?: number | null;
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

// --- Cohort page (GET /api/cohort?per_student=true) -------------------------- //
/** "sitting": one test (every key version) of one batch, or of all batches; "all": each student's latest test. */
export type CohortMode = "sitting" | "all";
/** What put a student in their urgency band. */
export type CohortReason = "below_55" | "below_70" | "low_chapters";
export type CohortItemFlag = "possible_key_error" | "hard" | "often_skipped" | "weak_discrimination";
export type CohortSummaryKind = "average" | "students" | "chapter" | "key";

export interface CohortKeyVersion {
  rubric_id: number;
  version: string;
  /** Completed sheets in scope graded with this key version. */
  sheets: number;
  latest: boolean;
}

/** One batch sitting one test (an answer-key family); each student counted once (latest sheet). */
export interface CohortSitting {
  batch_id: number;
  batch_name: string;
  /** Root id of the answer-key family. */
  test_id: number;
  rubric_ids: number[];
  latest_rubric_id: number;
  key_versions: CohortKeyVersion[];
  test_name: string;
  /** "Mock 09" - for mid-sentence use. */
  short_name: string;
  total_marks: number | null;
  date: string;
  students: number;
  sheets: number;
  average_pct: number | null;
  median_pct: number | null;
  urgency_counts: UrgencyCounts;
  /** At least 3 students. */
  is_class: boolean;
  /** Its class average compares with the batch's previous class sitting (null: small sitting or none before). */
  comparable_previous?: boolean | null;
}

export interface CohortScope {
  mode: CohortMode;
  batch_id: number | null;
  batch_name: string | null;
  test_id: number | null;
  test_name: string | null;
  short_name: string | null;
  rubric_ids: number[];
  latest_rubric_id: number | null;
  total_marks: number | null;
  date: string | null;
  /** N: one latest sheet per student. */
  students: number;
  /** Completed sheets in scope (a student may have several). */
  sheets: number;
  key_versions: CohortKeyVersion[];
  is_class: boolean;
  /** Different tests (key families) among the students' sheets. */
  tests?: number;
  /** Every sheet in scope (any status, before the one-per-student rule). */
  sheets_in_scope?: number;
  /** Of sheets_in_scope, synthetic demo sheets. */
  demo_sheets?: number;
  /** Students whose older graded sheet in scope was replaced by their latest one. */
  superseded?: string[];
}

export interface CohortPrevious {
  batch_id: number;
  test_id: number;
  test_name: string;
  short_name: string;
  date: string;
  students: number;
  average_pct: number | null;
  median_pct: number | null;
  urgency_counts: UrgencyCounts;
  negative_marks_total: number | null;
  negative_per_student?: number | null;
  attempt_rate: number | null;
  accuracy_attempted: number | null;
  blanks_per_student: number | null;
  blank_rate?: number | null;
  /** Same subjects and at least half the class sat both: the class averages are compared. */
  comparable?: boolean;
  /** Why the class averages are not compared ("different subjects", "only 4 of 12 sat both"). */
  note?: string | null;
  /** At risk now, not at risk on the previous test. */
  newly_at_risk?: number;
}

export interface CohortHeadline {
  average_pct: number | null;
  median_pct: number | null;
  p25_pct: number | null;
  p75_pct: number | null;
  /** One test with one total only. */
  average_marks: number | null;
  total_marks: number | null;
  top_pct: number | null;
  top_student: string | null;
  top_submission_id: number | null;
  /** Sheets below 0 marks (their percentage is clamped to 0). */
  negative_scores: number;
  /** Class average minus the previous class sitting's (exact, 1 dp). */
  delta_pts?: number | null;
  lowest_pct?: number | null;
  lowest_student?: string | null;
  lowest_submission_id?: number | null;
}

export interface CohortStudentTopic {
  topic: string;
  mastery: number;
  right: number;
  questions: number;
}

export interface CohortStudentRow {
  rank: number;
  submission_id: number;
  student_ref: string;
  student_name: string;
  rubric_id: number;
  score: number;
  total_marks: number;
  pct: number;
  urgency: Urgency;
  short_reason: CohortReason | null;
  reasons: string[];
  low_chapters: number;
  weakest_topic: string | null;
  mcq_count: number;
  attempted: number;
  right: number;
  wrong: number;
  blanks: number;
  negative_marks: number;
  accuracy_attempted: number | null;
  prev_pct: number | null;
  change_pts: number | null;
  prev_urgency: Urgency | null;
  newly_at_risk: boolean;
  release_status: ReleaseStatus;
  topics: CohortStudentTopic[];
}

export interface CohortAttemptTopic {
  topic: string;
  subject: string;
  answers: number;
  attempted: number;
  right: number;
  wrong: number;
  blanks: number;
  negative_marks: number;
  accuracy_attempted: number | null;
  blank_rate: number;
  /** A whole subject (a paper tagged by subject only). */
  subject_level?: boolean;
}

/** Pooled over every MCQ answer in the student set (0-100 percentages). */
export interface CohortAttempt {
  students: number;
  mcq_answers: number;
  questions_per_student: number;
  attempted: number;
  right: number;
  wrong: number;
  blanks: number;
  attempt_rate: number;
  accuracy_attempted: number | null;
  blanks_per_student: number;
  negative_marks_total: number;
  negative_per_student: number;
  /** % of MCQ answers left blank (its own 1-dp figure). */
  blank_rate?: number | null;
  /** Every paper has the same number of MCQs (else blanks per student means little). */
  same_length?: boolean;
  /** Answers to bonus questions, left out of every figure above. */
  bonus_answers?: number;
  by_topic: CohortAttemptTopic[];
}

export interface CohortHardestQuestion {
  question: number;
  correct: number;
  n: number;
  type?: string;
  /** Share right, 0-1 (written answers: share of the marks). */
  p?: number | null;
}

export interface CohortChapterStudent {
  submission_id: number;
  student_name: string;
  student_ref: string;
  mastery: number;
}

export interface CohortChapter {
  topic: string;
  subject: string;
  questions: number;
  students: number;
  mean: number;
  below_60: number;
  below_40: number;
  weightage: number;
  /** Chapter matrix avg marks / exam total (0-1); null = not in the NEET chapter table. */
  neet_weight?: number | null;
  subject_level: boolean;
  /** Fewer than 2 questions or fewer than 3 students. */
  thin: boolean;
  /** Ranked for a re-teach from one question (a short paper): treat as a hint. */
  hint?: boolean;
  prev_mean: number | null;
  change: number | null;
  hardest_question: CohortHardestQuestion | null;
  below_60_students: CohortChapterStudent[];
  /** 1 = re-teach first; null = not eligible (thin, subject-level or nobody below 60%). */
  reteach_rank: number | null;
}

export interface CohortSubject {
  subject: string;
  mean: number;
  students: number;
  prev_mean: number | null;
  change: number | null;
}

export interface CohortOptionCount {
  option: string;
  count: number;
}

export interface CohortItem {
  question: number;
  topic: string;
  subject: string;
  type: string;
  max_marks: number;
  key: string | null;
  n: number;
  correct: number;
  partial: number;
  wrong: number;
  blank: number;
  options: CohortOptionCount[];
  top_wrong_option: string | null;
  top_wrong_count: number;
  /** Another wrong option was chosen as often. */
  top_wrong_tied?: boolean;
  top_group_size: number;
  top_group_chose_wrong: number;
  negative_marks: number;
  /** Share right, 0-1 (written answers: share of the marks). */
  p: number;
  /** Top 27% minus bottom 27%; only from 8 answers. */
  discrimination: number | null;
  flags: CohortItemFlag[];
}

export interface CohortPairedRow {
  submission_id: number;
  student_ref: string;
  name: string;
  prev: number;
  now: number;
  change: number;
  /** Short name of the earlier sheet's test. */
  prev_test?: string;
  /** False: different papers, so the change is never up / down. */
  comparable?: boolean;
}

/** Each student against the sheet they sat just before: the same figures and counts as OwnerProgress (backend sittings.progress, comparable pairs only). */
export interface CohortPaired {
  /** Comparable pairs. */
  paired: number;
  mean_before: number | null;
  mean_after: number | null;
  /** mean_after - mean_before */
  mean_change: number | null;
  /** Pairs on papers that are not comparable. */
  not_comparable?: number;
  /** Up 5 points or more. */
  improved: number;
  /** Down 5 points or more. */
  declined: number;
  /** Moved less than 5 points either way. */
  steady: number;
  rows: CohortPairedRow[];
}

export interface CohortBatchCompare {
  batch_id: number;
  batch_name: string;
  students: number;
  average_pct: number | null;
  date: string;
  is_current: boolean;
  thin: boolean;
}

export interface CohortSummaryLine {
  kind: CohortSummaryKind;
  text: string;
  /** Relative query ("?tab=students&urgency=at_risk") on /cohort. */
  href: string;
}

export interface CohortReading {
  /** 0-1, over the student set. */
  mean_confidence: number | null;
  /** Live (non-demo) sheets only. */
  avg_seconds_per_sheet: number | null;
  live_sheets: number;
  costed_sheets: number;
  cost_per_live_sheet_inr: number | null;
  live_cost_inr: number;
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
  /** Exam-behaviour patterns (guarded; empty on failure). */
  patterns: CohortPatterns;
  // Cohort page fields: sent with per_student=true (empty / null otherwise, and absent on older APIs).
  scope?: CohortScope | null;
  sittings?: CohortSitting[];
  previous?: CohortPrevious | null;
  headline?: CohortHeadline | null;
  students_view?: CohortStudentRow[];
  attempt?: CohortAttempt | null;
  chapters?: CohortChapter[];
  subjects?: CohortSubject[];
  item_analysis?: CohortItem[] | null;
  paired_change?: CohortPaired | null;
  batch_comparison?: CohortBatchCompare[];
  summary?: CohortSummaryLine[];
  reading?: CohortReading | null;
  interventions_logged?: number;
  data_version?: string;
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
  /** Why the urgency is what it is (analytics.classify_urgency); empty for ungraded sheets. */
  urgency_reasons?: string[];
  input_kind?: InputKind;
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
// Students roster (GET /api/students/roster): one row per student, not per sheet
// --------------------------------------------------------------------------- //
/** Change vs the previous paper: >= +5 pts improving, <= -5 pts slipping, otherwise steady. */
export type Trend = "improving" | "steady" | "slipping";

export interface SubjectScore {
  subject: string;
  score: number;
  max_marks: number;
  pct: number;
}

/** The report's attempts insight on a negatively marked paper (students roster exam technique). */
export type TechniqueVerdict = "guessing" | "skipping" | "ok";

/** patterns.negative_marking_profile of the latest paper, condensed. items = attempted + blank. */
export interface NegativeMarkingBrief {
  scheme: string;
  /** 0-1 accuracy at which attempting breaks even (0.2 for +4/-1). */
  break_even: number;
  items: number;
  attempted: number;
  correct: number;
  wrong: number;
  blank: number;
  /** 0-1 */
  accuracy: number | null;
  marks_lost: number;
  /** Worst per-topic penalty risk (one topic is enough); shown per topic via risky_topics. */
  risk: RiskLevel;
  /** verdict === "skipping" (the report says blanks are holding the score back). */
  under_attempting: boolean;
  recommendation: string;
  /** The report's attempts insight: guessing = wrong answers costing marks, skipping = blanks
   * holding the score back, ok = the attempt strategy is working. */
  verdict: TechniqueVerdict;
  /** The report's attempts headline, word for word. */
  headline: string;
  /** Topics at medium / high penalty risk on this paper. */
  risky_topics: string[];
}

export interface RosterPaper {
  submission_id: number;
  test_id: number;
  test_name: string;
  /** "Mock 09" for "NEET MCQ Practice - Mock 09 (sample)"; chapter tests stay whole. */
  short_name: string;
  test_version: string;
  date: string;
  score: number;
  total_marks: number;
  pct: number;
  /** Question count of the paper. */
  questions: number;
  urgency: Urgency;
  urgency_reasons: string[];
  release_status: ReleaseStatus;
}

/** The newest sheet that is not graded yet (held, failed, processing). */
export interface RosterPending {
  submission_id: number;
  status: SubmissionStatus;
  review_reason: ReviewReason | null;
  date: string;
}

export interface RosterPrevious {
  submission_id: number;
  test_name: string;
  short_name: string;
  date: string;
  pct: number;
  total_marks: number;
  questions: number;
  /** Same test, or both full papers (10+ Qs) over the same subjects; only then is there a trend. */
  comparable: boolean;
}

export interface RosterSparkPoint {
  submission_id: number;
  date: string;
  pct: number;
  test_name: string;
  short_name: string;
}

/** The student's newest graded paper outside the batch / test filter, when newer than latest. */
export interface RosterNewer {
  submission_id: number;
  test_name: string;
  short_name: string;
  date: string;
  pct: number;
}

export interface RosterTopicMastery {
  topic: string;
  subject: string;
  mastery: number;
  /** Questions on the topic in the latest paper. */
  n: number;
  /** The "topic" is a whole subject (the paper had no chapter tags). */
  subject_level: boolean;
}

export interface RosterAction {
  id: number;
  topic: string;
  kind: InterventionKind;
  applied_at: string;
  applied_by: string;
  outcome_status: OutcomeStatus;
  mastery_change: number | null;
}

export interface RosterActions {
  count: number;
  /** Records applied at or after the latest paper's upload. */
  since_latest: number;
  last: RosterAction | null;
}

/** 1 at risk, no action since latest; 2 slipping; 3 needs attention with 2+ topics < 40%, no
 * action; 4 at risk with an action logged. null = not flagged. */
export interface RosterPriority {
  tier: number | null;
  reason: string;
}

export interface RosterRow {
  student_ref: string;
  student_name: string;
  is_demo: boolean;
  batch: Batch;
  latest: RosterPaper | null;
  pending: RosterPending | null;
  /** Every sheet in scope that is held, failed or being marked (older ones too), newest first. */
  waiting: RosterPending[];
  newer: RosterNewer | null;
  previous: RosterPrevious | null;
  delta_pct: number | null;
  trend: Trend | null;
  /** Up to 6 papers ending with latest, oldest first (oral checks excluded). */
  spark: RosterSparkPoint[];
  papers_count: number;
  subjects: SubjectScore[];
  /** Weakest first. */
  topics: RosterTopicMastery[];
  weak_count: number;
  very_weak_count: number;
  negative_marking: NegativeMarkingBrief | null;
  nudges: TeachingNudge[];
  /** Illustrative study focus, top 3. */
  focus: FocusItem[];
  actions: RosterActions;
  priority: RosterPriority;
}

export interface RosterTopicStudent {
  student_ref: string;
  is_demo: boolean;
  student_name: string;
  mastery: number;
}

export interface RosterTopic {
  topic: string;
  subject: string;
  /** Latest papers that contain the topic. */
  tested: number;
  below_60: number;
  mean_mastery: number | null;
  /** Marks lost to wrong answers on negatively marked MCQs (sum over latest papers). */
  marks_lost: number;
  actions_logged: number;
  actions_improved: number;
  /** The "topic" is a whole subject (a paper with no chapter tags). */
  subject_level: boolean;
  students_below: RosterTopicStudent[];
}

/** guessing_risk / under_attempting count the report's verdicts (guessing / skipping). */
export interface RosterTechnique {
  profiled: number;
  guessing_risk: number;
  under_attempting: number;
  flagged: number;
  marks_lost_total: number;
  marks_lost_per_paper: number;
  /** Students with at least one topic at medium / high penalty risk. */
  risky_topic_students: number;
}

export interface RosterSummary {
  students: number;
  graded: number;
  sheets: number;
  urgency_counts: UrgencyCounts;
  held: number;
  failed: number;
  processing: number;
  ungraded: number;
  improving: number;
  slipping: number;
  steady: number;
  with_trend: number;
  /** Rows with a previous paper of a different kind (no trend, delta is context only). */
  different_test: number;
  /** Students with at least one held / failed / processing sheet in scope. */
  waiting_students: number;
  /** Students with a newer graded paper outside the batch / test filter. */
  newer_outside: number;
  at_risk_without_action: number;
  flagged: number;
  provisional_latest: number;
  released_latest: number;
  demo_students: number;
  real_students: number;
  negative_marking: RosterTechnique;
}

export interface RosterScope {
  batch_id: number | null;
  rubric_id: number | null;
  demo: boolean | null;
}

export interface StudentRoster {
  scope: RosterScope;
  summary: RosterSummary;
  rows: RosterRow[];
  topics: RosterTopic[];
  generated_at: string;
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
  /** POST /api/rubrics/parse: file looked like the answer key alone, so key_file was drafted and file applied as the key. */
  files_swapped: boolean;
}

/**
 * POST /api/intake/inspect: a local read of an intake file's text layer (no AI call, nothing stored).
 * answer_key_paper = printed questions with their answer key (draft the rubric from it);
 * question_paper = printed MCQ paper without a printed key (ticks are read as the student's answers);
 * answer_sheet = typed or scanned answer sheet; unknown = could not tell.
 */
export interface PaperInspection {
  /** pdf | jpeg | png | webp | docx | mp3 | wav | m4a | ogg */
  file_type: string;
  /** Null for audio or a Word file too long to lay out. */
  pages: number | null;
  text_layer: boolean;
  role: PaperRole;
  /** Distinct question numbers found in the text. */
  numbered_questions: number;
  /** "Ans. (2)" / answer-key table entries found. */
  answer_markers: number;
  /** Option lists "(1)..(4)" / "(a)..(d)" found. */
  option_groups: number;
  /** Section headings: Physics, Chemistry, Biology, ... */
  subjects: string[];
  title: string | null;
  max_pdf_pages: number;
  within_page_limit: boolean;
  /** One plain sentence for faculty. */
  message: string;
  /** Only when rubric_id was sent and the text layer has question text. */
  rubric_match: RubricMatch | null;
}

/**
 * The printed question text by number compared with the rubric's question prompts
 * (PaperInspection.rubric_match).
 */
export interface RubricMatch {
  verdict: RubricMatchVerdict;
  /** Questions with text on both sides. */
  compared: number;
  /** Same number, similar text. */
  matched: number;
  /** Text found under a different number in the rubric. */
  moved: number;
  /** Printed paper code / set on the sheet, when seen. */
  sheet_code: string | null;
  /** Paper code / set named by the rubric, when known. */
  rubric_code: string | null;
  /** Up to 3 short lines, e.g. "Q12: sheet '...' vs rubric '...'". */
  examples: string[];
  /** One plain sentence for faculty. */
  message: string;
}

/** Exactly one of option, accepted_options or bonus: true. */
export interface AnswerKeyEntry {
  question: number;
  /** One letter A-F (options printed (1)-(4) read as A-D); null for a multi-answer or bonus entry. */
  option: string | null;
  /** The key accepts any of 2-6 options ("2 or 3" -> ["B", "C"]), in letter order; absent otherwise. */
  accepted_options?: string[] | null;
  /** The key drops the question: full marks to every student; absent (false) otherwise. */
  bonus?: boolean;
}

/**
 * POST /api/rubrics/answer-key: the answer key read from a key-only file or pasted text (a table
 * such as "1-2, 2-4", a "Que. / Ans." grid, or a question paper with "Ans." lines).
 */
export interface AnswerKeyExtraction {
  /** Sorted by question, unique. */
  entries: AnswerKeyEntry[];
  source: AnswerKeySource;
  method: AnswerKeyMethod;
  /** Printed paper code / set, when seen. */
  paper_code: string | null;
  warnings: string[];
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

/**
 * POST /api/submissions/{id}/reevaluate: re-grade a COMPLETED sheet from its stored transcript.
 * rubric: an answer key drafted on the fly (validated like upload's rubric_json, stored as a new
 * snapshot that the sheet moves to); rubric_id: an existing snapshot; neither: the sheet's current
 * key. Both -> 422 invalid_rubric.
 */
export interface ReevaluateInput {
  rubric_id?: number | null;
  rubric?: RubricContent | null;
}

/** A file an answer key was drafted from at upload: the question paper or a separate answer-key file. */
export type RubricSourceKind = "paper" | "key";

/**
 * What a stored source file is (sources.json "role"; upload's rubric_source_role names the paper's):
 * the printed question paper, a rubric as JSON / text, a teacher's marked copy whose ticks are the
 * key, or a separate answer-key file. Older entries have none (labelled by kind).
 */
export type RubricSourceRole = "question_paper" | "rubric_file" | "marked_copy" | "answer_key";

/** GET /api/rubrics/{id}/sources (one entry per stored file; [] when the key was pasted or JSON). */
export interface RubricSourceFile {
  kind: RubricSourceKind;
  filename: string;
  /** pdf | docx | jpeg | png | webp | text */
  file_type: string | null;
  /** Pages the preview can show (1 for an image or text file). */
  pages: number | null;
  /** What the file is (null / absent on older entries: labelled by kind). */
  role?: RubricSourceRole | null;
}

/**
 * POST /api/submissions/{id}/rerun: a full re-run from the stored upload. rubric: an answer key
 * drafted on the fly (validated like upload's rubric_json; the sheet moves to a new snapshot of it);
 * rubric_id: an existing snapshot; neither: the sheet's current key. Both -> 422 invalid_rubric.
 */
export interface RerunInput {
  rubric_id?: number | null;
  rubric?: RubricContent | null;
  reviewer?: string | null;
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
  /** null (or blank) clears it; max 120 characters. */
  faculty_lead?: string | null;
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

// =========================================================================== //
// Contract v3 - see API_CONTRACT.md
// =========================================================================== //

// --- Voice answers (FR-2.8) -------------------------------------------------- //
export interface VoiceInfo {
  /** Relative /api/submissions/{id}/audio; null when no audio file is stored (sample rows). */
  audio_url: string | null;
  audio_seconds: number | null;
  detected_languages: string[];
  transcription_model: string | null;
  voice_question: number | null;
  transcript_chars: number;
  synthetic: boolean;
}

export interface VoiceTranscript {
  submission_id: number;
  text: string;
  model: string | null;
  detected_languages: string[];
  audio_seconds: number | null;
  created_at: string | null;
  synthetic: boolean;
}

// --- LLM chain (FR-3.10) and Bloom detection (FR-3.9) ------------------------ //
export interface LlmRoute {
  stage: InvocationPurpose;
  primary_provider: string;
  primary_model: string;
  served_provider: string | null;
  served_model: string | null;
  fell_back: boolean;
  cross_vendor: boolean;
  reason: string | null;
  attempts: number;
}

export interface LlmProvider {
  provider: string;
  model: string;
  role: LlmRole;
  configured: boolean;
  stages: string[];
  deprecation: string | null;
  /** e.g. "Not residency-approved - PoC only (OpenAI, US-hosted)". */
  residency_note: string;
}

export interface LlmChainStatus {
  providers: LlmProvider[];
  fallback_enabled: boolean;
  simulate_outage: boolean;
  trigger_codes: string[];
  recent_fallbacks: ModelInvocation[];
  note: string;
}

export interface LlmDrillInput {
  simulate_outage: boolean;
}

export interface LlmDrillResult {
  ok: boolean;
  route: LlmRoute;
  calls: ModelInvocation[];
  sample_marks: number | null;
  sample_max_marks: number;
  latency_ms: number;
  message: string;
}

export interface BloomTag {
  question: number;
  level: BloomLevel;
  source: BloomSource;
  rationale: string;
  current_level: BloomLevel | null;
}

export interface BloomDetectInput {
  mode: BloomDetectMode;
}

export interface BloomDetection {
  rubric_id: number;
  mode: BloomDetectMode;
  levels: BloomTag[];
  warnings: string[];
}

// --- Exam-behaviour patterns (FR-4.8, FR-4.10, FR-4.11) --------------------- //
// Thresholds are defaults - confirm with the academic lead.
export interface TopicRisk {
  topic: string;
  attempted: number;
  correct: number;
  wrong: number;
  blank: number;
  accuracy: number | null;
  marks_lost: number;
  risk: RiskLevel;
  over_attempting: boolean;
  /** Minimum self-rated confidence (0-1) before attempting a question on this topic. */
  skip_threshold: number;
  eliminate_options: number;
  advice: string;
}

export interface NegativeMarkingProfile {
  scheme: string;
  /** neg / (max + neg): 0.2 for +4/-1. */
  break_even: number;
  attempted: number;
  correct: number;
  wrong: number;
  blank: number;
  accuracy: number | null;
  marks_lost: number;
  net_marks: number;
  risk: RiskLevel;
  topics: TopicRisk[];
  recommendation: string;
  /** Bonus questions (full marks to everyone) are outside the counts above. */
  bonus_questions?: number | number[] | null;
  bonus_marks?: number | null;
  /** net_answered (4R - P) + bonus_marks = total (S). */
  reconciliation?: NegativeMarkingReconciliation | null;
}

export interface NegativeMarkingReconciliation {
  net_answered: number;
  bonus_marks: number;
  total: number;
}

/** First half vs second half of one subject's section, on answered questions only. */
export interface SubjectPacing {
  subject: string;
  first_from: number;
  first_to: number;
  second_from: number;
  second_to: number;
  first_right: number;
  first_attempted: number;
  second_right: number;
  second_attempted: number;
  /** 0-1, null when nothing was answered in that half. */
  first_accuracy: number | null;
  second_accuracy: number | null;
  /** second - first, in percentage points. */
  change_pts: number | null;
}

export interface QuestionAccuracy {
  question: number;
  accuracy: number;
  cohort_accuracy: number | null;
  final_third: boolean;
  blank: boolean;
}

export interface FatigueProfile {
  questions: number;
  final_third_from: number;
  early_accuracy: number;
  late_accuracy: number;
  drop_pts: number;
  adjusted_drop_pts: number | null;
  cohort_size: number;
  early_blank_rate: number;
  late_blank_rate: number;
  flagged: boolean;
  severity: RiskLevel;
  reasons: string[];
  recommendation: string;
  series: QuestionAccuracy[];
  /** Pacing within each subject section (answered questions only). */
  within_subject?: SubjectPacing[] | null;
  /** Question-weighted change across the subjects' halves, in points. */
  within_subject_change_pts?: number | null;
  /** True when the paper's thirds line up with its subject blocks (cross-paper figures are confounded). */
  confounded_by_section?: boolean | null;
}

export interface ConceptTransfer {
  concept: string;
  recall_questions: number[];
  transfer_questions: number[];
  recall_accuracy: number;
  transfer_accuracy: number;
  gap_pts: number;
  classification: TransferClass;
  advice: string;
}

export interface TransferProfile {
  concepts: ConceptTransfer[];
  memorisation: number;
  transferable: number;
  summary: string;
}

export interface BloomBucket {
  level: BloomLevel;
  questions: number;
  marks: number;
  max_marks: number;
  accuracy: number | null;
  /** Marks before negative-marking penalties (older builds put this figure in `marks`). */
  marks_before_penalty?: number | null;
}

export interface StudentPatterns {
  /** Null with a note when the test has no negatively-marked MCQs. */
  negative_marking: NegativeMarkingProfile | null;
  /** Null with a note when the test has fewer than 6 questions. */
  fatigue: FatigueProfile | null;
  /** Null with a note when no concept is tested at both recall and application levels. */
  transfer: TransferProfile | null;
  bloom_profile: BloomBucket[];
  notes: string[];
  /** False when the Bloom profile tells nothing (one level, or every tag a heuristic guess): the card is hidden. */
  bloom_informative?: boolean;
}

export interface StudentRiskRow {
  submission_id: number;
  student_name: string;
  value: number;
  detail: string;
  severity: RiskLevel;
}

export interface CohortTopicRisk {
  topic: string;
  students_profiled: number;
  students_over_attempting: number;
  mean_accuracy: number | null;
  marks_lost: number;
  skip_threshold: number;
}

export interface CohortNegativeMarking {
  students_profiled: number;
  marks_lost_total: number;
  topics: CohortTopicRisk[];
  students: StudentRiskRow[];
}

export interface CohortFatigue {
  students_profiled: number;
  flagged_count: number;
  early_accuracy: number | null;
  late_accuracy: number | null;
  students: StudentRiskRow[];
}

export interface ConceptSummary {
  concept: string;
  students: number;
  memorisation: number;
  transferable: number;
  foundational_gap: number;
}

export interface CohortTransfer {
  students_profiled: number;
  concepts: ConceptSummary[];
  students: StudentRiskRow[];
}

export interface CohortPatterns {
  negative_marking: CohortNegativeMarking | null;
  fatigue: CohortFatigue | null;
  transfer: CohortTransfer | null;
  bloom_profile: BloomBucket[];
  notes: string[];
}

// --- Interventions and outcomes (FR-4.13) ------------------------------------ //
export interface InterventionOutcome {
  follow_up_submission_id: number;
  follow_up_date: string;
  follow_up_test: string;
  baseline_mastery: number;
  follow_up_mastery: number;
  mastery_change: number;
  predicted_gain_pct: number | null;
  roi_accuracy: number | null;
  score_change_pct: number | null;
}

export interface InterventionRecord {
  id: number;
  institution_id: number;
  batch_id: number;
  /** The baseline result the action responds to. */
  submission_id: number;
  student_ref: string;
  student_name: string;
  topic: string;
  kind: InterventionKind;
  action: string;
  source: ContentSource;
  applied_by: string;
  applied_at: string;
  hours: number | null;
  /** 0-1 */
  compliance: number | null;
  baseline_mastery: number | null;
  predicted_gain_pct: number | null;
  note: string | null;
  is_demo: boolean;
  created_at: string;
  outcome_status: OutcomeStatus;
  outcome: InterventionOutcome | null;
}

export interface InterventionInput {
  submission_id: number;
  topic: string;
  kind: InterventionKind;
  action: string;
  source: ContentSource;
  applied_by: string;
  /** null = now */
  applied_at: string | null;
  hours: number | null;
  compliance: number | null;
  note: string | null;
}

export interface EffectRow {
  key: string;
  label: string;
  n: number;
  mean_change: number | null;
  control_change: number | null;
  uplift: number | null;
  improved_share: number | null;
}

export interface InstitutionEffect {
  institution_id: number;
  institution_name: string;
  records: number;
  measured: number;
  mean_change: number | null;
  uplift: number | null;
  calibration_factor: number | null;
  calibration_n: number;
}

export interface InterventionEffectiveness {
  institution_id: number | null;
  batch_id: number | null;
  records: number;
  measured: number;
  pending: number;
  mean_change_treated: number | null;
  mean_change_control: number | null;
  uplift: number | null;
  by_kind: EffectRow[];
  by_topic: EffectRow[];
  by_institution: InstitutionEffect[];
  is_demo: boolean;
  /** Observational - interventions are not assumed to cause the changes. */
  caveat: string;
  generated_at: string;
}

export interface InterventionSummary {
  records: number;
  measured: number;
  uplift: number | null;
  calibration_factor: number | null;
  pending?: number;
  /** Measured records that had a predicted gain (the calibration sample). */
  calibration_n?: number;
  is_demo?: boolean;
}

// --- What-if (FR-4.14) - illustrative effort-response model ----------------- //
export interface WhatIfScenarioInput {
  topic: string;
  /** 0.5-40 */
  extra_hours: number;
}

export interface WhatIfInput {
  batch_id: number | null;
  rubric_id: number | null;
  institution_id: number | null;
  /** 1-5 scenarios */
  scenarios: WhatIfScenarioInput[];
  use_calibration: boolean;
}

export interface WhatIfImpact {
  exam_marks_avg: number;
  exam_marks_low: number;
  exam_marks_high: number;
  test_pct_points_avg: number;
  exam_scale_max: number;
}

export interface WhatIfStudentRow {
  submission_id: number;
  student_name: string;
  student_ref: string;
  mastery_before: number;
  mastery_after: number;
  exam_marks_gain: number;
}

export interface WhatIfScenarioResult {
  topic: string;
  subject: string | null;
  chapter: string | null;
  extra_hours: number;
  hours_to_target: number | null;
  students_assessed: number;
  /** Already at the 85% target before the extra hours. */
  students_at_target: number;
  /** At the 85% target after the extra hours (absent on older APIs). */
  students_at_target_after?: number | null;
  mean_mastery_before: number | null;
  mean_mastery_after: number | null;
  impact: WhatIfImpact;
  headline: string;
  students: WhatIfStudentRow[];
}

export interface WhatIfResult {
  batch_id: number | null;
  batch_name: string | null;
  rubric_id: number | null;
  institution_id: number | null;
  students_considered: number;
  baseline_avg_pct: number | null;
  projected_avg_pct: number | null;
  scenarios: WhatIfScenarioResult[];
  combined: WhatIfImpact;
  calibration_factor: number;
  calibrated: boolean;
  /** e.g. "Illustrative - not a calibrated forecast". */
  label: string;
  assumptions: string[];
  is_demo: boolean;
}

export interface WhatIfTopicOption {
  topic: string;
  subject: string | null;
  students: number;
  mean_mastery: number | null;
  hours_to_target: number | null;
}

export interface WhatIfOptions {
  batches: Batch[];
  topics: WhatIfTopicOption[];
  calibration_factor: number | null;
}

// --- Owner dashboard (FR-5.9) - no login in this PoC ------------------------- //
/** act = do something now; check = look at it; good = progress; info = context. */
export type OwnerSignalSeverity = "act" | "check" | "good" | "info";
export type OwnerHiddenTopicReason = "subject_only" | "few_students";

/** One sitting (one test in one batch); date = IST date of its newest upload. */
export interface OwnerSittingRef {
  rubric_id: number;
  test_name: string;
  students: number;
  date: string;
  average_pct: number | null;
  max_marks: number | null;
  /** previous_test only: its students who also sat the batch's main test (0 = different students). */
  shared_students?: number | null;
}

/** Same students, previous vs latest whole-class test. mean_change = mean_after - mean_before. */
export interface OwnerProgress {
  students: number;
  mean_before: number | null;
  mean_after: number | null;
  mean_change: number | null;
  /** change >= +5 points */
  improved: number;
  /** change <= -5 points */
  declined: number;
  /** moved less than 5 points either way */
  steady: number;
  /** Pairs on papers that are not comparable (never up / down). */
  not_comparable?: number;
  /** The sittings the pairs' earlier results come from (students = re-tested students from it, average_pct = their mean there). */
  before_sittings?: OwnerSittingRef[];
  /** The sittings the pairs' later results come from. */
  after_sittings?: OwnerSittingRef[];
}

export interface OwnerProgressStudent {
  /** The later result of the pair. */
  submission_id: number;
  previous_submission_id: number;
  student_name: string;
  batch_id: number;
  batch_name: string;
  before_pct: number;
  after_pct: number;
  change: number;
  before_test: string;
  after_test: string;
}

export interface OwnerAtRiskStudent {
  /** The student's latest result. */
  submission_id: number;
  student_name: string;
  student_ref: string;
  batch_id: number;
  batch_name: string;
  test_name: string;
  pct: number;
  change: number | null;
  weakest_topic: string | null;
  weakest_mastery: number | null;
  /** An intervention logged since the latest test. */
  actioned: boolean;
  last_action_at: string | null;
}

export interface OwnerReleaseBatch {
  batch_id: number;
  batch_name: string;
  lead: string | null;
  awaiting: number;
  oldest_days: number | null;
}

/** Per student: the latest report is not released yet. Sheet counts cover every completed sheet. */
export interface OwnerRelease {
  students_awaiting: number;
  students_graded: number;
  oldest_days: number | null;
  oldest_test: string | null;
  oldest_batch: string | null;
  oldest_submission_id: number | null;
  by_batch: OwnerReleaseBatch[];
  sheets_provisional: number;
  sheets_released: number;
  sheets_provisional_over_7d: number;
}

/** A held (HUMAN_REVIEW_REQUIRED) or failed sheet. */
export interface OwnerSheet {
  submission_id: number;
  student_name: string;
  batch_id: number;
  batch_name: string;
  review_reason: string | null;
  created_at: string;
}

export interface OwnerTopicGap {
  topic: string;
  subject: string | null;
  mastery: number;
  students: number;
  below_40: number;
  batches: string[];
  batch_ids: number[];
}

export interface OwnerHiddenTopic {
  topic: string;
  students: number;
  reason: OwnerHiddenTopicReason;
}

/** The same students' previous negatively-marked MCQ result. */
export interface OwnerBehaviourPrevious {
  test: string;
  tests: number;
  students: number;
  marks_lost_per_student: number | null;
  current_marks_lost_per_student: number | null;
}

export interface OwnerBehaviourRow {
  /** null on the institution row */
  batch_id: number | null;
  batch_name: string | null;
  test: string | null;
  tests: number;
  students: number;
  mcqs: number;
  attempted: number;
  correct: number;
  wrong: number;
  blank: number;
  attempt_rate_pct: number | null;
  accuracy_pct: number | null;
  blank_share_pct: number | null;
  marks_lost: number;
  marks_lost_per_student: number | null;
  blank_per_student: number | null;
  over_attempting_students: number;
  top_over_topic: string | null;
  top_over_topic_students: number;
  scheme: string | null;
  break_even: number | null;
  previous: OwnerBehaviourPrevious | null;
}

export interface OwnerExamBehaviour {
  overall: OwnerBehaviourRow | null;
  by_batch: OwnerBehaviourRow[];
}

export interface SamePaperRow {
  batch_id: number;
  batch_name: string;
  avg_pct: number | null;
  students: number;
  date: string;
}

export interface SamePaperComparison {
  rubric_id: number;
  test_name: string;
  rows: SamePaperRow[];
}

export interface OwnerSignalItem {
  label: string;
  detail: string | null;
  value: string | null;
  href: string | null;
}

/** One "needs your attention" row; the text is built server-side from the same numbers. */
export interface OwnerSignal {
  key: string;
  severity: OwnerSignalSeverity;
  title: string;
  detail: string | null;
  count: number;
  href: string | null;
  cta: string | null;
  items: OwnerSignalItem[];
}

export interface OwnerSpendPurpose {
  purpose: string;
  label: string;
  cost_inr: number;
  calls: number;
}

export interface OwnerSpend {
  grading_inr: number;
  grading_calls: number;
  live_graded_sheets: number;
  per_graded_sheet_inr: number | null;
  target_inr: number;
  institution_other_inr: number;
  institution_other_by_purpose: OwnerSpendPurpose[];
  /** Recorded without an institution or a sheet (e.g. answer-key drafting). */
  unlinked_inr: number;
  unlinked_by_purpose: OwnerSpendPurpose[];
  total_inr: number;
}

/** How many sheets each operations figure covers (grading time is live-only; confidence was not). */
export interface OwnerOpsScope {
  latency_sheets: number;
  confidence_sheets: number;
  confidence_sample_sheets: number;
  /** Mean tick-reading confidence over live sheets only (0-1). */
  live_confidence: number | null;
  live_confidence_sheets: number;
}

export interface OwnerPeriod {
  first: string | null;
  last: string | null;
}

export interface OwnerTotals {
  students: number;
  /** Students with at least one completed result. */
  students_graded?: number;
  /** Urgency over every completed sheet (reconciles with the cohort and students pages). */
  sheet_urgency_counts?: UrgencyCounts | null;
  submissions: number;
  completed: number;
  human_review: number;
  failed: number;
  processing: number;
  average_pct: number | null;
  released: number;
  provisional: number;
  batches: number;
  faculty: number;
  tests: number;
}

export interface BatchSummary {
  batch: Batch;
  students: number;
  completed: number;
  average_pct: number | null;
  previous_average_pct: number | null;
  trend_delta_pct: number | null;
  urgency_counts: UrgencyCounts;
  latest_test: RubricRef | null;
  latest_test_date: string | null;
  released: number;
  provisional: number;
  review_backlog: number;
  failed: number;
  top_gap_topic: string | null;
  cost_inr: number;
  is_demo: boolean;
  students_graded?: number;
  progress?: OwnerProgress | null;
  latest_test_students?: number;
  latest_test_avg_pct?: number | null;
  /** false when the batch has no sitting of 3+ students (the newest small one is shown). */
  latest_test_main?: boolean;
  newer_small_sitting?: OwnerSittingRef | null;
  previous_test?: OwnerSittingRef | null;
  at_risk_unactioned?: number;
  awaiting_release?: number;
  oldest_awaiting_days?: number | null;
  top_gap_mastery?: number | null;
  top_gap_students?: number;
  demo_count?: number;
  real_count?: number;
}

export interface FacultySummary {
  name: string;
  batches: string[];
  students: number;
  average_pct: number | null;
  reports_released: number;
  ocr_reviews: number;
  interventions_logged: number;
  avg_release_hours: number | null;
  median_release_hours?: number | null;
  students_graded?: number;
  at_risk?: number;
  at_risk_unactioned?: number;
  awaiting_release?: number;
  oldest_awaiting_days?: number | null;
  progress_change?: number | null;
  progress_students?: number;
  actions_measured?: number;
  actions_improved?: number;
}

export interface TrendPoint {
  date: string;
  batch_id: number;
  batch_name: string;
  test_name: string;
  average_pct: number;
  students: number;
  rubric_id?: number | null;
  max_marks?: number | null;
  /** 3+ students; small sittings are never joined by a line. */
  main?: boolean;
}

export interface OwnerDashboard {
  institution: Institution;
  institutions: Institution[];
  generated_at: string;
  totals: OwnerTotals;
  urgency_counts: UrgencyCounts;
  batches: BatchSummary[];
  faculty: FacultySummary[];
  trend: TrendPoint[];
  weakest_topics: TopicPoint[];
  operations: Operations;
  interventions: InterventionSummary;
  is_demo: boolean;
  demo_count: number;
  real_count: number;
  /** "Owner view - no login in this PoC". */
  role_note: string;
  period?: OwnerPeriod | null;
  progress?: OwnerProgress | null;
  progress_students?: OwnerProgressStudent[];
  at_risk_students?: OwnerAtRiskStudent[];
  release?: OwnerRelease | null;
  held_sheets?: OwnerSheet[];
  failed_sheets?: OwnerSheet[];
  topic_gaps?: OwnerTopicGap[];
  topic_gaps_hidden?: OwnerHiddenTopic[];
  exam_behaviour?: OwnerExamBehaviour | null;
  same_paper?: SamePaperComparison[];
  signals?: OwnerSignal[];
  spend?: OwnerSpend | null;
  operations_scope?: OwnerOpsScope | null;
}

// --- LMS export (FR-5.10) - read-only, X-API-Key ----------------------------- //
/** Never carries the secret (only its SHA-256 is stored). */
export interface ApiKey {
  id: number;
  name: string;
  /** First 8 characters of the secret, for display. */
  prefix: string;
  /** null = all institutions */
  institution_id: number | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
  active: boolean;
}

export interface ApiKeyInput {
  name: string;
  institution_id: number | null;
}

/** POST /api/lms/keys: the secret is shown once. */
export interface ApiKeyCreated {
  key: ApiKey;
  secret: string;
}

export interface LmsEndpoint {
  method: string;
  path: string;
  format: string;
  description: string;
}

export interface LmsInfo {
  enabled: boolean;
  /** "X-API-Key" */
  header_name: string;
  env_key_configured: boolean;
  active_keys: number;
  /** Released results only unless include_provisional=true. */
  released_only_default: boolean;
  endpoints: LmsEndpoint[];
  docs_path: string;
}

export interface LmsTopic {
  topic: string;
  subject: string;
  mastery: number;
}

export interface LmsResultRow {
  submission_id: number;
  student_ref: string;
  student_name: string;
  institution_id: number;
  institution_name: string;
  batch_id: number;
  batch_name: string;
  test_name: string;
  test_version: string;
  rubric_id: number;
  evaluated_at: string;
  score: number;
  total_marks: number;
  percentage: number;
  urgency: Urgency;
  release_status: ReleaseStatus;
  input_kind: InputKind;
  is_demo: boolean;
  topics: LmsTopic[];
  focus_topics: string[];
  nudges: string[];
}

export interface LmsBatch {
  batch_id: number;
  name: string;
  exam: string;
  exam_date: string | null;
  institution_id: number;
  institution_name: string;
  faculty_lead: string | null;
  students: number;
}

export interface LmsStudent {
  student_ref: string;
  student_name: string;
  batch_ids: number[];
  assessments: number;
  latest_submission_id: number | null;
  latest_percentage: number | null;
  latest_urgency: Urgency | null;
}
