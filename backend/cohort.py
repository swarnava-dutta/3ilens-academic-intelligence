"""Cohort dashboard aggregation (GET /api/cohort and the cohort PDF).

The no-filter numbers are exactly the v1 get_cohort numbers (tests pin them), except
urgency_counts: it counts students (each one's latest sheet in the view), like the owner and
students pages, never a student twice.
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
import cohort_insights
import insights
import marking
import provenance
import result_view
import seed
import sittings
from database import Batch, EvaluationResult, Institution, Rubric, StudentSubmission, SubmissionStatus
from errors import ApiError
from schemas import CohortOut, DistributionBucket, PriorityOut, TopicAverage

DISTRIBUTION_LABELS = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"]
# The cohort page's bins (per_student=true): [0,20) [20,40) [40,60) [60,80) [80,100] of the shown
# 1-dp percentage, so a 59.96% shown as 60.0% is counted in 60-79%.
PAGE_DISTRIBUTION_LABELS = ["<20%", "20–39%", "40–59%", "60–79%", "80%+"]
# CohortOut fields only filled with per_student=true (the cohort page); left out of the v1 payload.
PAGE_FIELDS = {
    "scope", "sittings", "previous", "headline", "students_view", "attempt", "chapters", "subjects",
    "item_analysis", "paired_change", "batch_comparison", "summary", "reading", "interventions_logged",
    "data_version",
}


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


def matches_topic(result: EvaluationResult, topic: str) -> bool:
    """The topic filter: mastery below analytics.TOPIC_GAP_MASTERY, or the topic is in the stored top 5."""
    wanted = topic.strip().casefold()
    for tm in result.topic_mastery or []:
        if isinstance(tm, dict) and str(tm.get("topic", "")).casefold() == wanted:
            try:
                if float(tm.get("mastery", 100)) < analytics.TOPIC_GAP_MASTERY:
                    return True
            except (TypeError, ValueError):
                pass
    return any(
        isinstance(p, dict) and str(p.get("topic", "")).casefold() == wanted
        for p in (result.roi_recommendations or [])[:5]
    )


def _sitting_out(sitting: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in sitting.items() if k != "subs"}


def list_sittings(db: Session, *, batch_id: int | None = None) -> list[dict[str, Any]]:
    """Every (batch, test) sitting in scope, newest first (GET /api/cohort/sittings)."""
    if batch_id is not None and db.get(Batch, batch_id) is None:
        raise ApiError(404, f"Batch {batch_id} not found.", "unknown_batch")
    query = select(StudentSubmission).options(selectinload(StudentSubmission.result))
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    return [_sitting_out(s) for s in sittings.class_sittings(db, db.scalars(query).all())]


def _page_fields(
    db: Session,
    *,
    institution: Institution,
    batch_id: int | None,
    test_id: int | None,
    families: sittings.Families,
    batch_subs: list[StudentSubmission],
    scope_subs: list[StudentSubmission],
    students: list[StudentSubmission],
    urgency_counts: dict[str, int],
) -> dict[str, Any]:
    """The cohort page fields over S = `students` (one latest sheet per student in scope)."""
    mode = "sitting" if test_id is not None else "all"
    root = families.root(test_id) if test_id is not None else None
    all_sittings = sittings.class_sittings(db, batch_subs, families=families)
    current = next(
        (s for s in all_sittings if root is not None and s["batch_id"] == batch_id and s["test_id"] == root), None
    )
    previous = sittings.previous_class_sitting(all_sittings, current) if current and current["is_class"] else None
    reason = sittings.not_comparable_reason(previous["subs"][0], current["subs"][0], families) if previous else None
    # Class-level changes (chapters, subjects) only against a comparable previous sitting.
    prev_subs = previous["subs"] if previous and reason is None else []
    # Each student against the sheet they sat just before (any batch or test), in every view.
    student_pairs = sittings.pairs(students, sittings.history(db, students))

    batch = db.get(Batch, batch_id) if batch_id is not None else None
    head = cohort_insights.headline(students, single_test=mode == "sitting")
    rows = cohort_insights.student_rows(students, student_pairs, families)
    attempt = cohort_insights.attempt_summary(students)
    items = cohort_insights.item_analysis(students) if mode == "sitting" else None
    chapter_rows = cohort_insights.chapters(
        students, prev_subs, items, family_of=families.root, exam=(batch.exam if batch is not None else None) or "NEET"
    )
    paired = cohort_insights.paired_change(student_pairs, families)
    previous_out = None
    head["delta_pts"] = None
    if previous:
        before = cohort_insights.attempt_summary(previous["subs"])
        comparable, note = cohort_insights.comparison(len(students), paired, reason)
        previous_out = {
            **{k: previous[k] for k in (
                "batch_id", "test_id", "test_name", "short_name", "date", "students", "average_pct", "median_pct",
                "urgency_counts",
            )},
            "negative_marks_total": before["negative_marks_total"] if before else None,
            "negative_per_student": before["negative_per_student"] if before else None,
            "attempt_rate": before["attempt_rate"] if before else None,
            "accuracy_attempted": before["accuracy_attempted"] if before else None,
            "blanks_per_student": before["blanks_per_student"] if before else None,
            "blank_rate": before["blank_rate"] if before else None,
            "comparable": comparable,
            "note": note,
            "newly_at_risk": sum(1 for r in rows if r["newly_at_risk"]),
        }
        if comparable and head["average_pct"] is not None and previous["average_pct"] is not None:
            head["delta_pts"] = sittings.change_pts(previous["average_pct"], head["average_pct"])

    comparison: list[dict[str, Any]] = []
    if root is not None:
        versions = families.versions(root)
        across = db.scalars(
            select(StudentSubmission).options(selectinload(StudentSubmission.result))
            .where(StudentSubmission.rubric_id.in_(versions))
        ).all()
        comparison = cohort_insights.batch_comparison(
            sittings.class_sittings(db, across, families=families), batch_id
        )

    completed_scope = [s for s in scope_subs if result_view.is_completed(s)]
    used = Counter(s.rubric_id for s in completed_scope)
    name = families.name(root) if root is not None else None
    scope = {
        "mode": mode,
        "batch_id": batch_id,
        "batch_name": batch.name if batch is not None else None,
        "test_id": root,
        "test_name": name,
        "short_name": sittings.short_test_name(name) if name else None,
        "rubric_ids": sorted(used),
        "latest_rubric_id": families.latest(root) if root is not None else None,
        "total_marks": families.total_marks(root) if root is not None else None,
        "date": max((sittings.sat_at(s) for s in students), default=None),
        "students": len(students),
        "sheets": len(completed_scope),
        # Every sheet in scope (any status, before the one-per-student rule) and how many of them
        # are synthetic demo sheets: the provenance chip and About this data use these.
        "tests": len({families.root(s.rubric_id) for s in students}),  # different tests among S
        "sheets_in_scope": len(scope_subs),
        "demo_sheets": sum(1 for s in scope_subs if s.is_demo),
        # Older graded sheets of a student in scope that the latest one replaced, by name.
        "superseded": sorted(
            {s.student_name for s in completed_scope if s.id not in {x.id for x in students}}, key=str.casefold
        ),
        "key_versions": [
            {"rubric_id": rid, "version": families.version_label(rid), "sheets": used[rid],
             "latest": rid == families.latest(root)}
            for rid in families.versions(root) if used.get(rid)
        ] if root is not None else [],
        "is_class": len(students) >= sittings.MIN_CLASS_STUDENTS,
    }
    logged = cohort_insights.interventions_logged(
        db, batch_id=batch_id, institution_id=institution.id if batch_id is None else None
    )
    return {
        "scope": scope,
        "sittings": [_sitting_out(s) for s in all_sittings],
        "previous": previous_out,
        "headline": head,
        "students_view": rows,
        "attempt": attempt,
        "chapters": chapter_rows,
        "subjects": cohort_insights.subjects(students, prev_subs),
        "item_analysis": items,
        "paired_change": paired,
        "batch_comparison": comparison,
        "summary": cohort_insights.summary(
            mode=mode, head=head, students=rows, counts=urgency_counts, previous=previous_out, paired=paired,
            chapter_rows=chapter_rows, items=items,
        ),
        "reading": cohort_insights.reading(db, scope_subs=scope_subs, students=students),
        "interventions_logged": logged,
        "data_version": cohort_insights.data_version(scope_subs, (logged, batch_id, test_id)),
    }


def build_cohort(
    db: Session,
    *,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    urgency: str | None = None,
    topic: str | None = None,
    test_id: int | None = None,
    per_student: bool = False,
) -> CohortOut:
    """test_id: any version id of a test; every version of its answer-key family is included.
    per_student: one row per student - their latest completed sheet in scope - BEFORE any figure
    is computed (the cohort page always asks for this; the default keeps the v1 numbers)."""
    institution, batch = _context(db, batch_id)
    families = sittings.Families(db) if (test_id is not None or per_student) else None
    query = select(StudentSubmission).options(
        selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric)
    )
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    batch_subs = list(db.scalars(query).all())
    all_subs = [s for s in batch_subs if rubric_id is None or s.rubric_id == rubric_id]
    if test_id is not None:
        assert families is not None
        if not families.known(test_id):
            raise ApiError(404, f"Test {test_id} not found.", "unknown_test")
        versions = set(families.versions(test_id))
        all_subs = [s for s in all_subs if s.rubric_id in versions]
    scoped_subs = list(all_subs)  # every sheet in scope, before the per-student dedupe
    if per_student:
        # The student unit: only each student's newest completed sheet in scope counts.
        keep = {s.id for s in sittings.latest_per_student(all_subs)}
        all_subs = [s for s in all_subs if not result_view.is_completed(s) or s.id in keep]

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
            if topic and not matches_topic(r, topic):
                continue
            subs.append(s)
    else:
        subs = list(all_subs)

    statuses = Counter(s.status for s in subs)
    completed_subs = [s for s in subs if sittings.is_completed(s)]
    results = [s.result for s in completed_subs]

    # Different rubric totals are compared by percentage; report on the most common scale.
    if results:
        total_marks = Counter(r.total_marks for r in results).most_common(1)[0][0]
    else:
        # No completed result yet: the scoped test's total, else 0 (there is no default rubric).
        scoped = db.get(Rubric, rubric_id) if rubric_id is not None else None
        total_marks = scoped.total_marks if scoped else 0.0
    percentages = [max(0.0, min(100.0, r.total_score / r.total_marks * 100)) for r in results]
    average_score = round(fmean(percentages) / 100 * total_marks, 2) if percentages else None
    average_mastery = round(fmean(r.overall_mastery for r in results), 1) if results else None

    distribution = [0] * len(DISTRIBUTION_LABELS)
    # The page bins the shown 1-dp percentage (as every row, tile and urgency does); v1 is unchanged.
    for pct in ([analytics.percentage(r) for r in results] if per_student else percentages):
        distribution[min(int(pct // 20), len(DISTRIBUTION_LABELS) - 1)] += 1
    labels = PAGE_DISTRIBUTION_LABELS if per_student else DISTRIBUTION_LABELS

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
                    f"Cohort mastery averages {mastery:g}% across {marking.plural(assessments, 'assessment')}. "
                    f"At {weightage * 100:.4g}% of the exam weight "
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
    pairs = [(s, s.result) for s in completed_subs]
    extras = analytics.cohort_extras(pairs=pairs, rubrics=rubrics, batch=batch)
    # Students, not sheets: each student's latest sheet in the view (as on the owner and students pages).
    extras["urgency_counts"] = sittings.urgency_counts(sittings.latest_per_student(completed_subs))
    operations = provenance.cohort_operations(db, subs=list(subs))
    # Guarded: a pattern bug never breaks the cohort.
    cohort_patterns = result_view.cohort_patterns(db, pairs=pairs, rubrics=rubrics)
    page: dict[str, Any] = {}
    if per_student:
        assert families is not None
        page = _page_fields(
            db, institution=institution, batch_id=batch_id, test_id=test_id, families=families,
            batch_subs=batch_subs, scope_subs=scoped_subs, students=completed_subs, urgency_counts=extras["urgency_counts"],
        )
        # Study-plan priorities only from chapters that can carry a class figure (2+ questions and
        # 3+ students, or ranked for a re-teach), never a whole-subject row; filtered BEFORE the top 5.
        usable = {
            c["topic"] for c in page["chapters"]
            if not c["subject_level"] and (not c["thin"] or c["reteach_rank"] is not None)
        }
        priorities = [p for p in priorities if p.topic in usable]
        # Written-answer gaps per question (denominator = sheets with that question); MCQ blanks
        # and 'Not attempted' are counted by the attempt figures instead.
        extras["common_errors"] = cohort_insights.written_errors(completed_subs)
        extras["confusion_clusters"] = cohort_insights.confusion_denominators(
            completed_subs, extras["confusion_clusters"], family_of=families.root
        )
        # Class actions in the page's re-teach order, each with its own denominator.
        extras["interventions"] = cohort_insights.class_interventions(
            page["chapters"], extras["common_errors"], extras["confusion_clusters"]
        )
        # The at-risk list names the same weakest chapter as the page (not the ROI top gap).
        weakest = {r["submission_id"]: r["weakest_topic"] for r in page["students_view"]}
        for row in extras["at_risk"]:
            row["top_gap"] = weakest.get(row["submission_id"], row["top_gap"])
        # Competition ranks (equal % share a rank), as on the page.
        ranks = {r["submission_id"]: r["rank"] for r in page["students_view"]}
        for row in extras["ranking"]:
            row["rank"] = ranks.get(row["submission_id"], row["rank"])
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
            DistributionBucket(label=label, count=count) for label, count in zip(labels, distribution)
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
        **page,
    )
