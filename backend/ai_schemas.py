"""Shared data contracts between the AI layer (ai.py, preprocessing.py, insights.py)
and the pipeline orchestrator (pipeline.py).

Fields may be ADDED by the AI layer, but existing names/types must not change:
pipeline.py, insights.py and the tests depend on them.

These models are the lenient PARSE and RETURN types: every newer field has a default, so
older model replies, fixtures and stored artifacts still validate. ai.py sends stricter
LLM-facing variants (required fields) as the structured-output schema.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Pre-processing output
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PreparedPage:
    """One normalised page image, ready to send to a vision model."""

    page_number: int          # 1-based
    media_type: str           # "image/png" or "image/jpeg"
    data: bytes               # encoded image bytes (fits provider size limits)
    path: Path                # copy written under ./artifacts/<submission_id>/


# --------------------------------------------------------------------------- #
# AI Call 1 - OCR & answer structuring
# --------------------------------------------------------------------------- #
class UncertainWord(BaseModel):
    text: str = Field(description="A word or short fragment the transcriber was unsure about.")
    confidence: float = Field(description="Confidence for this word, between 0 and 1.")


class OcrAnswer(BaseModel):
    question: int = Field(description="Question number as written on the sheet (1-based).")
    answer: str = Field(description="Verbatim transcription of the student's handwritten answer.")
    confidence: float = Field(description="Transcription confidence between 0 and 1.")
    pages: list[int] = Field(default_factory=list, description="1-based page numbers the answer appears on.")
    uncertain_words: list[UncertainWord] = Field(default_factory=list)
    source: str = "ocr"  # "ocr" | "faculty" (corrected by a faculty reviewer)


class PageAssessment(BaseModel):
    page: int = Field(description="1-based page number.")
    legibility_confidence: float = Field(description="How legible the page is overall, between 0 and 1.")


class OcrExtraction(BaseModel):
    """JSON shape the vision model returns (lenient parse type)."""

    answers: list[OcrAnswer]
    page_assessments: list[PageAssessment] = Field(default_factory=list)


class OcrResult(BaseModel):
    """What ai.run_ocr returns to the pipeline."""

    answers: list[OcrAnswer]
    overall_confidence: float  # mean of answer confidences, 0.0 when no answers
    provider: str              # "anthropic" | "openai"
    model: str
    raw_response: str | None = None  # raw model JSON, saved to artifacts for audit
    page_assessments: list[PageAssessment] = Field(default_factory=list)
    dropped_questions: list[int] = Field(default_factory=list)  # numbers returned but not in the rubric
    language_hints: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# AI Call 2 - Rubric evaluation
# --------------------------------------------------------------------------- #
class QuestionGrade(BaseModel):
    question: int = Field(description="Rubric question number being graded.")
    estimated_marks: float = Field(description="Marks awarded, between 0 and the question's max_marks.")
    evidence: str = Field(description="Quote or paraphrase from the answer that justifies the marks.")
    strengths: list[str]
    gaps: list[str]


class TeachingNudgeAI(BaseModel):
    priority: str = Field(description="high | medium | low")
    label: str = Field(description="Short label, 6 words or fewer.")
    text: str = Field(description="One concrete teacher action citing question numbers.")
    topic: str | None = None
    question_refs: list[int] = Field(default_factory=list)


class TopicIntervention(BaseModel):
    topic: str
    teach: str
    practice: str
    check_criterion: str


class Confusion(BaseModel):
    concept_a: str
    concept_b: str
    question: int | None = None
    evidence: str = ""


class EvaluationOutput(BaseModel):
    """JSON shape of the evaluation reply (and what ai.run_evaluation returns)."""

    evaluations: list[QuestionGrade]
    overall_strengths: list[str] = Field(description="2-3 strengths across the whole sheet.")
    overall_gaps: list[str] = Field(description="2-3 gaps across the whole sheet.")
    summary: str = ""
    teaching_nudges: list[TeachingNudgeAI] = Field(default_factory=list)
    topic_interventions: list[TopicIntervention] = Field(default_factory=list)
    confusions: list[Confusion] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Provider usage (cost & provenance) - one per provider call, never prompt/response text
# --------------------------------------------------------------------------- #
class ModelUsage(BaseModel):
    purpose: str                       # ocr | evaluation | consistency | rubric_parse
    provider: str                      # anthropic | openai | cache
    model_requested: str
    model_served: str | None = None
    request_id: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    image_count: int = 0
    latency_ms: int = 0
    status: str = "ok"                 # ok | error | refusal | cache_hit
    error_code: str | None = None
    fell_back: bool = False
