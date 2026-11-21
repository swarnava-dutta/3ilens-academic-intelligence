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
    max_pdf_pages: int = 10
    allowed_mime_types: tuple[str, ...] = field(default=ALLOWED_MIME_TYPES)
    # --- OCR / pre-processing (FR-2.x) ---------------------------------------------------
    ocr_cache_enabled: bool = True              # OCR_CACHE: reuse OCR for identical file bytes (SHA-256)
    pdf_master_dpi: int = 300                   # PDF_MASTER_DPI
    vision_max_edge_px: int = 2000              # VISION_MAX_EDGE_PX (clamped 800-2576)
    preprocess_enhance: bool = True             # PREPROCESS_ENHANCE: deskew + contrast + sharpen
    preprocess_contrast: float = 1.4            # PREPROCESS_CONTRAST (BRD says 1.8; 1.4 keeps faint pencil)
    min_short_edge_px: int = 1200               # MIN_SHORT_EDGE_PX: upscale small photos
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
        ocr_cache_enabled=_bool("OCR_CACHE", True),
        pdf_master_dpi=max(72, min(600, _int("PDF_MASTER_DPI", 300))),
        vision_max_edge_px=max(800, min(2576, _int("VISION_MAX_EDGE_PX", 2000))),
        preprocess_enhance=_bool("PREPROCESS_ENHANCE", True),
        preprocess_contrast=max(0.5, min(3.0, _float("PREPROCESS_CONTRAST", 1.4))),
        min_short_edge_px=max(0, _int("MIN_SHORT_EDGE_PX", 1200)),
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
