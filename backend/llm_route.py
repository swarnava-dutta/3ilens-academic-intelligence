"""LLM route provenance and the provider chain (FR-3.10). Owned by W2-1.

Routes are derived from the model_invocations rows of the latest run, so there is no new result
column: for each stage (transcription, voice mapping, OCR, grading) the first row names the
primary model and the last successful row names the model that actually served the answer.
Every OpenAI route is labelled "not residency-approved - PoC only".
"""
from __future__ import annotations

from typing import Any

from config import RESIDENCY_NOTE, get_settings

STAGES: tuple[str, ...] = ("transcription", "voice_mapping", "ocr", "evaluation")
LLM_STAGES: tuple[str, ...] = ("ocr", "evaluation", "voice_mapping")
ANTHROPIC_STAGES: tuple[str, ...] = ("ocr", "evaluation", "voice_mapping", "rubric_parse", "bloom_detect", "consistency")
SERVED_STATUSES = ("ok", "cache_hit")
RECENT_FALLBACKS = 20
ANTHROPIC_NOTE = "Pending the V5 'Model route and contract' decision (Bedrock India region preferred)"
OPENAI_FALLBACK_NOTE = RESIDENCY_NOTE + "; not approved for India-only processing"
GEMINI_NOTE = "Out of scope - no Gemini key in this PoC"
CACHE_REASON = "ocr_cache_hit"
CHAIN_NOTE = (
    "Claude is the primary model for OCR, grading and voice-answer mapping. On a timeout, outage, rate limit, "
    "refusal or empty reply the same call is retried once on the fallback model; a failing fallback reports the "
    "original Claude error. The chain exists for evaluation availability only: the OpenAI routes are not "
    "residency-approved (PoC only), and consistency re-grades, rubric drafting and Bloom detection never leave Claude."
)


# --------------------------------------------------------------------------- #
# Routes from invocation rows
# --------------------------------------------------------------------------- #
def _provider_of_model(model: str | None) -> str:
    return "anthropic" if str(model or "").lower().startswith("claude") else "openai"


def _stage_order(purpose: str, first_seen: int) -> tuple[int, int]:
    return (STAGES.index(purpose) if purpose in STAGES else len(STAGES), first_seen)


def _route(stage: str, rows: list[Any]) -> dict[str, Any]:
    first = rows[0]
    primary_provider = first.provider
    if primary_provider == "cache":  # a cache hit stands in for the configured vision model
        primary_provider = _provider_of_model(first.model_requested)
    served_index = next((i for i in range(len(rows) - 1, -1, -1) if rows[i].status in SERVED_STATUSES), None)
    served = rows[served_index] if served_index is not None else None
    before = rows[:served_index] if served_index is not None else rows
    failed = [r for r in before if r.status not in SERVED_STATUSES]
    reason = failed[-1].error_code if failed else None
    if served is not None and served.status == "cache_hit":
        reason = CACHE_REASON
    cross_vendor = bool(
        served is not None and served.provider != "cache" and served.provider != primary_provider
    )
    return {
        "stage": stage,
        "primary_provider": primary_provider,
        "primary_model": first.model_requested,
        "served_provider": served.provider if served is not None else None,
        "served_model": (served.model_served or served.model_requested) if served is not None else None,
        "fell_back": bool(cross_vendor or (served is not None and served.fell_back)),
        "cross_vendor": cross_vendor,
        "reason": reason,
        "attempts": len(rows),
    }


def derive_routes(rows: list[Any]) -> list[dict[str, Any]]:
    """LlmRoute dicts from the ModelInvocation rows of ONE run: one route per purpose, pipeline
    stages first (transcription, voice_mapping, ocr, evaluation), then any other purpose (e.g.
    llm_drill) in order of appearance."""
    groups: dict[str, list[Any]] = {}
    for row in sorted(rows or [], key=lambda r: r.id or 0):
        groups.setdefault(row.purpose, []).append(row)
    order = {purpose: i for i, purpose in enumerate(groups)}
    return [_route(purpose, groups[purpose]) for purpose in sorted(groups, key=lambda p: _stage_order(p, order[p]))]


