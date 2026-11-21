"""Institute-owner dashboard (FR-5.9): one institution's batches, faculty, tests, trend, weakest
topics, operations and intervention effect in a single read-only payload.

PoC: there is no login, so the page is open (role_note says so). Faculty are identified by the
free-text names already in the data (batch faculty lead, report reviewer, OCR reviewer and
intervention author), matched case- and whitespace-insensitively, until a users table exists.
Trend deltas compare DIFFERENT tests, so they are indicative only (the UI labels them).
"""
from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime, timedelta
from statistics import fmean
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

import analytics
import hashing
import outcomes
import provenance
import result_view
from database import (
    IST,
    Batch,
    Institution,
    InterventionRecord,
    ModelInvocation,
    OcrReview,
    ReleaseStatus,
    StudentSubmission,
    SubmissionStatus,
    utcnow,
)
from errors import ApiError

logger = logging.getLogger("3ilens.owner")

ROLE_NOTE = (
    "Owner view - no login in this PoC. Production: the owner role from the identity provider "
    "(V5 'identity' step) and row-level security per institution."
)
WEAKEST_TOPICS = 5
SITTING_GAP = timedelta(days=3)
MIN_TREND_STUDENTS = 3  # a previous test sat by fewer students is not used for the batch delta


def _key(name: str | None) -> str:
    return " ".join((name or "").split()).casefold()


def _display(name: str | None) -> str:
    return " ".join((name or "").split())


def _ref(sub: StudentSubmission) -> str:
    return sub.student_ref or hashing.student_ref_for(sub.student_name)


def _mean(values: Iterable[float]) -> float | None:
    items = list(values)
    return round(fmean(items), 1) if items else None


def _latest_per_student(subs: Iterable[StudentSubmission]) -> list[StudentSubmission]:
    """The newest completed result per student_ref (by result.created_at, then id)."""
    latest: dict[str, StudentSubmission] = {}
    for sub in subs:
        current = latest.get(_ref(sub))
        if current is None or (sub.result.created_at, sub.id) > (current.result.created_at, current.id):
            latest[_ref(sub)] = sub
    return list(latest.values())


def _urgency_counts(subs: Iterable[StudentSubmission]) -> dict[str, int]:
    counts = {"on_track": 0, "needs_attention": 0, "at_risk": 0}
    for sub in subs:
        urgency, _reasons, _pct = analytics.result_urgency(sub.result)
        counts[urgency] = counts.get(urgency, 0) + 1
    return counts


def _topic_means(subs: Iterable[StudentSubmission]) -> dict[str, tuple[str, float]]:
    """topic -> (subject, mean mastery) over the given results."""
    values: dict[str, list[float]] = {}
    subjects: dict[str, str] = {}
    for sub in subs:
        for item in sub.result.topic_mastery or []:
            if not isinstance(item, dict) or not item.get("topic"):
                continue
            try:
                mastery = float(item.get("mastery") or 0.0)
            except (TypeError, ValueError):
                continue
            topic = str(item["topic"])
            values.setdefault(topic, []).append(mastery)
            subjects.setdefault(topic, str(item.get("subject") or ""))
    return {topic: (subjects[topic], fmean(v)) for topic, v in values.items()}


def _released(sub: StudentSubmission) -> bool:
    return (sub.result.release_status or ReleaseStatus.PROVISIONAL) == ReleaseStatus.RELEASED


def _tests_by_recency(subs: list[StudentSubmission]) -> list[tuple[int, list[StudentSubmission]]]:
    """[(rubric_id, completed subs)] newest test first (by the newest result of each test)."""
    groups: dict[int, list[StudentSubmission]] = {}
    for sub in subs:
        groups.setdefault(sub.rubric_id, []).append(sub)
    return sorted(
        groups.items(), key=lambda item: max((s.result.created_at, s.id) for s in item[1]), reverse=True,
    )


