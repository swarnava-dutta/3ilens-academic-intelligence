"""Students roster (GET /api/students/roster): one row per STUDENT, not per answer sheet.

Deterministic, no AI. Definitions (the /students page reads every number from here):

* Student = (student_ref, is_demo): report_meta.ref_of (the stored ref, else the name-derived
  one). A real student and a synthetic demo namesake are never merged (same rule as history).
* Graded = COMPLETED with a usable result (sittings.is_completed, as on the cohort and owner
  pages), an oral answer too. Paper = a graded sheet whose input_kind is not "voice": only papers
  are a previous sheet, the spark line or papers_count.
* Scope = batch_id + rubric_id + demo. summary and topics always describe the whole scope;
  the urgency and topic params narrow the rows only.
* Order, rounding and the up / down threshold are sittings.py's (the cohort and owner pages use
  the same): sheets in sittings.order (upload time, then id; a re-grade never moves a sheet).
* latest = the student's newest graded sheet in scope.
  previous = the paper just before latest, any batch or test (same is_demo): sittings.pairs.
  delta = sittings.change_pts(previous pct, latest pct) (exact on the shown 1-dp percentages).
  The pair is *comparable* by sittings.comparable (the owner and cohort pages' rule): the same
  test (a retake counts), or both full papers (10+ questions) over the same subjects. Only a
  comparable pair gets a trend (sittings.movement: up 5+ improving, down 5+ slipping, else
  steady); otherwise trend is null and the delta is context only (never counted as improving /
  slipping, never in a priority reason).
* newer = in a narrowed scope (batch / test), the student's newest graded paper outside it when it
  is newer than latest, so the page can say a newer result exists.
* waiting = the student's sheets in scope that are held, failed or still being marked (older ones
  too); summary.waiting_students counts students with at least one, and their sheets add up to
  held + failed + processing.
* urgency = analytics.result_urgency(latest) with its reasons; weak topic < TOPIC_GAP_MASTERY (60),
  very weak < LOW_TOPIC (40).
* action_since_latest = intervention records of the student (same institution and is_demo)
  applied at or after latest.created_at (its upload time).
* Exam technique (negatively marked MCQs only) follows the report's own attempts insight
  (analytics.key_insights, id "attempts"): verdict "guessing" = wrong answers are costing marks,
  "skipping" = blanks are holding the score back, "ok" = the attempt strategy is working. The
  per-topic penalty risk is listed as risky_topics (topics at medium / high risk), never as a
  paper-level label.
* A topic row whose name is a whole subject (a paper with no chapter tags) is subject_level.
* Priority tier: 1 at risk with no action since latest; 2 slipping; 3 needs attention with 2+
  very weak topics and no action since latest; 4 at risk with an action logged since latest.
  Order: tier, pct, name.
"""
from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable
from datetime import datetime
from statistics import fmean
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

import analytics
import marking
import outcomes
import patterns
import report_meta
import result_view
import sittings
from database import (
    INPUT_VOICE,
    InterventionRecord,
    ReleaseStatus,
    StudentSubmission,
    SubmissionStatus,
    utcnow,
)

TREND_PTS = sittings.BIG_CHANGE
TREND = {"up": "improving", "down": "slipping", "steady": "steady"}  # sittings.movement -> trend
SPARK_POINTS = 6
SMALL_TEST_QUESTIONS = sittings.FULL_PAPER_QUESTIONS
MAX_NUDGES = 3
FOCUS_LIMIT = 3
WEAK_MASTERY = analytics.TOPIC_GAP_MASTERY
VERY_WEAK_MASTERY = analytics.LOW_TOPIC
RISKY_TOPIC_LEVELS = ("medium", "high")
SUBJECT_NAMES = {"physics", "chemistry", "biology", "botany", "zoology"}  # same set as owner / cohort
PENDING_STATUSES = (
    SubmissionStatus.HUMAN_REVIEW_REQUIRED,
    SubmissionStatus.FAILED,
    SubmissionStatus.PROCESSING,
    SubmissionStatus.PENDING,
)

