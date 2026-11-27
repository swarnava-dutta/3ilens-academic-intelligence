"""Institute-owner dashboard (FR-5.9): one institution's batches, faculty, progress, topics, exam
behaviour, release backlog, AI spend and the signals that need the owner's attention, in one
read-only payload computed in a single pass (so every number on the page agrees).

Definitions (API_CONTRACT.md, GET /api/owner/dashboard):
Sittings, ordering, rounding and progress are sittings.py's (the cohort and students pages use
the same definitions):
- Student = distinct student_ref. Graded student = at least one completed result.
- Latest result = per student, the newest completed sheet by sittings.order (upload time, then
  id; a re-grade never moves it, its marks show everywhere). A student's batch is the batch of
  their latest result, so batch figures add up to the institution's.
- Sitting = one test (answer-key family) in one batch, each student's latest sheet in it. A main
  sitting is a class sitting (at least MIN_TREND_STUDENTS students).
- Progress = per batch, the students of its latest main sitting against the sheet each sat just
  before it (sittings.pairs); only comparable pairs count (sittings.comparable: the same test, or
  full papers over the same subjects; up 5+ / down 5+ / steady), the rest are not_comparable;
  the institution's is every batch's pairs.
- Means are exact and rounded half-up to 1 dp; a change shown next to its before / after values
  is after - before of the shown values, so the three numbers always reconcile.

PoC: there is no login, so the page is open (role_note says so). Faculty are identified by the
free-text names already in the data (batch faculty lead, report reviewer, OCR reviewer and
intervention author), matched case- and whitespace-insensitively, until a users table exists.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from statistics import fmean, median
from typing import Any
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

import analytics
import marking
import outcomes
import patterns
import provenance
import result_view
import sittings
from config import get_settings
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
MIN_TREND_STUDENTS = sittings.MIN_CLASS_STUDENTS  # a smaller sitting is never a main test or a progress pair
MIN_TOPIC_STUDENTS = 3  # topic gaps and the batch "weakest topic" need this many students
SUBJECT_NAMES = {"physics", "chemistry", "biology", "botany", "zoology"}
MOVERS_CAP = 10
AT_RISK_ITEMS = 10
# Signal thresholds (owner overview spec S1-S10).
BATCH_DECLINE_PTS = -3.0
STUDENT_DROP_PTS = -10.0
PROGRESS_GOOD_PTS = 2.0
RELEASE_ACT_DAYS = 7.0
PROVISIONAL_STALE_DAYS = 7
UNDER_ATTEMPT_BLANK_PCT = 20.0
UNDER_ATTEMPT_ACCURACY_PCT = 60.0
OVER_ATTEMPT_STUDENTS = 3
MIN_BEHAVIOUR_STUDENTS = 3
COST_SIGNAL_SHEETS = 5
SEVERITY_ORDER = {"act": 0, "check": 1, "good": 2, "info": 3}
REVIEW_REASON_TEXT = {
    "low_confidence": "ticks hard to read",
    "low_page_confidence": "a page hard to read",
    "no_answers": "no answers matched the key",
    "mostly_blank": "fewer than half answered",
    "paper_mismatch": "a different paper from the key",
    "paper_reordered": "same paper, another code/set",
}
PURPOSE_LABELS = {
    "ocr": "tick reading",
    "evaluation": "grading",
    "consistency": "consistency check",
    "rubric_parse": "answer-key drafting",
    "transcription": "voice transcription",
    "voice_mapping": "voice mapping",
    "bloom_detect": "Bloom tagging",
    "llm_drill": "provider drill",
}
MINUS = "−"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
r1 = sittings.r1  # half-up to 1 dp (round() would turn 71.25 into 71.2; the UI shows 71.3)


def _r2(value: float) -> float:
    return float(Decimal(repr(float(value))).quantize(Decimal("0.01"), ROUND_HALF_UP))


def _int_half_up(value: float) -> int:
    return int(Decimal(repr(float(value))).quantize(Decimal("1"), ROUND_HALF_UP))


def _display(name: str | None) -> str:
    return " ".join((name or "").split())


_ref = sittings.student_key
_mean = sittings.mean1
_sat_at = sittings.sat_at  # when the sheet was sat (upload time): never moved by a re-grade
_order = sittings.order


def _ist_date(moment: datetime) -> str:
    return moment.astimezone(IST).date().isoformat()


def _pct(sub: StudentSubmission) -> float:
    return analytics.percentage(sub.result)


def _released(sub: StudentSubmission) -> bool:
    return (sub.result.release_status or ReleaseStatus.PROVISIONAL) == ReleaseStatus.RELEASED


def _days_since(now: datetime, moment: datetime | None) -> float:
    if moment is None:
        return 0.0
    return max(0.0, (now - moment).total_seconds() / 86400.0)


def _signed(value: float) -> str:
    text = f"{abs(value):.1f}"
    if value > 0 and text != "0.0":
        return f"+{text}"
    if value < 0 and text != "0.0":
        return f"{MINUS}{text}"
    return text


def _age(days: float | None) -> str:
    """3.0 -> '3 days', 0.4 -> '10 h'."""
    if days is None:
        return "-"
    if days < 1:
        hours = _int_half_up(days * 24)
        return "under an hour" if hours == 0 else marking.plural(hours, "hour")
    return marking.plural(_int_half_up(days), "day")


def _test_name(sub: StudentSubmission) -> str:
    return sub.rubric.name if sub.rubric is not None else f"Test {sub.rubric_id}"


_urgency_counts = sittings.urgency_counts


# --------------------------------------------------------------------------- #
# Sittings and progress (sittings.py: one sitting per batch + test, each student once)
# --------------------------------------------------------------------------- #
Sitting = dict[str, Any]  # a sittings.class_sittings row; its "subs" are newest first
Pair = sittings.Pair
# (latest main sitting, its students' (before, after) pairs) of one batch
Progress = tuple[Sitting, list[Pair]]


def _sitting_ref(sitting: Sitting, subs: list[StudentSubmission] | None = None) -> dict[str, Any]:
    """OwnerSittingRef; with `subs`, students / average_pct of those of its students only."""
    newest = sitting["subs"][0]
    return {
        "rubric_id": newest.rubric_id,
        "test_name": _test_name(newest),
        "students": sitting["students"] if subs is None else len(subs),
        "date": _ist_date(sitting["date"]),
        "average_pct": sitting["average_pct"] if subs is None else _mean(_pct(s) for s in subs),
        "max_marks": float(newest.result.total_marks) if newest.result.total_marks else None,
    }


def _batch_progress(
    here: list[Sitting], completed: list[StudentSubmission]
) -> tuple[Sitting | None, Sitting | None, Progress | None]:
    """(main sitting, previous class sitting, progress) of one batch's sittings (newest first):
    main = the newest class sitting, else the newest sitting; progress = a class main sitting's
    students against the sheet each sat just before it (sittings.pairs)."""
    main = sittings.latest_class_sitting(here) or (here[0] if here else None)
    if main is None or not main["is_class"]:
        return main, None, None
    return main, sittings.previous_class_sitting(here, main), (main, sittings.pairs(main["subs"], completed))


def _change(pair: Pair) -> float:
    return sittings.change_pts(_pct(pair[0]), _pct(pair[1]))


def _progress(
    groups: list[Progress], families: sittings.Families, sitting_of: dict[tuple[int, int], Sitting] | None = None
) -> dict[str, Any]:
    """sittings.progress over every pair of these batches; with `sitting_of` ((batch, test) ->
    sitting) also the sittings the comparable pairs' earlier / later results come from (oldest
    first; students and average_pct of the re-tested students)."""
    paired = [pair for _main, pairs in groups for pair in pairs]
    out = {**sittings.progress(paired, families), "before_sittings": [], "after_sittings": []}
    if sitting_of is not None:
        same = [pair for pair in paired if sittings.comparable(*pair, families)]
        for side, index in (("before_sittings", 0), ("after_sittings", 1)):
            grouped: dict[tuple[int, int], list[StudentSubmission]] = {}
            for pair in same:
                grouped.setdefault((pair[index].batch_id, families.root(pair[index].rubric_id)), []).append(pair[index])
            out[side] = [
                _sitting_ref(sitting_of[key], grouped[key])
                for key in sorted(grouped, key=lambda k: _order(sitting_of[k]["subs"][0]))
            ]
    return out


def _progress_student(pair: Pair, batches: dict[int, Batch], batch_id: int) -> dict[str, Any]:
    before, after = pair
    return {
        "submission_id": after.id,
        "previous_submission_id": before.id,
        "student_name": after.student_name,
        "batch_id": batch_id,
        "batch_name": batches[batch_id].name,
        "before_pct": _pct(before),
        "after_pct": _pct(after),
        "change": _change(pair),
        "before_test": _test_name(before),
        "after_test": _test_name(after),
    }


# --------------------------------------------------------------------------- #
# Topics
# --------------------------------------------------------------------------- #
def _subject_only(topic: str, subject: str | None) -> bool:
    name = analytics.norm(topic)
    return name in SUBJECT_NAMES or (bool(subject) and name == analytics.norm(subject))


def _topic_gaps(latest: list[StudentSubmission], batches: dict[int, Batch]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(gaps, hidden): mean topic mastery over the latest results that cover each topic, weakest
    first. Topics seen by fewer than MIN_TOPIC_STUDENTS students, or named only by a subject
    (a subject-level key such as 'Physics'), are listed in `hidden` instead."""
    agg: dict[str, dict[str, Any]] = {}
    for sub in latest:
        per_student: dict[str, list[float]] = {}
        for item in sub.result.topic_mastery or []:
            if not isinstance(item, dict) or not item.get("topic"):
                continue
            try:
                mastery = float(item.get("mastery") or 0.0)
            except (TypeError, ValueError):
                continue
            name = _display(str(item["topic"]))
            key = name.casefold()
            entry = agg.setdefault(key, {"topic": name, "subject": item.get("subject") or None, "m": [], "batch_ids": set()})
            per_student.setdefault(key, []).append(mastery)
        for key, values in per_student.items():
            agg[key]["m"].append(fmean(values))
            agg[key]["batch_ids"].add(sub.batch_id)
    gaps: list[dict[str, Any]] = []
    hidden: list[dict[str, Any]] = []
    for entry in agg.values():
        n = len(entry["m"])
        if _subject_only(entry["topic"], entry["subject"]):
            hidden.append({"topic": entry["topic"], "students": n, "reason": "subject_only"})
            continue
        if n < MIN_TOPIC_STUDENTS:
            hidden.append({"topic": entry["topic"], "students": n, "reason": "few_students"})
            continue
        ids = sorted(entry["batch_ids"])
        gaps.append({
            "topic": entry["topic"],
            "subject": str(entry["subject"]) if entry["subject"] else None,
            "mastery": r1(fmean(entry["m"])),
            "students": n,
            "below_40": sum(1 for m in entry["m"] if m < 40.0),
            "batch_ids": ids,
            "batches": [batches[i].name for i in ids if i in batches],
        })
    gaps.sort(key=lambda g: (g["mastery"], g["topic"].casefold()))
    hidden.sort(key=lambda h: (h["reason"], -h["students"], h["topic"].casefold()))
    return gaps, hidden


