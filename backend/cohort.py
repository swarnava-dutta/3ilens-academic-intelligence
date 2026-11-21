"""Cohort dashboard aggregation (GET /api/cohort and the cohort PDF).

The no-filter numbers are exactly the v1 get_cohort numbers (tests pin them).
batch_id / rubric_id filter every submission; urgency / topic filter only the completed set
(non-completed rows have no score), so counts stay consistent: total = completed shown +
processing + review + failed.
"""
from __future__ import annotations

from collections import Counter
from statistics import fmean
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

import analytics
import insights
import provenance
import result_view
import seed
from database import Batch, EvaluationResult, Institution, Rubric, StudentSubmission, SubmissionStatus
from errors import ApiError
from schemas import CohortOut, DistributionBucket, PriorityOut, TopicAverage

DISTRIBUTION_LABELS = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"]
TOPIC_GAP_MASTERY = 60.0  # topic filter: mastery below this, or the topic is in the stored top 5


def _context(db: Session, batch_id: int | None) -> tuple[Institution, Batch]:
    if batch_id is not None:
        batch = db.get(Batch, batch_id)
        if batch is None:
            raise ApiError(404, f"Batch {batch_id} not found.", "unknown_batch")
        return batch.institution, batch
    institution = db.scalar(select(Institution).order_by(Institution.id))
    batch = db.scalar(select(Batch).order_by(Batch.id))
    if institution is None or batch is None:
        institution, batch, _ = seed.seed_base(db)
    return institution, batch


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


