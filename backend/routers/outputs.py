"""Output endpoints (API_CONTRACT.md, "Outputs"): branded PDFs, the ZIP bundle, the faculty
release gate, SIMULATED WhatsApp delivery with signed download links, student cards, longitudinal
history and the dashboard filter options.

WhatsApp is never really sent: a delivery is recorded as BLOCKED_TEMPLATE_PENDING (default,
WHATSAPP_MODE=blocked) or SIMULATED_NOT_SENT (WHATSAPP_MODE=simulate), with a masked recipient and
a signed, expiring /api/download/{token} link.

Student PDFs are cached as artifacts/<submission id>/report_r<result id>_<release status>.pdf with a
sidecar .key file (hash of the rendered content); a changed release state, a new result or any
change to the report content produces a fresh render.
"""
from __future__ import annotations

import io
import logging
import os
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

import analytics
import cohort as cohort_module
import provenance
import report_meta
import reports
import result_view
from config import get_settings
from database import (
    Batch,
    Delivery,
    EvaluationResult,
    Rubric,
    StudentSubmission,
    SubmissionStatus,
    get_db,
    utc_iso,
    utcnow,
)
from errors import ApiError
from hashing import sha256_bytes, sha256_json
from schemas import (
    URGENCIES,
    BatchOut,
    DashboardFilters,
    DeliveryInput,
    DeliveryOut,
    HistoryEntry,
    ReleaseInfo,
    ReleaseInput,
    ResultOut,
    ResultVersionOut,
    StudentCard,
    TestOption,
)

logger = logging.getLogger("3ilens.outputs")

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]
UrgencyQuery = Literal["on_track", "needs_attention", "at_risk"]

RENDER_VERSION = "sair-pdf-v4"   # bump to invalidate every cached student PDF
TOPIC_GAP_MASTERY = 60.0         # topic filter: mastery below this, or the topic is in the stored top 5
PDF_MEDIA_TYPE = "application/pdf"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _append_log(sub: StudentSubmission, step: str, message: str) -> None:
    """Append a {step, message, timestamp} audit entry (re-assigned so the JSON column is dirty)."""
    sub.processing_log = [*(sub.processing_log or []), {"step": step, "message": message, "timestamp": utc_iso()}]
    sub.updated_at = utcnow()


def _load(db: Session, submission_id: int) -> StudentSubmission:
    sub = db.get(
        StudentSubmission,
        submission_id,
        options=[selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric)],
    )
    if sub is None:
        raise ApiError(404, f"Submission {submission_id} not found.", "unknown_submission")
    return sub


def _require_completed(sub: StudentSubmission) -> EvaluationResult:
    if not result_view.is_completed(sub):
        raise ApiError(
            409,
            f"Submission {sub.id} is {sub.status} - reports, release and delivery need a COMPLETED result.",
            "invalid_state",
        )
    assert sub.result is not None
    return sub.result


def _attachment(content: bytes, filename: str, media_type: str = PDF_MEDIA_TYPE) -> Response:
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )


def _render_key(result_out: ResultOut, extra: str = "") -> str:
    """Hash of what the PDF shows. Deliveries, the audit log, updated_at and the per-step latency
    breakdown are not rendered (and change whenever a sign-off or delivery is logged)."""
    dump = result_out.model_dump(
        mode="json",
        exclude={
            "deliveries": True,
            "processing_log": True,
            "submission": {"updated_at": True},
            "latency": {"stages": True},
        },
    )
    return sha256_json({"v": RENDER_VERSION, "result": dump, "extra": extra, "branding": _branding_key()})


def _branding_key() -> str:
    """REPORT_LOGO_PATH and the logo file's mtime, so swapping the logo re-renders cached PDFs."""
    logo = get_settings().report_logo_path
    if logo is None:
        return "text-mark"
    try:
        return f"{logo}:{logo.stat().st_mtime_ns}" if logo.is_file() else f"{logo}:missing"
    except OSError:
        return f"{logo}:unreadable"


