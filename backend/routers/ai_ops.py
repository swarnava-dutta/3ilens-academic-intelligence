"""[W2-1] LLM provider chain and Bloom detection (contract v3, API_CONTRACT.md):

- GET  /api/ops/llm-chain                 -> LlmChainStatus
- POST /api/ops/llm-chain/drill           (LlmDrillInput) -> LlmDrillResult
- POST /api/rubrics/{rubric_id}/bloom-levels (BloomDetectInput) -> BloomDetection
"""
from __future__ import annotations

import logging
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import ai
import llm_route
import marking
import provenance
from ai_schemas import ModelUsage, OcrAnswer
from config import get_settings
from database import get_db
from errors import ApiError
from schemas import LlmChainStatus, LlmDrillInput, LlmDrillResult

logger = logging.getLogger("3ilens.ai_ops")

router = APIRouter()
DbSession = Annotated[Session, Depends(get_db)]

# The drill grades one built-in answer: Genetics Q5 (Down's syndrome, 4 marks), criteria copied
# from rubrics/biology_genetics_v1.json. Sample data - never stored as a result.
DRILL_QUESTION = 5
DRILL_RUBRIC: dict[str, Any] = {
    "name": "LLM chain drill - Genetics Q5 (sample)",
    "subject": "Biology",
    "questions": [
        {
            "question": DRILL_QUESTION,
            "topic": "Chromosomal Disorders",
            "subject": "Biology",
            "max_marks": 4,
            "prompt": "What is Down's syndrome? State its cause and any two symptoms.",
            "expected_answer": (
                "Down's syndrome is a chromosomal disorder caused by trisomy of chromosome 21 (47 chromosomes, "
                "2n+1), usually due to non-disjunction of chromosome 21 during meiosis (gamete formation). "
                "Symptoms: short stature, small round head, furrowed tongue, partially open mouth, broad palm "
                "with characteristic palm crease, physical, psychomotor and mental retardation / congenital "
                "heart disease."
            ),
            "grading_criteria": [
                "1 mark: identifies it as a chromosomal disorder / aneuploidy",
                "1 mark: cause is trisomy 21 (extra copy of chromosome 21, 47 chromosomes)",
                "1 mark: mentions non-disjunction during meiosis",
                "1 mark: any two correct symptoms (0.5 each)",
            ],
            "effort_hours": 2,
        }
    ],
}
# A short, realistic answer worth about 3/4 (non-disjunction is missing).
DRILL_ANSWER = (
    "Down's syndrome is a chromosomal disorder. It is caused by trisomy of chromosome 21, so the person has "
    "47 chromosomes. Symptoms are short stature and mental retardation."
)


def _ai_failure(exc: ai.AIServiceError) -> ApiError:
    return ApiError(502, str(exc), "ai_failed")


def _record(db: Session, usages: list[ModelUsage]) -> list[Any]:
    """Persist each provider call (submission None) and return the rows in call order."""
    rows = []
    for usage in usages:
        try:
            rows.append(provenance.record_invocation(db, usage=usage, submission=None, commit=True))
        except Exception:  # noqa: BLE001 - cost tracking never fails the request
            db.rollback()
            logger.exception("Could not record a %s model invocation", usage.purpose)
    return rows


# --------------------------------------------------------------------------- #
# LLM chain
# --------------------------------------------------------------------------- #
@router.get("/api/ops/llm-chain", response_model=LlmChainStatus)
def get_llm_chain(db: DbSession) -> LlmChainStatus:
    return LlmChainStatus.model_validate(llm_route.chain_status(db))


def _drill_message(route: dict[str, Any], seconds: float) -> str:
    served = route.get("served_model") or "no model"
    if route.get("cross_vendor"):
        why = "skipped (simulated outage)" if route.get("reason") == "simulated_outage" else (
            f"failed ({route.get('reason') or 'error'})"
        )
        return f"Claude {why} - graded by {served} in {seconds:.1f} s (fallback route; not residency-approved)"
    if route.get("fell_back"):
        return f"Graded by {served} in {seconds:.1f} s (Claude server-side fallback model)"
    return f"Graded by {served} in {seconds:.1f} s - primary route, no fallback needed"


@router.post("/api/ops/llm-chain/drill", response_model=LlmDrillResult)
def run_llm_drill(body: LlmDrillInput, db: DbSession) -> LlmDrillResult:
    """Grade one built-in sample answer through the chain (real provider calls, about Rs 0.5).
    simulate_outage=True skips Claude so the fallback route runs."""
    settings = get_settings()
    if not body.simulate_outage and not settings.anthropic_api_key:
        raise ApiError(
            503,
            "The LLM chain drill needs ANTHROPIC_API_KEY. Add it to the .env file in the project root and restart "
            "the backend, or run the drill with simulate_outage to test only the fallback.",
            "ai_not_configured",
        )
    if body.simulate_outage and not ai.fallback_available(settings):
        raise ApiError(
            409,
            "No fallback model is available: set OPENAI_API_KEY and LLM_FALLBACK=1 in the .env file and restart "
            "the backend.",
            "fallback_unavailable",
        )
    usages: list[ModelUsage] = []
    answers = [OcrAnswer(question=DRILL_QUESTION, answer=DRILL_ANSWER, confidence=0.95)]
    started = time.perf_counter()
    try:
        evaluation = ai.run_evaluation(
            answers, DRILL_RUBRIC, on_usage=usages.append, purpose="llm_drill", simulate_outage=body.simulate_outage
        )
    except ai.AIConfigurationError as exc:
        _record(db, usages)
        raise ApiError(503, str(exc), "ai_not_configured") from exc
    except ai.AIServiceError as exc:
        _record(db, usages)
        raise _ai_failure(exc) from exc
    latency_ms = max(0, int(round((time.perf_counter() - started) * 1000)))
    rows = _record(db, usages)
    routes = llm_route.derive_routes(rows)
    route = routes[0] if routes else {
        "stage": "llm_drill", "primary_provider": "anthropic", "primary_model": settings.anthropic_model,
        "served_provider": None, "served_model": None, "fell_back": False, "cross_vendor": False,
        "reason": None, "attempts": 0,
    }
    grade = next((g for g in evaluation.evaluations if g.question == DRILL_QUESTION), None)
    question = DRILL_RUBRIC["questions"][0]
    sample_marks = None
    if grade is not None:
        sample_marks = marking.score_descriptive(
            question, estimated_marks=grade.estimated_marks,
            criteria_awards=[a.model_dump() for a in grade.criteria_awards],
            policy=marking.policy_for(DRILL_RUBRIC),
        )["marks"]
    return LlmDrillResult.model_validate({
        "ok": route.get("served_provider") is not None,
        "route": route,
        "calls": [llm_route.invocation_out(row) for row in rows],
        "sample_marks": sample_marks,
        "sample_max_marks": float(question["max_marks"]),
        "latency_ms": latency_ms,
        "message": _drill_message(route, latency_ms / 1000),
    })
