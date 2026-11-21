"""Owner what-if engine (FR-4.14): "+X hours of topic T for every student in scope -> about how
many exam marks?". Deterministic, illustrative, no AI call.

Effort-response model (linear, ILLUSTRATIVE - not a calibrated forecast):
    delta_mastery_pts = max(0, 85 - mastery) x min(1, hours / hours_to_target) x k
    hours_to_target   = the matrix effort band for the student's mastery (from_low < 40 <= from_mid
                        < 70 <= from_high), else the rubric effort_hours, else 6 h
    exam marks gain   = matrix avg_marks (else weightage x 720) x delta / 100
    test points gain  = topic max_marks x delta / 100 / result total_marks x 100
    range             = gain x c .. gain x (2 - c), c = the matrix chapter confidence (else 0.3)
k = 1.0, or the institution's outcome-calibration factor (outcomes.effectiveness) when asked.
"""
from __future__ import annotations

from statistics import fmean, median
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

import analytics
from database import Batch, Institution, StudentSubmission, SubmissionStatus
from errors import ApiError
from hashing import student_ref_for

FALLBACK_HOURS = 6.0
DEFAULT_CONFIDENCE = 0.3
LABEL = "Illustrative - linear effort-response model on the illustrative NEET matrix; not a calibrated forecast"


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def hours_to_target(
    topic: str, subject: str | None, chapter: str | None, mastery: float, rubric_effort_hours: float | None
) -> float | None:
    """Study hours to reach the 85% target: the matrix effort band for this mastery, else the
    rubric effort_hours, else None."""
    row = analytics.map_chapter(topic, subject, chapter)
    if row is not None:
        bands = row.get("effort_hours") or {}
        key = "from_low" if mastery < analytics.FOUNDATIONAL_MASTERY else (
            "from_mid" if mastery < analytics.WEAK_MASTERY else "from_high"
        )
        value = _num(bands.get(key))
        if value > 0:
            return value
    effort = _num(rubric_effort_hours)
    return effort if effort > 0 else None


def exam_marks_for(topic: str, subject: str | None, chapter: str | None, weightage: float | None) -> float:
    """Exam marks at stake for a topic: matrix avg_marks, else weightage x EXAM_TOTAL_MARKS."""
    row = analytics.map_chapter(topic, subject, chapter)
    if row is not None and _num(row.get("avg_marks")) > 0:
        return _num(row.get("avg_marks"))
    return _num(weightage) * analytics.EXAM_TOTAL_MARKS


def predicted_gain_pct(mastery: float, hours: float, hours_to_target: float | None, factor: float = 1.0) -> float:
    """max(0, 85 - mastery) x min(1, hours / H) x factor (H falls back to 6 h), 1 dp."""
    target_hours = hours_to_target if hours_to_target and hours_to_target > 0 else FALLBACK_HOURS
    gap = max(0.0, analytics.TARGET_MASTERY - float(mastery))
    return round(gap * min(1.0, max(0.0, float(hours)) / target_hours) * float(factor), 1)


def _confidence(topic: str, subject: str | None, chapter: str | None) -> float:
    row = analytics.map_chapter(topic, subject, chapter)
    if row is not None and row.get("confidence") is not None:
        return max(0.0, min(1.0, _num(row.get("confidence"), DEFAULT_CONFIDENCE)))
    matrix = analytics.load_matrix("NEET") or {}
    return max(0.0, min(1.0, _num(matrix.get("confidence"), DEFAULT_CONFIDENCE)))


# --------------------------------------------------------------------------- #
# Scope
# --------------------------------------------------------------------------- #
def _usable(sub: StudentSubmission) -> bool:
    r = sub.result
    return sub.status == SubmissionStatus.COMPLETED and r is not None and _num(r.total_marks) > 0


def _ref(sub: StudentSubmission) -> str:
    return sub.student_ref or student_ref_for(sub.student_name)