def _cached_render(path: Path, key: str, render: Callable[[], bytes]) -> bytes:
    key_path = path.with_suffix(".key")
    try:
        if path.is_file() and key_path.is_file() and key_path.read_text(encoding="utf-8").strip() == key:
            return path.read_bytes()
    except OSError:
        pass
    pdf = render()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_bytes(pdf)
        os.replace(tmp, path)
        key_path.write_text(key, encoding="utf-8")
    except OSError:
        logger.warning("Could not cache report PDF %s", path.name)
    return pdf


def student_pdf(db: Session, sub: StudentSubmission) -> tuple[bytes, str]:
    """(PDF bytes, attachment filename) for the CURRENT result of a completed submission."""
    result = _require_completed(sub)
    out = result_view.build_result(db, sub)
    status = result.release_status or "PROVISIONAL"
    path = get_settings().artifact_dir / str(sub.id) / f"report_r{result.id}_{status}.pdf"
    pdf = _cached_render(path, _render_key(out), lambda: reports.render_student_pdf(out))
    return pdf, reports.student_pdf_filename(sub.student_name, sub.rubric.name, sub.rubric.version)


def archived_pdf(db: Session, sub: StudentSubmission, version: int) -> tuple[bytes, str]:
    archived = result_view.find_version(db, sub, version)
    if archived is None:
        raise ApiError(404, f"Submission {sub.id} has no evaluation version {version}.", "unknown_version")
    result, rubric = result_view.archived_result(db, archived, sub)
    out = result_view.build_result_for(db, sub, result, rubric=rubric)
    label = result_view.superseded_label(db, archived)
    path = get_settings().artifact_dir / str(sub.id) / f"report_v{archived.id}_SUPERSEDED.pdf"
    pdf = _cached_render(path, _render_key(out, label), lambda: reports.render_student_pdf(out, superseded_by=label))
    name = reports.student_pdf_filename(sub.student_name, rubric.name, f"{rubric.version}-superseded-v{version}")
    return pdf, name


def _matches_topic(result: EvaluationResult, topic: str) -> bool:
    wanted = topic.strip().casefold()
    for tm in result.topic_mastery or []:
        if isinstance(tm, dict) and str(tm.get("topic", "")).casefold() == wanted:
            try:
                if float(tm.get("mastery", 100)) < TOPIC_GAP_MASTERY:
                    return True
            except (TypeError, ValueError):
                pass
    return any(
        isinstance(p, dict) and str(p.get("topic", "")).casefold() == wanted
        for p in (result.roi_recommendations or [])[:5]
    )


def _submissions(
    db: Session,
    *,
    batch_id: int | None,
    rubric_id: int | None,
    urgency: str | None,
    topic: str | None,
) -> list[StudentSubmission]:
    """Newest first. urgency / topic keep only completed rows that match (like the cohort)."""
    query = (
        select(StudentSubmission)
        .options(
            selectinload(StudentSubmission.result),
            selectinload(StudentSubmission.rubric),
            selectinload(StudentSubmission.batch),
        )
        .order_by(StudentSubmission.created_at.desc(), StudentSubmission.id.desc())
    )
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    if rubric_id is not None:
        query = query.where(StudentSubmission.rubric_id == rubric_id)
    subs = list(db.scalars(query).all())
    topic = (topic or "").strip() or None
    if urgency or topic:
        kept = []
        for sub in subs:
            if not result_view.is_completed(sub):
                continue
            assert sub.result is not None
            if urgency and analytics.result_urgency(sub.result)[0] != urgency:
                continue
            if topic and not _matches_topic(sub.result, topic):
                continue
            kept.append(sub)
        subs = kept
    return subs


def _cards(subs: list[StudentSubmission]) -> list[StudentCard]:
    batches: dict[int, BatchOut] = {}
    return [result_view.student_card(sub, batches=batches) for sub in subs]


