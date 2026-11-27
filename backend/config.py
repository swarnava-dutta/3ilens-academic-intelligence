"""Runtime settings, loaded from the repo-root .env (never from the CWD).

get_settings() re-reads os.environ on every call so tests can monkeypatch env vars.
Secrets are only ever read here; never log or return them from the API.
"""
from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from dotenv import dotenv_values, load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent

ENV_FILE = REPO_ROOT / ".env"

# LLM settings come ONLY from the project .env. The Windows user environment / shell
# may export ANTHROPIC_* / OPENAI_* variables for other tools (a local proxy base URL,
# an auth token, a different model or key). Those must never reach this backend, so
# every inherited variable with these prefixes is dropped before .env is loaded, and
# .env values override anything else. Runs once at import; tests override afterwards
# with monkeypatch.setenv.
_LLM_ENV_PREFIXES = ("ANTHROPIC_", "OPENAI_", "OPEN_API_")


def _load_project_env() -> None:
    file_values = dotenv_values(ENV_FILE) if ENV_FILE.is_file() else {}
    for name in list(os.environ):
        if name.upper().startswith(_LLM_ENV_PREFIXES) and name not in file_values:
            del os.environ[name]
    load_dotenv(ENV_FILE, override=True)


_load_project_env()

DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"

DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5"
DEFAULT_OPENAI_VISION_MODEL = "gpt-4o"

# BRD FR-2.4: below this OCR confidence a sheet is held for faculty review.
DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.70
# Assumed NEET date (the client has not confirmed one) - always labelled "assumed" in the UI.
DEFAULT_EXAM = "NEET"
DEFAULT_EXAM_DATE = "2027-05-02"

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ALLOWED_MIME_TYPES: tuple[str, ...] = ("application/pdf", "image/jpeg", "image/png", "image/webp", DOCX_MIME)
# Short labels for /api/health accepted_upload_types (same order as ALLOWED_MIME_TYPES).
MIME_LABELS: dict[str, str] = {
    "application/pdf": "pdf",
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
    DOCX_MIME: "docx",
}

# Voice answers (FR-2.8). Reported separately from accepted_upload_types (documents only).
AUDIO_MIME_TYPES: tuple[str, ...] = ("audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg")
AUDIO_LABELS: dict[str, str] = {"audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg"}
# The only non-deprecated transcription model in openai 3.57 (gpt-4o-transcribe,
# gpt-4o-mini-transcribe and whisper-1 have an announced shutdown of 2027-02-26).
DEFAULT_TRANSCRIBE_MODEL = "gpt-transcribe"
# Cross-vendor fallback (FR-3.10). openai 3.57 lists gpt-4o with an announced shutdown of
# 2027-01-14, so the model is env-configurable (LLM_FALLBACK_MODEL).
DEFAULT_FALLBACK_MODEL = "gpt-4o"
GPT4O_SHUTDOWN = "2027-01-14"
# Every OpenAI route (fallback grading, voice transcription) is labelled with this note.
RESIDENCY_NOTE = "Not residency-approved - PoC only (OpenAI, US-hosted)"

WHATSAPP_MODES = ("blocked", "simulate")

# Used to sign download links when DOWNLOAD_LINK_SECRET is not set: generated once per
# process, so links stop working after a restart (acceptable for a local PoC). Never logged.
_PROCESS_LINK_SECRET = secrets.token_hex(32)

