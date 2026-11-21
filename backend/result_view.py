"""Read-side assembly of API shapes from ORM rows (main.py and the PDF renderer share it).

build_result merge order: base fields, then provenance.result_extras, then
report_meta.result_extras, then analytics.result_extras LAST - its topic_mastery,
roi_recommendations and question_evaluations replace the stored lists.
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

import analytics
import hashing
import provenance
import report_meta
from config import get_settings
from database import (
    Batch,
    EvaluationResult,
    EvaluationVersion,
    Institution,
    Rubric,
    StudentSubmission,
    SubmissionStatus,
)
from schemas import (
    BatchOut,
    InstitutionOut,
    ProcessingLogEntry,
    ResultOut,
    ResultPendingOut,
    RubricOut,
    RubricRef,
    StudentCard,
    SubmissionOut,
)

LANGUAGE_CODES = ("en", "hi", "ta", "kn", "te")


def institution_out(institution: Institution) -> InstitutionOut:
    return InstitutionOut(id=institution.id, name=institution.name)


def batch_out(batch: Batch) -> BatchOut:
    settings = get_settings()
    exam_date, assumed = analytics.exam_date_for(batch)
    days = analytics.days_to_exam(batch)
    return BatchOut(
        id=batch.id,
        name=batch.name,
        exam_type=batch.exam_type,
        exam=batch.exam or settings.default_exam,
        exam_date=exam_date,
        exam_date_assumed=assumed,
        days_to_exam=days,
        strategy_mode=analytics.strategy_mode_for(days),
    )


def _rubric_status(rubric: Rubric) -> str:
    return rubric.status if rubric.status in ("AUTHOR_DRAFT", "FACULTY_APPROVED") else "AUTHOR_DRAFT"


def _rubric_hash(rubric: Rubric) -> str:
    return rubric.rubric_hash or hashing.rubric_hash(rubric.content or {})


def rubric_ref(rubric: Rubric) -> RubricRef:
    return RubricRef(
        id=rubric.id,
        version=rubric.version,
        name=rubric.name,
        total_marks=rubric.total_marks,
        status=_rubric_status(rubric),
        rubric_hash=_rubric_hash(rubric),
    )


def rubric_out(rubric: Rubric) -> RubricOut:
    return RubricOut(
        id=rubric.id,
        version=rubric.version,
        name=rubric.name,
        total_marks=rubric.total_marks,
        content=rubric.content,
        status=_rubric_status(rubric),
        rubric_hash=_rubric_hash(rubric),
        parent_id=rubric.parent_id,
        change_note=rubric.change_note,
        created_at=rubric.created_at,
    )


def _language_hints(sub: StudentSubmission) -> list[str]:
    hints = [h for h in (sub.language_hints or []) if h in LANGUAGE_CODES]
    return hints or ["en"]


def submission_out(sub: StudentSubmission) -> SubmissionOut:
    settings = get_settings()
    result = sub.result
    completed = sub.status == SubmissionStatus.COMPLETED and result is not None
    urgency = pct = None
    if completed and result.total_marks:
        urgency, _reasons, pct = analytics.result_urgency(result)
    return SubmissionOut(
        id=sub.id,
        student_name=sub.student_name,
        original_filename=sub.original_filename,
        status=sub.status,
        ocr_confidence=sub.ocr_confidence,
        created_at=sub.created_at,
        updated_at=sub.updated_at,
        error_message=sub.error_message,
        current_step=sub.current_step,
        is_demo=bool(sub.is_demo),
        total_score=result.total_score if completed else None,
        total_marks=result.total_marks if completed else sub.rubric.total_marks,
        rubric_id=sub.rubric_id,
        batch_id=sub.batch_id,
        file_sha256=sub.file_hash,
        file_size=sub.file_size,
        page_count=sub.page_count,
        language_hints=_language_hints(sub),
        student_ref=sub.student_ref or hashing.student_ref_for(sub.student_name),
        intake_batch_id=sub.intake_batch_id,
        attempts=int(sub.attempts or 0),
        max_attempts=settings.max_job_attempts,
        last_error_code=sub.last_error_code,
        flagged_pages=list(sub.flagged_pages or []),
        ocr_cache_hit=bool(sub.ocr_cache_hit),
        urgency=urgency,
        percentage=pct,
        started_at=sub.started_at,
        completed_at=sub.completed_at,
        release_status=(result.release_status or "PROVISIONAL") if completed else None,
        llm_cost_inr=result.llm_cost_inr if completed else None,
    )


def processing_log(sub: StudentSubmission) -> list[ProcessingLogEntry]:
    entries: list[ProcessingLogEntry] = []
    for entry in sub.processing_log or []:
        try:
            entries.append(ProcessingLogEntry.model_validate(entry))
        except ValidationError:
            continue
    return entries


def pending_detail(sub: StudentSubmission) -> str:
    if sub.status == SubmissionStatus.PENDING:
        return "Queued for processing."
    if sub.status == SubmissionStatus.PROCESSING:
        return f"Processing - {sub.current_step}."
    if sub.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED:
        return sub.error_message or "OCR confidence is below the threshold - awaiting faculty review."
    if sub.status == SubmissionStatus.FAILED:
        return sub.error_message or "Processing failed."
    return "The result is not available yet."


def pending_out(sub: StudentSubmission) -> ResultPendingOut:
    return ResultPendingOut(
        status=sub.status,
        detail=pending_detail(sub),
        submission=submission_out(sub),
        processing_log=processing_log(sub),
    )


def is_completed(sub: StudentSubmission) -> bool:
    """COMPLETED with a usable result (what every report / PDF / card endpoint requires)."""
    result = sub.result
    return (
        sub.status == SubmissionStatus.COMPLETED
        and result is not None
        and bool(result.total_marks)
        and result.total_marks > 0
    )


def build_result(db: Session, sub: StudentSubmission) -> ResultOut:
    """The full Result for a COMPLETED submission (caller checks status and sub.result)."""
    result = sub.result
    assert result is not None, "build_result needs a completed submission"
    return build_result_for(db, sub, result)


def build_result_for(
    db: Session, sub: StudentSubmission, result: EvaluationResult, *, rubric: Rubric | None = None
) -> ResultOut:
    """Assemble a Result for `result`: either sub.result or a transient (never saved) row rebuilt
    from an archived evaluation version (archived_result). Merge order: base fields, provenance,
    report_meta, then analytics LAST (its topic_mastery / roi_recommendations /
    question_evaluations replace the stored lists)."""
    rubric = rubric or sub.rubric
    batch = sub.batch
    institution = batch.institution
    payload: dict[str, Any] = {
        "submission": submission_out(sub),
        "total_score": result.total_score,
        "total_marks": result.total_marks,
        "overall_mastery": result.overall_mastery,
        "ocr_confidence": sub.ocr_confidence,
        "topic_mastery": result.topic_mastery or [],
        "roi_recommendations": result.roi_recommendations or [],
        "strengths_gaps": result.strengths_gaps or {"strengths": [], "gaps": []},
        "question_evaluations": result.question_evaluations or [],
        "processing_log": processing_log(sub),
        "rubric": rubric_ref(rubric),
    }
    payload.update(provenance.result_extras(db, sub=sub, result=result, rubric=rubric))
    payload.update(
        report_meta.result_extras(db, sub=sub, result=result, rubric=rubric, batch=batch, institution=institution)
    )
    payload.update(
        analytics.result_extras(db, sub=sub, result=result, rubric=rubric, batch=batch, institution=institution)
    )
    return ResultOut.model_validate(payload)


# --------------------------------------------------------------------------- #
# Archived (superseded) evaluation versions
# --------------------------------------------------------------------------- #
def find_version(db: Session, sub: StudentSubmission, version: int) -> EvaluationVersion | None:
    return db.scalar(
        select(EvaluationVersion)
        .where(EvaluationVersion.submission_id == sub.id, EvaluationVersion.version == version)
        .order_by(EvaluationVersion.id.desc())
        .limit(1)
    )


def archived_result(
    db: Session, archived: EvaluationVersion, sub: StudentSubmission
) -> tuple[EvaluationResult, Rubric]:
    """A transient EvaluationResult (never added to the session) rebuilt from an archived
    version's payload, plus the rubric it was graded against."""
    payload = archived.payload or {}
    rubric = (db.get(Rubric, archived.rubric_id) if archived.rubric_id is not None else None) or sub.rubric
    total_marks = float(payload.get("total_marks") or archived.total_marks or 0)
    score = payload.get("total_score")
    total_score = float(score if score is not None else archived.total_score)
    mastery = payload.get("overall_mastery")
    result = EvaluationResult(
        total_score=total_score,
        total_marks=total_marks,
        overall_mastery=float(
            mastery if mastery is not None else (round(total_score / total_marks * 100, 1) if total_marks else 0.0)
        ),
        topic_mastery=list(payload.get("topic_mastery") or []),
        roi_recommendations=list(payload.get("roi_recommendations") or []),
        strengths_gaps=payload.get("strengths_gaps") or {"strengths": [], "gaps": []},
        question_evaluations=list(payload.get("question_evaluations") or []),
        summary=payload.get("summary"),
        teaching_nudges=list(payload.get("teaching_nudges") or []),
        confusions=list(payload.get("confusions") or []),
        rubric_id=rubric.id,
        rubric_hash=archived.rubric_hash or rubric.rubric_hash,
        version=archived.version or 1,
        release_status=archived.release_status or "PROVISIONAL",
    )
    result.created_at = archived.created_at
    return result, rubric