def _cohort_pdf(
    db: Session, *, batch_id: int | None, rubric_id: int | None, urgency: str | None, topic: str | None
) -> tuple[bytes, str]:
    cohort = cohort_module.build_cohort(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic)
    cards = _cards(_submissions(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic))
    pdf = reports.render_cohort_pdf(cohort, students=cards)
    scope = reports.slug(cohort.batch.name if batch_id is not None else "all-batches")
    stamp = f"{report_meta.to_ist(utcnow()):%Y%m%d}"
    return pdf, f"3iLens_cohort_{scope}_{stamp}.pdf"


# --------------------------------------------------------------------------- #
# PDFs and the bundle
# --------------------------------------------------------------------------- #
@router.get(
    "/api/reports/bundle.zip",
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}, "description": "Student PDFs + cohort.pdf"}},
)
def reports_bundle(
    db: DbSession,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: UrgencyQuery | None = None,
    topic: str | None = None,
) -> Response:
    """Every completed student PDF in scope plus cohort.pdf, as one ZIP."""
    subs = [
        s for s in _submissions(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic)
        if result_view.is_completed(s)
    ]
    cohort_pdf, _ = _cohort_pdf(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic)
    buffer = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for sub in sorted(subs, key=lambda s: (s.student_name.casefold(), s.id)):
            pdf, name = student_pdf(db, sub)
            if name in used:
                name = name.removesuffix(".pdf") + f"_sub{sub.id}.pdf"
            used.add(name)
            archive.writestr(name, pdf)
        archive.writestr("cohort.pdf", cohort_pdf)
    stamp = f"{report_meta.to_ist(utcnow()):%Y%m%d_%H%M}"
    return _attachment(buffer.getvalue(), f"3iLens_reports_{stamp}.zip", "application/zip")