def _weakest_topic(sub: StudentSubmission) -> tuple[str | None, float | None]:
    """The student's weakest topic in one result (chapter-level names preferred over subjects)."""
    entries = []
    for item in sub.result.topic_mastery or []:
        if not isinstance(item, dict) or not item.get("topic"):
            continue
        try:
            entries.append((float(item.get("mastery") or 0.0), _display(str(item["topic"])), item.get("subject")))
        except (TypeError, ValueError):
            continue
    chapters = [e for e in entries if not _subject_only(e[1], e[2])] or entries
    if not chapters:
        return None, None
    mastery, topic, _subject = min(chapters, key=lambda e: (e[0], e[1].casefold()))
    return topic, r1(mastery)


# --------------------------------------------------------------------------- #
# Exam behaviour (negatively-marked MCQs)
# --------------------------------------------------------------------------- #
class _Profiles:
    """patterns.negative_marking_profile per result, computed once per request."""

    def __init__(self) -> None:
        self._cache: dict[int, dict[str, Any] | None] = {}

    def get(self, sub: StudentSubmission) -> dict[str, Any] | None:
        if sub.id not in self._cache:
            try:
                content = sub.rubric.content if sub.rubric is not None and isinstance(sub.rubric.content, dict) else {}
                self._cache[sub.id] = patterns.negative_marking_profile(patterns.question_items(sub.result, sub.rubric), content)
            except Exception:  # noqa: BLE001 - one odd result must not break the dashboard
                logger.exception("Negative-marking profile failed for submission %s", sub.id)
                self._cache[sub.id] = None
        return self._cache[sub.id]


