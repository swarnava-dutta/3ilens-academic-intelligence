"""SQLite persistence - the local stand-in for the "Governed Results Store" (Amazon RDS).

The engine is built lazily from get_settings().database_url and rebuilt automatically when
that URL changes (tests point DATABASE_URL at a temp file per test).

Schema evolution: init_db() runs create_all() (new tables) and then _ensure_columns(), an
idempotent SQLite migration that adds the newer nullable columns to databases created by
older builds (PRAGMA table_info + ALTER TABLE ADD COLUMN + CREATE INDEX IF NOT EXISTS).
Read code treats NULL in those columns as the documented default.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    event,
    text,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker
from sqlalchemy.types import TypeDecorator

from config import get_settings

logger = logging.getLogger("3ilens.database")


class SubmissionStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    HUMAN_REVIEW_REQUIRED = "HUMAN_REVIEW_REQUIRED"


class RubricStatus(StrEnum):
    AUTHOR_DRAFT = "AUTHOR_DRAFT"
    FACULTY_APPROVED = "FACULTY_APPROVED"


class ReleaseStatus(StrEnum):
    PROVISIONAL = "PROVISIONAL"
    RELEASED = "RELEASED"


# StudentSubmission.input_kind (NULL reads as INPUT_DOCUMENT).
INPUT_DOCUMENT = "document"
INPUT_VOICE = "voice"


# India has no DST, so a fixed +05:30 offset is exact (and needs no tzdata on Windows).
IST = timezone(timedelta(hours=5, minutes=30), "IST")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(dt: datetime | None = None) -> str:
    """ISO-8601 UTC timestamp with a trailing Z (used in processing_log entries)."""
    dt = (dt or utcnow()).astimezone(timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ist_today() -> date:
    return datetime.now(IST).date()


class UTCDateTime(TypeDecorator):
    """Stores naive UTC in SQLite, always hands back timezone-aware UTC datetimes."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


def _default_exam() -> str:
    return get_settings().default_exam


# --------------------------------------------------------------------------- #
# Models (spec Section 4, extended for the demo UI)
# --------------------------------------------------------------------------- #
class Institution(Base):
    __tablename__ = "institutions"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)

    batches: Mapped[list[Batch]] = relationship(back_populates="institution")


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    exam_type: Mapped[str] = mapped_column(String(100))
    institution_id: Mapped[int] = mapped_column(ForeignKey("institutions.id"))
    # NULL exam -> settings.default_exam. NULL exam_date -> settings.default_exam_date, reported
    # to the UI as an *assumed* date (Batch.exam_date_assumed); PATCH /api/batches sets a real one.
    exam: Mapped[str | None] = mapped_column(String(50), nullable=True, default=_default_exam)
    exam_date: Mapped[str | None] = mapped_column(String(10), nullable=True)  # ISO date
    faculty_lead: Mapped[str | None] = mapped_column(String(120), nullable=True)  # free text (no users table)

    institution: Mapped[Institution] = relationship(back_populates="batches")