_FALSE = {"0", "false", "no", "off"}
_TRUE = {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in _FALSE:
        return False
    if raw in _TRUE:
        return True
    return default


def _iso_date(name: str, default: str) -> str:
    raw = (os.environ.get(name) or "").strip()
    try:
        return date.fromisoformat(raw).isoformat() if raw else default
    except ValueError:
        return default


def _pricing_overrides() -> dict[str, dict[str, float]]:
    """LLM_PRICING_JSON='{"claude-sonnet-5-5": {"input": 2, "output": 10, "cache_write_5m": 2.5,
    "cache_read": 0.1}}' (USD per million tokens) overrides costing.PRICING_USD_PER_MTOK."""
    raw = (os.environ.get("LLM_PRICING_JSON") or "").strip()
    if not raw:
        return {}
    try:
        data: Any = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    overrides: dict[str, dict[str, float]] = {}
    for model, prices in data.items():
        if not isinstance(model, str) or not isinstance(prices, dict):
            continue
        clean = {}
        for key in ("input", "output", "cache_write_5m", "cache_read"):
            value = prices.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                clean[key] = float(value)
        if clean:
            overrides[model.strip()] = clean
    return overrides


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str
    openai_api_key: str
    vision_provider: str          # "anthropic" | "openai" (lower-cased; validated by ai.ai_readiness)
    anthropic_model: str
    openai_vision_model: str
    ocr_confidence_threshold: float
    cors_origins: list[str]
    database_url: str
    upload_dir: Path
    artifact_dir: Path
    anthropic_base_url: str = DEFAULT_ANTHROPIC_BASE_URL   # pass explicitly to anthropic.Anthropic(base_url=...)
    openai_base_url: str = DEFAULT_OPENAI_BASE_URL         # pass explicitly to openai.OpenAI(base_url=...)
    max_upload_bytes: int = 20 * 1024 * 1024
    max_pdf_pages: int = 40                     # MAX_PDF_PAGES (clamped 1-100): full printed papers (NEET: ~20 pages)
    ocr_pages_per_call: int = 10                # OCR_PAGES_PER_CALL (clamped 1-20): longer sheets are read in page chunks
    mcq_ocr_pages_per_call: int = 5             # MCQ_OCR_PAGES_PER_CALL (clamped 1-20): pages per call of the marked-option
                                                # reader (mcq_marks) for printed MCQ papers
    rubric_pages_per_call: int = 2              # RUBRIC_PAGES_PER_CALL (clamped 1-10): question-paper PDFs drafted page by page
    ai_chunk_concurrency: int = 5               # AI_CHUNK_CONCURRENCY (clamped 1-8): parallel page-chunk calls per sheet / paper
    allowed_mime_types: tuple[str, ...] = field(default=ALLOWED_MIME_TYPES)
    # --- OCR / pre-processing (FR-2.x) ---------------------------------------------------
    ocr_cache_enabled: bool = True              # OCR_CACHE: reuse OCR for identical file bytes (SHA-256)
    pdf_master_dpi: int = 200                   # PDF_MASTER_DPI
    vision_max_edge_px: int = 2000              # VISION_MAX_EDGE_PX (clamped 800-2576)
    preprocess_enhance: bool = True             # PREPROCESS_ENHANCE: deskew + contrast + sharpen
    preprocess_contrast: float = 1.4            # PREPROCESS_CONTRAST (BRD says 1.8; 1.4 keeps faint pencil)
    min_short_edge_px: int = 1200               # MIN_SHORT_EDGE_PX: upscale small photos
    typed_text_path: bool = True                # TYPED_TEXT_PATH: typed PDF / Word answer sheets read from their text layer
    preprocess_workers: int = 4                # PREPROCESS_WORKERS (clamped 1-8): threads for one sheet's per-page image
                                                # work and the tick reader's page re-encode (same bytes as 1)
    # --- worker ---------------------------------------------------------------------------
    max_job_attempts: int = 3                   # MAX_JOB_ATTEMPTS (transient AI errors)
    retry_backoff_base_seconds: float = 2.0     # RETRY_BACKOFF_BASE_SECONDS
    worker_concurrency: int = 4                 # WORKER_CONCURRENCY
    # --- cost / latency targets -------------------------------------------------------------
    usd_inr: float = 85.0                       # USD_INR
    cost_target_inr: float = 5.0                # COST_TARGET_INR (per student)
    latency_target_seconds: int = 300           # LATENCY_TARGET_SECONDS (per sheet)
    batch_target_seconds: int = 1800            # BATCH_TARGET_SECONDS (per intake batch)
    llm_pricing_overrides: dict[str, dict[str, float]] = field(default_factory=dict)  # LLM_PRICING_JSON
    # --- exam / study plan ------------------------------------------------------------------
    default_exam: str = DEFAULT_EXAM            # DEFAULT_EXAM
    default_exam_date: str = DEFAULT_EXAM_DATE  # NEET_EXAM_DATE (ISO; an assumed date)
    default_study_hours: float = 18.0           # STUDY_HOURS_PER_WEEK
    # --- outputs ---------------------------------------------------------------------------
    whatsapp_mode: str = "blocked"              # WHATSAPP_MODE: blocked | simulate (never really sends)
    download_link_secret: str = field(default=_PROCESS_LINK_SECRET, repr=False)  # DOWNLOAD_LINK_SECRET
    download_link_ttl_hours: int = 24           # DOWNLOAD_LINK_TTL_HOURS
    report_logo_path: Path | None = None        # REPORT_LOGO_PATH
    # --- voice, LLM fallback, LMS, interventions -----------------------------------------
    voice_answers_enabled: bool = True          # VOICE_ANSWERS (0/false/no/off disables)
    openai_transcribe_model: str = DEFAULT_TRANSCRIBE_MODEL  # OPENAI_TRANSCRIBE_MODEL
    allowed_audio_mime_types: tuple[str, ...] = field(default=AUDIO_MIME_TYPES)
    llm_fallback_enabled: bool = True           # LLM_FALLBACK: Claude -> OpenAI for ocr / evaluation / voice mapping
    llm_fallback_model: str = DEFAULT_FALLBACK_MODEL  # LLM_FALLBACK_MODEL (gpt-4o retires 2027-01-14)
    llm_simulate_outage: bool = False           # LLM_SIMULATE_PRIMARY_OUTAGE: demo switch, skips every Claude call
    lms_api_enabled: bool = True                # LMS_API
    lms_api_key: str = field(default="", repr=False)  # LMS_API_KEY: optional static key; never logged or returned
    lms_max_rows: int = 5000                    # LMS_MAX_ROWS (clamped 100-50000)
    default_intervention_hours: float = 3.0     # INTERVENTION_DEFAULT_HOURS (clamped 0.5-40)
    # --- demo data ---------------------------------------------------------------------------
    # SEED_DEMO_DATA: off (default) = a fresh database holds no rubric, sheet, result or insight;
    # every upload brings its own answer key. On = the Biology - Genetics sample rubric is created
    # at start-up and POST /api/demo/seed loads the synthetic sample sets.
    seed_demo_data: bool = False

    @property
    def max_upload_mb(self) -> int:
        return self.max_upload_bytes // (1024 * 1024)


def get_settings() -> Settings:
    env = os.environ.get
    whatsapp_mode = (env("WHATSAPP_MODE") or "blocked").strip().lower()
    logo = (env("REPORT_LOGO_PATH") or "").strip()
    return Settings(
        anthropic_api_key=(env("ANTHROPIC_API_KEY") or "").strip(),
        openai_api_key=(env("OPENAI_API_KEY") or "").strip(),
        vision_provider=(env("VISION_PROVIDER") or "anthropic").strip().lower(),
        anthropic_model=(env("ANTHROPIC_MODEL") or DEFAULT_ANTHROPIC_MODEL).strip(),
        openai_vision_model=(env("OPENAI_VISION_MODEL") or DEFAULT_OPENAI_VISION_MODEL).strip(),
        ocr_confidence_threshold=_float("OCR_CONFIDENCE_THRESHOLD", DEFAULT_OCR_CONFIDENCE_THRESHOLD),
        cors_origins=[
            o.strip()
            for o in (env("CORS_ORIGINS") or "http://localhost:3000,http://127.0.0.1:3000").split(",")
            if o.strip()
        ],
        database_url=env("DATABASE_URL") or f"sqlite:///{(BACKEND_DIR / '3ilens.db').as_posix()}",
        upload_dir=Path(env("UPLOAD_DIR") or REPO_ROOT / "uploads"),
        artifact_dir=Path(env("ARTIFACT_DIR") or REPO_ROOT / "artifacts"),
        anthropic_base_url=(env("ANTHROPIC_BASE_URL") or DEFAULT_ANTHROPIC_BASE_URL).strip(),
        openai_base_url=(env("OPENAI_BASE_URL") or DEFAULT_OPENAI_BASE_URL).strip(),
        max_pdf_pages=max(1, min(100, _int("MAX_PDF_PAGES", 40))),
        ocr_pages_per_call=max(1, min(20, _int("OCR_PAGES_PER_CALL", 10))),
        mcq_ocr_pages_per_call=max(1, min(20, _int("MCQ_OCR_PAGES_PER_CALL", 5))),
        rubric_pages_per_call=max(1, min(10, _int("RUBRIC_PAGES_PER_CALL", 2))),
        ai_chunk_concurrency=max(1, min(8, _int("AI_CHUNK_CONCURRENCY", 5))),
        ocr_cache_enabled=_bool("OCR_CACHE", True),
        pdf_master_dpi=max(72, min(600, _int("PDF_MASTER_DPI", 200))),
        vision_max_edge_px=max(800, min(2576, _int("VISION_MAX_EDGE_PX", 2000))),
        preprocess_enhance=_bool("PREPROCESS_ENHANCE", True),
        preprocess_contrast=max(0.5, min(3.0, _float("PREPROCESS_CONTRAST", 1.4))),
        min_short_edge_px=max(0, _int("MIN_SHORT_EDGE_PX", 1200)),
        typed_text_path=_bool("TYPED_TEXT_PATH", True),
        preprocess_workers=max(1, min(8, _int("PREPROCESS_WORKERS", 4))),
        max_job_attempts=max(1, _int("MAX_JOB_ATTEMPTS", 3)),
        retry_backoff_base_seconds=max(0.0, _float("RETRY_BACKOFF_BASE_SECONDS", 2.0)),
        worker_concurrency=max(1, _int("WORKER_CONCURRENCY", 4)),
        usd_inr=max(0.0, _float("USD_INR", 85.0)),
        cost_target_inr=max(0.0, _float("COST_TARGET_INR", 5.0)),
        latency_target_seconds=max(1, _int("LATENCY_TARGET_SECONDS", 300)),
        batch_target_seconds=max(1, _int("BATCH_TARGET_SECONDS", 1800)),
        llm_pricing_overrides=_pricing_overrides(),
        default_exam=(env("DEFAULT_EXAM") or DEFAULT_EXAM).strip() or DEFAULT_EXAM,
        default_exam_date=_iso_date("NEET_EXAM_DATE", DEFAULT_EXAM_DATE),
        default_study_hours=max(1.0, min(80.0, _float("STUDY_HOURS_PER_WEEK", 18.0))),
        whatsapp_mode=whatsapp_mode if whatsapp_mode in WHATSAPP_MODES else "blocked",
        download_link_secret=(env("DOWNLOAD_LINK_SECRET") or "").strip() or _PROCESS_LINK_SECRET,
        download_link_ttl_hours=max(1, _int("DOWNLOAD_LINK_TTL_HOURS", 24)),
        report_logo_path=Path(logo) if logo else None,
        voice_answers_enabled=_bool("VOICE_ANSWERS", True),
        openai_transcribe_model=(env("OPENAI_TRANSCRIBE_MODEL") or DEFAULT_TRANSCRIBE_MODEL).strip()
        or DEFAULT_TRANSCRIBE_MODEL,
        llm_fallback_enabled=_bool("LLM_FALLBACK", True),
        llm_fallback_model=(env("LLM_FALLBACK_MODEL") or DEFAULT_FALLBACK_MODEL).strip() or DEFAULT_FALLBACK_MODEL,
        llm_simulate_outage=_bool("LLM_SIMULATE_PRIMARY_OUTAGE", False),
        lms_api_enabled=_bool("LMS_API", True),
        lms_api_key=(env("LMS_API_KEY") or "").strip(),
        lms_max_rows=max(100, min(50000, _int("LMS_MAX_ROWS", 5000))),
        default_intervention_hours=max(0.5, min(40.0, _float("INTERVENTION_DEFAULT_HOURS", 3.0))),
        seed_demo_data=_bool("SEED_DEMO_DATA", False),
    )


def ocr_adapter_label(settings: Settings | None = None) -> str:
    """Honest name of the OCR engine, shown by /api/health, the report and the audit log."""
    settings = settings or get_settings()
    provider = settings.vision_provider
    model = settings.openai_vision_model if provider == "openai" else settings.anthropic_model
    return f"{provider} vision ({model}) - PoC stand-in for Google Vision DOCUMENT_TEXT_DETECTION"


def accepted_upload_types(settings: Settings | None = None) -> list[str]:
    settings = settings or get_settings()
    return [MIME_LABELS.get(mime, mime) for mime in settings.allowed_mime_types]


def accepted_voice_types(settings: Settings | None = None) -> list[str]:
    """['mp3', 'wav', 'm4a', 'ogg'] - reported by /api/health separately from documents."""
    settings = settings or get_settings()
    return [AUDIO_LABELS.get(mime, mime) for mime in settings.allowed_audio_mime_types]


def llm_fallback_label(settings: Settings | None = None) -> str:
    """The fallback model name, or 'off' (LLM_FALLBACK=0)."""
    settings = settings or get_settings()
    return settings.llm_fallback_model if settings.llm_fallback_enabled else "off"
