"""Pydantic models for the HTTP API (see /API_CONTRACT.md) and for validating
user-supplied rubric JSON and the insights report before it is persisted.

Response models mirror frontend/src/lib/types.ts field for field (tests/test_contract.py
checks both the names here and every live payload). Every field added after v1 has a
default, so rows stored by older builds still serialise."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

import bloom
import insights
import marking


# --------------------------------------------------------------------------- #
# Rubric input validation (POST /api/upload rubric_json)
# --------------------------------------------------------------------------- #
def _non_empty(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{what} must be a non-empty string")
    return " ".join(value.split())


QUESTION_TYPES = ("descriptive", "mcq")
MAX_OPTIONS = 6
MAX_SCHEME_STEPS = 20


class MarkingStepIn(BaseModel):
    """One step of a per-question marking scheme (FR-3.8)."""

    model_config = ConfigDict(extra="ignore")

    criterion: str = Field(max_length=500)
    marks: float = Field(gt=0, le=1000)
    required: bool = False

    @field_validator("criterion", mode="before")
    @classmethod
    def _criterion(cls, v: Any) -> str:
        return _non_empty(v, "criterion")

    @field_validator("marks", mode="before")
    @classmethod
    def _no_bool(cls, v: Any) -> Any:
        if isinstance(v, bool):
            raise ValueError("must be a number")
        return v


class MarkingPolicyIn(BaseModel):
    """Rubric-wide marking policy (FR-3.8 / FR-4.8). Questions may override mode and step."""

    model_config = ConfigDict(extra="ignore")

    partial_credit: Literal["steps", "proportional", "all_or_nothing"] = "steps"
    mark_step: float = 0.5
    negative_marks: float = Field(default=0.0, ge=0, le=100)
    scheme_name: str | None = Field(default=None, max_length=80)

    @field_validator("mark_step")
    @classmethod
    def _step(cls, v: float) -> float:
        if not any(abs(v - step) < 1e-9 for step in marking.MARK_STEPS):
            raise ValueError("mark_step must be one of 0.25, 0.5, 1 or 2")
        return v

    @field_validator("scheme_name", mode="before")
    @classmethod
    def _scheme_name(cls, v: Any) -> Any:
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        return " ".join(v.split()) if isinstance(v, str) else v


def _fmt_marks(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return str(int(number)) if number.is_integer() else f"{number:g}"


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
    # --- contract v3 (all default None, so model_dump(exclude_none=True) keeps old hashes) -------
    question_type: Literal["descriptive", "mcq"] | None = None
    options: list[str] | None = None
    correct_option: str | None = None
    negative_marks: float | None = None
    bloom_level: Literal["K1", "K2", "K3", "K4", "K5"] | None = None
    bloom_source: Literal["faculty", "ai", "heuristic"] | None = None
    concept: str | None = Field(default=None, max_length=200)
    marking_scheme: list[MarkingStepIn] | None = None
    partial_credit: Literal["steps", "proportional", "all_or_nothing"] | None = None
    mark_step: float | None = None

    @model_validator(mode="before")
    @classmethod
    def _v3_defaults(cls, data: Any) -> Any:
        """MCQ: needs a correct_option; fills expected_answer / grading_criteria when missing.
        A marking scheme without grading_criteria gets one criterion per step."""
        if not isinstance(data, dict):
            return data
        data = dict(data)
        number = data.get("question")
        qtype = data.get("question_type")
        if isinstance(qtype, str):
            qtype = qtype.strip().lower() or None
            data["question_type"] = qtype
        criteria = data.get("grading_criteria")
        no_criteria = criteria is None or (
            isinstance(criteria, list) and not any(isinstance(c, str) and c.strip() for c in criteria)
        )
        if qtype == "mcq":
            options = data.get("options") if isinstance(data.get("options"), list) else None
            raw_correct = data.get("correct_option")
            if raw_correct is None or not str(raw_correct).strip():
                raise ValueError(f"Q{number} is an MCQ: correct_option is required (one option letter A-F)")
            letter = marking.normalise_option(raw_correct, len(options) if options else None)
            if letter in (None, marking.MULTI, marking.UNKNOWN):
                raise ValueError(f"Q{number} correct_option must be one option letter A-F within the options")
            data["correct_option"] = letter
            expected = data.get("expected_answer")
            if not isinstance(expected, str) or not expected.strip():
                data["expected_answer"] = f"Option {letter}"
            if no_criteria:
                data["grading_criteria"] = [
                    f"{_fmt_marks(data.get('max_marks'))} marks for option {letter}; a wrong option follows the "
                    "negative-marking rule; 0 if blank"
                ]
        elif isinstance(data.get("marking_scheme"), list) and data["marking_scheme"] and no_criteria:
            steps = [st for st in data["marking_scheme"] if isinstance(st, dict)]
            data["grading_criteria"] = [
                f"{_fmt_marks(st.get('marks'))} marks: {' '.join(str(st.get('criterion') or '').split())}"
                for st in steps
            ]
        return data

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

    @field_validator("negative_marks", "mark_step", mode="before")
    @classmethod
    def _no_bool_optional(cls, v: Any) -> Any:
        if isinstance(v, bool):
            raise ValueError("must be a number")
        return v

    @field_validator("options", mode="before")
    @classmethod
    def _options(cls, v: Any) -> Any:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("options must be a list of strings")
        cleaned = [" ".join(o.split()) for o in v if isinstance(o, str) and o.strip()]
        if len(cleaned) != len(v):
            raise ValueError("options must contain only non-empty strings")
        if not 2 <= len(cleaned) <= MAX_OPTIONS:
            raise ValueError(f"options must have 2-{MAX_OPTIONS} entries")
        if any(len(o) > 500 for o in cleaned):
            raise ValueError("each option must be at most 500 characters")
        return cleaned

    @field_validator("bloom_level", mode="before")
    @classmethod
    def _bloom_level(cls, v: Any) -> Any:
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        level = bloom.parse_level(v)
        if level is None:
            raise ValueError("bloom_level must be K1-K5 (or remember / understand / apply / analyse / evaluate)")
        return level

    @field_validator("concept", mode="before")
    @classmethod
    def _concept(cls, v: Any) -> Any:
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        return " ".join(v.split()) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _v3_rules(self) -> RubricQuestionIn:
        n = self.question
        is_mcq = self.question_type == "mcq"
        if not is_mcq:
            for name in ("options", "correct_option", "negative_marks"):
                if getattr(self, name) is not None:
                    raise ValueError(f"Q{n} {name} is only allowed when question_type is 'mcq'")
        else:
            if self.marking_scheme:
                raise ValueError(f"Q{n} marking_scheme is only allowed on descriptive questions")
            if self.options and self.correct_option:
                index = marking.OPTION_LETTERS.index(self.correct_option)
                if index >= len(self.options):
                    raise ValueError(
                        f"Q{n} correct_option {self.correct_option} is not one of the {len(self.options)} options"
                    )
            if self.negative_marks is not None and not 0 <= self.negative_marks <= float(self.max_marks):
                raise ValueError(f"Q{n} negative_marks must be between 0 and max_marks ({_fmt_marks(self.max_marks)})")
        if self.marking_scheme is not None:
            if not 1 <= len(self.marking_scheme) <= MAX_SCHEME_STEPS:
                raise ValueError(f"Q{n} marking_scheme must have 1-{MAX_SCHEME_STEPS} steps")
            total = sum(step.marks for step in self.marking_scheme)
            if abs(total - float(self.max_marks)) > 0.01:
                raise ValueError(
                    f"Q{n} marking_scheme marks ({_fmt_marks(total)}) must add up to max_marks "
                    f"({_fmt_marks(self.max_marks)})"
                )
        if self.mark_step is not None:
            if not any(abs(self.mark_step - step) < 1e-9 for step in marking.MARK_STEPS):
                raise ValueError(f"Q{n} mark_step must be one of 0.25, 0.5, 1 or 2")
            if self.mark_step > float(self.max_marks):
                raise ValueError(f"Q{n} mark_step must not exceed max_marks")
        return self


class RubricContentIn(BaseModel):
    """A complete rubric content object, as stored in Rubric.content."""

    model_config = ConfigDict(extra="ignore")

    name: str = Field(max_length=200)
    subject: str | None = None
    questions: list[RubricQuestionIn] = Field(min_length=1, max_length=60)
    marking_policy: MarkingPolicyIn | None = None  # None keeps the default marking rule

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
InvocationPurposeLit = Literal[
    "ocr", "evaluation", "consistency", "rubric_parse", "transcription", "voice_mapping", "bloom_detect", "llm_drill",
]
LanguageHintLit = Literal["en", "hi", "ta", "kn", "te"]
ReviewActionLit = Literal["approve", "correct", "rescan"]
RubricSourceLit = Literal["text", "pdf", "docx", "json"]
DemoSetLit = Literal["genetics", "mixed", "all", "insights"]
# --- contract v3 ---
QuestionTypeLit = Literal["descriptive", "mcq"]
BloomLevelLit = Literal["K1", "K2", "K3", "K4", "K5"]
BloomSourceLit = Literal["faculty", "ai", "heuristic"]
PartialCreditModeLit = Literal["steps", "proportional", "all_or_nothing"]
InputKindLit = Literal["document", "voice"]
RiskLevelLit = Literal["low", "medium", "high"]
TransferClassLit = Literal["memorisation", "transferable", "foundational_gap", "inconsistent", "developing"]
InterventionKindLit = Literal["nudge", "study_focus", "class_intervention", "custom"]
OutcomeStatusLit = Literal["pending", "improved", "flat", "declined", "not_assessed"]
BloomDetectModeLit = Literal["ai", "heuristic"]
LlmRoleLit = Literal["primary", "fallback"]

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
    faculty_lead: str | None = None


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
    voice_enabled: bool = True
    voice_ready: bool = False  # enabled AND an OpenAI key is present
    transcription_model: str = "gpt-transcribe"
    accepted_voice_types: list[str] = Field(default_factory=list)
    llm_fallback: str = "gpt-4o"  # the fallback model name, or "off"
    lms_api_enabled: bool = True


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
    input_kind: InputKindLit = "document"
    audio_seconds: float | None = None
    voice_question: int | None = None
    detected_languages: list[str] = Field(default_factory=list)


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


class MarkingAward(BaseModel):
    criterion: str
    marks: float
    awarded: float
    required: bool = False


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
    # --- contract v3 (defaults so old rows validate) ---
    question_type: QuestionTypeLit = "descriptive"
    bloom_level: BloomLevelLit | None = None
    bloom_source: BloomSourceLit | None = None
    demonstrated_level: BloomLevelLit | None = None
    concept: str | None = None
    penalty: float = 0.0
    selected_option: str | None = None
    correct_option: str | None = None
    marking_breakdown: list[MarkingAward] = Field(default_factory=list)
    marking_note: str | None = None

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
# Study plan (ROI engine v2)
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
# Contract v3: shapes carried by Result / Cohort
# --------------------------------------------------------------------------- #
class VoiceInfo(BaseModel):
    audio_url: str | None = None  # relative /api/submissions/{id}/audio; null when no audio file is stored
    audio_seconds: float | None = None
    detected_languages: list[str] = Field(default_factory=list)
    transcription_model: str | None = None
    voice_question: int | None = None
    transcript_chars: int = 0
    synthetic: bool = False


class LlmRoute(BaseModel):
    stage: InvocationPurposeLit
    primary_provider: str
    primary_model: str
    served_provider: str | None = None
    served_model: str | None = None
    fell_back: bool = False
    cross_vendor: bool = False
    reason: str | None = None
    attempts: int = 1


class TopicRisk(BaseModel):
    topic: str
    attempted: int
    correct: int
    wrong: int
    blank: int
    accuracy: float | None = None
    marks_lost: float
    risk: RiskLevelLit
    over_attempting: bool
    skip_threshold: float
    eliminate_options: int
    advice: str


class NegativeMarkingProfile(BaseModel):
    scheme: str
    break_even: float
    attempted: int
    correct: int
    wrong: int
    blank: int
    accuracy: float | None = None
    marks_lost: float
    net_marks: float
    risk: RiskLevelLit
    topics: list[TopicRisk] = Field(default_factory=list)
    recommendation: str


class QuestionAccuracy(BaseModel):
    question: int
    accuracy: float
    cohort_accuracy: float | None = None
    final_third: bool
    blank: bool


class FatigueProfile(BaseModel):
    questions: int
    final_third_from: int
    early_accuracy: float
    late_accuracy: float
    drop_pts: float
    adjusted_drop_pts: float | None = None
    cohort_size: int
    early_blank_rate: float
    late_blank_rate: float
    flagged: bool
    severity: RiskLevelLit
    reasons: list[str] = Field(default_factory=list)
    recommendation: str
    series: list[QuestionAccuracy] = Field(default_factory=list)


class ConceptTransfer(BaseModel):
    concept: str
    recall_questions: list[int] = Field(default_factory=list)
    transfer_questions: list[int] = Field(default_factory=list)
    recall_accuracy: float
    transfer_accuracy: float
    gap_pts: float
    classification: TransferClassLit
    advice: str


class TransferProfile(BaseModel):
    concepts: list[ConceptTransfer] = Field(default_factory=list)
    memorisation: int = 0
    transferable: int = 0
    summary: str = ""


class BloomBucket(BaseModel):
    level: BloomLevelLit
    questions: int
    marks: float
    max_marks: float
    accuracy: float | None = None


class StudentPatterns(BaseModel):
    negative_marking: NegativeMarkingProfile | None = None
    fatigue: FatigueProfile | None = None
    transfer: TransferProfile | None = None
    bloom_profile: list[BloomBucket] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class StudentRiskRow(BaseModel):
    submission_id: int
    student_name: str
    value: float
    detail: str
    severity: RiskLevelLit


class CohortTopicRisk(BaseModel):
    topic: str
    students_profiled: int
    students_over_attempting: int
    mean_accuracy: float | None = None
    marks_lost: float
    skip_threshold: float


class CohortNegativeMarking(BaseModel):
    students_profiled: int = 0
    marks_lost_total: float = 0.0
    topics: list[CohortTopicRisk] = Field(default_factory=list)
    students: list[StudentRiskRow] = Field(default_factory=list)


class CohortFatigue(BaseModel):
    students_profiled: int = 0
    flagged_count: int = 0
    early_accuracy: float | None = None
    late_accuracy: float | None = None
    students: list[StudentRiskRow] = Field(default_factory=list)


class ConceptSummary(BaseModel):
    concept: str
    students: int
    memorisation: int
    transferable: int
    foundational_gap: int


class CohortTransfer(BaseModel):
    students_profiled: int = 0
    concepts: list[ConceptSummary] = Field(default_factory=list)
    students: list[StudentRiskRow] = Field(default_factory=list)


class CohortPatterns(BaseModel):
    negative_marking: CohortNegativeMarking | None = None
    fatigue: CohortFatigue | None = None
    transfer: CohortTransfer | None = None
    bloom_profile: list[BloomBucket] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class InterventionOutcome(BaseModel):
    follow_up_submission_id: int
    follow_up_date: datetime
    follow_up_test: str
    baseline_mastery: float
    follow_up_mastery: float
    mastery_change: float
    predicted_gain_pct: float | None = None
    roi_accuracy: float | None = None
    score_change_pct: float | None = None


class InterventionRecordOut(BaseModel):
    """types.ts InterventionRecord (Out suffix: the ORM class is database.InterventionRecord)."""

    id: int
    institution_id: int
    batch_id: int
    submission_id: int
    student_ref: str
    student_name: str
    topic: str
    kind: InterventionKindLit
    action: str
    source: ContentSourceLit = "faculty"
    applied_by: str
    applied_at: datetime
    hours: float | None = None
    compliance: float | None = None
    baseline_mastery: float | None = None
    predicted_gain_pct: float | None = None
    note: str | None = None
    is_demo: bool = False
    created_at: datetime
    outcome_status: OutcomeStatusLit = "pending"
    outcome: InterventionOutcome | None = None


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
    # --- guarded read-side hooks (result_view.build_result_for) ---
    llm_routes: list[LlmRoute] = Field(default_factory=list)
    patterns: StudentPatterns = Field(default_factory=StudentPatterns)
    interventions: list[InterventionRecordOut] = Field(default_factory=list)
    voice: VoiceInfo | None = None


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
    patterns: CohortPatterns = Field(default_factory=CohortPatterns)  # guarded hook


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


# --------------------------------------------------------------------------- #
# Contract v3: voice, LLM chain, Bloom detection
# --------------------------------------------------------------------------- #
class VoiceTranscript(BaseModel):
    submission_id: int
    text: str
    model: str | None = None
    detected_languages: list[str] = Field(default_factory=list)
    audio_seconds: float | None = None
    created_at: datetime | None = None
    synthetic: bool = False


class LlmProvider(BaseModel):
    provider: str
    model: str
    role: LlmRoleLit
    configured: bool
    stages: list[str] = Field(default_factory=list)
    deprecation: str | None = None
    residency_note: str


class LlmChainStatus(BaseModel):
    providers: list[LlmProvider] = Field(default_factory=list)
    fallback_enabled: bool
    simulate_outage: bool
    trigger_codes: list[str] = Field(default_factory=list)
    recent_fallbacks: list[ModelInvocationOut] = Field(default_factory=list)
    note: str


class LlmDrillResult(BaseModel):
    ok: bool
    route: LlmRoute
    calls: list[ModelInvocationOut] = Field(default_factory=list)
    sample_marks: float | None = None
    sample_max_marks: float
    latency_ms: int
    message: str


class BloomTag(BaseModel):
    question: int
    level: BloomLevelLit
    source: BloomSourceLit
    rationale: str
    current_level: BloomLevelLit | None = None


class BloomDetection(BaseModel):
    rubric_id: int
    mode: BloomDetectModeLit
    levels: list[BloomTag] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Intervention effectiveness (FR-4.13) and what-if (FR-4.14)
# --------------------------------------------------------------------------- #
INTERVENTION_CAVEAT = (
    "Observational: treated vs untreated topics of the same students. Interventions are not assumed to cause "
    "the score changes."
)


class EffectRow(BaseModel):
    key: str
    label: str
    n: int
    mean_change: float | None = None
    control_change: float | None = None
    uplift: float | None = None
    improved_share: float | None = None


class InstitutionEffect(BaseModel):
    institution_id: int
    institution_name: str
    records: int
    measured: int
    mean_change: float | None = None
    uplift: float | None = None
    calibration_factor: float | None = None
    calibration_n: int = 0


class InterventionEffectiveness(BaseModel):
    institution_id: int | None = None
    batch_id: int | None = None
    records: int = 0
    measured: int = 0
    pending: int = 0
    mean_change_treated: float | None = None
    mean_change_control: float | None = None
    uplift: float | None = None
    by_kind: list[EffectRow] = Field(default_factory=list)
    by_topic: list[EffectRow] = Field(default_factory=list)
    by_institution: list[InstitutionEffect] = Field(default_factory=list)
    is_demo: bool = False
    caveat: str = INTERVENTION_CAVEAT
    generated_at: datetime


class InterventionSummary(BaseModel):
    records: int = 0
    measured: int = 0
    uplift: float | None = None
    calibration_factor: float | None = None


class WhatIfImpact(BaseModel):
    exam_marks_avg: float
    exam_marks_low: float
    exam_marks_high: float
    test_pct_points_avg: float
    exam_scale_max: float


class WhatIfStudentRow(BaseModel):
    submission_id: int
    student_name: str
    student_ref: str
    mastery_before: float
    mastery_after: float
    exam_marks_gain: float


class WhatIfScenarioResult(BaseModel):
    topic: str
    subject: str | None = None
    chapter: str | None = None
    extra_hours: float
    hours_to_target: float | None = None
    students_assessed: int
    students_at_target: int
    mean_mastery_before: float | None = None
    mean_mastery_after: float | None = None
    impact: WhatIfImpact
    headline: str
    students: list[WhatIfStudentRow] = Field(default_factory=list)


class WhatIfResult(BaseModel):
    batch_id: int | None = None
    batch_name: str | None = None
    rubric_id: int | None = None
    institution_id: int | None = None
    students_considered: int
    baseline_avg_pct: float | None = None
    projected_avg_pct: float | None = None
    scenarios: list[WhatIfScenarioResult] = Field(default_factory=list)
    combined: WhatIfImpact
    calibration_factor: float = 1.0
    calibrated: bool = False
    label: str
    assumptions: list[str] = Field(default_factory=list)
    is_demo: bool = False


class WhatIfTopicOption(BaseModel):
    topic: str
    subject: str | None = None
    students: int
    mean_mastery: float | None = None
    hours_to_target: float | None = None


class WhatIfOptions(BaseModel):
    batches: list[BatchOut] = Field(default_factory=list)
    topics: list[WhatIfTopicOption] = Field(default_factory=list)
    calibration_factor: float | None = None


# --------------------------------------------------------------------------- #
# Owner dashboard (FR-5.9)
# --------------------------------------------------------------------------- #
class OwnerTotals(BaseModel):
    students: int = 0
    submissions: int = 0
    completed: int = 0
    human_review: int = 0
    failed: int = 0
    processing: int = 0
    average_pct: float | None = None
    released: int = 0
    provisional: int = 0
    batches: int = 0
    faculty: int = 0
    tests: int = 0


class BatchSummary(BaseModel):
    batch: BatchOut
    students: int
    completed: int
    average_pct: float | None = None
    previous_average_pct: float | None = None
    trend_delta_pct: float | None = None
    urgency_counts: UrgencyCounts
    latest_test: RubricRef | None = None
    latest_test_date: datetime | None = None
    released: int = 0
    provisional: int = 0
    review_backlog: int = 0
    failed: int = 0
    top_gap_topic: str | None = None
    cost_inr: float = 0.0
    is_demo: bool = False


class FacultySummary(BaseModel):
    name: str
    batches: list[str] = Field(default_factory=list)
    students: int = 0
    average_pct: float | None = None
    reports_released: int = 0
    ocr_reviews: int = 0
    interventions_logged: int = 0
    avg_release_hours: float | None = None


class TrendPoint(BaseModel):
    date: str
    batch_id: int
    batch_name: str
    test_name: str
    average_pct: float
    students: int


class OwnerDashboard(BaseModel):
    institution: InstitutionOut
    institutions: list[InstitutionOut] = Field(default_factory=list)
    generated_at: datetime
    totals: OwnerTotals
    urgency_counts: UrgencyCounts
    batches: list[BatchSummary] = Field(default_factory=list)
    faculty: list[FacultySummary] = Field(default_factory=list)
    trend: list[TrendPoint] = Field(default_factory=list)
    weakest_topics: list[TopicPoint] = Field(default_factory=list)
    operations: Operations
    interventions: InterventionSummary
    is_demo: bool = False
    demo_count: int = 0
    real_count: int = 0
    role_note: str = "Owner view - no login in this PoC"


# --------------------------------------------------------------------------- #
# LMS export (FR-5.10)
# --------------------------------------------------------------------------- #
class ApiKeyOut(BaseModel):
    """types.ts ApiKey (Out suffix: the ORM class is database.ApiKey). Never carries the secret."""

    id: int
    name: str
    prefix: str
    institution_id: int | None = None
    created_at: datetime
    last_used_at: datetime | None = None
    use_count: int = 0
    revoked_at: datetime | None = None
    active: bool = True


class ApiKeyCreated(BaseModel):
    key: ApiKeyOut
    secret: str  # shown once; only its SHA-256 is stored


class LmsEndpoint(BaseModel):
    method: str
    path: str
    format: str
    description: str


class LmsInfo(BaseModel):
    enabled: bool
    header_name: str = "X-API-Key"
    env_key_configured: bool = False
    active_keys: int = 0
    released_only_default: bool = True
    endpoints: list[LmsEndpoint] = Field(default_factory=list)
    docs_path: str = "/docs"


class LmsTopic(BaseModel):
    topic: str
    subject: str
    mastery: float


class LmsResultRow(BaseModel):
    submission_id: int
    student_ref: str
    student_name: str
    institution_id: int
    institution_name: str
    batch_id: int
    batch_name: str
    test_name: str
    test_version: str
    rubric_id: int
    evaluated_at: datetime
    score: float
    total_marks: float
    percentage: float
    urgency: UrgencyLit
    release_status: ReleaseStatusLit
    input_kind: InputKindLit = "document"
    is_demo: bool = False
    topics: list[LmsTopic] = Field(default_factory=list)
    focus_topics: list[str] = Field(default_factory=list)
    nudges: list[str] = Field(default_factory=list)


class LmsBatch(BaseModel):
    batch_id: int
    name: str
    exam: str
    exam_date: str | None = None
    institution_id: int
    institution_name: str
    faculty_lead: str | None = None
    students: int = 0


class LmsStudent(BaseModel):
    student_ref: str
    student_name: str
    batch_ids: list[int] = Field(default_factory=list)
    assessments: int = 0
    latest_submission_id: int | None = None
    latest_percentage: float | None = None
    latest_urgency: UrgencyLit | None = None


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
    faculty_lead: str | None = Field(default=None, max_length=120)  # explicit null (or blank) clears it

    @field_validator("faculty_lead", mode="before")
    @classmethod
    def _faculty_lead(cls, v: Any) -> Any:
        if isinstance(v, str):
            return " ".join(v.split()) or None
        return v


class ReleaseInput(BaseModel):
    reviewer_name: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)


class DeliveryInput(BaseModel):
    submission_ids: list[int] = Field(min_length=1, max_length=200)
    channel: Literal["whatsapp"] = "whatsapp"
    recipient: str | None = Field(default=None, max_length=32)


# --- contract v3 request bodies ------------------------------------------------------------
class LlmDrillInput(BaseModel):
    simulate_outage: bool = False


class BloomDetectInput(BaseModel):
    mode: BloomDetectModeLit = "ai"


class InterventionInput(BaseModel):
    submission_id: int
    topic: str = Field(min_length=1, max_length=200)
    kind: InterventionKindLit
    action: str = Field(min_length=1, max_length=1000)
    source: ContentSourceLit = "faculty"
    applied_by: str = Field(min_length=1, max_length=120)
    applied_at: datetime | None = None  # None means now
    hours: float | None = Field(default=None, gt=0, le=100)
    compliance: float | None = Field(default=None, ge=0, le=1)
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("topic", "action", "applied_by", mode="before")
    @classmethod
    def _squash(cls, v: Any) -> Any:
        return " ".join(v.split()) if isinstance(v, str) else v


class WhatIfScenarioInput(BaseModel):
    topic: str = Field(min_length=1, max_length=200)
    extra_hours: float = Field(ge=0.5, le=40)


class WhatIfInput(BaseModel):
    batch_id: int | None = None
    rubric_id: int | None = None
    institution_id: int | None = None
    scenarios: list[WhatIfScenarioInput] = Field(min_length=1, max_length=5)
    use_calibration: bool = False


class ApiKeyInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    institution_id: int | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> Any:
        return " ".join(v.split()) if isinstance(v, str) else v
