"""LMS export (FR-5.10): hashed API keys and the read-only result / roster / topic-mastery data
an LMS or ERP pulls (JSON or CSV).

- Keys: "3il_" + 24 random URL-safe bytes. Only the SHA-256 of the secret is stored; the secret
  is returned once, at creation. Logs only ever show the 8-character prefix. An optional static
  LMS_API_KEY from .env is accepted too (scope: all institutions); it is never logged or returned.
- Scope: a key created for an institution sees only that institution's batches; institution_id
  NULL (and the env key) see every institution.
- Results are RELEASED (faculty signed-off) only unless include_provisional=true is asked for.
- CSV cells that start with = + - @ TAB or CR get a leading apostrophe (formula-injection guard),
  and the body starts with a UTF-8 BOM so Excel opens it as UTF-8.
"""
from __future__ import annotations

import csv
import hmac
import io
import logging
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

import analytics
import hashing
import result_view
from config import get_settings
from database import (
    ApiKey,
    Batch,
    ReleaseStatus,
    StudentSubmission,
    SubmissionStatus,
    utc_iso,
    utcnow,
)
from errors import ApiError

logger = logging.getLogger("3ilens.lms")

SECRET_PREFIX = "3il_"
HEADER_NAME = "X-API-Key"
EXPORT_TAG = "LMS export (read-only)"
DOCS_PATH = "/docs#/LMS%20export%20(read-only)"
CSV_BOM = "﻿"
FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")
RESULTS_CSV_COLUMNS = (
    "submission_id", "student_ref", "student_name", "institution", "batch", "test", "test_version",
    "evaluated_at", "score", "total_marks", "percentage", "urgency", "release_status", "input_kind",
    "is_demo", "focus_topics",
)
TOPIC_CSV_COLUMNS = (
    "submission_id", "student_ref", "student_name", "batch", "test", "evaluated_at", "topic", "subject", "mastery",
)
ENDPOINTS: tuple[dict[str, str], ...] = (
    {"method": "GET", "path": "/api/lms/v1/batches", "format": "json",
     "description": "Batches the key can see, with exam, faculty lead and student count."},
    {"method": "GET", "path": "/api/lms/v1/students", "format": "json",
     "description": "Student roster (optional batch_id) with the latest result's percentage and urgency."},
    {"method": "GET", "path": "/api/lms/v1/results", "format": "json",
     "description": "One row per graded test: score, percentage, urgency, topic mastery, focus topics and "
                    "nudges. RELEASED results only unless include_provisional=true. X-Total-Count header."},
    {"method": "GET", "path": "/api/lms/v1/results.csv", "format": "csv",
     "description": "The same results as a UTF-8 CSV (one row per test) for spreadsheets and ERP imports."},
    {"method": "GET", "path": "/api/lms/v1/topic-mastery.csv", "format": "csv",
     "description": "Long-format CSV: one row per student x topic with the mastery percentage."},
)


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #
def new_secret() -> str:
    return SECRET_PREFIX + secrets.token_urlsafe(24)


def key_hash(secret: str) -> str:
    return hashing.sha256_bytes(secret.encode("utf-8"))