def scope(
    db: Session, *, institution_id: int | None = None, batch_id: int | None = None, rubric_id: int | None = None
) -> list[StudentSubmission]:
    """The LATEST usable completed submission per student_ref in the scope."""
    query = (
        select(StudentSubmission)
        .options(selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric),
                 selectinload(StudentSubmission.batch))
        .where(StudentSubmission.status == SubmissionStatus.COMPLETED)
    )
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    if rubric_id is not None:
        query = query.where(StudentSubmission.rubric_id == rubric_id)
    if institution_id is not None:
        query = query.join(Batch, StudentSubmission.batch_id == Batch.id).where(Batch.institution_id == institution_id)
    latest: dict[str, StudentSubmission] = {}
    for sub in db.scalars(query).all():
        if not _usable(sub):
            continue
        key = _ref(sub)
        current = latest.get(key)
        if current is None or (sub.created_at, sub.id) > (current.created_at, current.id):
            latest[key] = sub
    return sorted(latest.values(), key=lambda s: (s.student_name, s.id))


def _chapter_key(topic: str, subject: str | None = None, chapter: str | None = None) -> str | None:
    row = analytics.map_chapter(topic, subject, chapter)
    return str(row.get("chapter")) if row is not None else None


def match_topic(topic_mastery: list[dict[str, Any]] | None, topic: str) -> dict[str, Any] | None:
    """The result's topic entry for `topic`: same name (case-insensitive), else same matrix chapter."""
    wanted = " ".join(str(topic or "").split()).casefold()
    entries = [t for t in topic_mastery or [] if isinstance(t, dict) and t.get("topic")]
    for t in entries:
        if " ".join(str(t["topic"]).split()).casefold() == wanted:
            return t
    chapter = _chapter_key(topic)
    if chapter is None:
        return None
    for t in entries:
        if _chapter_key(str(t["topic"]), t.get("subject"), t.get("chapter")) == chapter:
            return t
    return None


def _institution_for(db: Session, subs: list[StudentSubmission], institution_id: int | None, batch: Batch | None) -> int | None:
    if institution_id is not None:
        return institution_id
    if batch is not None:
        return batch.institution_id
    ids = {s.batch.institution_id for s in subs if s.batch is not None}
    return ids.pop() if len(ids) == 1 else None


def calibration_for(db: Session, institution_id: int | None) -> tuple[float | None, int, bool]:
    """(factor, n, from sample data) for an institution from outcomes.effectiveness, or (None, 0, False)."""
    import outcomes  # local import: outcomes imports this module

    try:
        eff = outcomes.effectiveness(db, institution_id=institution_id)
    except Exception:  # noqa: BLE001 - calibration is optional; never break the what-if
        return None, 0, False
    rows = eff.get("by_institution") or []
    row = next((r for r in rows if institution_id is None or r.get("institution_id") == institution_id), None)
    if row is None or row.get("calibration_factor") is None:
        return None, 0, False
    return float(row["calibration_factor"]), int(row.get("calibration_n") or 0), bool(eff.get("is_demo"))


def _impact(rows: list[dict[str, float]]) -> dict[str, float]:
    if not rows:
        return {"exam_marks_avg": 0.0, "exam_marks_low": 0.0, "exam_marks_high": 0.0, "test_pct_points_avg": 0.0,
                "exam_scale_max": analytics.EXAM_TOTAL_MARKS}
    return {
        "exam_marks_avg": round(fmean(r["gain"] for r in rows), 2),
        "exam_marks_low": round(fmean(r["low"] for r in rows), 2),
        "exam_marks_high": round(fmean(r["high"] for r in rows), 2),
        "test_pct_points_avg": round(fmean(r["pts"] for r in rows), 2),
        "exam_scale_max": analytics.EXAM_TOTAL_MARKS,
    }


def _g(value: float, digits: int = 1) -> str:
    return f"{round(float(value), digits):g}"