class Rubric(Base):
    __tablename__ = "rubrics"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    version: Mapped[str] = mapped_column(String(50))
    content: Mapped[dict[str, Any]] = mapped_column(JSON)
    total_marks: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    rubric_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)  # hashing.rubric_hash(content)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True, default=RubricStatus.AUTHOR_DRAFT)
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # previous version (rubric_store)
    change_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class StudentSubmission(Base):
    __tablename__ = "student_submissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    student_name: Mapped[str] = mapped_column(String(120))
    file_path: Mapped[str] = mapped_column(String(1024), default="")  # internal only - never sent to the UI
    original_filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(32), default=SubmissionStatus.PENDING, index=True)
    ocr_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_step: Mapped[str] = mapped_column(String(100), default="Queued")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    processing_log: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=lambda: [])
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id"))
    rubric_id: Mapped[int] = mapped_column(ForeignKey("rubrics.id"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)
    # --- custody / intake (FR-1.x, FR-2.5) -------------------------------------------------
    file_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)  # SHA-256 at ingestion
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    language_hints: Mapped[list[str] | None] = mapped_column(JSON, nullable=True, default=lambda: ["en"])
    student_ref: Mapped[str | None] = mapped_column(String(160), nullable=True, index=True)
    intake_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # --- worker ------------------------------------------------------------------------------
    attempts: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)
    last_error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # why a HUMAN_REVIEW_REQUIRED sheet is held (schemas.ReviewReasonLit); None otherwise
    review_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    flagged_pages: Mapped[list[int] | None] = mapped_column(JSON, nullable=True, default=lambda: [])
    page_confidences: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True, default=lambda: [])
    ocr_cache_hit: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)
    custody_verified: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # --- voice answers (FR-2.8) ------------------------------------------------------------
    input_kind: Mapped[str | None] = mapped_column(String(16), nullable=True, default=INPUT_DOCUMENT)
    audio_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    voice_question: Mapped[int | None] = mapped_column(Integer, nullable=True)  # per-question recording
    detected_languages: Mapped[list[str] | None] = mapped_column(JSON, nullable=True, default=lambda: [])

    batch: Mapped[Batch] = relationship()
    rubric: Mapped[Rubric] = relationship()
    result: Mapped[EvaluationResult | None] = relationship(
        back_populates="submission", uselist=False, cascade="all, delete-orphan"
    )


class EvaluationResult(Base):
    __tablename__ = "evaluation_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Stays UNIQUE: a re-run archives the current row into evaluation_versions first.
    submission_id: Mapped[int] = mapped_column(ForeignKey("student_submissions.id"), unique=True)
    total_score: Mapped[float] = mapped_column(Float)
    total_marks: Mapped[float] = mapped_column(Float)
    overall_mastery: Mapped[float] = mapped_column(Float)
    topic_mastery: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    roi_recommendations: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    strengths_gaps: Mapped[dict[str, Any]] = mapped_column(JSON)
    question_evaluations: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    # --- narrative (AI call 2, FR-3.2) ------------------------------------------------------
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    teaching_nudges: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True, default=lambda: [])
    confusions: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True, default=lambda: [])
    # --- versioning / release / cost -----------------------------------------------------------
    rubric_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rubric_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True, default=1)
    release_status: Mapped[str | None] = mapped_column(String(32), nullable=True, default=ReleaseStatus.PROVISIONAL)
    reviewed_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_cost_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
    cost_breakdown: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)  # {ocr_inr, evaluation_inr, other_inr}

    submission: Mapped[StudentSubmission] = relationship(back_populates="result")


