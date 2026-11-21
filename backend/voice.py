"""Voice answers (FR-2.8): transcription and the read-side voice info.

Transcription uses OpenAI gpt-transcribe (OPENAI_TRANSCRIBE_MODEL) as the labelled stand-in for
Whisper large-v3 / Sarvam Saarika. It is not residency-approved (PoC only); VOICE_ANSWERS=0
switches voice intake off. The per-minute price is not known, so its cost is shown as unknown
(costing.py has no gpt-transcribe price; none is invented here).

Both recording styles are supported: one recording per question (Submission.voice_question set:
the transcript IS that answer, no mapping call) and a whole-paper recording (the transcript is
mapped onto the rubric questions by ai.structure_transcript). The transcript text is never logged.
"""
from __future__ import annotations

import json
import logging
import re
import time
import wave
from pathlib import Path
from typing import Any, Callable

from ai_schemas import ModelUsage, Transcript
from config import get_settings
from database import INPUT_VOICE

logger = logging.getLogger("3ilens.voice")

UsageCallback = Callable[[ModelUsage], None]
STAND_IN_LABEL = "stand-in for Whisper large-v3 / Sarvam Saarika"
# artifacts/<submission id>/transcript.json: {text, model, languages, seconds, request_id, created_at}
TRANSCRIPT_FILE = "transcript.json"
# Writing systems seen in a transcript (code-switched answers often report only one language).
_SCRIPTS = (
    ("hi", re.compile(r"[\u0900-\u097F]")),  # Devanagari
    ("te", re.compile(r"[\u0C00-\u0C7F]")),  # Telugu
    ("kn", re.compile(r"[\u0C80-\u0CFF]")),  # Kannada
    ("ta", re.compile(r"[\u0B80-\u0BFF]")),  # Tamil
)
_LATIN_WORD = re.compile(r"\b[A-Za-z]{2,}\b")
# File extension per sniffed audio MIME type (uploads.MIME_EXTENSIONS reuses it).
AUDIO_EXTENSIONS: dict[str, str] = {
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
}
AUDIO_FORMAT_NAMES: dict[str, str] = {"audio/mpeg": "MP3", "audio/wav": "WAV", "audio/mp4": "M4A", "audio/ogg": "OGG"}
MAX_KEYWORDS = 30
NO_KEY_MESSAGE = (
    "OPENAI_API_KEY is not configured (required for voice answers). Add it to the .env file in the "
    "project root and restart the backend."
)
EMPTY_TRANSCRIPT_MESSAGE = "The transcription returned no speech."


# --------------------------------------------------------------------------- #
# Transcription (one OpenAI speech-to-text call)
# --------------------------------------------------------------------------- #
def rubric_keywords(rubric_content: dict[str, Any] | None) -> list[str]:
    """Topic and chapter names of the rubric (de-duplicated, at most 30): vocabulary hints for the
    transcription model, e.g. 'Mendelian Genetics', 'Molecular Basis of Inheritance'."""
    out: list[str] = []
    seen: set[str] = set()
    for question in (rubric_content or {}).get("questions") or []:
        if not isinstance(question, dict):
            continue
        for key in ("topic", "chapter", "concept"):
            word = " ".join(str(question.get(key) or "").split())
            if word and word.casefold() not in seen:
                seen.add(word.casefold())
                out.append(word)
    return out[:MAX_KEYWORDS]


def _emit(on_usage: UsageCallback | None, usage: ModelUsage) -> None:
    if on_usage is None:
        return
    try:
        on_usage(usage)
    except Exception:  # noqa: BLE001 - bookkeeping must never fail the call
        logger.exception("on_usage callback failed for a transcription call")


def transcribe(
    path: Path,
    mime_type: str,
    *,
    language_hints: list[str],
    keywords: list[str],
    on_usage: UsageCallback | None = None,
) -> Transcript:
    """Transcribe one audio file with OpenAI (settings.openai_transcribe_model).

    Raises ai.AIConfigurationError without an OPENAI_API_KEY (no client is created) and
    ai.AIServiceError for provider errors (transient flags as for every other AI call, so the
    pipeline retries rate limits / timeouts) or an empty transcript (code empty_transcript)."""
    import ai  # local import: ai.py is heavy and owns the error types and the OpenAI client
    import openai

    settings = get_settings()
    if not settings.openai_api_key:
        raise ai.AIConfigurationError(NO_KEY_MESSAGE)
    model = settings.openai_transcribe_model
    hints = ai.clean_language_hints(language_hints)
    path = Path(path)
    params: dict[str, Any] = {
        "file": (f"answer{AUDIO_EXTENSIONS.get(mime_type, '.mp3')}", path.read_bytes(), mime_type),
        "model": model,
        "response_format": "json",
    }
    if model.startswith("gpt-transcribe"):
        if hints:
            params["languages"] = hints
        words = list(dict.fromkeys(w.strip() for w in keywords or [] if w and w.strip()))[:MAX_KEYWORDS]
        if words:
            params["keywords"] = words
    elif len(hints) == 1:
        params["language"] = hints[0]

    client = ai._openai_client(settings)
    started = time.perf_counter()
    try:
        response = client.audio.transcriptions.create(**params)
    except Exception as exc:  # noqa: BLE001 - mapped to a user-safe AIServiceError
        error = ai._service_error(
            exc, sdk=openai, provider="OpenAI", model=model, key_name="OPENAI_API_KEY",
            purpose="transcription", settings=settings,
        )
        _emit(on_usage, ModelUsage(
            purpose="transcription", provider="openai", model_requested=model,
            request_id=getattr(exc, "request_id", None),
            latency_ms=int((time.perf_counter() - started) * 1000), status="error", error_code=error.code,
        ))
        raise error from exc
    latency_ms = int((time.perf_counter() - started) * 1000)

    usage = getattr(response, "usage", None)
    usage_type = getattr(usage, "type", None)
    input_tokens = int(getattr(usage, "input_tokens", 0) or 0) if usage_type == "tokens" else 0
    output_tokens = int(getattr(usage, "output_tokens", 0) or 0) if usage_type == "tokens" else 0
    seconds = getattr(usage, "seconds", None) if usage_type == "duration" else None
    request_id = getattr(response, "_request_id", None)
    _emit(on_usage, ModelUsage(
        purpose="transcription", provider="openai", model_requested=model, model_served=model,
        request_id=request_id if isinstance(request_id, str) else None,
        input_tokens=input_tokens, output_tokens=output_tokens, latency_ms=latency_ms, status="ok",
    ))
    text = str(getattr(response, "text", "") or "").strip()
    if not text:
        raise ai.AIServiceError(EMPTY_TRANSCRIPT_MESSAGE, code="empty_transcript")
    languages = [
        code for code in (getattr(item, "code", None) for item in getattr(response, "languages", None) or [])
        if isinstance(code, str) and code
    ]
    languages = list(dict.fromkeys([*languages, *script_languages(text)]))
    logger.info(
        "Transcribed %s (%s): %d characters, languages %s, %d ms", path.name, model, len(text),
        ",".join(languages) or "-", latency_ms,
    )
    return Transcript(
        text=text, model=model, languages=languages,
        seconds=float(seconds) if isinstance(seconds, (int, float)) else None,
        request_id=request_id if isinstance(request_id, str) else None,
    )