# --------------------------------------------------------------------------- #
# POST /api/whatif
# --------------------------------------------------------------------------- #
def run(db: Session, body: Any) -> dict[str, Any]:
    """A WhatIfResult dict for a WhatIfInput."""
    batch = None
    if body.batch_id is not None:
        batch = db.get(Batch, body.batch_id)
        if batch is None:
            raise ApiError(404, f"Batch {body.batch_id} not found.", "unknown_batch")
    subs = scope(db, institution_id=body.institution_id, batch_id=body.batch_id, rubric_id=body.rubric_id)
    if not subs:
        raise ApiError(422, "No completed results in this scope yet - nothing to project.", "no_results")

    institution_id = _institution_for(db, subs, body.institution_id, batch)
    factor, cal_n, cal_demo = calibration_for(db, institution_id) if body.use_calibration else (None, 0, False)
    calibrated = factor is not None
    k = factor if calibrated else 1.0

    if batch is not None:
        scope_name = batch.name
    elif body.institution_id is not None and (inst := db.get(Institution, body.institution_id)) is not None:
        scope_name = inst.name
    else:
        scope_name = "this scope"
    rubrics = {s.rubric_id: s.rubric for s in subs if s.rubric is not None}
    test_name = next(iter(rubrics.values())).name if len(rubrics) == 1 else "their latest test"

    per_student: dict[int, dict[str, float]] = {}
    scenarios: list[dict[str, Any]] = []
    for scenario in body.scenarios:
        hours = float(scenario.extra_hours)
        rows: list[dict[str, Any]] = []
        meta: dict[str, Any] = {}
        for sub in subs:
            entry = match_topic(sub.result.topic_mastery, scenario.topic)
            if entry is None:
                continue
            name, subject, chapter = str(entry["topic"]), entry.get("subject"), entry.get("chapter")
            mastery = max(0.0, min(100.0, _num(entry.get("mastery"))))
            h = hours_to_target(name, subject, chapter, mastery, entry.get("effort_hours"))
            at_target = mastery >= analytics.TARGET_MASTERY
            delta = 0.0 if at_target else predicted_gain_pct(mastery, hours, h, k)
            exam_marks = exam_marks_for(name, subject, chapter, entry.get("weightage"))
            gain = exam_marks * delta / 100
            c = _confidence(name, subject, chapter)
            pts = _num(entry.get("max_marks")) * delta / 100 / float(sub.result.total_marks) * 100
            row_map = analytics.map_chapter(name, subject, chapter)
            meta.setdefault("subject", subject)
            meta.setdefault("chapter", str(row_map.get("chapter")) if row_map else chapter)
            meta.setdefault("topic", name)
            meta.setdefault("hours", []).append(h)
            rows.append({
                "sub": sub, "mastery": mastery, "delta": delta, "at_target": at_target,
                "gain": gain, "low": max(0.0, gain - (1 - c) * gain), "high": gain + (1 - c) * gain, "pts": pts,
            })
            agg = per_student.setdefault(sub.id, {"gain": 0.0, "low": 0.0, "high": 0.0, "pts": 0.0})
            for key in agg:
                agg[key] += rows[-1][key]
        if not rows:
            raise ApiError(
                422, f"No student in this scope was assessed on {scenario.topic}", "unknown_topic"
            )
        impact = _impact(rows)
        known_hours = [h for h in meta["hours"] if h is not None]
        topic_label = meta["topic"]
        headline = (
            f"+{_g(hours)} h of {topic_label} for every student in {scope_name} -> about "
            f"+{_g(impact['exam_marks_avg'])} NEET marks per student (range {_g(impact['exam_marks_low'])}-"
            f"{_g(impact['exam_marks_high'])}) and +{_g(impact['test_pct_points_avg'])} points on {test_name}"
        )
        scenarios.append({
            "topic": topic_label,
            "subject": meta.get("subject"),
            "chapter": meta.get("chapter"),
            "extra_hours": hours,
            "hours_to_target": round(median(known_hours), 1) if known_hours else None,
            "students_assessed": len(rows),
            "students_at_target": sum(1 for r in rows if r["at_target"]),
            "mean_mastery_before": round(fmean(r["mastery"] for r in rows), 1),
            "mean_mastery_after": round(fmean(min(100.0, r["mastery"] + r["delta"]) for r in rows), 1),
            "impact": impact,
            "headline": headline,
            "students": [
                {
                    "submission_id": r["sub"].id,
                    "student_name": r["sub"].student_name,
                    "student_ref": _ref(r["sub"]),
                    "mastery_before": round(r["mastery"], 1),
                    "mastery_after": round(min(100.0, r["mastery"] + r["delta"]), 1),
                    "exam_marks_gain": round(r["gain"], 2),
                }
                for r in sorted(rows, key=lambda r: (-r["gain"], r["sub"].student_name))
            ],
        })

    baseline = [analytics.percentage(s.result) for s in subs]
    projected = [min(100.0, pct + per_student.get(s.id, {}).get("pts", 0.0)) for s, pct in zip(subs, baseline)]
    label = LABEL
    if calibrated:
        source = "sample-data calibration factor" if cal_demo else "calibration factor"
        label += f"; scaled by the {source} {k:g} (n={cal_n})"
    calibration_line = (
        f"Scaled by k = {k:g}: realised / predicted mastery gains of {cal_n} measured interventions"
        + (" (sample data)" if cal_demo else "") + " - observational, not causal."
        if calibrated else
        "No calibration applied (k = 1.0)"
        + (": too few measured interventions for this institution yet." if body.use_calibration else ".")
    )
    assumptions = [
        f"Linear response: each extra hour closes an equal share of the gap to {analytics.TARGET_MASTERY:g}% "
        "mastery; nothing beyond the target.",
        "Hours to target come from the illustrative NEET matrix effort bands for each student's current mastery "
        f"(else the rubric effort hours, else {FALLBACK_HOURS:g} h).",
        "Every student in scope studies the full extra hours; topics do not interact.",
        "Exam marks use the matrix average marks per chapter on the "
        f"{analytics.EXAM_TOTAL_MARKS:g}-mark NEET scale; the range uses the matrix confidence.",
        calibration_line,
        "Each student's latest completed result is the baseline"
        + ("; the scope includes sample data." if any(s.is_demo for s in subs) else "."),
    ]
    return {
        "batch_id": body.batch_id,
        "batch_name": batch.name if batch is not None else None,
        "rubric_id": body.rubric_id,
        "institution_id": institution_id,
        "students_considered": len(subs),
        "baseline_avg_pct": round(fmean(baseline), 1) if baseline else None,
        "projected_avg_pct": round(fmean(projected), 1) if projected else None,
        "scenarios": scenarios,
        "combined": _impact(list(per_student.values())),
        "calibration_factor": k,
        "calibrated": calibrated,
        "label": label,
        "assumptions": assumptions,
        "is_demo": any(s.is_demo for s in subs),
    }


