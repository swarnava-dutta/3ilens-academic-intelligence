"""Report metadata: run id, release state, assessment history, (simulated) deliveries and the
signed download links that go with them.

WhatsApp delivery is SIMULATED in this PoC: nothing is ever sent. A delivery row records the
masked recipient, the Meta template that is pending approval and a signed, expiring download
link (token = urlsafe-base64 of 'submission_id:expiry_epoch:hmac_sha256(secret, submission_id:expiry)').
Only the masked recipient is stored; the token itself is never stored (it is re-derived).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import time
from datetime import datetime, timezone, tzinfo
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

import analytics
from config import get_settings
from database import (
    IST,
    Batch,
    Delivery,
    EvaluationResult,
    Institution,
    Rubric,
    StudentSubmission,
    SubmissionStatus,
    utcnow,
)
from hashing import student_ref_for

REPORT_TIMEZONE = "Asia/Kolkata"

# --- simulated WhatsApp delivery -----------------------------------------------------------
TEMPLATE_NAME = "3ilens_report_ready_v1"
# Shown by the UI as the message that WOULD be sent once Meta approves the template.
TEMPLATE_TEXT = "Namaste {{1}}, {{2}}'s 3iLens report for {{3}} is ready. Download (valid 24 h): {{4}}"
DELIVERY_BLOCKED = "BLOCKED_TEMPLATE_PENDING"
DELIVERY_SIMULATED = "SIMULATED_NOT_SENT"
MAX_TOKEN_CHARS = 512
MIN_RECIPIENT_DIGITS = 7
MAX_RECIPIENT_DIGITS = 15


def report_tz() -> tzinfo:
    """Asia/Kolkata via zoneinfo; tzdata is often missing on Windows, so fall back to the exact
    fixed +05:30 offset (India has no DST)."""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(REPORT_TIMEZONE)
    except Exception:  # noqa: BLE001 - ZoneInfoNotFoundError / missing tzdata
        return IST


def to_ist(dt: datetime | None) -> datetime:
    dt = dt or utcnow()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(report_tz())


def fmt_ist(dt: datetime | None, *, seconds: bool = False) -> str:
    """'2026-11-21 14:32 IST'."""
    return f"{to_ist(dt):%Y-%m-%d %H:%M{':%S' if seconds else ''}} IST"


def run_id_for(sub: StudentSubmission, result: EvaluationResult) -> str:
    """'RUN_20261121_1432_IST_SUB0042' from the result's creation time in India Standard Time."""
    return f"RUN_{to_ist(result.created_at):%Y%m%d_%H%M}_IST_SUB{sub.id:04d}"


def release_info(result: EvaluationResult) -> dict[str, Any]:
    return {
        "status": result.release_status or "PROVISIONAL",
        "reviewed_by": result.reviewed_by,
        "reviewed_at": result.reviewed_at,
        "note": result.review_note,
    }


def ref_of(sub: StudentSubmission) -> str:
    return sub.student_ref or student_ref_for(sub.student_name)


# --------------------------------------------------------------------------- #
# Longitudinal history (FR-5.8)
# --------------------------------------------------------------------------- #
def _subjects(rubric: Rubric | None, result: EvaluationResult) -> list[str]:
    subjects: list[str] = []
    for q in ((rubric.content or {}).get("questions") if rubric is not None else None) or []:
        if isinstance(q, dict) and q.get("subject"):
            subjects.append(str(q["subject"]))
    if not subjects:
        subjects = [str(t.get("subject")) for t in result.topic_mastery or [] if isinstance(t, dict) and t.get("subject")]
    return list(dict.fromkeys(subjects))