class OcrCache(Base):
    """FR-2.5: OCR output keyed by file SHA-256 + rubric question list + model + prompt version."""

    __tablename__ = "ocr_cache"

    id: Mapped[int] = mapped_column(primary_key=True)
    cache_key: Mapped[str] = mapped_column(String(64), unique=True)
    file_hash: Mapped[str] = mapped_column(String(64), index=True)
    institution_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rubric_questions_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    language_hints: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    ocr_result: Mapped[dict[str, Any]] = mapped_column(JSON)  # OcrResult.model_dump(mode="json")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    hit_count: Mapped[int] = mapped_column(Integer, default=0)
    last_hit_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class ModelInvocation(Base):
    """One row per provider call (or OCR cache hit): tokens, latency, cost. Never prompt text."""

    __tablename__ = "model_invocations"

    id: Mapped[int] = mapped_column(primary_key=True)
    institution_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    batch_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    submission_id: Mapped[int | None] = mapped_column(
        ForeignKey("student_submissions.id"), nullable=True, index=True
    )
    purpose: Mapped[str] = mapped_column(String(32))  # ocr | evaluation | consistency | rubric_parse
    provider: Mapped[str] = mapped_column(String(32))
    model_requested: Mapped[str] = mapped_column(String(100))
    model_served: Mapped[str | None] = mapped_column(String(100), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_creation_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    image_count: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="ok")  # ok | error | refusal | cache_hit
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fell_back: Mapped[bool] = mapped_column(Boolean, default=False)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    cost_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class EvaluationVersion(Base):
    """An archived (superseded) EvaluationResult - written by results_store.archive_current_result."""

    __tablename__ = "evaluation_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("student_submissions.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    rubric_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rubric_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    rubric_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    total_score: Mapped[float] = mapped_column(Float)
    total_marks: Mapped[float] = mapped_column(Float)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)  # ReportPayload fields + summary/nudges/confusions
    release_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # of the archived result
    superseded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True, default=utcnow)
    superseded_by_rubric_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class OcrReview(Base):
    """Faculty OCR review actions (approve / correct / rescan) - FR-2.4 human-in-the-loop."""

    __tablename__ = "ocr_reviews"

    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("student_submissions.id"), index=True)
    reviewer: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(16))  # approve | correct | rescan
    before: Mapped[Any] = mapped_column(JSON, nullable=True)
    after: Mapped[Any] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Delivery(Base):
    """A (simulated) report delivery. WhatsApp is never really sent in this PoC."""

    __tablename__ = "deliveries"

    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("student_submissions.id"), index=True)
    channel: Mapped[str] = mapped_column(String(32))
    recipient_masked: Mapped[str | None] = mapped_column(String(64), nullable=True)
    template_name: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(40))  # BLOCKED_TEMPLATE_PENDING | SIMULATED_NOT_SENT
    detail: Mapped[str] = mapped_column(Text, default="")
    token_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class InterventionRecord(Base):
    """FR-4.13: a teaching action applied to a student's topic, measured against a later test."""

    __tablename__ = "intervention_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    institution_id: Mapped[int] = mapped_column(Integer, index=True)
    batch_id: Mapped[int] = mapped_column(Integer, index=True)
    # The baseline result the action responds to.
    submission_id: Mapped[int] = mapped_column(ForeignKey("student_submissions.id"), index=True)
    student_ref: Mapped[str] = mapped_column(String(160), index=True)
    student_name: Mapped[str] = mapped_column(String(120))
    topic: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(32))  # nudge | study_focus | class_intervention | custom
    action: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(16), default="faculty")  # ai | template | faculty
    applied_by: Mapped[str] = mapped_column(String(120))
    applied_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    compliance: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-1
    baseline_mastery: Mapped[float | None] = mapped_column(Float, nullable=True)  # captured at record time
    predicted_gain_pct: Mapped[float | None] = mapped_column(Float, nullable=True)  # effort model, at record time
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ApiKey(Base):
    """FR-5.10: LMS export keys. Only the SHA-256 of the secret is stored; it is shown once."""

    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    prefix: Mapped[str] = mapped_column(String(16))  # first 8 characters of the secret, for display
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)  # SHA-256 hex of the full secret
    institution_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # NULL = all institutions
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


# --------------------------------------------------------------------------- #
# Idempotent SQLite migration for databases created by older builds
# --------------------------------------------------------------------------- #
# (table, column, SQLite column DDL). Every column is nullable; NULL = documented default.
MIGRATION_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("batches", "exam", "VARCHAR(50)"),
    ("batches", "exam_date", "VARCHAR(10)"),
    ("rubrics", "rubric_hash", "VARCHAR(64)"),
    ("rubrics", "status", "VARCHAR(32)"),
    ("rubrics", "parent_id", "INTEGER"),
    ("rubrics", "change_note", "TEXT"),
    ("student_submissions", "file_hash", "VARCHAR(64)"),
    ("student_submissions", "file_size", "INTEGER"),
    ("student_submissions", "page_count", "INTEGER"),
    ("student_submissions", "language_hints", "JSON"),
    ("student_submissions", "student_ref", "VARCHAR(160)"),
    ("student_submissions", "intake_batch_id", "VARCHAR(64)"),
    ("student_submissions", "attempts", "INTEGER"),
    ("student_submissions", "last_error_code", "VARCHAR(64)"),
    ("student_submissions", "flagged_pages", "JSON"),
    ("student_submissions", "page_confidences", "JSON"),
    ("student_submissions", "ocr_cache_hit", "BOOLEAN"),
    ("student_submissions", "custody_verified", "BOOLEAN"),
    ("student_submissions", "started_at", "DATETIME"),
    ("student_submissions", "completed_at", "DATETIME"),
    ("evaluation_results", "summary", "TEXT"),
    ("evaluation_results", "teaching_nudges", "JSON"),
    ("evaluation_results", "confusions", "JSON"),
    ("evaluation_results", "rubric_id", "INTEGER"),
    ("evaluation_results", "rubric_hash", "VARCHAR(64)"),
    ("evaluation_results", "version", "INTEGER"),
    ("evaluation_results", "release_status", "VARCHAR(32)"),
    ("evaluation_results", "reviewed_by", "VARCHAR(120)"),
    ("evaluation_results", "reviewed_at", "DATETIME"),
    ("evaluation_results", "review_note", "TEXT"),
    ("evaluation_results", "llm_cost_inr", "FLOAT"),
    ("evaluation_results", "cost_breakdown", "JSON"),
    # --- contract v3 ---
    ("batches", "faculty_lead", "VARCHAR(120)"),
    ("student_submissions", "input_kind", "VARCHAR(16)"),
    ("student_submissions", "audio_seconds", "FLOAT"),
    ("student_submissions", "voice_question", "INTEGER"),
    ("student_submissions", "detected_languages", "JSON"),
    # --- review reasons ---
    ("student_submissions", "review_reason", "VARCHAR(32)"),
)
# (index name, table, column) - names match SQLAlchemy's ix_<table>_<column> for index=True.
MIGRATION_INDEXES: tuple[tuple[str, str, str], ...] = (
    ("ix_student_submissions_file_hash", "student_submissions", "file_hash"),
    ("ix_student_submissions_student_ref", "student_submissions", "student_ref"),
    ("ix_student_submissions_intake_batch_id", "student_submissions", "intake_batch_id"),
)