@router.get(
    "/api/reports/{submission_id}/pdf",
    response_class=Response,
    responses={200: {"content": {PDF_MEDIA_TYPE: {}}, "description": "Student Academic Intelligence Report"}},
)
def report_pdf(
    submission_id: int,
    db: DbSession,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> Response:
    sub = _load(db, submission_id)
    result = _require_completed(sub)
    if version is not None and version != (result.version or 1):
        pdf, name = archived_pdf(db, sub, version)
    else:
        pdf, name = student_pdf(db, sub)
    return _attachment(pdf, name)


@router.get("/api/results/{submission_id}/versions", response_model=list[ResultVersionOut])
def result_versions(submission_id: int, db: DbSession) -> list[dict]:
    """Archived versions + the current result, oldest first."""
    sub = _load(db, submission_id)
    return provenance.version_rows(db, sub, sub.result, sub.rubric, always=True)


@router.get("/api/results/{submission_id}/versions/{version}", response_model=ResultOut)
def result_version(submission_id: int, version: int, db: DbSession) -> ResultOut:
    """One version as a full Result; an archived one has superseded=true (404 unknown_version)."""
    sub = _load(db, submission_id)
    if sub.result is not None and version == (sub.result.version or 1) and result_view.is_completed(sub):
        return result_view.build_result(db, sub)
    archived = result_view.find_version(db, sub, version)
    if archived is None:
        raise ApiError(404, f"Submission {sub.id} has no evaluation version {version}.", "unknown_version")
    result, rubric = result_view.archived_result(db, archived, sub)
    newer = [row["version"] for row in provenance.version_rows(db, sub, sub.result, sub.rubric) if row["version"] > version]
    out = result_view.build_result_for(db, sub, result, rubric=rubric)
    return out.model_copy(update={"superseded": True, "superseded_by": min(newer, default=None)})


@router.get(
    "/api/cohort/pdf",
    response_class=Response,
    responses={200: {"content": {PDF_MEDIA_TYPE: {}}, "description": "Cohort report"}},
)
def cohort_pdf(
    db: DbSession,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: UrgencyQuery | None = None,
    topic: str | None = None,
) -> Response:
    pdf, name = _cohort_pdf(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic)
    return _attachment(pdf, name)


# --------------------------------------------------------------------------- #
# Release gate (faculty sign-off)
# --------------------------------------------------------------------------- #
def _reviewer(body: ReleaseInput) -> tuple[str, str | None]:
    name = " ".join(body.reviewer_name.split())
    if not name:
        raise ApiError(422, "Reviewer name is required.", "invalid_reviewer")
    note = " ".join((body.note or "").split()) or None
    return name, note


@router.post("/api/results/{submission_id}/release", response_model=ReleaseInfo)
def release_result(submission_id: int, body: ReleaseInput, db: DbSession) -> ReleaseInfo:
    sub = _load(db, submission_id)
    result = _require_completed(sub)
    name, note = _reviewer(body)
    result.release_status = "RELEASED"
    result.reviewed_by = name
    result.reviewed_at = utcnow()
    result.review_note = note
    _append_log(
        sub, "Faculty sign-off",
        f"Released by {name} - faculty sign-off recorded; the report is no longer provisional"
        + (f". Note: {note}" if note else "."),
    )
    db.commit()
    return ReleaseInfo.model_validate(report_meta.release_info(result))


@router.post("/api/results/{submission_id}/revoke", response_model=ReleaseInfo)
def revoke_result(submission_id: int, body: ReleaseInput, db: DbSession) -> ReleaseInfo:
    sub = _load(db, submission_id)
    result = _require_completed(sub)
    name, note = _reviewer(body)
    if (result.release_status or "PROVISIONAL") != "RELEASED":
        raise ApiError(409, f"Result {submission_id} is not released - nothing to revoke.", "not_released")
    result.release_status = "PROVISIONAL"
    result.reviewed_by = name
    result.reviewed_at = utcnow()
    result.review_note = note
    _append_log(
        sub, "Faculty sign-off",
        f"Release revoked by {name} - the report is PROVISIONAL again (teacher review pending)"
        + (f". Note: {note}" if note else "."),
    )
    db.commit()
    return ReleaseInfo.model_validate(report_meta.release_info(result))


# --------------------------------------------------------------------------- #
# Simulated WhatsApp delivery + signed download links
# --------------------------------------------------------------------------- #
@router.post("/api/deliveries", response_model=list[DeliveryOut])
def create_deliveries(body: DeliveryInput, db: DbSession) -> list[DeliveryOut]:
    """SIMULATED: never sends anything. Records a delivery per submission with a masked
    recipient and a signed, expiring download link for the (rendered or cached) report PDF."""
    try:
        masked = report_meta.mask_recipient(body.recipient)
    except ValueError as exc:
        raise ApiError(422, f"Invalid recipient: {exc}.", "invalid_recipient") from exc
    ids = list(dict.fromkeys(body.submission_ids))
    subs = {}
    missing = []
    for sid in ids:
        sub = db.get(StudentSubmission, sid, options=[selectinload(StudentSubmission.result)])
        if sub is None:
            missing.append(sid)
        else:
            subs[sid] = sub
    if missing:
        raise ApiError(404, f"Submission(s) not found: {', '.join(map(str, missing))}.", "unknown_submission")
    not_ready = [sid for sid, sub in subs.items() if not result_view.is_completed(sub)]
    if not_ready:
        raise ApiError(
            409,
            f"Only COMPLETED results can be delivered; not ready: {', '.join(map(str, not_ready))}.",
            "invalid_state",
        )

    status = report_meta.delivery_status()
    rows: list[Delivery] = []
    for sid in ids:
        sub = subs[sid]
        pdf, _name = student_pdf(db, sub)
        token, expires = report_meta.new_download_token(sid)
        detail = report_meta.delivery_detail(status, expires)
        row = Delivery(
            submission_id=sid,
            channel=body.channel,
            recipient_masked=masked,
            template_name=report_meta.TEMPLATE_NAME,
            status=status,
            detail=detail,
            token_expires_at=report_meta.expiry_datetime(expires),
        )
        db.add(row)
        rows.append(row)
        _append_log(
            sub, "Delivery",
            f"WhatsApp {status}: message NOT sent (simulated channel; template {report_meta.TEMPLATE_NAME} "
            f"pending Meta approval). Recipient {masked or 'not provided'}. Signed download link issued, expires "
            f"{report_meta.fmt_ist(report_meta.expiry_datetime(expires))}. Report PDF sha256 {sha256_bytes(pdf)}.",
        )
        logger.info("Simulated delivery for submission %s (%s) - nothing sent", sid, status)
    db.commit()
    return [DeliveryOut.model_validate(report_meta.delivery_out(row)) for row in rows]


@router.get("/api/deliveries", response_model=list[DeliveryOut])
def list_deliveries(db: DbSession, submission_id: int | None = None) -> list[DeliveryOut]:
    return [DeliveryOut.model_validate(d) for d in report_meta.deliveries_for(db, submission_id)]


@router.get(
    "/api/download/{token}",
    response_class=Response,
    responses={200: {"content": {PDF_MEDIA_TYPE: {}}}, 403: {"description": "bad_signature"},
               410: {"description": "link_expired"}},
)
def download(token: str, db: DbSession) -> Response:
    try:
        submission_id = report_meta.verify_download_token(token)
    except report_meta.DownloadTokenError as exc:
        raise ApiError(403 if exc.code == "bad_signature" else 410, str(exc), exc.code) from exc
    sub = _load(db, submission_id)
    pdf, name = student_pdf(db, sub)
    return _attachment(pdf, name)


# --------------------------------------------------------------------------- #
# Students, history and dashboard filters
# --------------------------------------------------------------------------- #
@router.get("/api/students", response_model=list[StudentCard])
def list_students(
    db: DbSession,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: UrgencyQuery | None = None,
    topic: str | None = None,
) -> list[StudentCard]:
    return _cards(_submissions(db, batch_id=batch_id, rubric_id=rubric_id, urgency=urgency, topic=topic))


@router.get("/api/students/{student_ref}/history", response_model=list[HistoryEntry])
def student_history(student_ref: str, db: DbSession, demo: bool | None = None) -> list[HistoryEntry]:
    """Every completed assessment of this student, oldest first; the newest is marked current.
    Real and synthetic demo records are never mixed: by default the real records are returned when
    any exist, else the demo ones; ?demo=true / ?demo=false picks explicitly."""
    if demo is None:
        demo = not report_meta.history_for(db, student_ref=student_ref, is_demo=False)
    entries = report_meta.history_for(db, student_ref=student_ref, is_demo=demo)
    if entries:
        entries[-1]["current"] = True
    return [HistoryEntry.model_validate(e) for e in entries]


@router.get("/api/filters", response_model=DashboardFilters)
def dashboard_filters(db: DbSession) -> DashboardFilters:
    batches = [result_view.batch_out(b) for b in db.scalars(select(Batch).order_by(Batch.id)).all()]
    used: dict[int, set[int]] = {}
    for rubric_id, batch_id in db.execute(
        select(StudentSubmission.rubric_id, StudentSubmission.batch_id).distinct()
    ).all():
        used.setdefault(rubric_id, set()).add(batch_id)
    tests = []
    for rubric_id in sorted(used):
        rubric = db.get(Rubric, rubric_id)
        if rubric is None:
            continue
        ref = result_view.rubric_ref(rubric)
        tests.append(TestOption(rubric_id=rubric.id, name=rubric.name, version=rubric.version, status=ref.status,
                                batch_ids=sorted(used[rubric_id])))
    topics: dict[str, str] = {}
    for topic_mastery in db.scalars(
        select(EvaluationResult.topic_mastery)
        .join(StudentSubmission, EvaluationResult.submission_id == StudentSubmission.id)
        .where(StudentSubmission.status == SubmissionStatus.COMPLETED)
    ).all():
        for tm in topic_mastery or []:
            if isinstance(tm, dict) and str(tm.get("topic") or "").strip():
                name = " ".join(str(tm["topic"]).split())
                topics.setdefault(name.casefold(), name)
    return DashboardFilters(
        batches=batches,
        tests=tests,
        urgencies=list(URGENCIES),
        topics=sorted(topics.values(), key=str.casefold),
    )