def history_for(
    db: Session,
    *,
    student_ref: str,
    institution_id: int | None = None,
    current_id: int | None = None,
    is_demo: bool | None = None,
) -> list[dict[str, Any]]:
    """HistoryEntry dicts: every COMPLETED assessment of this student (same student_ref, same
    institution when given), oldest first. Rows from older builds without a stored student_ref
    are matched on the name-derived ref. is_demo True/False keeps only synthetic demo rows / only
    real rows, so a real student's history never mixes with a demo record of the same name."""
    ref = (student_ref or "").strip()
    if not ref:
        return []
    query = (
        select(StudentSubmission)
        .options(
            selectinload(StudentSubmission.result),
            selectinload(StudentSubmission.rubric),
            selectinload(StudentSubmission.batch),
        )
        .where(
            StudentSubmission.status == SubmissionStatus.COMPLETED,
            or_(StudentSubmission.student_ref == ref, StudentSubmission.student_ref.is_(None)),
        )
    )
    if institution_id is not None:
        query = query.join(Batch, StudentSubmission.batch_id == Batch.id).where(Batch.institution_id == institution_id)
    if is_demo is not None:
        query = query.where(StudentSubmission.is_demo.is_(bool(is_demo)))
    rows = [s for s in db.scalars(query).all() if ref_of(s) == ref and s.result is not None and s.result.total_marks]
    rows.sort(key=lambda s: (s.created_at, s.id))
    entries = []
    for sub in rows:
        result = sub.result
        assert result is not None
        urgency, _reasons, pct = analytics.result_urgency(result)
        entries.append(
            {
                "submission_id": sub.id,
                "date": sub.created_at,
                "batch_name": f"{sub.batch.name} {sub.batch.exam_type}".strip() if sub.batch else "",
                "rubric_name": sub.rubric.name if sub.rubric else "",
                "rubric_version": sub.rubric.version if sub.rubric else "",
                "subjects": _subjects(sub.rubric, result),
                "score": float(result.total_score),
                "total_marks": float(result.total_marks),
                "pct": pct,
                "urgency": urgency,
                "outcome_counts": analytics.outcome_counts(
                    [q for q in result.question_evaluations or [] if isinstance(q, dict)]
                ),
                "current": sub.id == current_id,
            }
        )
    return entries