StudentKey = tuple[str, bool]


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _norm(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


def _f1(value: float) -> str:
    """One decimal, always ('10.0'): the page shows every point and delta this way."""
    return f"{sittings.r1(value):.1f}"


def _g(value: float) -> str:
    rounded = sittings.r1(value)
    return f"{rounded:g}"


def is_voice(sub: StudentSubmission) -> bool:
    return (sub.input_kind or "document") == INPUT_VOICE


def student_key(sub: StudentSubmission) -> StudentKey:
    return report_meta.ref_of(sub), bool(sub.is_demo)


_order = sittings.order  # (upload time, id)


def _graded_paper(sub: StudentSubmission) -> bool:
    """A COMPLETED, usable, non-voice sheet (what previous / spark / papers_count are built from)."""
    return not is_voice(sub) and result_view.is_completed(sub)


def _day(dt: datetime | None) -> str:
    """'24 Nov' in India Standard Time."""
    local = report_meta.to_ist(dt)
    return f"{local.day} {local:%b}"


def short_test_name(name: str) -> str:
    """sittings.short_test_name: 'NEET MCQ Practice - Mock 09 (sample)' -> 'Mock 09';
    'Biology - Genetics' stays whole (its last part names a chapter, not the test)."""
    return sittings.short_test_name(str(name or ""))


def _test_name(sub: StudentSubmission) -> str:
    return sub.rubric.name if sub.rubric is not None else "Assessment"


def subject_level(topic: str, subject: str) -> bool:
    """A topic row that is really a whole subject ('Physics' on a paper with no chapter tags)."""
    name = _norm(topic)
    return name in SUBJECT_NAMES or (bool(subject) and name == _norm(subject))


def latest_paper_per_student(subs: Iterable[StudentSubmission]) -> dict[StudentKey, StudentSubmission]:
    """The newest COMPLETED non-voice sheet per (student_ref, is_demo), by sittings.order.
    A re-graded older sheet or an oral sample never becomes 'latest'."""
    latest: dict[StudentKey, StudentSubmission] = {}
    for sub in subs:
        if not _graded_paper(sub):
            continue
        key = student_key(sub)
        current = latest.get(key)
        if current is None or _order(sub) > _order(current):
            latest[key] = sub
    return latest


def previous_paper(db: Session, sub: StudentSubmission) -> StudentSubmission | None:
    """The student's COMPLETED non-voice sheet immediately before `sub` by sittings.order, in
    any batch or test (same is_demo)."""
    ref = report_meta.ref_of(sub)
    rows = db.scalars(
        select(StudentSubmission)
        .options(selectinload(StudentSubmission.result))
        .where(
            StudentSubmission.status == SubmissionStatus.COMPLETED,
            StudentSubmission.is_demo.is_(bool(sub.is_demo)),
            or_(StudentSubmission.student_ref == ref, StudentSubmission.student_ref.is_(None)),
        )
    ).all()
    earlier = [s for s in rows if report_meta.ref_of(s) == ref and _graded_paper(s) and _order(s) < _order(sub)]
    return max(earlier, key=_order, default=None)


# --------------------------------------------------------------------------- #
# Per-paper pieces
# --------------------------------------------------------------------------- #
def _topics(result: Any, rubric: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(question items, topic items) exactly as the report builds them."""
    questions = analytics._question_items(result)
    return questions, analytics._topic_items(result, questions, rubric)


def _topic_rows(topic_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """[{topic, subject, mastery, n}], weakest first. Unreadable mastery values are skipped, as in
    analytics.classify_urgency, so weak counts and the urgency rule agree."""
    rows = []
    for item in topic_items:
        if not item.get("topic"):
            continue
        try:
            mastery = float(item.get("mastery"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(mastery):
            continue
        topic, subject = str(item["topic"]), str(item.get("subject") or "")
        rows.append({
            "topic": topic,
            "subject": subject,
            "mastery": max(0.0, min(100.0, mastery)),
            "n": int(_num(item.get("n"))),
            "subject_level": subject_level(topic, subject),
        })
    rows.sort(key=lambda t: (t["mastery"], t["topic"].casefold()))
    return rows


def _subjects(topic_items: list[dict[str, Any]], questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """SubjectScore dicts from the same rollup the report's subject_rollup uses."""
    return [
        {"subject": s["subject"], "score": s["score"], "max_marks": s["max_marks"], "pct": s["pct"]}
        for s in analytics._subject_rollup(topic_items, questions)
    ]


def attempts_insight(sub: StudentSubmission) -> dict[str, Any] | None:
    """The report's own "attempts" key insight for this sheet (analytics.key_insights over the same
    annotated questions the report uses), or None when it cannot be built."""
    result, rubric = sub.result, sub.rubric
    content = rubric.content if rubric is not None and isinstance(rubric.content, dict) else None
    try:
        questions = marking.annotate_questions(analytics._question_items(result), content)
        topics = analytics._topic_items(result, questions, rubric)
        insights = analytics.key_insights(
            questions, topics, rubric, total_score=_num(result.total_score), total_marks=_num(result.total_marks)
        )
    except Exception:  # noqa: BLE001 - the report guards this block the same way (shows no insight)
        return None
    return next((i for i in insights if isinstance(i, dict) and i.get("id") == "attempts"), None)


def _verdict(insight: dict[str, Any] | None) -> tuple[str, str]:
    """(verdict, headline) from the attempts insight: guessing / skipping / ok."""
    if not insight:
        return "ok", ""
    headline = str(insight.get("headline") or "")
    if insight.get("tone") != "warn":
        return "ok", headline
    evidence = insight.get("evidence") if isinstance(insight.get("evidence"), dict) else {}
    focus = evidence.get("filter")
    if focus == "wrong":
        return "guessing", headline
    if focus == "blank":
        return "skipping", headline
    return "ok", headline


def negative_marking_brief(sub: StudentSubmission) -> dict[str, Any] | None:
    """NegativeMarkingBrief from patterns.negative_marking_profile (the function the report uses).
    verdict / headline are the report's attempts insight, so the flag never contradicts the report."""
    result, rubric = sub.result, sub.rubric
    content = rubric.content if rubric is not None and isinstance(rubric.content, dict) else {}
    profile = patterns.negative_marking_profile(patterns.question_items(result, rubric), content)
    if profile is None:
        return None
    items = int(profile["attempted"]) + int(profile["blank"])
    verdict, headline = _verdict(attempts_insight(sub))
    risky = [str(t["topic"]) for t in profile.get("topics") or [] if t.get("risk") in RISKY_TOPIC_LEVELS]
    return {
        "scheme": profile["scheme"],
        "break_even": profile["break_even"],
        "items": items,
        "attempted": profile["attempted"],
        "correct": profile["correct"],
        "wrong": profile["wrong"],
        "blank": profile["blank"],
        "accuracy": profile["accuracy"],
        "marks_lost": profile["marks_lost"],
        "risk": profile["risk"],
        "under_attempting": verdict == "skipping",
        "recommendation": profile["recommendation"],
        "verdict": verdict,
        "headline": headline,
        "risky_topics": risky,
        "_topics": profile.get("topics") or [],
    }


_question_count = sittings.question_count


def _brief_paper(sub: StudentSubmission) -> dict[str, Any]:
    """RosterNewer: a graded paper named in passing (a newer paper outside the scope)."""
    name = _test_name(sub)
    return {
        "submission_id": sub.id,
        "test_name": name,
        "short_name": short_test_name(name),
        "date": sub.created_at,
        "pct": analytics.percentage(sub.result),
    }


def _paper(sub: StudentSubmission) -> dict[str, Any]:
    result = sub.result
    assert result is not None
    urgency, reasons, pct = analytics.result_urgency(result)
    name = _test_name(sub)
    return {
        "submission_id": sub.id,
        "test_id": sub.rubric_id,
        "test_name": name,
        "short_name": short_test_name(name),
        "test_version": sub.rubric.version if sub.rubric is not None else "",
        "date": sub.created_at,
        "score": float(result.total_score),
        "total_marks": float(result.total_marks),
        "pct": pct,
        "questions": _question_count(sub),
        "urgency": urgency,
        "urgency_reasons": reasons,
        "release_status": result.release_status or ReleaseStatus.PROVISIONAL,
    }


# --------------------------------------------------------------------------- #
# Interventions
# --------------------------------------------------------------------------- #
class _FollowUps:
    """outcomes.follow_up per record, computed once."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.cache: dict[int, tuple[str, dict[str, Any] | None]] = {}

    def __call__(self, rec: InterventionRecord) -> tuple[str, dict[str, Any] | None]:
        if rec.id not in self.cache:
            self.cache[rec.id] = outcomes.follow_up(self.db, rec)
        return self.cache[rec.id]


def _records_by_student(db: Session, refs: set[str]) -> dict[tuple[str, bool, int], list[InterventionRecord]]:
    """Intervention records of these refs keyed by (student_ref, is_demo, institution_id),
    newest applied first."""
    if not refs:
        return {}
    rows = db.scalars(
        select(InterventionRecord)
        .where(InterventionRecord.student_ref.in_(sorted(refs)))
        .order_by(InterventionRecord.applied_at.desc(), InterventionRecord.id.desc())
    ).all()
    out: dict[tuple[str, bool, int], list[InterventionRecord]] = {}
    for rec in rows:
        out.setdefault((rec.student_ref, bool(rec.is_demo), rec.institution_id), []).append(rec)
    return out


def _action_out(rec: InterventionRecord, followed: tuple[str, dict[str, Any] | None]) -> dict[str, Any]:
    status, outcome = followed
    return {
        "id": rec.id,
        "topic": rec.topic,
        "kind": rec.kind,
        "applied_at": rec.applied_at,
        "applied_by": rec.applied_by,
        "outcome_status": status,
        "mastery_change": outcome["mastery_change"] if outcome else None,
    }


# --------------------------------------------------------------------------- #
# Rows
# --------------------------------------------------------------------------- #
def _priority(row: dict[str, Any], latest_sub: StudentSubmission | None) -> dict[str, Any]:
    latest = row["latest"]
    if latest is None:
        return {"tier": None, "reason": ""}
    urgency = latest["urgency"]
    since = row["actions"]["since_latest"]
    small = f" · {latest['questions']}-Q test" if latest["questions"] < SMALL_TEST_QUESTIONS else ""
    paper = f"{latest['short_name']} · {_day(latest['date'])}{small}"
    delta = row["delta_pct"]
    move = ""
    if row["trend"] == "improving":
        move = f" · up {_f1(delta)} pts"
    elif row["trend"] == "slipping":
        move = f" · down {_f1(abs(delta))} pts"
    if urgency == "at_risk" and since == 0:
        return {"tier": 1, "reason": f"{paper} · no action yet{move}"}
    if row["trend"] == "slipping":
        previous = row["previous"]
        return {"tier": 2, "reason": f"Dropped {_f1(abs(delta))} pts since {previous['short_name']} · {paper}"}
    if urgency == "needs_attention" and row["very_weak_count"] >= 2 and since == 0:
        return {
            "tier": 3,
            "reason": f"{row['very_weak_count']} topics below {_g(VERY_WEAK_MASTERY)}% · {paper} · no action yet",
        }
    if urgency == "at_risk":
        last = row["actions"]["last"]
        logged = f"Action on {last['topic']} logged {_day(last['applied_at'])}" if last else "Action logged"
        return {"tier": 4, "reason": f"{logged} · {paper}{move}"}
    return {"tier": None, "reason": ""}


def _row(
    key: StudentKey,
    scope_subs: list[StudentSubmission],
    history: list[StudentSubmission],
    records: list[InterventionRecord],
    follow: _FollowUps,
    batches: dict[int, Any],
    families: sittings.Families,
    narrowed: bool,
) -> dict[str, Any]:
    """One RosterRow (with private _-prefixed helpers removed by build_roster)."""
    ref, demo = key
    scope_subs = sorted(scope_subs, key=_order)
    graded = [s for s in scope_subs if result_view.is_completed(s)]
    latest_sub = graded[-1] if graded else None
    anchor = latest_sub or scope_subs[-1]
    if anchor.batch_id not in batches:
        batches[anchor.batch_id] = result_view.batch_out(anchor.batch)

    # Newer sheets that are not graded yet (held, failed, processing): the newest one.
    waiting = [
        s for s in scope_subs
        if not result_view.is_completed(s) and (latest_sub is None or _order(s) > _order(latest_sub))
        and (latest_sub is None or not is_voice(s))
    ]
    pending_sub = waiting[-1] if waiting else None
    # Every sheet in scope that is held, failed or still being marked (older ones too), newest first.
    blocked = sorted((s for s in scope_subs if s.status in PENDING_STATUSES), key=_order, reverse=True)

    row: dict[str, Any] = {
        "student_ref": ref,
        "student_name": anchor.student_name,
        "is_demo": demo,
        "batch": batches[anchor.batch_id],
        "latest": None,
        "pending": (
            {
                "submission_id": pending_sub.id,
                "status": pending_sub.status,
                "review_reason": result_view._review_reason(pending_sub),
                "date": pending_sub.created_at,
            }
            if pending_sub is not None else None
        ),
        "waiting": [
            {
                "submission_id": s.id,
                "status": s.status,
                "review_reason": result_view._review_reason(s),
                "date": s.created_at,
            }
            for s in blocked
        ],
        "newer": None,
        "previous": None,
        "delta_pct": None,
        "trend": None,
        "spark": [],
        "papers_count": len(history),
        "subjects": [],
        "topics": [],
        "weak_count": 0,
        "very_weak_count": 0,
        "negative_marking": None,
        "nudges": [],
        "focus": [],
        "actions": {"count": len(records), "since_latest": 0, "last": None},
        "priority": {"tier": None, "reason": ""},
        "_latest_sub": latest_sub,
        "_records": records,
    }
    if records:
        row["actions"]["last"] = _action_out(records[0], follow(records[0]))
    if latest_sub is None:
        return row

    result = latest_sub.result
    assert result is not None
    latest = _paper(latest_sub)
    row["latest"] = latest

    # Trend: the paper just before latest (any test, same is_demo) and up to SPARK_POINTS papers.
    upto = [s for s in history if _order(s) < _order(latest_sub)] + [latest_sub]
    prev_sub = next((before for before, _after in sittings.pairs([latest_sub], history)), None)
    if prev_sub is not None:
        prev_pct = analytics.percentage(prev_sub.result)
        delta = sittings.change_pts(prev_pct, latest["pct"])
        same_kind = sittings.comparable(prev_sub, latest_sub, families)
        prev_name = _test_name(prev_sub)
        row["previous"] = {
            "submission_id": prev_sub.id,
            "test_name": prev_name,
            "short_name": short_test_name(prev_name),
            "date": prev_sub.created_at,
            "pct": prev_pct,
            "total_marks": float(prev_sub.result.total_marks),
            "questions": _question_count(prev_sub),
            "comparable": same_kind,
        }
        row["delta_pct"] = delta
        if same_kind:
            row["trend"] = TREND[sittings.movement(delta)]
    row["spark"] = [
        {
            "submission_id": s.id,
            "date": s.created_at,
            "pct": analytics.percentage(s.result),
            "test_name": _test_name(s),
            "short_name": short_test_name(_test_name(s)),
        }
        for s in upto[-SPARK_POINTS:]
    ]
    newest = history[-1] if history else None
    if narrowed and newest is not None and _order(newest) > _order(latest_sub):
        row["newer"] = _brief_paper(newest)

    questions, topic_items = _topics(result, latest_sub.rubric)
    topics = _topic_rows(topic_items)
    row["topics"] = topics
    row["weak_count"] = sum(1 for t in topics if t["mastery"] < WEAK_MASTERY)
    row["very_weak_count"] = sum(1 for t in topics if t["mastery"] < VERY_WEAK_MASTERY)
    row["subjects"] = _subjects(topic_items, questions)
    brief = negative_marking_brief(latest_sub)
    row["_nm_topics"] = brief.pop("_topics") if brief else []
    row["negative_marking"] = brief
    row["nudges"] = analytics.nudges_for(result)[:MAX_NUDGES]
    row["focus"] = analytics.focus_items(
        result=result, rubric=latest_sub.rubric, batch=latest_sub.batch, limit=FOCUS_LIMIT
    )
    row["actions"]["since_latest"] = sum(1 for r in records if r.applied_at >= latest_sub.created_at)
    row["priority"] = _priority(row, latest_sub)
    return row


def _sort_key(row: dict[str, Any]) -> tuple:
    tier = row["priority"]["tier"]
    latest = row["latest"]
    return (
        latest is None,
        tier is None,
        tier or 0,
        latest["pct"] if latest else 0.0,
        row["student_name"].casefold(),
        row["student_ref"],
        row["is_demo"],
    )


# --------------------------------------------------------------------------- #
# Summary and topics
# --------------------------------------------------------------------------- #
def _summary(rows: list[dict[str, Any]], scope_subs: list[StudentSubmission]) -> dict[str, Any]:
    graded = [r for r in rows if r["latest"] is not None]
    counts = {level: 0 for level in analytics.URGENCY_LEVELS}
    for r in graded:
        counts[r["latest"]["urgency"]] += 1
    statuses = Counter(s.status for s in scope_subs)
    trends = Counter(r["trend"] for r in graded if r["trend"])
    profiled = [r for r in graded if r["negative_marking"] is not None]
    guessing = {(r["student_ref"], r["is_demo"]) for r in profiled if r["negative_marking"]["verdict"] == "guessing"}
    under = {(r["student_ref"], r["is_demo"]) for r in profiled if r["negative_marking"]["verdict"] == "skipping"}
    risky = sum(1 for r in profiled if r["negative_marking"]["risky_topics"])
    marks_lost = round(sum(_num(r["negative_marking"]["marks_lost"]) for r in profiled), 2)
    released = sum(1 for r in graded if r["latest"]["release_status"] == ReleaseStatus.RELEASED)
    demo_students = sum(1 for r in rows if r["is_demo"])
    return {
        "students": len(rows),
        "graded": len(graded),
        "sheets": len(scope_subs),
        "urgency_counts": counts,
        "held": statuses[SubmissionStatus.HUMAN_REVIEW_REQUIRED],
        "failed": statuses[SubmissionStatus.FAILED],
        "processing": statuses[SubmissionStatus.PENDING] + statuses[SubmissionStatus.PROCESSING],
        "ungraded": len(rows) - len(graded),
        "improving": trends["improving"],
        "slipping": trends["slipping"],
        "steady": trends["steady"],
        "with_trend": sum(trends.values()),
        "different_test": sum(1 for r in graded if r["previous"] is not None and not r["previous"]["comparable"]),
        "waiting_students": sum(1 for r in rows if r["waiting"]),
        "newer_outside": sum(1 for r in rows if r["newer"] is not None),
        "at_risk_without_action": sum(
            1 for r in graded if r["latest"]["urgency"] == "at_risk" and r["actions"]["since_latest"] == 0
        ),
        "flagged": sum(1 for r in rows if r["priority"]["tier"] is not None),
        "provisional_latest": len(graded) - released,
        "released_latest": released,
        "demo_students": demo_students,
        "real_students": len(rows) - demo_students,
        "negative_marking": {
            "profiled": len(profiled),
            "guessing_risk": len(guessing),
            "under_attempting": len(under),
            "flagged": len(guessing | under),
            "marks_lost_total": marks_lost,
            "marks_lost_per_paper": sittings.r1(marks_lost / len(profiled)) if profiled else 0.0,
            "risky_topic_students": risky,
        },
    }


def _topic_summary(rows: list[dict[str, Any]], follow: _FollowUps) -> list[dict[str, Any]]:
    """RosterTopic dicts over each graded student's latest paper, most students below 60% first."""
    topics: dict[str, dict[str, Any]] = {}

    def entry(name: str, subject: str) -> dict[str, Any]:
        key = _norm(name)
        if key not in topics:
            topics[key] = {
                "topic": name, "subject": subject, "masteries": [], "students_below": [], "marks_lost": 0.0,
                "actions_logged": 0, "actions_improved": 0, "subject_level": False,
            }
        elif not topics[key]["subject"] and subject:
            topics[key]["subject"] = subject
        return topics[key]

    for r in rows:
        if r["latest"] is None:
            continue
        for t in r["topics"]:
            e = entry(t["topic"], t["subject"])
            e["subject_level"] = e["subject_level"] or bool(t.get("subject_level"))
            e["masteries"].append(t["mastery"])
            if t["mastery"] < WEAK_MASTERY:
                e["students_below"].append({
                    "student_ref": r["student_ref"], "is_demo": r["is_demo"], "student_name": r["student_name"],
                    "mastery": t["mastery"],
                })
        for t in r.get("_nm_topics") or []:
            entry(str(t.get("topic") or "Unmapped"), "")["marks_lost"] += _num(t.get("marks_lost"))
    for r in rows:
        for rec in r["_records"]:
            key = _norm(rec.topic)
            if key in topics:
                topics[key]["actions_logged"] += 1
                if follow(rec)[0] == "improved":
                    topics[key]["actions_improved"] += 1
    out = []
    for e in topics.values():
        tested = len(e["masteries"])
        out.append({
            "topic": e["topic"],
            "subject": e["subject"],
            "tested": tested,
            "below_60": len(e["students_below"]),
            "mean_mastery": sittings.r1(fmean(e["masteries"])) if tested else None,
            "marks_lost": round(e["marks_lost"], 2),
            "actions_logged": e["actions_logged"],
            "actions_improved": e["actions_improved"],
            "subject_level": e["subject_level"] or subject_level(e["topic"], e["subject"]),
            "students_below": sorted(e["students_below"], key=lambda s: (s["mastery"], s["student_name"].casefold())),
        })
    out.sort(key=lambda t: (-t["below_60"], t["mean_mastery"] if t["mean_mastery"] is not None else 101.0,
                            t["topic"].casefold()))
    return out


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def _load(db: Session, *, batch_id: int | None, rubric_id: int | None, demo: bool | None) -> list[StudentSubmission]:
    query = select(StudentSubmission).options(
        selectinload(StudentSubmission.result),
        selectinload(StudentSubmission.rubric),
        selectinload(StudentSubmission.batch),
    )
    if batch_id is not None:
        query = query.where(StudentSubmission.batch_id == batch_id)
    if rubric_id is not None:
        query = query.where(StudentSubmission.rubric_id == rubric_id)
    if demo is not None:
        query = query.where(StudentSubmission.is_demo.is_(bool(demo)))
    return list(db.scalars(query).all())


def _history(db: Session, scope_subs: list[StudentSubmission]) -> dict[StudentKey, list[StudentSubmission]]:
    """Every graded paper (any batch / test) of the students in scope (sittings.history), oldest first."""
    out: dict[StudentKey, list[StudentSubmission]] = {}
    for sub in sittings.history(db, scope_subs):
        if _graded_paper(sub):
            out.setdefault(student_key(sub), []).append(sub)
    for subs in out.values():
        subs.sort(key=_order)
    return out


def build_roster(
    db: Session,
    *,
    batch_id: int | None = None,
    rubric_id: int | None = None,
    demo: bool | None = None,
    urgency: str | None = None,
    topic: str | None = None,
) -> dict[str, Any]:
    """A StudentRoster dict. urgency / topic narrow `rows` only (latest urgency; latest mastery of
    the topic < 60); summary and topics always describe the batch + test + demo scope."""
    scope_subs = _load(db, batch_id=batch_id, rubric_id=rubric_id, demo=demo)
    grouped: dict[StudentKey, list[StudentSubmission]] = {}
    for sub in scope_subs:
        grouped.setdefault(student_key(sub), []).append(sub)
    history = _history(db, scope_subs)
    records = _records_by_student(db, {ref for ref, _demo in grouped})
    follow = _FollowUps(db)
    batches: dict[int, Any] = {}
    families = sittings.Families(db)
    narrowed = batch_id is not None or rubric_id is not None

    rows = []
    for key, subs in grouped.items():
        anchor = max((s for s in subs if result_view.is_completed(s)), key=_order, default=None) or max(subs, key=_order)
        institution_id = anchor.batch.institution_id if anchor.batch is not None else None
        mine = records.get((key[0], key[1], institution_id), []) if institution_id is not None else []
        rows.append(_row(key, subs, history.get(key, []), mine, follow, batches, families, narrowed))
    rows.sort(key=_sort_key)

    summary = _summary(rows, scope_subs)
    topics = _topic_summary(rows, follow)

    wanted_topic = _norm(topic)
    shown = []
    for r in rows:
        if urgency and (r["latest"] is None or r["latest"]["urgency"] != urgency):
            continue
        if wanted_topic and not any(
            _norm(t["topic"]) == wanted_topic and t["mastery"] < WEAK_MASTERY for t in r["topics"]
        ):
            continue
        shown.append({k: v for k, v in r.items() if not k.startswith("_")})

    return {
        "scope": {"batch_id": batch_id, "rubric_id": rubric_id, "demo": demo},
        "summary": summary,
        "rows": shown,
        "topics": topics,
        "generated_at": utcnow(),
    }
