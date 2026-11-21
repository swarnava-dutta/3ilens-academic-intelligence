"""Intervention log and outcome tracking (FR-4.13). Deterministic, no AI call.

A record captures a teaching action on one student's topic, with the topic mastery and the
effort-model prediction at record time. Its outcome is read at request time from the student's
EARLIEST later completed test that covers the topic (same name, or the same matrix chapter).

Effectiveness is observational (treated topics vs the same students' untreated topics); the
calibration factor it suggests is used only by the owner's what-if when asked, never by the BRD ROI.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from statistics import fmean
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

import analytics
import whatif
from config import get_settings
from database import (
    Institution,
    InterventionRecord,
    StudentSubmission,
    SubmissionStatus,
    utcnow,
)
from errors import ApiError
from hashing import student_ref_for

CAVEAT = (
    "Observational comparison: students and topics were not randomised, so uplift is indicative, not causal - "
    "interventions are not assumed to cause the score changes (V5: do not assume interventions caused score gains)."
)
SAMPLE_SUFFIX = " Sample data."
MIN_CALIBRATION_N = 5
CALIBRATION_MIN_N = MIN_CALIBRATION_N
CALIBRATION_RANGE = (0.25, 2.0)
IMPROVED_PTS = 5.0
DECLINED_PTS = -5.0
ROI_ACCURACY_MAX = 3.0
MAX_APPLIED_AHEAD = timedelta(days=1)
RESULT_RECORD_CAP = 50
KIND_LABELS = {
    "study_focus": "Study focus",
    "nudge": "Nudge",
    "class_intervention": "Class intervention",
    "custom": "Custom",
}
MEASURED = ("improved", "flat", "declined")


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _norm(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


def _chapter(entry: dict[str, Any]) -> str | None:
    row = analytics.map_chapter(str(entry.get("topic") or ""), entry.get("subject"), entry.get("chapter"))
    return str(row.get("chapter")) if row is not None else None


def find_topic(topic_mastery: list[dict[str, Any]] | None, topic: str) -> dict[str, Any] | None:
    """The topic entry with this name (case-insensitive)."""
    wanted = _norm(topic)
    return next(
        (t for t in topic_mastery or [] if isinstance(t, dict) and t.get("topic") and _norm(t["topic"]) == wanted),
        None,
    )


def _covering(topic_mastery: list[dict[str, Any]] | None, baseline_entry: dict[str, Any]) -> dict[str, Any] | None:
    """The entry covering the baseline topic: same name, else the same matrix chapter."""
    entry = find_topic(topic_mastery, str(baseline_entry.get("topic") or ""))
    if entry is not None:
        return entry
    chapter = _chapter(baseline_entry)
    if chapter is None:
        return None
    return next(
        (t for t in topic_mastery or [] if isinstance(t, dict) and t.get("topic") and _chapter(t) == chapter),
        None,
    )


# --------------------------------------------------------------------------- #
# Recording
# --------------------------------------------------------------------------- #
def build_record(
    sub: StudentSubmission,
    *,
    topic: str,
    kind: str,
    action: str,
    applied_by: str,
    source: str = "faculty",
    applied_at: datetime | None = None,
    hours: float | None = None,
    compliance: float | None = None,
    note: str | None = None,
    now: datetime | None = None,
) -> InterventionRecord:
    """A new (unsaved) InterventionRecord against a completed submission, with the baseline mastery
    and the effort-model prediction captured now. Raises ApiError on invalid input."""
    if sub.status != SubmissionStatus.COMPLETED or sub.result is None:
        raise ApiError(
            409,
            f"Interventions can be logged only against a completed result (submission {sub.id} is {sub.status}).",
            "invalid_state",
        )
    entry = find_topic(sub.result.topic_mastery, topic)
    if entry is None:
        raise ApiError(422, f"Topic '{topic}' is not in this result's topic mastery.", "unknown_topic")
    now = now or utcnow()
    applied = _aware(applied_at) if applied_at is not None else now
    if applied > now + MAX_APPLIED_AHEAD:
        raise ApiError(422, "applied_at cannot be more than 1 day in the future.", "invalid_applied_at")
    hours = float(hours) if hours else float(get_settings().default_intervention_hours)
    name = str(entry["topic"])
    mastery = max(0.0, min(100.0, _num(entry.get("mastery"))))
    h = whatif.hours_to_target(name, entry.get("subject"), entry.get("chapter"), mastery, entry.get("effort_hours"))
    return InterventionRecord(
        institution_id=sub.batch.institution_id,
        batch_id=sub.batch_id,
        submission_id=sub.id,
        student_ref=sub.student_ref or student_ref_for(sub.student_name),
        student_name=sub.student_name,
        topic=name,
        kind=kind,
        action=action,
        source=source or "faculty",
        applied_by=applied_by,
        applied_at=applied,
        hours=hours,
        compliance=compliance,
        baseline_mastery=round(mastery, 1),
        predicted_gain_pct=whatif.predicted_gain_pct(mastery, hours, h),
        note=note,
        is_demo=bool(sub.is_demo),
        created_at=now,
    )


def record(db: Session, body: Any) -> InterventionRecord:
    """POST /api/interventions: validate, capture baseline + prediction, insert."""
    sub = db.get(StudentSubmission, body.submission_id)
    if sub is None:
        raise ApiError(404, f"Submission {body.submission_id} not found.", "unknown_submission")
    row = build_record(
        sub, topic=body.topic, kind=body.kind, action=body.action, applied_by=body.applied_by,
        source=body.source, applied_at=body.applied_at, hours=body.hours, compliance=body.compliance, note=body.note,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def delete(db: Session, intervention_id: int) -> None:
    row = db.get(InterventionRecord, intervention_id)
    if row is None:
        raise ApiError(404, f"Intervention {intervention_id} not found.", "unknown_intervention")
    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Follow-up
# --------------------------------------------------------------------------- #
def follow_up(db: Session, rec: InterventionRecord) -> tuple[str, dict[str, Any] | None]:
    """(outcome_status, InterventionOutcome | None) from the earliest later completed test that
    covers the topic."""
    baseline_sub = db.get(StudentSubmission, rec.submission_id)
    baseline_entry = (
        find_topic(baseline_sub.result.topic_mastery, rec.topic)
        if baseline_sub is not None and baseline_sub.result is not None else None
    ) or {"topic": rec.topic}
    later = db.scalars(
        select(StudentSubmission)
        .where(
            StudentSubmission.student_ref == rec.student_ref,
            StudentSubmission.status == SubmissionStatus.COMPLETED,
            StudentSubmission.created_at > rec.applied_at,
            StudentSubmission.id != rec.submission_id,
        )
        .order_by(StudentSubmission.created_at, StudentSubmission.id)
    ).all()
    later = [s for s in later if s.result is not None]
    if not later:
        return "pending", None
    for sub in later:
        entry = _covering(sub.result.topic_mastery, baseline_entry)
        if entry is None:
            continue
        baseline = _num(rec.baseline_mastery, _num(baseline_entry.get("mastery")))
        follow = max(0.0, min(100.0, _num(entry.get("mastery"))))
        change = round(follow - baseline, 1)
        status = "improved" if change >= IMPROVED_PTS else ("declined" if change <= DECLINED_PTS else "flat")
        predicted = rec.predicted_gain_pct
        roi = None
        if predicted is not None and predicted > 0:
            roi = round(max(0.0, min(ROI_ACCURACY_MAX, change / predicted)), 2)
        score_change = None
        if baseline_sub is not None and baseline_sub.result is not None:
            score_change = round(analytics.percentage(sub.result) - analytics.percentage(baseline_sub.result), 1)
        return status, {
            "follow_up_submission_id": sub.id,
            "follow_up_date": sub.created_at,
            "follow_up_test": f"{sub.rubric.name} {sub.rubric.version}" if sub.rubric is not None else "Unknown test",
            "baseline_mastery": round(baseline, 1),
            "follow_up_mastery": round(follow, 1),
            "mastery_change": change,
            "predicted_gain_pct": predicted,
            "roi_accuracy": roi,
            "score_change_pct": score_change,
        }
    return "not_assessed", None


def record_out(db: Session, row: InterventionRecord, followed: tuple[str, dict[str, Any] | None] | None = None) -> dict[str, Any]:
    """An InterventionRecord dict (schemas.InterventionRecordOut) with its outcome."""
    status, outcome = followed or follow_up(db, row)
    return {
        "id": row.id,
        "institution_id": row.institution_id,
        "batch_id": row.batch_id,
        "submission_id": row.submission_id,
        "student_ref": row.student_ref,
        "student_name": row.student_name,
        "topic": row.topic,
        "kind": row.kind,
        "action": row.action,
        "source": row.source or "faculty",
        "applied_by": row.applied_by,
        "applied_at": row.applied_at,
        "hours": row.hours,
        "compliance": row.compliance,
        "baseline_mastery": row.baseline_mastery,
        "predicted_gain_pct": row.predicted_gain_pct,
        "note": row.note,
        "is_demo": bool(row.is_demo),
        "created_at": row.created_at,
        "outcome_status": status,
        "outcome": outcome,
    }


def _records(
    db: Session,
    *,
    batch_id: int | None = None,
    student_ref: str | None = None,
    submission_id: int | None = None,
    institution_id: int | None = None,
    limit: int | None = None,
) -> list[InterventionRecord]:
    query = select(InterventionRecord)
    if batch_id is not None:
        query = query.where(InterventionRecord.batch_id == batch_id)
    if student_ref is not None:
        query = query.where(InterventionRecord.student_ref == student_ref)
    if submission_id is not None:
        query = query.where(InterventionRecord.submission_id == submission_id)
    if institution_id is not None:
        query = query.where(InterventionRecord.institution_id == institution_id)
    query = query.order_by(InterventionRecord.applied_at.desc(), InterventionRecord.id.desc())
    if limit is not None:
        query = query.limit(limit)
    return list(db.scalars(query).all())


def records_out(
    db: Session,
    *,
    batch_id: int | None = None,
    student_ref: str | None = None,
    submission_id: int | None = None,
    institution_id: int | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """InterventionRecord dicts, newest applied_at first."""
    rows = _records(db, batch_id=batch_id, student_ref=student_ref, submission_id=submission_id,
                    institution_id=institution_id, limit=limit)
    return [record_out(db, row) for row in rows]


def result_extras(db: Any, *, sub: Any, result: Any) -> dict[str, Any]:
    """{"interventions": InterventionRecord[]} for the student of this result (newest first, cap 50)."""
    ref = getattr(sub, "student_ref", None)
    if db is None or not ref:
        return {"interventions": []}
    return {"interventions": records_out(db, student_ref=ref, limit=RESULT_RECORD_CAP)}


# --------------------------------------------------------------------------- #
# Effectiveness
# --------------------------------------------------------------------------- #
def _mean(values: list[float]) -> float | None:
    return fmean(values) if values else None


def _r(value: float | None) -> float | None:
    return round(value, 1) if value is not None else None


def _uplift(treated: float | None, control: float | None) -> float | None:
    return round(treated - control, 1) if treated is not None and control is not None else None


def _control_changes(db: Session, measured: list[tuple[InterventionRecord, dict[str, Any]]], all_rows: list[InterventionRecord]) -> dict[tuple[str, str], float]:
    """{(student_ref, topic): change} for topics present in both the baseline and the follow-up
    result of a measured record that have NO record for that student. Each pair counted once."""
    treated_topics: dict[str, set[str]] = {}
    for row in all_rows:
        treated_topics.setdefault(row.student_ref, set()).add(_norm(row.topic))
    out: dict[tuple[str, str], float] = {}
    seen_pairs: set[tuple[int, int]] = set()
    for rec, outcome in measured:
        pair = (rec.submission_id, outcome["follow_up_submission_id"])
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        base, follow = db.get(StudentSubmission, pair[0]), db.get(StudentSubmission, pair[1])
        if base is None or follow is None or base.result is None or follow.result is None:
            continue
        for entry in base.result.topic_mastery or []:
            if not isinstance(entry, dict) or not entry.get("topic"):
                continue
            key = _norm(entry["topic"])
            if key in treated_topics.get(rec.student_ref, set()) or (rec.student_ref, key) in out:
                continue
            later = find_topic(follow.result.topic_mastery, str(entry["topic"]))
            if later is None:
                continue
            out[(rec.student_ref, key)] = _num(later.get("mastery")) - _num(entry.get("mastery"))
    return out


def _effect_rows(
    groups: dict[str, list[tuple[InterventionRecord, str, dict[str, Any] | None]]],
    control: float | None,
    labels: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    rows = []
    for key, items in groups.items():
        changes = [o["mastery_change"] for _, status, o in items if status in MEASURED and o is not None]
        improved = sum(1 for _, status, _o in items if status == "improved")
        mean = _mean(changes)
        rows.append({
            "key": key,
            "label": (labels or {}).get(key, key),
            "n": len(changes),
            "mean_change": _r(mean),
            "control_change": _r(control),
            "uplift": _uplift(mean, control),
            "improved_share": round(improved / len(changes), 2) if changes else None,
        })
    rows.sort(key=lambda r: (r["mean_change"] is None, -(r["mean_change"] or 0.0), r["label"]))
    return rows


def calibration_factor(measured: list[tuple[InterventionRecord, dict[str, Any]]]) -> tuple[float | None, int]:
    """sum(max(0, change)) / sum(predicted) over measured records with predicted > 0; only when
    n >= 5, clamped to [0.25, 2.0]. Returns (factor | None, n)."""
    usable = [(r, o) for r, o in measured if r.predicted_gain_pct is not None and r.predicted_gain_pct > 0]
    n = len(usable)
    if n < CALIBRATION_MIN_N:
        return None, n
    predicted = sum(float(r.predicted_gain_pct) for r, _ in usable)
    realised = sum(max(0.0, float(o["mastery_change"])) for _, o in usable)
    low, high = CALIBRATION_RANGE
    return round(max(low, min(high, realised / predicted)), 2), n


def _empty(institution_id: int | None, batch_id: int | None) -> dict[str, Any]:
    return {
        "institution_id": institution_id, "batch_id": batch_id, "records": 0, "measured": 0, "pending": 0,
        "mean_change_treated": None, "mean_change_control": None, "uplift": None, "by_kind": [], "by_topic": [],
        "by_institution": [], "is_demo": False, "caveat": CAVEAT, "generated_at": utcnow(),
    }


def effectiveness(db: Any, *, institution_id: int | None = None, batch_id: int | None = None) -> dict[str, Any]:
    """An InterventionEffectiveness over the records in scope (observational)."""
    if db is None:
        return _empty(institution_id, batch_id)
    rows = _records(db, batch_id=batch_id, institution_id=institution_id)
    if not rows:
        return _empty(institution_id, batch_id)
    followed = [(row, *follow_up(db, row)) for row in rows]
    measured = [(row, o) for row, status, o in followed if status in MEASURED and o is not None]
    control_map = _control_changes(db, measured, rows)
    treated = _mean([o["mastery_change"] for _, o in measured])
    control = _mean(list(control_map.values()))

    by_kind: dict[str, list[tuple[InterventionRecord, str, dict[str, Any] | None]]] = {}
    by_topic: dict[str, list[tuple[InterventionRecord, str, dict[str, Any] | None]]] = {}
    by_inst: dict[int, list[tuple[InterventionRecord, str, dict[str, Any] | None]]] = {}
    for item in followed:
        row = item[0]
        by_kind.setdefault(row.kind, []).append(item)
        by_topic.setdefault(row.topic, []).append(item)
        by_inst.setdefault(row.institution_id, []).append(item)

    institutions = []
    for inst_id, items in sorted(by_inst.items()):
        inst_measured = [(r, o) for r, status, o in items if status in MEASURED and o is not None]
        refs = {r.student_ref for r, _ in inst_measured}
        inst_control = _mean([v for (ref, _), v in control_map.items() if ref in refs])
        inst_mean = _mean([o["mastery_change"] for _, o in inst_measured])
        factor, n = calibration_factor(inst_measured)
        inst = db.get(Institution, inst_id)
        institutions.append({
            "institution_id": inst_id,
            "institution_name": inst.name if inst is not None else f"Institution {inst_id}",
            "records": len(items),
            "measured": len(inst_measured),
            "mean_change": _r(inst_mean),
            "uplift": _uplift(inst_mean, inst_control),
            "calibration_factor": factor,
            "calibration_n": n,
        })

    is_demo = any(row.is_demo for row in rows)
    statuses = Counter(status for _, status, _ in followed)
    return {
        "institution_id": institution_id,
        "batch_id": batch_id,
        "records": len(rows),
        "measured": len(measured),
        "pending": statuses["pending"],
        "mean_change_treated": _r(treated),
        "mean_change_control": _r(control),
        "uplift": _uplift(treated, control),
        "by_kind": _effect_rows(by_kind, control, KIND_LABELS),
        "by_topic": _effect_rows(by_topic, control),
        "by_institution": institutions,
        "is_demo": is_demo,
        "caveat": CAVEAT + (SAMPLE_SUFFIX if is_demo else ""),
        "generated_at": utcnow(),
    }