def create_key(db: Session, name: str, institution_id: int | None) -> tuple[ApiKey, str]:
    """(row, secret). The secret is not stored - only its SHA-256 and its first 8 characters."""
    secret = new_secret()
    row = ApiKey(
        name=name, prefix=secret[:8], key_hash=key_hash(secret), institution_id=institution_id, use_count=0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("Created LMS API key %s... (id %s, institution %s)", row.prefix, row.id, institution_id or "all")
    return row, secret


def revoke_key(db: Session, row: ApiKey) -> ApiKey:
    """Idempotent: an already revoked key keeps its original revoked_at."""
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        db.commit()
        db.refresh(row)
        logger.info("Revoked LMS API key %s... (id %s)", row.prefix, row.id)
    return row


def key_out(row: ApiKey) -> dict[str, Any]:
    """An ApiKey dict - never the secret or its hash."""
    return {
        "id": row.id,
        "name": row.name,
        "prefix": row.prefix,
        "institution_id": row.institution_id,
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
        "use_count": int(row.use_count or 0),
        "revoked_at": row.revoked_at,
        "active": row.revoked_at is None,
    }


def verify(db: Session, provided: str | None) -> ApiKey | Literal["env"] | None:
    """The active key row matching the provided secret (use is recorded), "env" for the static
    LMS_API_KEY, or None. Lookups are by SHA-256, confirmed with a constant-time compare."""
    secret = (provided or "").strip()
    if not secret:
        return None
    digest = key_hash(secret)
    row = db.scalar(select(ApiKey).where(ApiKey.key_hash == digest, ApiKey.revoked_at.is_(None)))
    if row is not None and hmac.compare_digest(row.key_hash, digest):
        row.last_used_at = utcnow()
        row.use_count = int(row.use_count or 0) + 1
        db.commit()
        return row
    env_key = get_settings().lms_api_key
    if env_key and hmac.compare_digest(env_key.encode("utf-8"), secret.encode("utf-8")):
        return "env"
    logger.info("Rejected an LMS API key starting %s...", secret[:8])
    return None


@dataclass(frozen=True)
class Scope:
    """What an authenticated LMS call may see: institution_id None = every institution."""

    institution_id: int | None
    key_prefix: str


# --------------------------------------------------------------------------- #
# Parameters
# --------------------------------------------------------------------------- #
def parse_since(raw: str | None) -> datetime | None:
    """ISO 8601 date ('2026-11-01', midnight UTC) or datetime ('2026-11-01T09:30:00Z', '+05:30');
    anything else is 422 invalid_since. A datetime without an offset is read as UTC."""
    text = (raw or "").strip()
    if not text:
        return None
    try:
        if len(text) == 10:
            day = date.fromisoformat(text)
            return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError as exc:
        raise ApiError(
            422, "since must be an ISO 8601 date or datetime, e.g. 2026-11-01 or 2026-11-01T09:30:00Z.",
            "invalid_since",
        ) from exc
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def clamp_limit(limit: int | None) -> int:
    max_rows = get_settings().lms_max_rows
    return max_rows if limit is None else max(1, min(int(limit), max_rows))


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
def _submissions(db: Session, scope_institution_id: int | None, batch_id: int | None = None) -> list[StudentSubmission]:
    query = (
        select(StudentSubmission)
        .join(Batch, StudentSubmission.batch_id == Batch.id)
        .options(
            selectinload(StudentSubmission.result),
            selectinload(StudentSubmission.rubric),
            selectinload(StudentSubmission.batch).selectinload(Batch.institution),
        )
        .order_by(StudentSubmission.id)
    )
    if scope_institution_id is not None:
        query = query.where(Batch.institution_id == scope_institution_id)
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    return list(db.scalars(query).all())


def _iso(value: datetime | None) -> str | None:
    return utc_iso(value) if value is not None else None


def _topics(result: Any) -> list[dict[str, Any]]:
    out = []
    for item in result.topic_mastery or []:
        if not isinstance(item, dict) or not item.get("topic"):
            continue
        try:
            mastery = round(float(item.get("mastery") or 0.0), 1)
        except (TypeError, ValueError):
            mastery = 0.0
        out.append({"topic": str(item["topic"]), "subject": str(item.get("subject") or ""), "mastery": mastery})
    return out


def result_row(sub: StudentSubmission) -> dict[str, Any]:
    """An LmsResultRow dict for a COMPLETED submission."""
    result = sub.result
    rubric = sub.rubric
    batch = sub.batch
    institution = batch.institution
    urgency, _reasons, pct = analytics.result_urgency(result)
    focus = [
        str(p["topic"]) for p in (result.roi_recommendations or [])[:3] if isinstance(p, dict) and p.get("topic")
    ]
    nudges = []
    try:
        nudges = [f"{n['label']}: {n['text']}" for n in analytics.nudges_for(result) if n.get("label")]
    except Exception:  # noqa: BLE001 - a nudge problem must never break the export
        logger.exception("Nudges unavailable for LMS row %s", sub.id)
    return {
        "submission_id": sub.id,
        "student_ref": sub.student_ref or hashing.student_ref_for(sub.student_name),
        "student_name": sub.student_name,
        "institution_id": institution.id,
        "institution_name": institution.name,
        "batch_id": batch.id,
        "batch_name": batch.name,
        "test_name": rubric.name,
        "test_version": rubric.version,
        "rubric_id": rubric.id,
        "evaluated_at": _iso(result.created_at),
        "score": float(result.total_score),
        "total_marks": float(result.total_marks),
        "percentage": pct,
        "urgency": urgency,
        "release_status": result.release_status or ReleaseStatus.PROVISIONAL,
        "input_kind": sub.input_kind or "document",
        "is_demo": bool(sub.is_demo),
        "topics": _topics(result),
        "focus_topics": focus,
        "nudges": nudges,
    }


def result_rows(
    db: Session,
    *,
    scope_institution_id: int | None,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    since: datetime | None = None,
    include_provisional: bool = False,
    include_demo: bool = True,
    limit: int | None = 500,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """(rows, total) of graded tests, oldest evaluation first (evaluated_at, then submission id)."""
    eligible = []
    for sub in _submissions(db, scope_institution_id, batch_id):
        if not result_view.is_completed(sub):
            continue
        if rubric_id is not None and sub.rubric_id != rubric_id:
            continue
        if not include_demo and sub.is_demo:
            continue
        result = sub.result
        if not include_provisional and (result.release_status or ReleaseStatus.PROVISIONAL) != ReleaseStatus.RELEASED:
            continue
        if since is not None and (result.created_at is None or result.created_at < since):
            continue
        eligible.append(sub)
    eligible.sort(key=lambda s: (s.result.created_at, s.id))
    start = max(0, int(offset or 0))
    page = eligible[start:start + clamp_limit(limit)]
    return [result_row(s) for s in page], len(eligible)


def batches(db: Session, scope_institution_id: int | None) -> list[dict[str, Any]]:
    """LmsBatch dicts (students = distinct student_ref in the batch)."""
    query = select(Batch).options(selectinload(Batch.institution)).order_by(Batch.id)
    if scope_institution_id is not None:
        query = query.where(Batch.institution_id == scope_institution_id)
    refs: dict[int, set[str]] = {}
    for sub in _submissions(db, scope_institution_id):
        refs.setdefault(sub.batch_id, set()).add(sub.student_ref or hashing.student_ref_for(sub.student_name))
    out = []
    for batch in db.scalars(query).all():
        out.append({
            "batch_id": batch.id,
            "name": batch.name,
            "exam": batch.exam or get_settings().default_exam,
            "exam_date": (batch.exam_date or "").strip() or None,  # null = not set (no assumed default)
            "institution_id": batch.institution_id,
            "institution_name": batch.institution.name if batch.institution is not None else "",
            "faculty_lead": batch.faculty_lead,
            "students": len(refs.get(batch.id, set())),
        })
    return out


def students(db: Session, scope_institution_id: int | None, batch_id: int | None = None) -> list[dict[str, Any]]:
    """LmsStudent dicts, one per student_ref; latest_* come from the newest completed result."""
    groups: dict[str, list[StudentSubmission]] = {}
    for sub in _submissions(db, scope_institution_id, batch_id):
        groups.setdefault(sub.student_ref or hashing.student_ref_for(sub.student_name), []).append(sub)
    out = []
    for ref, subs in groups.items():
        completed = sorted(
            (s for s in subs if result_view.is_completed(s)), key=lambda s: (s.result.created_at, s.id)
        )
        latest = completed[-1] if completed else None
        urgency = pct = None
        if latest is not None:
            urgency, _reasons, pct = analytics.result_urgency(latest.result)
        newest = max(subs, key=lambda s: (s.created_at, s.id))
        out.append({
            "student_ref": ref,
            "student_name": (latest or newest).student_name,
            "batch_ids": sorted({s.batch_id for s in subs}),
            "assessments": len(completed),
            "latest_submission_id": latest.id if latest is not None else None,
            "latest_percentage": pct,
            "latest_urgency": urgency,
        })
    return sorted(out, key=lambda row: (row["student_name"].casefold(), row["student_ref"]))


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def safe_cell(value: Any) -> Any:
    """Formula-injection guard: a text cell starting with = + - @ TAB or CR is prefixed with '."""
    if isinstance(value, str) and value.startswith(FORMULA_STARTS):
        return "'" + value
    return value


def _csv(columns: tuple[str, ...], rows: list[list[Any]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow([safe_cell(v) for v in row])
    return CSV_BOM + buffer.getvalue()


def results_csv(rows: list[dict[str, Any]]) -> str:
    return _csv(RESULTS_CSV_COLUMNS, [
        [r["submission_id"], r["student_ref"], r["student_name"], r["institution_name"], r["batch_name"],
         r["test_name"], r["test_version"], r["evaluated_at"], r["score"], r["total_marks"], r["percentage"],
         r["urgency"], r["release_status"], r["input_kind"], str(r["is_demo"]).lower(), "; ".join(r["focus_topics"])]
        for r in rows
    ])


def topic_mastery_csv(rows: list[dict[str, Any]]) -> str:
    return _csv(TOPIC_CSV_COLUMNS, [
        [r["submission_id"], r["student_ref"], r["student_name"], r["batch_name"], r["test_name"], r["evaluated_at"],
         t["topic"], t["subject"], t["mastery"]]
        for r in rows for t in r["topics"]
    ])


def info(db: Session) -> dict[str, Any]:
    """An LmsInfo dict (no secrets: only whether an env key is configured)."""
    settings = get_settings()
    active = db.scalars(select(ApiKey.id).where(ApiKey.revoked_at.is_(None))).all()
    return {
        "enabled": settings.lms_api_enabled,
        "header_name": HEADER_NAME,
        "env_key_configured": bool(settings.lms_api_key),
        "active_keys": len(active),
        "released_only_default": True,
        "endpoints": [dict(e) for e in ENDPOINTS],
        "docs_path": DOCS_PATH,
    }