# --------------------------------------------------------------------------- #
# GET /api/whatif/options
# --------------------------------------------------------------------------- #
def options(db: Session, *, batch_id: int | None = None, institution_id: int | None = None) -> dict[str, Any]:
    """A WhatIfOptions: batches with completed results, topics in scope (weakest first) and the
    calibration factor available for the scope's institution."""
    batch = None
    if batch_id is not None:
        batch = db.get(Batch, batch_id)
        if batch is None:
            raise ApiError(404, f"Batch {batch_id} not found.", "unknown_batch")
    batch_query = (
        select(Batch)
        .join(StudentSubmission, StudentSubmission.batch_id == Batch.id)
        .where(StudentSubmission.status == SubmissionStatus.COMPLETED)
        .distinct()
        .order_by(Batch.id)
    )
    if institution_id is not None:
        batch_query = batch_query.where(Batch.institution_id == institution_id)
    import result_view  # local import: result_view -> outcomes -> whatif

    batches = [result_view.batch_out(b).model_dump() for b in db.scalars(batch_query).all()]

    subs = scope(db, institution_id=institution_id, batch_id=batch_id)
    topics: dict[str, dict[str, Any]] = {}
    for sub in subs:
        for t in sub.result.topic_mastery or []:
            if not isinstance(t, dict) or not t.get("topic"):
                continue
            name = " ".join(str(t["topic"]).split())
            agg = topics.setdefault(name.casefold(), {"topic": name, "subject": t.get("subject"), "m": [], "h": []})
            mastery = max(0.0, min(100.0, _num(t.get("mastery"))))
            agg["m"].append(mastery)
            h = hours_to_target(name, t.get("subject"), t.get("chapter"), mastery, t.get("effort_hours"))
            if h is not None:
                agg["h"].append(h)
    rows = [
        {
            "topic": a["topic"],
            "subject": a["subject"],
            "students": len(a["m"]),
            "mean_mastery": round(fmean(a["m"]), 1) if a["m"] else None,
            "hours_to_target": round(median(a["h"]), 1) if a["h"] else None,
        }
        for a in topics.values()
    ]
    rows.sort(key=lambda r: (r["mean_mastery"] if r["mean_mastery"] is not None else 101.0, r["topic"]))
    factor, _, _ = calibration_for(db, _institution_for(db, subs, institution_id, batch))
    return {"batches": batches, "topics": rows, "calibration_factor": factor}