def _behaviour_row(
    rows: list[tuple[StudentSubmission, dict[str, Any]]],
    previous: list[tuple[dict[str, Any], dict[str, Any], StudentSubmission]],
    batch: Batch | None,
) -> dict[str, Any]:
    n = len(rows)
    correct = sum(int(p["correct"]) for _s, p in rows)
    wrong = sum(int(p["wrong"]) for _s, p in rows)
    blank = sum(int(p["blank"]) for _s, p in rows)
    attempted = correct + wrong
    mcqs = attempted + blank
    lost = round(sum(float(p["marks_lost"]) for _s, p in rows), 2)
    tests = Counter(_test_name(s) for s, _p in rows)
    newest_test = _test_name(max((s for s, _p in rows), key=_order))
    test = max(tests, key=lambda name: (tests[name], name == newest_test))
    schemes = Counter(str(p.get("scheme") or "").replace(" ", "") for _s, p in rows)
    scheme = schemes.most_common(1)[0][0] if schemes else ""
    break_even = next((p.get("break_even") for _s, p in rows if str(p.get("scheme") or "").replace(" ", "") == scheme), None)
    over_topics: Counter[str] = Counter()
    for _s, p in rows:
        for t in p.get("topics") or []:
            if t.get("over_attempting"):
                over_topics[str(t["topic"])] += 1
    top_over = min(over_topics, key=lambda t: (-over_topics[t], t)) if over_topics else None
    prev = None
    if previous:
        prev_tests = Counter(_test_name(s) for _p, _c, s in previous)
        prev = {
            "test": prev_tests.most_common(1)[0][0],
            "tests": len(prev_tests),
            "students": len(previous),
            "marks_lost_per_student": r1(sum(float(p["marks_lost"]) for p, _c, _s in previous) / len(previous)),
            "current_marks_lost_per_student": r1(sum(float(c["marks_lost"]) for _p, c, _s in previous) / len(previous)),
        }
    return {
        "batch_id": batch.id if batch is not None else None,
        "batch_name": batch.name if batch is not None else None,
        "test": test,
        "tests": len(tests),
        "students": n,
        "mcqs": mcqs,
        "attempted": attempted,
        "correct": correct,
        "wrong": wrong,
        "blank": blank,
        "attempt_rate_pct": r1(attempted / mcqs * 100) if mcqs else None,
        "accuracy_pct": r1(correct / attempted * 100) if attempted else None,
        "blank_share_pct": r1(blank / mcqs * 100) if mcqs else None,
        "marks_lost": lost,
        "marks_lost_per_student": r1(lost / n) if n else None,
        "blank_per_student": r1(blank / n) if n else None,
        "over_attempting_students": sum(1 for _s, p in rows if p.get("risk") == "high"),
        "top_over_topic": top_over,
        "top_over_topic_students": over_topics[top_over] if top_over else 0,
        "scheme": scheme or None,
        "break_even": break_even,
        "previous": prev,
    }


def _exam_behaviour(
    latest: list[StudentSubmission],
    completed: list[StudentSubmission],
    batches: dict[int, Batch],
) -> dict[str, Any]:
    profiles = _Profiles()
    history: dict[str, list[StudentSubmission]] = {}
    for sub in completed:
        history.setdefault(_ref(sub), []).append(sub)
    for items in history.values():
        items.sort(key=_order)

    rows: list[tuple[StudentSubmission, dict[str, Any]]] = []
    previous: dict[int, tuple[dict[str, Any], dict[str, Any], StudentSubmission]] = {}
    for sub in sorted(latest, key=_order):
        profile = profiles.get(sub)
        if profile is None:
            continue
        rows.append((sub, profile))
        earlier = [s for s in history.get(_ref(sub), []) if _order(s) < _order(sub)]
        for prior in reversed(earlier):
            prior_profile = profiles.get(prior)
            if prior_profile is not None:
                previous[sub.id] = (prior_profile, profile, prior)
                break
    if not rows:
        return {"overall": None, "by_batch": []}
    by_batch = []
    for batch_id in sorted({s.batch_id for s, _p in rows}):
        mine = [(s, p) for s, p in rows if s.batch_id == batch_id]
        by_batch.append(_behaviour_row(mine, [previous[s.id] for s, _p in mine if s.id in previous], batches.get(batch_id)))
    overall = _behaviour_row(rows, [previous[s.id] for s, _p in rows if s.id in previous], None)
    return {"overall": overall, "by_batch": by_batch}


# --------------------------------------------------------------------------- #
# Faculty
# --------------------------------------------------------------------------- #
def _follow_ups(db: Session, records: list[InterventionRecord]) -> dict[int, str]:
    """record id -> outcome status (improved / flat / declined / pending / not_assessed)."""
    out: dict[int, str] = {}
    for rec in records:
        try:
            out[rec.id] = outcomes.follow_up(db, rec)[0]
        except Exception:  # noqa: BLE001 - one odd record must not break the dashboard
            logger.exception("Follow-up failed for intervention %s", rec.id)
            out[rec.id] = "pending"
    return out