# --------------------------------------------------------------------------- #
# Sections
# --------------------------------------------------------------------------- #
def _batch_summary(db: Session, batch: Batch, subs: list[StudentSubmission]) -> dict[str, Any]:
    completed = [s for s in subs if result_view.is_completed(s)]
    tests = _tests_by_recency(completed)
    latest_subs = tests[0][1] if tests else []
    latest_pct = _mean(analytics.percentage(s.result) for s in latest_subs)
    # The previous test sat by at least MIN_TREND_STUDENTS students (a one-student oral check is
    # not a comparable sitting for a whole-batch mock).
    previous = next((t for _rubric, t in tests[1:] if len({_ref(s) for s in t}) >= MIN_TREND_STUDENTS), None)
    previous_pct = _mean(analytics.percentage(s.result) for s in previous) if previous else None
    delta = round(latest_pct - previous_pct, 1) if latest_pct is not None and previous_pct is not None else None
    gaps = _topic_means(latest_subs)
    cost = db.scalar(select(func.sum(ModelInvocation.cost_inr)).where(ModelInvocation.batch_id == batch.id))
    return {
        "batch": result_view.batch_out(batch),
        "students": len({_ref(s) for s in subs}),
        "completed": len(completed),
        "average_pct": latest_pct,
        "previous_average_pct": previous_pct,
        "trend_delta_pct": delta,
        "urgency_counts": _urgency_counts(latest_subs),
        "latest_test": result_view.rubric_ref(latest_subs[0].rubric) if latest_subs else None,
        "latest_test_date": max(s.result.created_at for s in latest_subs) if latest_subs else None,
        "released": sum(1 for s in completed if _released(s)),
        "provisional": sum(1 for s in completed if not _released(s)),
        "review_backlog": sum(1 for s in subs if s.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED),
        "failed": sum(1 for s in subs if s.status == SubmissionStatus.FAILED),
        "top_gap_topic": min(gaps, key=lambda t: (gaps[t][1], t)) if gaps else None,
        "cost_inr": round(float(cost or 0.0), 2),
        "is_demo": any(s.is_demo for s in subs),
    }


def _faculty(
    db: Session,
    batches: list[Batch],
    subs: list[StudentSubmission],
    completed: list[StudentSubmission],
    interventions: list[InterventionRecord],
) -> list[dict[str, Any]]:
    sub_ids = [s.id for s in subs]
    reviews = list(db.scalars(select(OcrReview).where(OcrReview.submission_id.in_(sub_ids))).all()) if sub_ids else []
    names: dict[str, str] = {}

    def add(raw: str | None) -> None:
        key = _key(raw)
        if key and key not in names:
            names[key] = _display(raw)

    for batch in batches:
        add(batch.faculty_lead)
    for sub in completed:
        add(sub.result.reviewed_by)
    for review in reviews:
        add(review.reviewer)
    for record in interventions:
        add(record.applied_by)

    out = []
    for key, name in names.items():
        led = [b for b in batches if _key(b.faculty_lead) == key]
        led_ids = {b.id for b in led}
        led_latest = _latest_per_student(s for s in completed if s.batch_id in led_ids)
        released = [s for s in completed if _released(s) and _key(s.result.reviewed_by) == key]
        hours = []
        for sub in released:
            start: datetime | None = sub.completed_at or sub.result.created_at
            end = sub.result.reviewed_at
            if start is not None and end is not None:
                hours.append(max(0.0, (end - start).total_seconds() / 3600.0))
        out.append({
            "name": name,
            "batches": [b.name for b in led],
            "students": len({_ref(s) for s in subs if s.batch_id in led_ids}),
            "average_pct": _mean(analytics.percentage(s.result) for s in led_latest),
            "reports_released": len(released),
            "ocr_reviews": sum(1 for r in reviews if _key(r.reviewer) == key),
            "interventions_logged": sum(1 for r in interventions if _key(r.applied_by) == key),
            "avg_release_hours": round(fmean(hours), 1) if hours else None,
        })
    return sorted(out, key=lambda f: (-len(f["batches"]), -f["reports_released"], f["name"].casefold()))


def _sittings(completed: list[StudentSubmission]) -> list[tuple[int, list[StudentSubmission]]]:
    """[(batch_id, subs)] per sitting: the results of one test in one batch, split wherever two
    consecutive results are more than SITTING_GAP apart (the same paper re-used weeks later, e.g.
    Mock-05 and Mock-06, is a separate sitting; one evening's uploads across midnight are not)."""
    groups: dict[tuple[int, int], list[StudentSubmission]] = {}
    for sub in completed:
        groups.setdefault((sub.batch_id, sub.rubric_id), []).append(sub)
    sittings = []
    for (batch_id, _rubric_id), subs in groups.items():
        subs.sort(key=lambda s: (s.result.created_at, s.id))
        current = [subs[0]]
        for sub in subs[1:]:
            if sub.result.created_at - current[-1].result.created_at > SITTING_GAP:
                sittings.append((batch_id, current))
                current = []
            current.append(sub)
        sittings.append((batch_id, current))
    return sittings