# --------------------------------------------------------------------------- #
# Signed download links
# --------------------------------------------------------------------------- #
class DownloadTokenError(ValueError):
    """code: 'bad_signature' (403) or 'link_expired' (410)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def now_epoch() -> int:
    return int(time.time())


def _signature(submission_id: int, expires: int) -> str:
    secret = get_settings().download_link_secret.encode("utf-8")
    return hmac.new(secret, f"{submission_id}:{expires}".encode("ascii"), hashlib.sha256).hexdigest()


def sign_download_token(submission_id: int, expires: int) -> str:
    raw = f"{submission_id}:{expires}:{_signature(submission_id, expires)}"
    return base64.urlsafe_b64encode(raw.encode("ascii")).decode("ascii").rstrip("=")


def new_download_token(submission_id: int) -> tuple[str, int]:
    """(token, expiry epoch) valid for DOWNLOAD_LINK_TTL_HOURS."""
    expires = now_epoch() + get_settings().download_link_ttl_hours * 3600
    return sign_download_token(submission_id, expires), expires


def verify_download_token(token: str) -> int:
    """The submission id of a valid, unexpired token; raises DownloadTokenError otherwise."""
    bad = DownloadTokenError("bad_signature", "This download link is invalid or has been tampered with.")
    if not token or len(token) > MAX_TOKEN_CHARS or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
        raise bad
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("ascii")
        sid_text, exp_text, signature = raw.split(":")
        if not (sid_text.isdigit() and exp_text.isdigit()):
            raise ValueError("non-numeric token fields")
        submission_id, expires = int(sid_text), int(exp_text)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise bad from exc
    if not hmac.compare_digest(_signature(submission_id, expires), signature):
        raise bad
    if expires < now_epoch():
        raise DownloadTokenError("link_expired", "This download link has expired - ask the institute for a new one.")
    return submission_id


def download_path(token: str) -> str:
    return f"/api/download/{token}"


def expiry_datetime(expires: int) -> datetime:
    return datetime.fromtimestamp(expires, tz=timezone.utc)


def mask_recipient(raw: str | None) -> str | None:
    """'+91 98765 43210' -> '+*********210' (only the last 3 digits survive). None stays None.
    Raises ValueError for something that is not a phone number."""
    if raw is None or not raw.strip():
        return None
    text = raw.strip()
    if not re.fullmatch(r"\+?[0-9 ()\-.]+", text):
        raise ValueError("recipient must be a phone number (digits, spaces, + - . ( ))")
    digits = re.sub(r"\D", "", text)
    if not MIN_RECIPIENT_DIGITS <= len(digits) <= MAX_RECIPIENT_DIGITS:
        raise ValueError(f"recipient must have {MIN_RECIPIENT_DIGITS}-{MAX_RECIPIENT_DIGITS} digits")
    return ("+" if text.startswith("+") else "") + "*" * (len(digits) - 3) + digits[-3:]


def delivery_status() -> str:
    return DELIVERY_SIMULATED if get_settings().whatsapp_mode == "simulate" else DELIVERY_BLOCKED


def delivery_detail(status: str, expires: int) -> str:
    when = fmt_ist(expiry_datetime(expires))
    if status == DELIVERY_SIMULATED:
        return (
            f"SIMULATED (demo mode) - WhatsApp template {TEMPLATE_NAME} - message NOT sent; "
            f"secure download link issued (expires {when})"
        )
    return (
        f"Meta template {TEMPLATE_NAME} pending approval - message NOT sent; "
        f"secure download link issued (expires {when})"
    )


def delivery_out(row: Delivery) -> dict[str, Any]:
    """A Delivery dict. The link is re-derived from (submission, expiry); null once expired."""
    url = None
    if row.token_expires_at is not None:
        expires = int(row.token_expires_at.timestamp())
        if expires >= now_epoch():
            url = download_path(sign_download_token(row.submission_id, expires))
    status = row.status if row.status in (DELIVERY_BLOCKED, DELIVERY_SIMULATED) else DELIVERY_BLOCKED
    return {
        "id": row.id,
        "submission_id": row.submission_id,
        "channel": row.channel,
        "recipient_masked": row.recipient_masked,
        "template_name": row.template_name,
        "status": status,
        "detail": row.detail or "",
        "download_url": url,
        "link_expires_at": row.token_expires_at,
        "created_at": row.created_at,
    }


def deliveries_for(db: Session, submission_id: int | None = None, *, limit: int = 200) -> list[dict[str, Any]]:
    query = select(Delivery).order_by(Delivery.created_at.desc(), Delivery.id.desc()).limit(limit)
    if submission_id is not None:
        query = query.where(Delivery.submission_id == submission_id)
    return [delivery_out(row) for row in db.scalars(query).all()]


# --------------------------------------------------------------------------- #
# Result extras (merged by result_view.build_result)
# --------------------------------------------------------------------------- #
def result_extras(
    db: Session,
    *,
    sub: StudentSubmission,
    result: EvaluationResult,
    rubric: Rubric,
    batch: Batch,
    institution: Institution,
) -> dict[str, Any]:
    """Keys: report_meta, release, history, deliveries."""
    import result_view  # local import: result_view imports this module

    ref = ref_of(sub)
    return {
        "report_meta": {
            "run_id": run_id_for(sub, result),
            "institution": {"id": institution.id, "name": institution.name},
            "batch": result_view.batch_out(batch).model_dump(),
            "executed_at": result.created_at or utcnow(),
            "timezone": REPORT_TIMEZONE,
            "student_ref": ref,
            "is_demo": bool(sub.is_demo),
        },
        "release": release_info(result),
        "history": history_for(
            db, student_ref=ref, institution_id=institution.id, current_id=sub.id, is_demo=bool(sub.is_demo)
        ),
        "deliveries": deliveries_for(db, sub.id),
    }
