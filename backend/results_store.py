"""Result persistence (pipeline and seed both use this module) and the submission's artifact folder
(job_dir / read_artifact: pipeline, provenance, voice and the routers).

evaluation_results.submission_id stays UNIQUE: before a re-run replaces a result, the
current row is archived into evaluation_versions (archive_current_result), so the report's
version history and older PDFs remain available.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from config import get_settings
from database import EvaluationResult, EvaluationVersion, ReleaseStatus, Rubric, StudentSubmission, utcnow

# ReportPayload fields copied verbatim from insights.build_evaluation_report.
REPORT_FIELDS = (
    "total_score", "total_marks", "overall_mastery", "topic_mastery", "roi_recommendations",
    "strengths_gaps", "question_evaluations",
)


def job_dir(submission_id: int) -> Path:
    """artifact_dir/<submission id>/: a submission's artifacts (the local S3 mock)."""
    return get_settings().artifact_dir / str(submission_id)


def read_artifact(submission_id: int, name: str) -> dict[str, Any] | None:
    """A JSON artifact of a submission, or None when missing/unreadable."""
    try:
        data = json.loads((job_dir(submission_id) / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def build_evaluation_result(
    report: dict[str, Any],
    *,
    rubric: Rubric,
    version: int = 1,
    llm_cost_inr: float | None = None,
    cost_breakdown: dict[str, Any] | None = None,
    created_at: datetime | None = None,
) -> EvaluationResult:
    """A new (unsaved) EvaluationResult from a validated report dict. The caller attaches it
    (sub.result = ... or .submission_id = ...) and adds/commits. Narrative keys are read with
    .get() so reports from before AI call 2 grew them still persist."""
    result = EvaluationResult(
        total_score=float(report["total_score"]),
        total_marks=float(report["total_marks"]),
        overall_mastery=float(report["overall_mastery"]),
        topic_mastery=report["topic_mastery"],
        roi_recommendations=report["roi_recommendations"],
        strengths_gaps=report["strengths_gaps"],
        question_evaluations=report["question_evaluations"],
        summary=report.get("summary") or None,
        teaching_nudges=list(report.get("teaching_nudges") or []),
        confusions=list(report.get("confusions") or []),
        rubric_id=rubric.id,
        rubric_hash=rubric.rubric_hash,
        version=version,
        release_status=ReleaseStatus.PROVISIONAL,
        llm_cost_inr=llm_cost_inr,
        cost_breakdown=cost_breakdown,
    )
    if created_at is not None:
        result.created_at = created_at
    return result


def result_payload(result: EvaluationResult) -> dict[str, Any]:
    """The archived payload: ReportPayload fields + summary / teaching_nudges / confusions."""
    payload = {field: getattr(result, field) for field in REPORT_FIELDS}
    payload["summary"] = result.summary
    payload["teaching_nudges"] = list(result.teaching_nudges or [])
    payload["confusions"] = list(result.confusions or [])
    return payload


def archive_current_result(
    db: Session, sub: StudentSubmission, *, superseded_by_rubric_id: int | None
) -> EvaluationVersion | None:
    """Copy the current result into evaluation_versions, delete it, flush. None if no result."""
    result = sub.result
    if result is None:
        return None
    rubric_id = result.rubric_id or sub.rubric_id
    rubric = db.get(Rubric, rubric_id) if rubric_id is not None else None
    archived = EvaluationVersion(
        submission_id=sub.id,
        version=result.version or 1,
        rubric_id=rubric_id,
        rubric_version=rubric.version if rubric is not None else None,
        rubric_hash=result.rubric_hash or (rubric.rubric_hash if rubric is not None else None),
        total_score=result.total_score,
        total_marks=result.total_marks,
        payload=result_payload(result),
        release_status=result.release_status or ReleaseStatus.PROVISIONAL,
        created_at=result.created_at or utcnow(),
        superseded_at=utcnow(),
        superseded_by_rubric_id=superseded_by_rubric_id,
    )
    db.add(archived)
    sub.result = None  # delete-orphan cascade removes the row (submission_id stays UNIQUE)
    db.flush()
    return archived


def latest_version(db: Session, submission_id: int) -> EvaluationVersion | None:
    """The most recently archived version of a submission's result (None if never re-run)."""
    return db.scalar(
        select(EvaluationVersion)
        .where(EvaluationVersion.submission_id == submission_id)
        .order_by(EvaluationVersion.version.desc(), EvaluationVersion.id.desc())
        .limit(1)
    )


def next_version(db: Session, sub: StudentSubmission) -> int:
    """Version number for a new result: one more than the current or newest archived version."""
    numbers = [1 if sub.result is None else 0]
    if sub.result is not None:
        numbers.append((sub.result.version or 1) + 1)
    archived = latest_version(db, sub.id)
    if archived is not None:
        numbers.append((archived.version or 1) + 1)
    return max(numbers)


def versions(db: Session, submission_id: int) -> list[EvaluationVersion]:
    return list(
        db.scalars(
            select(EvaluationVersion)
            .where(EvaluationVersion.submission_id == submission_id)
            .order_by(EvaluationVersion.version, EvaluationVersion.id)
        ).all()
    )
