"""LLM route provenance and the provider chain (FR-3.10). Owned by W2-1; W2-0 wrote the stubs.

Routes are derived from the model_invocations rows of the latest run, so there is no new result
column. Every OpenAI route is labelled "not residency-approved - PoC only".
"""
from __future__ import annotations

from typing import Any

from config import GPT4O_SHUTDOWN, RESIDENCY_NOTE, get_settings

STAGES: tuple[str, ...] = ("transcription", "voice_mapping", "ocr", "evaluation")
LLM_STAGES: tuple[str, ...] = ("ocr", "evaluation", "voice_mapping")
ANTHROPIC_NOTE = "PoC: Anthropic API; India-region hosting not configured"
GEMINI_NOTE = "Not configured (no key) - listed so the BRD chain is visible; never called"


def derive_routes(rows: list[Any]) -> list[dict[str, Any]]:
    """LlmRoute dicts from ModelInvocation rows of one run. Stub until W2-1."""
    return []


def result_extras(db: Any, *, sub: Any, result: Any, rubric: Any) -> dict[str, Any]:
    """{"llm_routes": LlmRoute[]} for a completed result. Stub until W2-1."""
    return {"llm_routes": []}


def _deprecation(model: str) -> str | None:
    return f"Announced shutdown {GPT4O_SHUTDOWN} (openai SDK deprecation list)" if model == "gpt-4o" else None


def chain_status(db: Any) -> dict[str, Any]:
    """An LlmChainStatus built from settings (recent_fallbacks stays [] until W2-1)."""
    import ai  # local import: keeps this module light for result_view

    settings = get_settings()
    openai_ready = bool(settings.openai_api_key)
    providers = [
        {
            "provider": "anthropic",
            "model": settings.anthropic_model,
            "role": "primary",
            "configured": bool(settings.anthropic_api_key),
            "stages": list(LLM_STAGES),
            "deprecation": None,
            "residency_note": ANTHROPIC_NOTE,
        },
        {
            "provider": "openai",
            "model": settings.llm_fallback_model,
            "role": "fallback",
            "configured": settings.llm_fallback_enabled and openai_ready,
            "stages": list(LLM_STAGES) if settings.llm_fallback_enabled else [],
            "deprecation": _deprecation(settings.llm_fallback_model),
            "residency_note": RESIDENCY_NOTE,
        },
        {
            "provider": "openai",
            "model": settings.openai_transcribe_model,
            "role": "primary",
            "configured": settings.voice_answers_enabled and openai_ready,
            "stages": ["transcription"] if settings.voice_answers_enabled else [],
            "deprecation": None,
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
        "recent_fallbacks": [],
        "note": (
            "Claude is the primary model for OCR, grading and voice mapping; on a timeout, outage, rate limit, "
            "refusal or empty reply the same call is retried once on the fallback model. OpenAI routes are not "
            "residency-approved (PoC only)."
        ),
    }