def build_cohort(
    db: Session,
    *,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: str | None = None,
    topic: str | None = None,
) -> CohortOut:
    institution, batch = _context(db, batch_id)
    query = select(StudentSubmission).options(
        selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric)
    )
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    if rubric_id is not None:
        query = query.where(StudentSubmission.rubric_id == rubric_id)
    all_subs = db.scalars(query).all()

    topic = (topic or "").strip() or None
    if urgency or topic:
        subs = []
        for s in all_subs:
            if s.status != SubmissionStatus.COMPLETED:
                subs.append(s)
                continue
            r = s.result
            if r is None or not r.total_marks or r.total_marks <= 0:
                continue
            if urgency and analytics.result_urgency(r)[0] != urgency:
                continue
            if topic and not _matches_topic(r, topic):
                continue
            subs.append(s)
    else:
        subs = list(all_subs)

    statuses = Counter(s.status for s in subs)
    completed_subs = [
        s for s in subs
        if s.status == SubmissionStatus.COMPLETED and s.result is not None
        and s.result.total_marks and s.result.total_marks > 0
    ]
    results = [s.result for s in completed_subs]

    # Different rubric totals are compared by percentage; report on the most common scale.
    if results:
        total_marks = Counter(r.total_marks for r in results).most_common(1)[0][0]
    else:
        scoped = db.get(Rubric, rubric_id) if rubric_id is not None else None
        default = scoped or seed.get_default_rubric(db)
        total_marks = default.total_marks if default else 0.0
    percentages = [max(0.0, min(100.0, r.total_score / r.total_marks * 100)) for r in results]
    average_score = round(fmean(percentages) / 100 * total_marks, 2) if percentages else None
    average_mastery = round(fmean(r.overall_mastery for r in results), 1) if results else None

    distribution = [0] * len(DISTRIBUTION_LABELS)
    for pct in percentages:
        distribution[min(int(pct // 20), len(DISTRIBUTION_LABELS) - 1)] += 1

    # Topic averages only include the assessments that cover the topic.
    topics: dict[str, dict[str, Any]] = {}
    for r in results:
        for tm in r.topic_mastery or []:
            name = tm.get("topic")
            if not name:
                continue
            agg = topics.setdefault(
                name, {"subject": tm.get("subject", ""), "mastery": [], "weightage": [], "effort": []}
            )
            agg["mastery"].append(float(tm.get("mastery", 0)))
            agg["weightage"].append(float(tm.get("weightage", 0)))
            agg["effort"].append(float(tm.get("effort_hours", 0)))

    # Cohort ROI: per topic, average mastery/weightage/effort, then the same BRD formula.
    mastered = float(getattr(insights, "MASTERED_THRESHOLD", 100.0))
    topic_mastery: list[TopicAverage] = []
    priorities: list[PriorityOut] = []
    for name, agg in topics.items():
        mastery = round(fmean(agg["mastery"]), 1)
        topic_mastery.append(TopicAverage(topic=name, mastery=mastery))
        weightage, effort = round(fmean(agg["weightage"]), 4), round(fmean(agg["effort"]), 2)
        gain = round(100.0 - mastery, 1)
        if mastery >= mastered or gain <= 0 or effort <= 0:
            continue  # mastered topics are excluded
        assessments = len(agg["mastery"])
        roi = round(float(insights.calculate_roi(weightage, gain, effort)), 2)
        priorities.append(
            PriorityOut(
                topic=name,
                subject=agg["subject"],
                roi=roi,
                weightage=weightage,
                gain_potential=gain,
                effort_hours=effort,
                mastery=mastery,
                rationale=(
                    f"Cohort mastery averages {mastery:g}% across {assessments} "
                    f"assessment{'s' if assessments != 1 else ''}. At {weightage * 100:.4g}% of the exam weight "
                    f"({agg['subject']}), closing the {gain:g}-point gap in about {effort:g} study "
                    f"hour{'s' if effort != 1 else ''} gives an ROI of {roi:.2f}."
                ),
            )
        )
    priorities.sort(key=lambda p: (-p.roi, -p.gain_potential, p.topic))

    # Rubric versions among the completed set (mixing tests is compared by percentage).
    rubric_ids = sorted({s.rubric_id for s in completed_subs})
    rubrics: dict[int, Rubric] = {}
    for rid in rubric_ids:
        rubric = db.get(Rubric, rid)
        if rubric is not None:
            rubrics[rid] = rubric
    released = sum(1 for r in results if (r.release_status or "PROVISIONAL") == "RELEASED")

    def names(*wanted: str) -> list[str]:
        return [s.student_name for s in subs if s.status in wanted]

    demo_count = sum(1 for s in subs if s.is_demo)
    extras = analytics.cohort_extras(pairs=[(s, s.result) for s in completed_subs], rubrics=rubrics, batch=batch)
    operations = provenance.cohort_operations(db, subs=list(subs))
    # Wave 2: guarded - a pattern bug never breaks the cohort.
    cohort_patterns = result_view.cohort_patterns(db, pairs=[(s, s.result) for s in completed_subs], rubrics=rubrics)
    return CohortOut(
        institution=result_view.institution_out(institution),
        batch=result_view.batch_out(batch),
        total_submissions=len(subs),
        completed=statuses[SubmissionStatus.COMPLETED],
        processing=statuses[SubmissionStatus.PENDING] + statuses[SubmissionStatus.PROCESSING],
        human_review=statuses[SubmissionStatus.HUMAN_REVIEW_REQUIRED],
        failed=statuses[SubmissionStatus.FAILED],
        average_score=average_score,
        average_mastery=average_mastery,
        total_marks=total_marks,
        topic_mastery=topic_mastery,
        score_distribution=[
            DistributionBucket(label=label, count=count) for label, count in zip(DISTRIBUTION_LABELS, distribution)
        ],
        top_priorities=priorities[:5],
        is_demo=demo_count > 0,
        demo_count=demo_count,
        real_count=len(subs) - demo_count,
        filters={"batch_id": batch_id, "rubric_id": rubric_id, "urgency": urgency, "topic": topic},
        rubric_versions=[result_view.rubric_ref(rubrics[rid]) for rid in rubric_ids if rid in rubrics],
        mixed_rubrics=len(rubrics) > 1,
        release_counts={"provisional": len(results) - released, "released": released},
        excluded={
            "review": names(SubmissionStatus.HUMAN_REVIEW_REQUIRED),
            "failed": names(SubmissionStatus.FAILED),
            "processing": names(SubmissionStatus.PENDING, SubmissionStatus.PROCESSING),
        },
        operations=operations,
        **extras,
        patterns=cohort_patterns,
    )