def _faculty(
    db: Session,
    batches: list[Batch],
    subs: list[StudentSubmission],
    completed: list[StudentSubmission],
    interventions: list[InterventionRecord],
    batch_rows: dict[int, dict[str, Any]],
    latest_by_batch: dict[int, list[StudentSubmission]],
    progress_by_batch: dict[int, Progress],
    statuses: dict[int, str],
    families: sittings.Families,
) -> list[dict[str, Any]]:
    sub_ids = [s.id for s in subs]
    reviews = list(db.scalars(select(OcrReview).where(OcrReview.submission_id.in_(sub_ids))).all()) if sub_ids else []
    names: dict[str, str] = {}

    def add(raw: str | None) -> None:
        key = analytics.norm(raw)
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
        led = [b for b in batches if analytics.norm(b.faculty_lead) == key]
        led_ids = {b.id for b in led}
        led_rows = [batch_rows[b.id] for b in led if b.id in batch_rows]
        graded = sum(row["students_graded"] for row in led_rows)
        released = [s for s in completed if _released(s) and analytics.norm(s.result.reviewed_by) == key]
        hours = []
        for sub in released:
            start: datetime | None = sub.completed_at or sub.result.created_at
            end = sub.result.reviewed_at
            if start is not None and end is not None:
                hours.append(max(0.0, (end - start).total_seconds() / 3600.0))
        progress = _progress([progress_by_batch[bid] for bid in led_ids if bid in progress_by_batch], families)
        authored = [r for r in interventions if analytics.norm(r.applied_by) == key]
        oldest = [row["oldest_awaiting_days"] for row in led_rows if row["oldest_awaiting_days"] is not None]
        out.append({
            "name": name,
            "batches": [b.name for b in led],
            "students": len({_ref(s) for s in subs if s.batch_id in led_ids}),
            # Kept for older clients; the overview compares progress, not raw averages across papers.
            "average_pct": _mean(_pct(s) for bid in led_ids for s in latest_by_batch.get(bid, [])),
            "reports_released": len(released),
            "ocr_reviews": sum(1 for r in reviews if analytics.norm(r.reviewer) == key),
            "interventions_logged": len(authored),
            "avg_release_hours": r1(fmean(hours)) if hours else None,
            "median_release_hours": r1(median(hours)) if hours else None,
            "students_graded": graded,
            "at_risk": sum(row["urgency_counts"]["at_risk"] for row in led_rows),
            "at_risk_unactioned": sum(row["at_risk_unactioned"] for row in led_rows),
            "awaiting_release": sum(row["awaiting_release"] for row in led_rows),
            "oldest_awaiting_days": max(oldest) if oldest else None,
            "progress_change": progress["mean_change"],
            "progress_students": progress["students"],
            "actions_measured": sum(1 for r in authored if statuses.get(r.id) in outcomes.MEASURED),
            "actions_improved": sum(1 for r in authored if statuses.get(r.id) == "improved"),
        })
    return sorted(out, key=lambda f: (-len(f["batches"]), -f["reports_released"], f["name"].casefold()))


# --------------------------------------------------------------------------- #
# Interventions, spend
# --------------------------------------------------------------------------- #
def _interventions(db: Session, institution_id: int) -> dict[str, Any]:
    """InterventionSummary from outcomes.effectiveness (zeros when it is unavailable)."""
    try:
        effect = outcomes.effectiveness(db, institution_id=institution_id)
        inst = next(
            (row for row in effect.get("by_institution") or [] if row.get("institution_id") == institution_id), {}
        )
        return {
            "records": int(effect.get("records") or 0),
            "measured": int(effect.get("measured") or 0),
            "uplift": effect.get("uplift"),
            "calibration_factor": inst.get("calibration_factor"),
            "pending": int(effect.get("pending") or 0),
            "calibration_n": int(inst.get("calibration_n") or 0),
            "is_demo": bool(effect.get("is_demo")),
        }
    except Exception:  # noqa: BLE001 - the intervention summary must never break the dashboard
        logger.exception("Intervention effectiveness unavailable for institution %s", institution_id)
        return {"records": 0, "measured": 0, "uplift": None, "calibration_factor": None, "pending": 0, "calibration_n": 0,
                "is_demo": False}


def _by_purpose(rows: list[ModelInvocation]) -> list[dict[str, Any]]:
    groups: dict[str, list[ModelInvocation]] = {}
    for row in rows:
        groups.setdefault(row.purpose or "other", []).append(row)
    out = [
        {
            "purpose": purpose,
            "label": PURPOSE_LABELS.get(purpose, purpose.replace("_", " ")),
            "cost_inr": _r2(sum(float(r.cost_inr or 0.0) for r in items)),
            "calls": sum(1 for r in items if r.status != "cache_hit"),
        }
        for purpose, items in groups.items()
    ]
    return sorted(out, key=lambda p: (-p["cost_inr"], p["purpose"]))


def _spend(db: Session, institution_id: int, subs: list[StudentSubmission], completed: list[StudentSubmission]) -> dict[str, Any]:
    """AI spend: grading calls of this institution's sheets, other calls tagged with the
    institution, and calls recorded without any institution or sheet (e.g. answer-key drafting)."""
    ids = [s.id for s in subs]
    grading = list(db.scalars(select(ModelInvocation).where(ModelInvocation.submission_id.in_(ids))).all()) if ids else []
    other = list(db.scalars(select(ModelInvocation).where(
        ModelInvocation.institution_id == institution_id, ModelInvocation.submission_id.is_(None),
    )).all())
    unlinked = list(db.scalars(select(ModelInvocation).where(
        ModelInvocation.institution_id.is_(None), ModelInvocation.submission_id.is_(None),
    )).all())
    grading_inr = _r2(sum(float(r.cost_inr or 0.0) for r in grading))
    traced = {r.submission_id for r in grading}
    live_graded = [s for s in completed if not s.is_demo and s.id in traced]
    other_parts, unlinked_parts = _by_purpose(other), _by_purpose(unlinked)
    # Totals are the sum of the rounded parts, so a breakdown always adds up to its total.
    other_inr = _r2(sum(p["cost_inr"] for p in other_parts))
    unlinked_inr = _r2(sum(p["cost_inr"] for p in unlinked_parts))
    return {
        "grading_inr": grading_inr,
        "grading_calls": sum(1 for r in grading if r.status != "cache_hit"),
        "live_graded_sheets": len(live_graded),
        "per_graded_sheet_inr": _r2(grading_inr / len(live_graded)) if live_graded else None,
        "target_inr": float(get_settings().cost_target_inr),
        "institution_other_inr": other_inr,
        "institution_other_by_purpose": other_parts,
        "unlinked_inr": unlinked_inr,
        "unlinked_by_purpose": unlinked_parts,
        "total_inr": _r2(grading_inr + other_inr + unlinked_inr),
    }


# --------------------------------------------------------------------------- #
# Signals
# --------------------------------------------------------------------------- #
def _signal(key: str, severity: str, title: str, *, detail: str | None = None, count: int = 0,
            href: str | None = None, cta: str | None = None, items: list[dict[str, Any]] | None = None,
            tier: int = 0) -> dict[str, Any]:
    return {"key": key, "severity": severity, "title": title, "detail": detail, "count": count,
            "href": href, "cta": cta, "items": items or [], "_tier": tier}


