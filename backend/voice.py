"""Voice answers (FR-2.8): transcription and the read-side voice info. Owned by W2-2; W2-0
wrote the final signatures, a stub transcribe and the real wav_seconds / result_extras.

Transcription uses OpenAI gpt-transcribe (OPENAI_TRANSCRIBE_MODEL) as the labelled stand-in for
Whisper large-v3 / Sarvam Saarika. It is not residency-approved (PoC only); VOICE_ANSWERS=0
switches voice intake off. The per-minute price is not known, so its cost is shown as unknown.
"""
from __future__ import annotations

import wave
from pathlib import Path
from typing import Any, Callable

from ai_schemas import ModelUsage, Transcript
from config import get_settings
from database import INPUT_VOICE

UsageCallback = Callable[[ModelUsage], None]
STAND_IN_LABEL = "stand-in for Whisper large-v3 / Sarvam Saarika"


def transcribe(
    path: Path,
    mime_type: str,
    *,
    language_hints: list[str],
    keywords: list[str],
    on_usage: UsageCallback | None = None,
) -> Transcript:
    """Transcribe one audio file. Stub until W2-2: needs OPENAI_API_KEY, then not_implemented."""
    import ai  # local import: ai.py is heavy and owns the error types

    settings = get_settings()
    if not settings.openai_api_key:
        raise ai.AIConfigurationError("OPENAI_API_KEY is not configured (voice answers use OpenAI transcription).")
    raise ai.AIServiceError("Voice transcription is not available yet.", code="not_implemented")


def wav_seconds(path: Path) -> float | None:
    """Duration of a WAV file (stdlib wave); None when the file is not a readable WAV."""
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            if rate <= 0:
                return None
            return round(handle.getnframes() / float(rate), 2)
    except (wave.Error, EOFError, OSError, ValueError):
        return None


def is_voice(sub: Any) -> bool:
    return (getattr(sub, "input_kind", None) or "document") == INPUT_VOICE


def result_extras(db: Any, *, sub: Any) -> dict[str, Any]:
    """{"voice": VoiceInfo | None}: None for documents. Minimal real version (W2-2 adds the
    transcript details)."""
    if not is_voice(sub):
        return {"voice": None}
    file_path = getattr(sub, "file_path", "") or ""
    has_audio = bool(file_path) and Path(file_path).is_file()
    return {
        "voice": {
            "audio_url": f"/api/submissions/{sub.id}/audio" if has_audio else None,
            "audio_seconds": sub.audio_seconds,
            "detected_languages": list(sub.detected_languages or []),
            "transcription_model": None,
            "voice_question": sub.voice_question,
            "transcript_chars": 0,
            "synthetic": bool(sub.is_demo),
        }
    }
