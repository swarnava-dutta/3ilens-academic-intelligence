"""Pydantic models for the HTTP API (see /API_CONTRACT.md) and for validating
user-supplied rubric JSON and the insights report before it is persisted.

Response models mirror frontend/src/lib/types.ts field for field (tests/test_contract.py
checks both the names here and every live payload). Every field added after v1 has a
default, so rows stored by older builds still serialise."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

import insights


# --------------------------------------------------------------------------- #
# Rubric input validation (POST /api/upload rubric_json)
# --------------------------------------------------------------------------- #
def _non_empty(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{what} must be a non-empty string")
    return " ".join(value.split())


class RubricQuestionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    question: int = Field(gt=0, le=1000)
    topic: str = Field(max_length=200)
    subject: str
    max_marks: int | float = Field(gt=0, le=1000)
    prompt: str | None = Field(default=None, max_length=5000)
    expected_answer: str = Field(max_length=10000)
    grading_criteria: list[str] = Field(min_length=1, max_length=50)
    effort_hours: int | float = Field(gt=0, le=1000)
    chapter: str | None = Field(default=None, max_length=200)  # syllabus chapter (weightage matrix)

    @field_validator("question", "max_marks", "effort_hours", mode="before")
    @classmethod
    def _no_bool(cls, v: Any) -> Any:
        if isinstance(v, bool):
            raise ValueError("must be a number")
        return v

    @field_validator("topic", mode="before")
    @classmethod
    def _topic(cls, v: Any) -> str:
        return _non_empty(v, "topic")

    @field_validator("expected_answer", mode="before")
    @classmethod
    def _expected(cls, v: Any) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("expected_answer must be a non-empty string")
        return v.strip()

    @field_validator("prompt", mode="before")
    @classmethod
    def _prompt(cls, v: Any) -> Any:
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        return v.strip() if isinstance(v, str) else v

    @field_validator("chapter", mode="before")
    @classmethod
    def _chapter(cls, v: Any) -> Any:
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        return " ".join(v.split()) if isinstance(v, str) else v

    @field_validator("subject", mode="before")
    @classmethod
    def _subject(cls, v: Any) -> str:
        name = _non_empty(v, "subject")
        if len(name) > 100:
            raise ValueError("subject must be at most 100 characters")
        for canonical in insights.SUBJECT_WEIGHTS:  # "biology" -> "Biology" (NEET weights)
            if canonical.lower() == name.lower():
                return canonical
        return name

    @field_validator("grading_criteria", mode="before")
    @classmethod
    def _criteria(cls, v: Any) -> Any:
        if not isinstance(v, list):
            raise ValueError("grading_criteria must be a list of strings")
        cleaned = [c.strip() for c in v if isinstance(c, str) and c.strip()]
        if len(cleaned) != len(v):
            raise ValueError("grading_criteria must contain only non-empty strings")
        return cleaned


class RubricContentIn(BaseModel):
    """A complete rubric content object, as stored in Rubric.content."""

    model_config = ConfigDict(extra="ignore")

    name: str = Field(max_length=200)
    subject: str | None = None
    questions: list[RubricQuestionIn] = Field(min_length=1, max_length=60)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> str:
        return _non_empty(v, "name")

    @model_validator(mode="after")
    def _consistency(self) -> RubricContentIn:
        numbers = [q.question for q in self.questions]
        dupes = sorted({n for n in numbers if numbers.count(n) > 1})
        if dupes:
            raise ValueError(f"question numbers must be unique (duplicated: {', '.join(map(str, dupes))})")
        self.questions.sort(key=lambda q: q.question)
        subjects = list(dict.fromkeys(q.subject for q in self.questions))
        if not self.subject or not self.subject.strip():
            self.subject = subjects[0] if len(subjects) == 1 else "Mixed"
        else:
            self.subject = " ".join(self.subject.split())
            matches = [s for s in insights.SUBJECT_WEIGHTS if s.lower() == self.subject.lower()]
            self.subject = matches[0] if matches else self.subject
        return self

    @property
    def total_marks(self) -> float:
        return float(sum(q.max_marks for q in self.questions))


# --------------------------------------------------------------------------- #
# Named unions (frontend/src/lib/types.ts)
# --------------------------------------------------------------------------- #
UrgencyLit = Literal["on_track", "needs_attention", "at_risk"]
QuestionOutcomeLit = Literal["FULL", "PARTIAL", "ZERO", "BLANK"]
ReleaseStatusLit = Literal["PROVISIONAL", "RELEASED"]
RubricStatusLit = Literal["AUTHOR_DRAFT", "FACULTY_APPROVED"]
NudgePriorityLit = Literal["high", "medium", "low"]
ContentSourceLit = Literal["ai", "template", "faculty"]
StrategyModeLit = Literal["broad", "focused", "revision", "consolidation"]
QuadrantLit = Literal["priority_focus", "maintain", "deprioritise", "no_action"]
PlanActionLit = Literal["learn", "drill", "fix_errors", "maintain", "none"]
CalendarActivityLit = Literal["learn", "drill", "fix_errors", "review", "checkpoint"]
EffortFlagKindLit = Literal["over_investing", "low_marginal_return"]
RoadmapHorizonLit = Literal["7", "30", "60", "90"]
DeliveryStatusLit = Literal["BLOCKED_TEMPLATE_PENDING", "SIMULATED_NOT_SENT"]
InvocationStatusLit = Literal["ok", "error", "refusal", "cache_hit"]
InvocationPurposeLit = Literal["ocr", "evaluation", "consistency", "rubric_parse"]
LanguageHintLit = Literal["en", "hi", "ta", "kn", "te"]
ReviewActionLit = Literal["approve", "correct", "rescan"]
RubricSourceLit = Literal["text", "pdf", "docx", "json"]
DemoSetLit = Literal["genetics", "mixed", "all"]

URGENCIES: tuple[str, ...] = get_args(UrgencyLit)
LANGUAGE_HINTS: tuple[str, ...] = get_args(LanguageHintLit)


# --------------------------------------------------------------------------- #
# Shared shapes
# --------------------------------------------------------------------------- #
class InstitutionOut(BaseModel):
    id: int
    name: str


class BatchOut(BaseModel):
    id: int
    name: str
    exam_type: str
    exam: str = "NEET"
    exam_date: str | None = None
    exam_date_assumed: bool = True
    days_to_exam: int | None = None
    strategy_mode: StrategyModeLit | None = None


class HealthOut(BaseModel):
    status: str
    ai_ready: bool
    vision_provider: str
    missing_configuration: list[str]
    ocr_confidence_threshold: float
    institution: InstitutionOut
    batch: BatchOut
    ocr_adapter: str = ""
    ocr_cache_enabled: bool = True
    cost_target_inr: float = 5.0
    latency_target_seconds: int = 300
    batch_target_seconds: int = 1800
    whatsapp_mode: str = "blocked"
    max_upload_mb: int = 20
    accepted_upload_types: list[str] = Field(default_factory=list)


class RubricOut(BaseModel):
    id: int
    version: str
    name: str
    total_marks: float
    content: dict[str, Any]
    status: RubricStatusLit = "AUTHOR_DRAFT"
    rubric_hash: str = ""
    parent_id: int | None = None
    change_note: str | None = None
    created_at: datetime | None = None


class RubricRef(BaseModel):
    id: int
    version: str
    name: str
    total_marks: float
    status: RubricStatusLit = "AUTHOR_DRAFT"
    rubric_hash: str = ""


class SubmissionOut(BaseModel):
    id: int
    student_name: str
    original_filename: str
    status: str
    ocr_confidence: float | None
    created_at: datetime
    updated_at: datetime
    error_message: str | None
    current_step: str
    is_demo: bool
    total_score: float | None
    total_marks: float
    rubric_id: int
    batch_id: int
    file_sha256: str | None = None
    file_size: int | None = None
    page_count: int | None = None
    language_hints: list[LanguageHintLit] = Field(default_factory=lambda: ["en"])
    student_ref: str = ""
    intake_batch_id: str | None = None
    attempts: int = 0
    max_attempts: int = 3
    last_error_code: str | None = None
    flagged_pages: list[int] = Field(default_factory=list)
    ocr_cache_hit: bool = False
    urgency: UrgencyLit | None = None
    percentage: float | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    release_status: ReleaseStatusLit | None = None
    llm_cost_inr: float | None = None


class TopicMasteryOut(BaseModel):
    topic: str
    subject: str
    score: float
    max_marks: float
    mastery: float
    weightage: float
    effort_hours: float
    chapter: str | None = None
    questions: list[int] = Field(default_factory=list)
    n: int = 0
    full: int = 0
    partial: int = 0
    zero: int = 0
    blank: int = 0
    priority_rank: int | None = None


class InterventionOut(BaseModel):
    teach: str
    practice: str
    check_criterion: str
    source: ContentSourceLit = "template"


class PriorityOut(BaseModel):
    topic: str
    subject: str
    roi: float
    weightage: float
    gain_potential: float
    effort_hours: float
    rationale: str
    mastery: float
    projected_gain_marks: float | None = None
    target_mastery: float | None = None
    gain_low: float | None = None
    gain_high: float | None = None
    trigger_questions: list[int] = Field(default_factory=list)
    intervention: InterventionOut | None = None
    qualitative_rank: int | None = None
    calibrated: bool = False


class UncertainWordOut(BaseModel):
    text: str
    confidence: float


def question_outcome(item: dict[str, Any]) -> str:
    """FULL / PARTIAL / ZERO / BLANK for a stored question evaluation (old rows lack 'outcome')."""
    if not str(item.get("student_answer") or "").strip():
        return "BLANK"
    try:
        marks = float(item.get("estimated_marks") or 0)
        max_marks = float(item.get("max_marks") or 0)
    except (TypeError, ValueError):
        return "PARTIAL"
    if max_marks > 0 and marks >= max_marks:
        return "FULL"
    if marks <= 0:
        return "ZERO"
    return "PARTIAL"


class QuestionEvaluationOut(BaseModel):
    question: int
    topic: str
    estimated_marks: float
    max_marks: float
    evidence: str
    strengths: list[str]
    gaps: list[str]
    student_answer: str
    confidence: float
    outcome: QuestionOutcomeLit = "PARTIAL"  # filled from the marks when missing (see below)
    source_pages: list[int] = Field(default_factory=list)
    uncertain_words: list[UncertainWordOut] = Field(default_factory=list)
    corrected_by_faculty: bool = False

    @model_validator(mode="before")
    @classmethod
    def _default_outcome(cls, data: Any) -> Any:
        if isinstance(data, dict) and not data.get("outcome"):
            data = {**data, "outcome": question_outcome(data)}
        return data


class StrengthsGapsOut(BaseModel):
    strengths: list[str]
    gaps: list[str]


class ProcessingLogEntry(BaseModel):
    step: str
    message: str
    timestamp: str


class TeachingNudge(BaseModel):
    priority: NudgePriorityLit
    label: str
    text: str
    topic: str | None = None
    question_refs: list[int] = Field(default_factory=list)
    source: ContentSourceLit = "ai"


class ConfusionOut(BaseModel):
    concept_a: str
    concept_b: str
    question: int | None = None
    evidence: str = ""


class ReportPayload(BaseModel):
    """What insights.build_evaluation_report must return; validated before persisting.
    The narrative keys are optional so reports built before AI call 2 grew them still validate."""

    total_score: float
    total_marks: float
    overall_mastery: float
    topic_mastery: list[TopicMasteryOut]
    roi_recommendations: list[PriorityOut]
    strengths_gaps: StrengthsGapsOut
    question_evaluations: list[QuestionEvaluationOut]
    summary: str | None = None
    teaching_nudges: list[TeachingNudge] = Field(default_factory=list)
    confusions: list[ConfusionOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Result building blocks
# --------------------------------------------------------------------------- #
class OutcomeCounts(BaseModel):
    full: int = 0
    partial: int = 0
    zero: int = 0
    blank: int = 0
    mapped: int = 0
    total_questions: int = 0


class SubjectRollup(BaseModel):
    subject: str
    questions: int
    full: int
    partial: int
    zero: int
    blank: int
    score: float
    max_marks: float
    pct: float


class ScoringControls(BaseModel):
    marking_rule: str
    rubric_version: str
    rubric_status: RubricStatusLit
    rubric_hash: str
    item_sum: float
    reported_total: float
    parity: bool
    llm_total_used: bool = False


class RoiBasis(BaseModel):
    calculation_version: str
    matrix_version: str
    weightage_source: str
    effort_source: str
    forecast_status: str
    reason: str
    calibrated: bool = False


class ReportMeta(BaseModel):
    run_id: str
    institution: InstitutionOut
    batch: BatchOut
    executed_at: datetime
    timezone: str
    student_ref: str
    is_demo: bool


class ReleaseInfo(BaseModel):
    status: ReleaseStatusLit = "PROVISIONAL"
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    note: str | None = None


class Custody(BaseModel):
    sha256: str
    size_bytes: int
    page_count: int | None = None
    mime_type: str
    detected_by: str
    verified: bool
    verified_at: datetime | None = None


class PageConfidence(BaseModel):
    page: int
    confidence: float


class Extraction(BaseModel):
    mapped: int
    total_questions: int
    unattempted: list[int] = Field(default_factory=list)
    dropped: list[int] = Field(default_factory=list)
    mean_confidence: float | None = None
    min_confidence: float | None = None
    below_threshold: int = 0
    threshold: float
    flagged_pages: list[int] = Field(default_factory=list)
    page_confidences: list[PageConfidence] = Field(default_factory=list)
    ocr_adapter: str
    ocr_cache_hit: bool = False
    language_hints: list[LanguageHintLit] = Field(default_factory=lambda: ["en"])
    corrected_by_faculty: bool = False


class CostSummary(BaseModel):
    llm_cost_inr: float | None = None
    ocr_inr: float | None = None
    evaluation_inr: float | None = None
    other_inr: float | None = None
    target_inr: float
    within_target: bool | None = None
    calls: int = 0
    ocr_cache_hit: bool = False
    synthetic: bool = False
    usd_inr: float


class StageDuration(BaseModel):
    step: str
    seconds: float


class LatencySummary(BaseModel):
    seconds: float | None = None
    target_seconds: float
    within_target: bool | None = None
    stages: list[StageDuration] = Field(default_factory=list)


class HistoryEntry(BaseModel):
    submission_id: int
    date: datetime
    batch_name: str
    rubric_name: str
    rubric_version: str
    subjects: list[str]
    score: float
    total_marks: float
    pct: float
    urgency: UrgencyLit
    outcome_counts: OutcomeCounts
    current: bool


class EvaluationVersionOut(BaseModel):
    version: int
    rubric_id: int
    rubric_version: str
    rubric_hash: str | None = None
    total_score: float
    total_marks: float
    created_at: datetime
    superseded_at: datetime | None = None
    current: bool


class DeliveryOut(BaseModel):
    id: int
    submission_id: int
    channel: str
    recipient_masked: str | None = None
    template_name: str
    status: DeliveryStatusLit
    detail: str
    download_url: str | None = None  # relative /api/download/{token}
    link_expires_at: datetime | None = None
    created_at: datetime


# --------------------------------------------------------------------------- #
# Study plan (WP1 engine v2)
# --------------------------------------------------------------------------- #
class PlanTopic(BaseModel):
    topic: str
    subject: str
    chapter: str | None = None
    mastery: float
    exam_marks: float
    gain_marks: float
    gain_low: float
    gain_high: float
    target_mastery: float
    effort_hours: float
    time_factor: float
    roi: float
    quadrant: QuadrantLit
    quadrant_reason: str
    action: PlanActionLit
    allocated_hours: float
    rank: int | None = None
    question_refs: list[int] = Field(default_factory=list)


class Deprioritised(BaseModel):
    topic: str
    reason: str


class EffortFlag(BaseModel):
    topic: str
    kind: EffortFlagKindLit
    message: str


class ProjectedScore(BaseModel):
    current: float
    expected: float
    low: float
    high: float
    scale_max: float
    label: str


class CalendarBlock(BaseModel):
    topic: str
    minutes: int
    activity: CalendarActivityLit
    note: str


class CalendarDay(BaseModel):
    day: int
    date: str | None = None
    blocks: list[CalendarBlock] = Field(default_factory=list)


class RoadmapStage(BaseModel):
    horizon: RoadmapHorizonLit
    title: str
    days_label: str
    tasks: list[str] = Field(default_factory=list)
    checkpoint: str
    condition: str
    applicable: bool


class RoiInputs(BaseModel):
    exam_marks: float
    mastery: float
    target_mastery: float
    time_factor: float
    effort_hours: float
    roi: float


class RoiExplanation(BaseModel):
    topic: str
    formula: str
    arithmetic: str
    inputs: RoiInputs


class StudyPlan(BaseModel):
    calculation_version: str
    matrix_version: str
    exam: str
    exam_date: str | None = None
    days_to_exam: int | None = None
    strategy_mode: StrategyModeLit
    strategy_title: str
    strategy_text: str
    study_hours: float
    calibrated: bool = False
    topics: list[PlanTopic] = Field(default_factory=list)
    focus: list[PlanTopic] = Field(default_factory=list)
    deprioritised: list[Deprioritised] = Field(default_factory=list)
    effort_flags: list[EffortFlag] = Field(default_factory=list)
    projected_score: ProjectedScore
    weekly_calendar: list[CalendarDay] = Field(default_factory=list)
    roadmap: list[RoadmapStage] = Field(default_factory=list)
    explanation: RoiExplanation | None = None
    allocation_note: str = ""


# --------------------------------------------------------------------------- #
# Result / pending
# --------------------------------------------------------------------------- #
class ResultOut(BaseModel):
    submission: SubmissionOut
    total_score: float
    total_marks: float
    overall_mastery: float
    ocr_confidence: float | None
    topic_mastery: list[TopicMasteryOut]
    roi_recommendations: list[PriorityOut]
    strengths_gaps: StrengthsGapsOut
    question_evaluations: list[QuestionEvaluationOut]
    processing_log: list[ProcessingLogEntry]
    rubric: RubricRef
    urgency: UrgencyLit
    urgency_reasons: list[str] = Field(default_factory=list)
    percentage: float
    summary: str | None = None
    executive_summary: list[str] = Field(default_factory=list)
    teaching_nudges: list[TeachingNudge] = Field(default_factory=list)
    confusions: list[ConfusionOut] = Field(default_factory=list)
    outcome_counts: OutcomeCounts
    subject_rollup: list[SubjectRollup] = Field(default_factory=list)
    scoring_controls: ScoringControls
    roi_basis: RoiBasis
    report_meta: ReportMeta
    release: ReleaseInfo
    custody: Custody | None = None
    extraction: Extraction
    cost: CostSummary
    latency: LatencySummary
    history: list[HistoryEntry] = Field(default_factory=list)
    versions: list[EvaluationVersionOut] = Field(default_factory=list)
    deliveries: list[DeliveryOut] = Field(default_factory=list)
    study_plan: StudyPlan


class ResultPendingOut(BaseModel):
    status: str
    detail: str
    submission: SubmissionOut
    processing_log: list[ProcessingLogEntry] = Field(default_factory=list)  # audit trail so far


# --------------------------------------------------------------------------- #
# Cohort
# --------------------------------------------------------------------------- #
class TopicAverage(BaseModel):
    topic: str
    mastery: float


class DistributionBucket(BaseModel):
    label: str
    count: int


class CohortFilters(BaseModel):
    batch_id: int | None = None
    rubric_id: int | None = None
    urgency: UrgencyLit | None = None
    topic: str | None = None


class UrgencyCounts(BaseModel):
    on_track: int = 0
    needs_attention: int = 0
    at_risk: int = 0


class RankingRow(BaseModel):
    rank: int
    submission_id: int
    student_name: str
    student_ref: str
    score: float
    total_marks: float
    pct: float
    urgency: UrgencyLit


class AtRiskRow(BaseModel):
    submission_id: int
    student_name: str
    pct: float
    reasons: list[str] = Field(default_factory=list)
    top_gap: str | None = None


class CommonError(BaseModel):
    question: int
    topic: str
    error: str
    count: int
    denominator: int
    students: list[str] = Field(default_factory=list)


class ClassIntervention(BaseModel):
    topic: str
    action: str
    students_count: int
    rationale: str


class ConfusionCluster(BaseModel):
    concept_a: str
    concept_b: str
    count: int
    students: list[str] = Field(default_factory=list)


class ExcludedStudents(BaseModel):
    review: list[str] = Field(default_factory=list)
    failed: list[str] = Field(default_factory=list)
    processing: list[str] = Field(default_factory=list)


class Operations(BaseModel):
    calls: int = 0
    total_cost_inr: float = 0.0
    avg_cost_per_student_inr: float | None = None
    ocr_cache_hits: int = 0
    avg_latency_seconds: float | None = None
    p95_latency_seconds: float | None = None
    over_latency_target: int = 0
    dlq_count: int = 0
    mean_ocr_confidence: float | None = None
    target_inr: float
    target_latency_seconds: float


class ReleaseCounts(BaseModel):
    provisional: int = 0
    released: int = 0


class CohortOut(BaseModel):
    institution: InstitutionOut
    batch: BatchOut
    total_submissions: int
    completed: int
    processing: int  # PENDING + PROCESSING
    human_review: int
    failed: int
    average_score: float | None  # expressed on the total_marks scale, averaged by percentage
    average_mastery: float | None
    total_marks: float
    topic_mastery: list[TopicAverage]
    score_distribution: list[DistributionBucket]
    top_priorities: list[PriorityOut]
    is_demo: bool  # true when any synthetic demo record is part of the cohort
    demo_count: int
    real_count: int
    filters: CohortFilters = Field(default_factory=CohortFilters)
    rubric_versions: list[RubricRef] = Field(default_factory=list)
    mixed_rubrics: bool = False
    urgency_counts: UrgencyCounts = Field(default_factory=UrgencyCounts)
    ranking: list[RankingRow] = Field(default_factory=list)
    at_risk: list[AtRiskRow] = Field(default_factory=list)
    common_errors: list[CommonError] = Field(default_factory=list)
    interventions: list[ClassIntervention] = Field(default_factory=list)
    confusion_clusters: list[ConfusionCluster] = Field(default_factory=list)
    excluded: ExcludedStudents = Field(default_factory=ExcludedStudents)
    operations: Operations
    release_counts: ReleaseCounts = Field(default_factory=ReleaseCounts)


class DemoSeedOut(BaseModel):
    message: str
    created: int


# Name parity with types.ts (DemoSeedResult).
DemoSeedResult = DemoSeedOut


# --------------------------------------------------------------------------- #
# Students & dashboard filters
# --------------------------------------------------------------------------- #
class TopicPoint(BaseModel):
    topic: str
    subject: str
    mastery: float


class FocusItem(BaseModel):
    topic: str
    roi: float
    rank: int
    projected_gain_marks: float | None = None
    quadrant: QuadrantLit = "priority_focus"


class StudentCard(BaseModel):
    submission_id: int
    student_name: str
    student_ref: str
    batch: BatchOut
    test: RubricRef
    status: str
    score: float | None = None
    total_marks: float
    percentage: float | None = None
    urgency: UrgencyLit | None = None
    strengths: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    nudges: list[TeachingNudge] = Field(default_factory=list)
    topic_mastery: list[TopicPoint] = Field(default_factory=list)
    top_focus: list[FocusItem] = Field(default_factory=list)
    release_status: ReleaseStatusLit | None = None
    is_demo: bool
    created_at: datetime


class TestOption(BaseModel):
    __test__ = False  # not a pytest test class

    rubric_id: int
    name: str
    version: str
    status: RubricStatusLit
    batch_ids: list[int] = Field(default_factory=list)


class DashboardFilters(BaseModel):
    batches: list[BatchOut] = Field(default_factory=list)
    tests: list[TestOption] = Field(default_factory=list)
    urgencies: list[UrgencyLit] = Field(default_factory=lambda: list(URGENCIES))
    topics: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# OCR review, pages & operations
# --------------------------------------------------------------------------- #
class PageRef(BaseModel):
    page_number: int
    url: str
    original_url: str | None = None
    media_type: str
    width: int | None = None
    height: int | None = None


class ReviewAnswer(BaseModel):
    question: int
    topic: str
    prompt: str | None = None
    answer: str
    confidence: float | None = None
    source_pages: list[int] = Field(default_factory=list)
    uncertain_words: list[UncertainWordOut] = Field(default_factory=list)


class OcrReviewOut(BaseModel):
    id: int
    reviewer: str
    action: ReviewActionLit
    note: str | None = None
    changed_questions: list[int] = Field(default_factory=list)
    created_at: datetime


class OcrReviewData(BaseModel):
    submission_id: int
    status: str
    threshold: float
    has_transcript: bool
    answers: list[ReviewAnswer] = Field(default_factory=list)
    page_confidences: list[PageConfidence] = Field(default_factory=list)
    flagged_pages: list[int] = Field(default_factory=list)
    pages: list[PageRef] = Field(default_factory=list)
    reviews: list[OcrReviewOut] = Field(default_factory=list)


class ModelInvocationOut(BaseModel):
    id: int
    submission_id: int | None = None
    purpose: InvocationPurposeLit
    provider: str
    model_requested: str
    model_served: str | None = None
    request_id: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    image_count: int = 0
    latency_ms: int = 0
    status: InvocationStatusLit = "ok"
    error_code: str | None = None
    fell_back: bool = False
    cost_usd: float | None = None
    cost_inr: float | None = None
    created_at: datetime


class CostGroup(BaseModel):
    key: str
    calls: int
    cost_inr: float
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int


class OpsCosts(BaseModel):
    group_by: str
    groups: list[CostGroup] = Field(default_factory=list)
    total_cost_inr: float = 0.0
    calls: int = 0
    students: int = 0
    avg_cost_per_student_inr: float | None = None
    ocr_cache_hits: int = 0
    target_inr: float
    usd_inr: float


class IntakeBatchStatus(BaseModel):
    intake_batch_id: str
    total: int
    completed: int
    human_review: int
    failed: int
    processing: int
    started_at: datetime | None = None
    elapsed_seconds: float | None = None
    eta_seconds: float | None = None
    target_seconds: float


# --------------------------------------------------------------------------- #
# Rubrics, re-evaluation, consistency & weightage
# --------------------------------------------------------------------------- #
class RubricDraft(BaseModel):
    draft: dict[str, Any]  # a RubricContent (validated as RubricContentIn by the parser)
    warnings: list[str] = Field(default_factory=list)
    source: RubricSourceLit
    ai_drafted_questions: list[int] = Field(default_factory=list)


class RubricCompatibility(BaseModel):
    reusable: bool
    added: list[int] = Field(default_factory=list)
    removed: list[int] = Field(default_factory=list)
    changed: list[int] = Field(default_factory=list)


class RubricVersionResult(BaseModel):
    rubric: RubricOut
    compatibility: RubricCompatibility
    queued_submission_ids: list[int] = Field(default_factory=list)


class ReevaluationEstimate(BaseModel):
    rubric_id: int
    submission_ids: list[int] = Field(default_factory=list)
    students: int
    live_students: int
    demo_students: int
    evaluation_calls: int
    ocr_calls: int = 0
    estimated_cost_inr: float
    estimated_cost_per_student_inr: float
    basis: str


class ConsistencyDelta(BaseModel):
    question: int
    original: float
    regrade: float
    delta: float


class ConsistencyCheck(BaseModel):
    submission_id: int
    runs: int
    tolerance: float
    total_original: float
    total_regrade: float
    max_abs_delta_total: float
    within_tolerance: bool
    deltas: list[ConsistencyDelta] = Field(default_factory=list)
    checked_at: datetime


class EffortBands(BaseModel):
    from_low: float
    from_mid: float
    from_high: float


class ChapterWeight(BaseModel):
    subject: str
    chapter: str
    aliases: list[str] = Field(default_factory=list)
    avg_questions_per_paper: float
    avg_marks: float
    weightage_rank: int
    effort_hours: EffortBands
    historic_error_rate: float | None = None
    confidence: float


class WeightageMatrix(BaseModel):
    exam: str
    version: str
    source: str
    confidence: float
    illustrative: bool = True
    total_marks: float
    chapters: list[ChapterWeight] = Field(default_factory=list)


class ExamOption(BaseModel):
    exam: str
    enabled: bool
    note: str


class ApiErrorBody(BaseModel):
    detail: str
    code: str | None = None


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #
class ReviewAnswerInput(BaseModel):
    question: int
    answer: str = Field(max_length=10000)


class ReviewInput(BaseModel):
    reviewer: str = Field(min_length=1, max_length=120)
    action: Literal["approve", "correct"]
    answers: list[ReviewAnswerInput] = Field(default_factory=list)
    note: str | None = Field(default=None, max_length=1000)


class ReevaluateInput(BaseModel):
    rubric_id: int | None = None


class RubricCreateInput(BaseModel):
    content: RubricContentIn
    parent_id: int | None = None
    change_note: str | None = Field(default=None, max_length=1000)
    approved: bool = False


class RubricVersionInput(BaseModel):
    content: RubricContentIn
    change_note: str | None = Field(default=None, max_length=1000)
    reprocess: bool = False


class BatchPatchInput(BaseModel):
    exam: str | None = Field(default=None, max_length=50)
    exam_date: str | None = None  # ISO date; explicit null resets to the assumed default


class ReleaseInput(BaseModel):
    reviewer_name: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)


class DeliveryInput(BaseModel):
    submission_ids: list[int] = Field(min_length=1, max_length=200)
    channel: Literal["whatsapp"] = "whatsapp"
    recipient: str | None = Field(default=None, max_length=32)