def _trend(batches: dict[int, Batch], completed: list[StudentSubmission]) -> list[dict[str, Any]]:
    """One point per sitting: the IST date of its newest result and the mean percentage."""
    points = []
    for batch_id, subs in _sittings(completed):
        newest = max(s.result.created_at for s in subs)
        points.append({
            "date": newest.astimezone(IST).date().isoformat(),
            "batch_id": batch_id,
            "batch_name": batches[batch_id].name,
            "test_name": subs[0].rubric.name,
            "average_pct": _mean(analytics.percentage(s.result) for s in subs) or 0.0,
            "students": len({_ref(s) for s in subs}),
            "_sort": newest,
        })
    points.sort(key=lambda p: (p["date"], p["_sort"], p["batch_id"]))
    for point in points:
        point.pop("_sort")
    return points


def _interventions(db: Session, institution_id: int) -> dict[str, Any]:
    """InterventionSummary from outcomes.effectiveness (zeros when it is unavailable)."""
    try:
        effect = outcomes.effectiveness(db, institution_id=institution_id)
        calibration = next(
            (row.get("calibration_factor") for row in effect.get("by_institution") or []
             if row.get("institution_id") == institution_id),
            None,
        )
        return {
            "records": int(effect.get("records") or 0),
            "measured": int(effect.get("measured") or 0),
            "uplift": effect.get("uplift"),
            "calibration_factor": calibration,
        }
    except Exception:  # noqa: BLE001 - the intervention summary must never break the dashboard
        logger.exception("Intervention effectiveness unavailable for institution %s", institution_id)
        return {"records": 0, "measured": 0, "uplift": None, "calibration_factor": None}


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #
def dashboard(db: Session, institution_id: int | None = None) -> dict[str, Any]:
    """An OwnerDashboard dict for one institution (the first one when none is given)."""
    institutions = list(db.scalars(select(Institution).order_by(Institution.id)).all())
    if institution_id is not None:
        institution = db.get(Institution, institution_id)
        if institution is None:
            raise ApiError(404, f"Institution {institution_id} not found.", "unknown_institution")
    elif institutions:
        institution = institutions[0]
    else:
        raise ApiError(404, "No institution exists yet.", "unknown_institution")

    batches = list(db.scalars(
        select(Batch).where(Batch.institution_id == institution.id).order_by(Batch.id)
    ).all())
    batch_ids = [b.id for b in batches]
    subs: list[StudentSubmission] = []
    if batch_ids:
        subs = list(db.scalars(
            select(StudentSubmission)
            .where(StudentSubmission.batch_id.in_(batch_ids))
            .options(selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric))
            .order_by(StudentSubmission.id)
        ).all())
    completed = [s for s in subs if result_view.is_completed(s)]
    latest = _latest_per_student(completed)
    interventions = list(db.scalars(
        select(InterventionRecord).where(InterventionRecord.institution_id == institution.id)
    ).all())
    faculty = _faculty(db, batches, subs, completed, interventions)
    topics = _topic_means(latest)
    weakest = sorted(topics.items(), key=lambda item: (item[1][1], item[0]))[:WEAKEST_TOPICS]
    demo_count = sum(1 for s in subs if s.is_demo)
    by_status = {status: sum(1 for s in subs if s.status == status) for status in SubmissionStatus}

    return {
        "institution": result_view.institution_out(institution),
        "institutions": [result_view.institution_out(i) for i in institutions],
        "generated_at": utcnow(),
        "totals": {
            "students": len({_ref(s) for s in subs}),
            "submissions": len(subs),
            "completed": len(completed),
            "human_review": by_status[SubmissionStatus.HUMAN_REVIEW_REQUIRED],
            "failed": by_status[SubmissionStatus.FAILED],
            "processing": by_status[SubmissionStatus.PENDING] + by_status[SubmissionStatus.PROCESSING],
            "average_pct": _mean(analytics.percentage(s.result) for s in latest),
            "released": sum(1 for s in completed if _released(s)),
            "provisional": sum(1 for s in completed if not _released(s)),
            "batches": len(batches),
            "faculty": len(faculty),
            "tests": len({s.rubric_id for s in completed}),
        },
        "urgency_counts": _urgency_counts(latest),
        "batches": [_batch_summary(db, b, [s for s in subs if s.batch_id == b.id]) for b in batches],
        "faculty": faculty,
        "trend": _trend({b.id: b for b in batches}, completed),
        "weakest_topics": [
            {"topic": topic, "subject": subject, "mastery": round(mean, 1)} for topic, (subject, mean) in weakest
        ],
        "operations": provenance.cohort_operations(db, subs=subs),
        "interventions": _interventions(db, institution.id),
        "is_demo": demo_count > 0,
        "demo_count": demo_count,
        "real_count": len(subs) - demo_count,
        "role_note": ROLE_NOTE,
    }
