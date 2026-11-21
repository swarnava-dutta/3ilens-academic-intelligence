"""Exam-behaviour patterns (FR-4.8 negative marking, FR-4.10 fatigue, FR-4.11 memorisation vs
transfer) and the Bloom profile. Owned by W2-3; W2-0 wrote the constants and schema-valid stubs.

Read-side only: result_view / cohort call result_extras / cohort_extras through guarded hooks,
so an exception here never breaks a report. Every threshold below is a DEFAULT - confirm with
the academic lead (labelled so in the UI).

Rules (contract v3 section 11):
* Accuracy per question: clamp(estimated_marks / max_marks, 0, 1). Blank = 0; a wrong MCQ at -1 = 0.
* Negative marking: smoothed topic accuracy a_s = (correct + 1) / (attempted + 2); EV per attempt
  = a_s x mean_max - (1 - a_s) x mean_neg; high risk when EV < 1.0 and wrong >= 2, medium when
  EV < 2.0 and wrong >= 1. BREAK_EVEN = neg / (max + neg) (0.2 for +4/-1).
* Fatigue: needs >= 6 questions; final third vs the rest, cohort-adjusted when >= 5 results share
  the rubric; flagged at >= 15 pts (high >= 25) or a blank-rate jump >= 0.20 (high >= 0.35).
* Transfer: concept groups with >= 1 recall (K1-K2) and >= 1 transfer (K3-K5) question;
  foundational_gap / memorisation / inconsistent / transferable / developing (first match wins).
"""
from __future__ import annotations

from typing import Any

import bloom

THRESHOLD_LABEL = "default - confirm with academic lead"

# --- negative marking (FR-4.8) -----------------------------------------------------------
NEG_HIGH_EV = 1.0
NEG_MEDIUM_EV = 2.0
SKIP_THRESHOLD = {"high": 0.50, "medium": 0.34}  # low = break-even
ELIMINATE_OPTIONS = {"high": 2, "medium": 1, "low": 0}
NO_NEGATIVE_MCQ_NOTE = "No negatively-marked MCQs in this test"

# --- fatigue (FR-4.10) --------------------------------------------------------------------
MIN_FATIGUE_QUESTIONS = 6
COHORT_ADJUST_MIN = 5
FATIGUE_FLAG_PTS = 15.0
FATIGUE_HIGH_PTS = 25.0
FATIGUE_BLANK_JUMP = 0.20
FATIGUE_HIGH_BLANK_JUMP = 0.35
FATIGUE_NOTE = "Needs at least 6 questions (this test has {n})"

# --- memorisation vs transfer (FR-4.11) ---------------------------------------------------
TRANSFER_LOW = 40.0
TRANSFER_HIGH = 60.0
TRANSFER_GAP = 25.0
TRANSFER_NOTE = "Needs the same concept at recall (K1-K2) and application (K3-K5) levels"


def break_even(max_marks: float, negative_marks: float) -> float:
    """Accuracy at which attempting breaks even: neg / (max + neg). 0.2 for +4/-1."""
    total = float(max_marks) + float(negative_marks)
    return round(float(negative_marks) / total, 4) if total > 0 else 0.0


def empty_student_patterns() -> dict[str, Any]:
    """A StudentPatterns with every profile null (the hook default)."""
    return {"negative_marking": None, "fatigue": None, "transfer": None, "bloom_profile": [], "notes": []}


def empty_cohort_patterns() -> dict[str, Any]:
    """A CohortPatterns with every profile null (the hook default)."""
    return {"negative_marking": None, "fatigue": None, "transfer": None, "bloom_profile": [], "notes": []}


def concept_group(question_eval: dict[str, Any], rubric_question: dict[str, Any] | None) -> str:
    """The concept a question belongs to. Stub: bloom.concept_key (W2-3 adds the matrix parent chapter)."""
    return bloom.concept_key(rubric_question) or bloom.concept_key(question_eval)


def result_extras(db: Any, *, sub: Any, result: Any, rubric: Any) -> dict[str, Any]:
    """{"patterns": StudentPatterns} for one completed result. Stub until W2-3."""
    return {"patterns": empty_student_patterns()}


def cohort_extras(db: Any, *, pairs: list[tuple[Any, Any]], rubrics: dict[int, Any]) -> dict[str, Any]:
    """{"patterns": CohortPatterns} over the completed (submission, result) pairs. Stub until W2-3."""
    return {"patterns": empty_cohort_patterns()}