def result_extras(db: Any, *, sub: Any, result: Any, rubric: Any) -> dict[str, Any]:
    """{"llm_routes": LlmRoute[]} for the latest run of a submission (seeded demo rows have no
    invocations, so []). Consistency re-grades and other non-pipeline calls are left out."""
    import provenance  # local import: keeps this module light for result_view

    rows = provenance.invocations_for(db, sub.id, since=provenance.run_start(sub))
    return {"llm_routes": derive_routes([r for r in rows if r.purpose in STAGES])}


# --------------------------------------------------------------------------- #
# Chain status (GET /api/ops/llm-chain)
# --------------------------------------------------------------------------- #
def invocation_out(row: Any) -> dict[str, Any]:
    """A ModelInvocation row as a ModelInvocationOut dict."""
    return {
        "id": row.id,
        "submission_id": row.submission_id,
        "purpose": row.purpose,
        "provider": row.provider,
        "model_requested": row.model_requested,
        "model_served": row.model_served,
        "request_id": row.request_id,
        "input_tokens": int(row.input_tokens or 0),
        "output_tokens": int(row.output_tokens or 0),
        "cache_creation_input_tokens": int(row.cache_creation_input_tokens or 0),
        "cache_read_input_tokens": int(row.cache_read_input_tokens or 0),
        "image_count": int(row.image_count or 0),
        "latency_ms": int(row.latency_ms or 0),
        "status": row.status if row.status in ("ok", "error", "refusal", "cache_hit") else "error",
        "error_code": row.error_code,
        "fell_back": bool(row.fell_back),
        "cost_usd": row.cost_usd,
        "cost_inr": row.cost_inr,
        "created_at": row.created_at,
    }


def _deprecation(model: str) -> str | None:
    import ai

    date = ai.deprecation_for(model)
    return f"Shutdown announced for {date} (openai SDK deprecation list)" if date else None


def recent_fallbacks(db: Any, limit: int = RECENT_FALLBACKS) -> list[Any]:
    """The newest model_invocations rows that fell back or failed with a fallback trigger code."""
    import ai
    from sqlalchemy import or_, select

    from database import ModelInvocation

    query = (
        select(ModelInvocation)
        .where(or_(ModelInvocation.fell_back.is_(True), ModelInvocation.error_code.in_(ai.FALLBACK_TRIGGER_CODES)))
        .order_by(ModelInvocation.id.desc())
        .limit(limit)
    )
    return list(db.scalars(query).all())


def chain_status(db: Any) -> dict[str, Any]:
    """An LlmChainStatus: the configured providers (with deprecation and residency notes) and the
    last 20 fallback / trigger-code calls."""
    import ai

    settings = get_settings()
    voice_ready = bool(settings.voice_answers_enabled and settings.openai_api_key)
    providers = [
        {
            "provider": "anthropic",
            "model": settings.anthropic_model,
            "role": "primary",
            "configured": bool(settings.anthropic_api_key),
            "stages": list(ANTHROPIC_STAGES),
            "deprecation": None,
            "residency_note": ANTHROPIC_NOTE,
        },
        {
            "provider": "openai",
            "model": settings.llm_fallback_model,
            "role": "fallback",
            "configured": ai.fallback_available(settings),
            "stages": list(LLM_STAGES),
            "deprecation": _deprecation(settings.llm_fallback_model),
            "residency_note": OPENAI_FALLBACK_NOTE,
        },
        {
            "provider": "openai",
            "model": settings.openai_transcribe_model,
            "role": "primary",
            "configured": voice_ready,
            "stages": ["transcription"],
            "deprecation": _deprecation(settings.openai_transcribe_model),
            "residency_note": RESIDENCY_NOTE + "; stand-in for Whisper large-v3 / Sarvam Saarika",
        },
        {
            "provider": "google",
            "model": "gemini-flash",
            "role": "fallback",
            "configured": False,
            "stages": [],
            "deprecation": None,
            "residency_note": GEMINI_NOTE,
        },
    ]
    return {
        "providers": providers,
        "fallback_enabled": settings.llm_fallback_enabled,
        "simulate_outage": settings.llm_simulate_outage,
        "trigger_codes": list(ai.FALLBACK_TRIGGER_CODES),
        "recent_fallbacks": [invocation_out(row) for row in recent_fallbacks(db)] if db is not None else [],
        "note": CHAIN_NOTE,
    }