def _item(label: str, detail: str | None = None, value: str | None = None, href: str | None = None) -> dict[str, Any]:
    return {"label": label, "detail": detail, "value": value, "href": href}


def _sheet_names(sheets: list[dict[str, Any]], *, reason: bool) -> str:
    parts = []
    for sheet in sheets[:2]:
        text = f"{sheet['student_name']} ({sheet['batch_name']})"
        if reason and sheet.get("review_reason"):
            text += f" · {REVIEW_REASON_TEXT.get(sheet['review_reason'], sheet['review_reason'].replace('_', ' '))}"
        parts.append(text)
    if len(sheets) > 2:
        parts.append(f"{len(sheets) - 2} more")
    return ", ".join(parts)


def _signals(
    *,
    graded: int,
    at_risk: list[dict[str, Any]],
    release: dict[str, Any],
    batch_rows: list[dict[str, Any]],
    progress: dict[str, Any],
    movers: list[dict[str, Any]],
    gaps: list[dict[str, Any]],
    held: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    behaviour: dict[str, Any],
    spend: dict[str, Any],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    # S1 at-risk students with no action since their latest test
    if at_risk:
        open_rows = [s for s in at_risk if not s["actioned"]]
        n, total = len(open_rows), len(at_risk)
        if open_rows:
            per_batch = Counter(s["batch_name"] for s in open_rows)
            detail = " · ".join(f"{name} {per_batch[name]}" for name in sorted(per_batch, key=lambda b: (-per_batch[b], b)))
            noun = "at-risk students" if total > 1 else "at-risk student"
            verb = "has" if n == 1 else "have"
            out.append(_signal(
                "at_risk_unactioned", "act",
                f"{n} of {total} {noun} {verb} no action logged since their latest test",
                detail=detail, count=n, href="/students?urgency=at_risk", cta="All at-risk results on Students",
                items=[
                    _item(s["student_name"], f"{s['batch_name']} · weakest: {s['weakest_topic']}" if s["weakest_topic"] else s["batch_name"],
                          f"{s['pct']:.1f}%", f"/report/{s['submission_id']}")
                    for s in open_rows[:AT_RISK_ITEMS]
                ],
            ))
        else:
            out.append(_signal(
                "at_risk_actioned", "good", "Every at-risk student has an action since their latest test",
                detail=f"{marking.plural(total, 'at-risk student')}, each with a logged action", count=total,
            ))

    # S2 release backlog (per student, latest report)
    awaiting = int(release.get("students_awaiting") or 0)
    if awaiting:
        oldest = release.get("oldest_days")
        verb = "has" if awaiting == 1 else "have"
        detail = f"Oldest waiting {_age(oldest)}"
        if release.get("oldest_test"):
            detail += f" · {release['oldest_test']}, {release['oldest_batch']}"
        out.append(_signal(
            "release_backlog", "act" if (oldest or 0) >= RELEASE_ACT_DAYS else "check",
            f"{awaiting} of {graded} students {verb} not received their latest report",
            detail=detail, count=awaiting,
            items=[
                _item(f"{row['batch_name']} · {row['lead'] or 'no lead set'}", f"oldest {_age(row['oldest_days'])}",
                      str(row["awaiting"]), f"/students?batch_id={row['batch_id']}")
                for row in release.get("by_batch") or [] if row["awaiting"]
            ],
        ))
    elif graded:
        out.append(_signal("all_released", "good", "Every graded student has their latest report",
                           detail=f"{marking.plural(graded, 'student')}", count=graded))

    # S3 a batch slipping on the same students
    for row in batch_rows:
        prog = row.get("progress") or {}
        if prog.get("students", 0) >= MIN_TREND_STUDENTS and prog.get("mean_change") is not None \
                and prog["mean_change"] <= BATCH_DECLINE_PTS:
            name = row["batch"].name
            out.append(_signal(
                f"batch_decline:{row['batch'].id}", "act",
                f"{name} fell {abs(prog['mean_change']):.1f} pts on {prog['students']} re-tested students",
                detail=f"Same students, {prog['mean_before']:.1f}% to {prog['mean_after']:.1f}% (previous vs latest whole-class test)",
                count=prog["students"], href=f"/cohort?batch_id={row['batch'].id}", cta="Open in cohort",
            ))

    # S4 students dropping 10+ points
    drops = sorted((m for m in movers if m["change"] <= STUDENT_DROP_PTS), key=lambda m: (m["change"], m["student_name"]))
    if drops:
        out.append(_signal(
            "students_dropping", "act", f"{marking.plural(len(drops), 'student')} dropped 10+ points since their previous test",
            detail=", ".join(f"{m['student_name']} {_signed(m['change'])}" for m in drops[:3]) + (f" and {len(drops) - 3} more" if len(drops) > 3 else ""),
            count=len(drops),
            items=[_item(m["student_name"], f"{m['batch_name']} · {m['before_pct']:.1f}% to {m['after_pct']:.1f}%",
                         _signed(m["change"]), f"/report/{m['submission_id']}") for m in drops],
        ))

    # S5 weakest topic
    gap = next((g for g in gaps if g["mastery"] < 50.0 and g["students"] >= MIN_TOPIC_STUDENTS), None)
    if gap is not None:
        href = f"/cohort?topic={quote(gap['topic'], safe='')}"
        if len(gap["batch_ids"]) == 1:
            href += f"&batch_id={gap['batch_ids'][0]}"
        out.append(_signal(
            "topic_gap", "check",
            f"Weakest topic: {gap['topic']}, {_int_half_up(gap['mastery'])}% across {gap['students']} students",
            detail=f"{', '.join(gap['batches'])} · {marking.plural(gap['below_40'], 'student')} below 40%",
            count=gap["students"], href=href, cta="Open in cohort",
        ))

    # S6 held sheets
    if held:
        one = len(held) == 1
        out.append(_signal(
            "held", "check", f"{marking.plural(len(held), 'sheet')} held for review",
            detail=_sheet_names(held, reason=True), count=len(held),
            href=f"/report/{held[0]['submission_id']}" if one else "/", cta="Open sheet" if one else "Open Intake",
            items=[_item(s["student_name"], f"{s['batch_name']} · {REVIEW_REASON_TEXT.get(s['review_reason'] or '', 'held for review')}",
                         None, f"/report/{s['submission_id']}") for s in held],
        ))

    # S7 failed sheets
    if failed:
        out.append(_signal(
            "failed", "act", f"{marking.plural(len(failed), 'sheet')} failed to process",
            detail=_sheet_names(failed, reason=False), count=len(failed), href="/", cta="Open Intake",
        ))

    # S8 exam behaviour (negatively-marked MCQs), a secondary tier after the operational checks
    overall = behaviour.get("overall") or None
    if overall and overall["students"] >= MIN_BEHAVIOUR_STUDENTS:
        blank_share, accuracy = overall.get("blank_share_pct"), overall.get("accuracy_pct")
        scheme = overall.get("scheme") or "+4/-1"
        if blank_share is not None and accuracy is not None and blank_share >= UNDER_ATTEMPT_BLANK_PCT \
                and accuracy >= UNDER_ATTEMPT_ACCURACY_PCT:
            be = overall.get("break_even")
            be_text = f" (break-even {_int_half_up(be * 100)}%)" if be is not None else ""
            out.append(_signal(
                "under_attempting", "check",
                f"Students may be under-attempting: {_int_half_up(blank_share)}% of MCQs left blank, "
                f"{_int_half_up(accuracy)}% of attempted answers right",
                detail=f"At {scheme}, answering after ruling out one option pays{be_text} · {overall['students']} students",
                count=overall["students"], tier=1,
            ))
        if overall["over_attempting_students"] >= OVER_ATTEMPT_STUDENTS and overall.get("top_over_topic"):
            out.append(_signal(
                "over_attempting", "check",
                f"{overall['over_attempting_students']} students lose marks by guessing in {overall['top_over_topic']}",
                detail=f"{overall['marks_lost_per_student']:.1f} marks lost to wrong answers per student · "
                       "answer there only after ruling out 2 options",
                count=overall["over_attempting_students"], tier=1,
            ))

    # S9 progress
    if progress.get("students", 0) >= MIN_TREND_STUDENTS and progress.get("mean_change") is not None \
            and progress["mean_change"] >= PROGRESS_GOOD_PTS:
        out.append(_signal(
            "progress", "good", f"Re-tested students are up {_signed(progress['mean_change'])} pts",
            detail=f"{progress['students']} students · {progress['improved']} up 5+ · "
                   f"{progress['declined']} down 5+ · {progress['steady']} steady",
            count=progress["students"], cta="See progress",
        ))

    # S10 AI spend over target (live sheets only)
    per_sheet = spend.get("per_graded_sheet_inr")
    if spend.get("live_graded_sheets", 0) >= COST_SIGNAL_SHEETS and per_sheet is not None and per_sheet > spend["target_inr"]:
        out.append(_signal(
            "cost", "info", f"AI spend is Rs {per_sheet:.2f} per graded sheet, above the Rs {spend['target_inr']:.2f} target",
            detail=f"{spend['live_graded_sheets']} live sheets · Rs {spend['grading_inr']:.2f} in total",
            count=spend["live_graded_sheets"],
        ))

    out.sort(key=lambda s: (SEVERITY_ORDER[s["severity"]], s["_tier"], -s["count"], s["key"]))
    for signal in out:
        signal.pop("_tier")
    return out


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #
def _sheet_row(sub: StudentSubmission, batches: dict[int, Batch], reason: str | None) -> dict[str, Any]:
    return {
        "submission_id": sub.id,
        "student_name": sub.student_name,
        "batch_id": sub.batch_id,
        "batch_name": batches[sub.batch_id].name,
        "review_reason": reason,
        "created_at": sub.created_at,
    }


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

    now = utcnow()
    batches = list(db.scalars(
        select(Batch).where(Batch.institution_id == institution.id).order_by(Batch.id)
    ).all())
    by_id = {b.id: b for b in batches}
    subs: list[StudentSubmission] = []
    if batches:
        subs = list(db.scalars(
            select(StudentSubmission)
            .where(StudentSubmission.batch_id.in_(list(by_id)))
            .options(selectinload(StudentSubmission.result), selectinload(StudentSubmission.rubric))
            .order_by(StudentSubmission.id)
        ).all())
    completed = [s for s in subs if result_view.is_completed(s)]
    latest = sittings.latest_per_student(completed)
    latest_by_batch: dict[int, list[StudentSubmission]] = {b.id: [] for b in batches}
    for sub in latest:
        latest_by_batch.setdefault(sub.batch_id, []).append(sub)
    families = sittings.Families(db)
    all_sittings = sittings.class_sittings(db, completed, families=families)  # newest first
    sitting_of = {(s["batch_id"], s["test_id"]): s for s in all_sittings}
    interventions = list(db.scalars(
        select(InterventionRecord).where(InterventionRecord.institution_id == institution.id)
    ).all())
    records_by_ref: dict[str, list[InterventionRecord]] = {}
    for rec in interventions:
        records_by_ref.setdefault(rec.student_ref, []).append(rec)

    # Progress: per batch, its latest main sitting's students against the sheet each sat before
    # (as on the cohort and students pages); only comparable pairs are a change.
    main_by_batch: dict[int, Sitting | None] = {}
    previous_by_batch: dict[int, Sitting | None] = {}
    progress_by_batch: dict[int, Progress] = {}
    for batch in batches:
        main, previous, progress = _batch_progress([s for s in all_sittings if s["batch_id"] == batch.id], completed)
        main_by_batch[batch.id], previous_by_batch[batch.id] = main, previous
        if progress is not None:
            progress_by_batch[batch.id] = progress
    compared = {
        batch_id: [pair for pair in pairs if sittings.comparable(*pair, families)]
        for batch_id, (_main, pairs) in progress_by_batch.items()
    }
    pair_of = {pair[1].id: pair for pairs in compared.values() for pair in pairs}
    movers = [_progress_student(pair, by_id, batch_id) for batch_id, pairs in compared.items() for pair in pairs]
    movers.sort(key=lambda m: (-m["change"], m["student_name"]))
    capped_ids = {m["submission_id"] for m in movers[:MOVERS_CAP]} | {m["submission_id"] for m in movers[-MOVERS_CAP:]}
    progress_students = [m for m in movers if m["submission_id"] in capped_ids]

    # At-risk students (latest result) and whether anyone acted since.
    at_risk: list[dict[str, Any]] = []
    for sub in latest:
        urgency, _reasons, pct = analytics.result_urgency(sub.result)
        if urgency != "at_risk":
            continue
        records = records_by_ref.get(_ref(sub), [])
        # "Since their latest test" = since its upload, so a re-grade never resets it.
        since = [r for r in records if r.submission_id == sub.id or r.applied_at >= _sat_at(sub)]
        pair = pair_of.get(sub.id)
        topic, mastery = _weakest_topic(sub)
        at_risk.append({
            "submission_id": sub.id,
            "student_name": sub.student_name,
            "student_ref": _ref(sub),
            "batch_id": sub.batch_id,
            "batch_name": by_id[sub.batch_id].name,
            "test_name": _test_name(sub),
            "pct": pct,
            "change": _change(pair) if pair is not None else None,
            "weakest_topic": topic,
            "weakest_mastery": mastery,
            "actioned": bool(since),
            "last_action_at": max((r.applied_at for r in records), default=None),
        })
    at_risk.sort(key=lambda s: (s["pct"], s["student_name"]))

    # Release backlog, per student (latest result) and per sheet.
    # Waiting time runs from the upload, so re-grading a sheet never restarts the clock.
    unreleased = [s for s in latest if not _released(s)]
    ages = {s.id: _days_since(now, _sat_at(s)) for s in unreleased}
    oldest_sub = max(unreleased, key=lambda s: (ages[s.id], -s.id)) if unreleased else None
    provisional_sheets = [s for s in completed if not _released(s)]

    gaps, hidden = _topic_gaps(latest, by_id)
    behaviour: dict[str, Any] = {"overall": None, "by_batch": []}
    try:
        behaviour = _exam_behaviour(latest, completed, by_id)
    except Exception:  # noqa: BLE001 - like the intervention summary, never break the dashboard
        logger.exception("Exam behaviour unavailable for institution %s", institution.id)

    batch_rows: list[dict[str, Any]] = []
    for batch in batches:
        mine = [s for s in subs if s.batch_id == batch.id]
        done = [s for s in mine if result_view.is_completed(s)]
        latest_here = latest_by_batch.get(batch.id, [])
        main = main_by_batch[batch.id]
        newest = main["subs"][0] if main is not None else None
        newer = [s for s in all_sittings if s["batch_id"] == batch.id and newest is not None
                 and _order(s["subs"][0]) > _order(newest)]
        batch_progress = progress_by_batch.get(batch.id)
        progress = _progress([batch_progress] if batch_progress is not None else [], families, sitting_of)
        batch_gaps, _hidden = _topic_gaps(latest_here, by_id)
        previous_ref = None
        previous = previous_by_batch[batch.id]
        if previous is not None:
            shared = sum(
                1 for before, _after in (batch_progress[1] if batch_progress else [])
                if (before.batch_id, families.root(before.rubric_id)) == (previous["batch_id"], previous["test_id"])
            )
            previous_ref = {**_sitting_ref(previous), "shared_students": shared}
        waiting = [s for s in unreleased if s.batch_id == batch.id]
        risk_here = [s for s in at_risk if s["batch_id"] == batch.id]
        cost = sum(float(r or 0.0) for r in db.scalars(
            select(ModelInvocation.cost_inr).where(ModelInvocation.batch_id == batch.id)
        ).all())
        demo = sum(1 for s in mine if s.is_demo)
        batch_rows.append({
            "batch": result_view.batch_out(batch),
            "students": len({_ref(s) for s in mine}),
            "students_graded": len(latest_here),
            "completed": len(done),
            "average_pct": _mean(_pct(s) for s in latest_here),
            "previous_average_pct": progress["mean_before"],
            "trend_delta_pct": progress["mean_change"],
            "progress": progress,
            "urgency_counts": _urgency_counts(latest_here),
            "latest_test": result_view.rubric_ref(newest.rubric) if newest is not None else None,
            "latest_test_date": main["date"] if main is not None else None,
            "latest_test_students": main["students"] if main is not None else 0,
            "latest_test_avg_pct": main["average_pct"] if main is not None else None,
            "latest_test_main": main["is_class"] if main is not None else False,
            "newer_small_sitting": _sitting_ref(newer[0]) if newer else None,
            "previous_test": previous_ref,
            "released": sum(1 for s in done if _released(s)),
            "provisional": sum(1 for s in done if not _released(s)),
            "review_backlog": sum(1 for s in mine if s.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED),
            "failed": sum(1 for s in mine if s.status == SubmissionStatus.FAILED),
            "at_risk_unactioned": sum(1 for s in risk_here if not s["actioned"]),
            "awaiting_release": len(waiting),
            "oldest_awaiting_days": r1(max(ages[s.id] for s in waiting)) if waiting else None,
            "top_gap_topic": batch_gaps[0]["topic"] if batch_gaps else None,
            "top_gap_mastery": batch_gaps[0]["mastery"] if batch_gaps else None,
            "top_gap_students": batch_gaps[0]["students"] if batch_gaps else 0,
            "cost_inr": _r2(cost),
            "is_demo": demo > 0,
            "demo_count": demo,
            "real_count": len(mine) - demo,
        })
    rows_by_id = {row["batch"].id: row for row in batch_rows}

    release = {
        "students_awaiting": len(unreleased),
        "students_graded": len(latest),
        "oldest_days": r1(ages[oldest_sub.id]) if oldest_sub is not None else None,
        "oldest_test": _test_name(oldest_sub) if oldest_sub is not None else None,
        "oldest_batch": by_id[oldest_sub.batch_id].name if oldest_sub is not None else None,
        "oldest_submission_id": oldest_sub.id if oldest_sub is not None else None,
        "by_batch": [
            {
                "batch_id": b.id,
                "batch_name": b.name,
                "lead": _display(b.faculty_lead) or None,
                "awaiting": rows_by_id[b.id]["awaiting_release"],
                "oldest_days": rows_by_id[b.id]["oldest_awaiting_days"],
            }
            for b in sorted(batches, key=lambda b: (-rows_by_id[b.id]["awaiting_release"], b.id))
        ],
        "sheets_provisional": len(provisional_sheets),
        "sheets_released": len(completed) - len(provisional_sheets),
        "sheets_provisional_over_7d": sum(
            1 for s in provisional_sheets if _days_since(now, _sat_at(s)) >= PROVISIONAL_STALE_DAYS
        ),
    }

    held = [_sheet_row(s, by_id, s.review_reason) for s in subs if s.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED]
    failed = [_sheet_row(s, by_id, s.last_error_code) for s in subs if s.status == SubmissionStatus.FAILED]

    statuses = _follow_ups(db, interventions)
    faculty = _faculty(
        db, batches, subs, completed, interventions, rows_by_id, latest_by_batch, progress_by_batch, statuses, families
    )
    progress_all = _progress(list(progress_by_batch.values()), families, sitting_of)
    spend = _spend(db, institution.id, subs, completed)

    # Same paper sat by two or more batches: each batch's sitting of it, like for like.
    same_paper = []
    for test_id in sorted({s["test_id"] for s in all_sittings}):
        here = [s for s in all_sittings if s["test_id"] == test_id]  # one per batch, newest first
        if len(here) < 2:
            continue
        same_paper.append({
            "rubric_id": here[0]["subs"][0].rubric_id,
            "test_name": _test_name(here[0]["subs"][0]),
            "rows": [
                {"batch_id": s["batch_id"], "batch_name": by_id[s["batch_id"]].name, "avg_pct": s["average_pct"],
                 "students": s["students"], "date": _ist_date(s["date"])}
                for s in sorted(here, key=lambda s: s["batch_id"])
            ],
            "_newest": _order(here[0]["subs"][0]),
        })
    same_paper.sort(key=lambda p: p["_newest"], reverse=True)
    for paper in same_paper:
        paper.pop("_newest")

    signals = _signals(
        graded=len(latest), at_risk=at_risk, release=release, batch_rows=batch_rows, progress=progress_all,
        movers=movers, gaps=gaps, held=held, failed=failed, behaviour=behaviour, spend=spend,
    )
    demo_count = sum(1 for s in subs if s.is_demo)
    by_status = {status: sum(1 for s in subs if s.status == status) for status in SubmissionStatus}
    sat_times = [_sat_at(s) for s in completed]

    return {
        "institution": result_view.institution_out(institution),
        "institutions": [result_view.institution_out(i) for i in institutions],
        "generated_at": now,
        "totals": {
            "students": len({_ref(s) for s in subs}),
            "students_graded": len(latest),
            "submissions": len(subs),
            "completed": len(completed),
            "human_review": by_status[SubmissionStatus.HUMAN_REVIEW_REQUIRED],
            "failed": by_status[SubmissionStatus.FAILED],
            "processing": by_status[SubmissionStatus.PENDING] + by_status[SubmissionStatus.PROCESSING],
            "average_pct": _mean(_pct(s) for s in latest),
            "released": release["sheets_released"],
            "provisional": release["sheets_provisional"],
            "batches": len(batches),
            "faculty": len(faculty),
            "tests": len({s["test_id"] for s in all_sittings}),
            "sheet_urgency_counts": _urgency_counts(completed),
        },
        "urgency_counts": _urgency_counts(latest),
        "batches": batch_rows,
        "faculty": faculty,
        "trend": _trend(by_id, all_sittings),
        "weakest_topics": [
            {"topic": g["topic"], "subject": g["subject"] or "", "mastery": g["mastery"]} for g in gaps[:WEAKEST_TOPICS]
        ],
        "operations": provenance.cohort_operations(db, subs=subs),
        "interventions": _interventions(db, institution.id),
        "is_demo": demo_count > 0,
        "demo_count": demo_count,
        "real_count": len(subs) - demo_count,
        "role_note": ROLE_NOTE,
        "period": {
            "first": _ist_date(min(sat_times)) if sat_times else None,
            "last": _ist_date(max(sat_times)) if sat_times else None,
        },
        "progress": progress_all,
        "progress_students": progress_students,
        "at_risk_students": at_risk,
        "release": release,
        "held_sheets": held,
        "failed_sheets": failed,
        "topic_gaps": gaps,
        "topic_gaps_hidden": hidden,
        "exam_behaviour": behaviour,
        "same_paper": same_paper,
        "signals": signals,
        "spend": spend,
        "operations_scope": _ops_scope(completed),
    }


def _ops_scope(completed: list[StudentSubmission]) -> dict[str, Any]:
    """How many sheets the operations figures cover: grading time is live-only, while the
    shared operations block averages tick-reading confidence over live and sample sheets."""
    live = [s for s in completed if not s.is_demo]
    with_conf = [s for s in completed if s.ocr_confidence is not None]
    live_conf = [float(s.ocr_confidence) for s in live if s.ocr_confidence is not None]
    return {
        "latency_sheets": sum(1 for s in live if provenance.latency_seconds(s) is not None),
        "confidence_sheets": len(with_conf),
        "confidence_sample_sheets": sum(1 for s in with_conf if s.is_demo),
        "live_confidence": round(fmean(live_conf), 3) if live_conf else None,
        "live_confidence_sheets": len(live_conf),
    }


def _trend(batches: dict[int, Batch], all_sittings: list[Sitting]) -> list[dict[str, Any]]:
    """One point per sitting, oldest first: the IST date of its newest sheet, its mean percentage,
    and whether it is a main (whole-class) sitting. Points of small sittings are never joined."""
    points = []
    for sitting in all_sittings:
        newest = sitting["subs"][0]
        points.append({
            "date": _ist_date(sitting["date"]),
            "batch_id": sitting["batch_id"],
            "batch_name": batches[sitting["batch_id"]].name,
            "test_name": _test_name(newest),
            "average_pct": sitting["average_pct"] or 0.0,
            "students": sitting["students"],
            "rubric_id": newest.rubric_id,
            "max_marks": float(newest.result.total_marks) if newest.result.total_marks else None,
            "main": sitting["is_class"],
            "_sort": _order(newest),
        })
    points.sort(key=lambda p: (p["date"], p["_sort"], p["batch_id"]))
    for point in points:
        point.pop("_sort")
    return points