def _ensure_columns(engine: Engine) -> list[str]:
    """Add missing nullable columns + indexes (SQLite only). Returns the 'table.column' names added."""
    if engine.dialect.name != "sqlite":
        return []
    added: list[str] = []
    with engine.begin() as conn:
        existing: dict[str, set[str]] = {}
        for table, column, ddl in MIGRATION_COLUMNS:
            if table not in existing:
                existing[table] = {row[1] for row in conn.execute(text(f'PRAGMA table_info("{table}")'))}
            if not existing[table]:
                continue  # table missing entirely (create_all failed?) - nothing to alter
            if column not in existing[table]:
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {ddl}'))
                existing[table].add(column)
                added.append(f"{table}.{column}")
        for name, table, column in MIGRATION_INDEXES:
            conn.execute(text(f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" ("{column}")'))
    if added:
        logger.info("Database migrated: added %d column(s): %s", len(added), ", ".join(added))
    return added


# --------------------------------------------------------------------------- #
# Engine / session management
# --------------------------------------------------------------------------- #
_lock = threading.Lock()
_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None
_engine_url: str | None = None


def _build_engine(url: str) -> Engine:
    if not url.startswith("sqlite"):
        return create_engine(url, pool_pre_ping=True)

    # Background pipeline threads and request threads share the DB: allow cross-thread use
    # and wait (instead of failing) when another thread holds the write lock.
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")  # readers (3 s UI polling) never block the worker
        cursor.close()

    return engine


def get_engine() -> Engine:
    """Engine for the current DATABASE_URL (rebuilt if the URL changed, e.g. between tests)."""
    global _engine, _session_factory, _engine_url
    url = get_settings().database_url
    if _engine is None or url != _engine_url:
        with _lock:
            if _engine is None or url != _engine_url:
                old = _engine
                _engine = _build_engine(url)
                _session_factory = sessionmaker(bind=_engine, expire_on_commit=False)
                _engine_url = url
                if old is not None:
                    old.dispose()
    return _engine


def SessionLocal() -> Session:  # noqa: N802 - conventional FastAPI name
    get_engine()
    assert _session_factory is not None
    return _session_factory()


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request."""
    with SessionLocal() as db:
        yield db


def init_db() -> None:
    engine = get_engine()
    Base.metadata.create_all(engine)
    _ensure_columns(engine)


def dispose_engine() -> None:
    """Close every pooled connection (tests call this so temp DB files can be removed)."""
    global _engine, _session_factory, _engine_url
    with _lock:
        if _engine is not None:
            _engine.dispose()
        _engine = _session_factory = _engine_url = None