def superseded_label(db: Session, archived: EvaluationVersion) -> str:
    """'rubric v2' style name of whatever replaced an archived version."""
    if archived.superseded_by_rubric_id is not None:
        rubric = db.get(Rubric, archived.superseded_by_rubric_id)
        if rubric is not None:
            return f"rubric {rubric.version}"
    return "a newer evaluation"


# --------------------------------------------------------------------------- #
# Student cards (GET /api/students and the cohort PDF)
# --------------------------------------------------------------------------- #
def _topic_points(result: EvaluationResult) -> list[dict[str, Any]]:
    points = []
    for tm in result.topic_mastery or []:
        if not isinstance(tm, dict) or not tm.get("topic"):
            continue
        try:
            mastery = float(tm.get("mastery") or 0)
        except (TypeError, ValueError):
            mastery = 0.0
        points.append({"topic": str(tm["topic"]), "subject": str(tm.get("subject") or ""), "mastery": mastery})
    return points


def student_card(sub: StudentSubmission, *, batches: dict[int, BatchOut] | None = None) -> StudentCard:
    """A StudentCard. Non-completed rows carry their status with nulls and empty lists."""
    cache = batches if batches is not None else {}
    if sub.batch_id not in cache:
        cache[sub.batch_id] = batch_out(sub.batch)
    base: dict[str, Any] = {
        "submission_id": sub.id,
        "student_name": sub.student_name,
        "student_ref": sub.student_ref or hashing.student_ref_for(sub.student_name),
        "batch": cache[sub.batch_id],
        "test": rubric_ref(sub.rubric),
        "status": sub.status,
        "total_marks": sub.rubric.total_marks,
        "is_demo": bool(sub.is_demo),
        "created_at": sub.created_at,
    }
    if not is_completed(sub):
        return StudentCard.model_validate(base)
    result = sub.result
    assert result is not None
    urgency, _reasons, pct = analytics.result_urgency(result)
    sg = result.strengths_gaps or {}
    return StudentCard.model_validate(
        {
            **base,
            "score": float(result.total_score),
            "total_marks": float(result.total_marks),
            "percentage": pct,
            "urgency": urgency,
            "strengths": [str(s) for s in (sg.get("strengths") or [])][:2],
            "gaps": [str(g) for g in (sg.get("gaps") or [])][:2],
            "nudges": analytics.nudges_for(result),
            "topic_mastery": _topic_points(result),
            "top_focus": analytics.focus_items(result=result, rubric=sub.rubric, batch=sub.batch, limit=3),
            "release_status": result.release_status or "PROVISIONAL",
        }
    )