def script_languages(text: str) -> list[str]:
    """Language codes implied by the scripts in a transcript: Devanagari -> hi, Telugu -> te,
    Kannada -> kn, Tamil -> ta, and en when there are at least 3 Latin-script words."""
    codes = [code for code, pattern in _SCRIPTS if pattern.search(text or "")]
    if len(_LATIN_WORD.findall(text or "")) >= 3:
        codes.append("en")
    return codes


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


# --------------------------------------------------------------------------- #
# Read side
# --------------------------------------------------------------------------- #
def is_voice(sub: Any) -> bool:
    return (getattr(sub, "input_kind", None) or "document") == INPUT_VOICE


def read_transcript(submission_id: int) -> dict[str, Any] | None:
    """artifacts/<id>/transcript.json, or None when missing / unreadable."""
    path = get_settings().artifact_dir / str(submission_id) / TRANSCRIPT_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("text"), str) else None


def audio_path(sub: Any) -> Path | None:
    """The stored audio file of a voice submission, only when it exists inside UPLOAD_DIR."""
    if not is_voice(sub) or not getattr(sub, "file_path", None):
        return None
    try:
        root = get_settings().upload_dir.resolve()
        path = Path(sub.file_path).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return path


def _sample_text(sub: Any) -> str:
    """Demo / sample rows have no transcript artifact: the stored answer text stands in."""
    result = getattr(sub, "result", None)
    items = [q for q in (getattr(result, "question_evaluations", None) or []) if isinstance(q, dict)]
    question = getattr(sub, "voice_question", None)
    if question is not None:
        for item in items:
            if item.get("question") == question:
                return str(item.get("student_answer") or "")
    return "\n\n".join(
        f"Q{item.get('question')}: {str(item.get('student_answer')).strip()}"
        for item in items if str(item.get("student_answer") or "").strip()
    )


def result_extras(db: Any, *, sub: Any) -> dict[str, Any]:
    """{"voice": VoiceInfo | None}: None for documents."""
    if not is_voice(sub):
        return {"voice": None}
    transcript = None if sub.is_demo else read_transcript(sub.id)
    # Sample rows have no transcript artifact: count the text GET /transcript synthesises for them.
    model = transcript.get("model") if transcript is not None else None
    if transcript is not None:
        chars = len(transcript["text"])
    else:
        sample = _sample_text(sub) if sub.is_demo else ""
        chars = len(sample) if sample.strip() else 0
    return {
        "voice": {
            "audio_url": f"/api/submissions/{sub.id}/audio" if audio_path(sub) is not None else None,
            "audio_seconds": sub.audio_seconds,
            "detected_languages": list(sub.detected_languages or []),
            "transcription_model": model if isinstance(model, str) else None,
            "voice_question": sub.voice_question,
            "transcript_chars": chars,
            "synthetic": bool(sub.is_demo),
        }
    }


def transcript_out(db: Any, sub: Any) -> dict[str, Any] | None:
    """A VoiceTranscript dict, or None (not a voice row, or no transcript yet)."""
    if not is_voice(sub):
        return None
    transcript = None if sub.is_demo else read_transcript(sub.id)
    if transcript is not None:
        languages = [c for c in transcript.get("languages") or [] if isinstance(c, str)]
        seconds = transcript.get("seconds")
        return {
            "submission_id": sub.id,
            "text": transcript["text"],
            "model": transcript.get("model") if isinstance(transcript.get("model"), str) else None,
            "detected_languages": languages or list(sub.detected_languages or []),
            "audio_seconds": sub.audio_seconds if sub.audio_seconds is not None else (
                float(seconds) if isinstance(seconds, (int, float)) else None
            ),
            "created_at": transcript.get("created_at"),
            "synthetic": False,
        }
    if not sub.is_demo:
        return None
    text = _sample_text(sub)
    if not text.strip():
        return None
    return {
        "submission_id": sub.id,
        "text": text,
        "model": None,
        "detected_languages": list(sub.detected_languages or []),
        "audio_seconds": sub.audio_seconds,
        "created_at": None,
        "synthetic": True,
    }
