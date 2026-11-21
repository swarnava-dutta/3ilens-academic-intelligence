"""Student analytics: urgency, days-to-exam strategy, result extras, the Preparation ROI
engine v2 (study plan) and cohort extras.

Everything here is deterministic and must also work for OLD stored rows that lack the newer
report keys (defaults are filled in when the report is read).

* Urgency (classify_urgency, the one rule everywhere): >= 70% on_track, 55-70% needs_attention,
  < 55% at_risk; one level worse (capped) when 2+ topics have mastery < 40%.
* BRD ROI (insights.py) stays on roi_recommendations unchanged: weightage x (100 - mastery) /
  effort_hours, top 5, mastered >= 90% excluded. Engine v2 only feeds StudyPlan and the
  optional Priority fields (projected gain, target, range, qualitative rank).
* Engine v2 (build_study_plan), per topic, with an ILLUSTRATIVE chapter matrix
  (data/weightage/neet.json - sample data, not calibrated):
      gain_marks  = exam_marks x max(0, 85 - mastery) / 100
      roi         = gain_marks x time_factor / effort_hours
      target_mastery = max(mastery, 85): the level gain_marks and effort_hours (base hours) refer
      to; allocated_hours is this window's share of effort_hours, and the projected score credits
      min(1, allocated / effort) of each focus topic's gap.
      time_factor = 1.0 (>= 90 days) | 1 + 0.12 x exam_marks/26 (30-89) |
                    0.76 + 0.5 x error (7-29) | 0.5 + 0.62 x mastery/100 + 0.25 x error (< 7)
  plus mode rules (broad / focused / revision / consolidation) that change which topics are
  in the top 5 and what the student does with them. Projections are labelled illustrative.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from statistics import fmean
from typing import Any

from sqlalchemy.orm import Session

import insights
import marking
from config import get_settings
from database import Batch, EvaluationResult, Institution, Rubric, StudentSubmission, ist_today
from hashing import student_ref_for
from schemas import question_outcome

URGENCY_ON_TRACK = 70.0
URGENCY_AT_RISK = 55.0
LOW_TOPIC = 40.0
URGENCY_LEVELS = ("on_track", "needs_attention", "at_risk")
URGENCY_LABELS = {"on_track": "on track", "needs_attention": "needs attention", "at_risk": "at risk"}
URGENCY_RULE = (
    ">=70% on track, 55-70% needs attention, <55% at risk; one level worse when 2+ topics are below 40%"
)

MARKING_RULE = "Partial credit in 0.5-mark steps, clamped to each question max; totals summed server-side"
CALCULATION_VERSION = "roi-engine-v2-illustrative"
PROVISIONAL_NOTE = "All prescriptions are provisional pending teacher review."
PROJECTION_LABEL = "Illustrative - not a calibrated forecast"
FORECAST_REASON = "no calibrated effort-response data; NEET chapter matrix is illustrative"

# --- engine v2 parameters (illustrative, see module docstring) ------------------------------
TARGET_MASTERY = 85.0
WEAK_MASTERY = 70.0             # quadrant split: weak < 70 <= strong
FOUNDATIONAL_MASTERY = 40.0     # "heavy" topic: learn from scratch
CONSOLIDATION_MIN_MASTERY = 50.0
OVER_INVEST_MASTERY = 80.0
HIGH_ROI_SHARE = 0.5            # high ROI = >= half the student's best ROI (relative, not absolute)
LOW_RETURN_SHARE = 0.25
REVISION_BOOST = 1.25           # topics with confusions or repeated gaps, revision mode
FOCUS_SIZE = 5
RESCUE_SIZE = 3                 # topics kept when a mode rule would exclude every topic
TOPIC_GAP_MASTERY = 60.0        # cohort: a student "needs" a topic below this
EXAM_TOTAL_MARKS = 720.0
CHECKPOINT_MINUTES = 45
MAX_DAY_MINUTES = 240
NEET_SUBJECT_WEIGHTS = {"physics": 0.25, "chemistry": 0.25, "biology": 0.50, "botany": 0.25, "zoology": 0.25}

MATRIX_DIR = Path(__file__).resolve().parent / "data" / "weightage"
MATRIX_FILES = {"NEET": "neet.json"}
EXAM_OPTIONS: tuple[tuple[str, bool, str], ...] = (
    ("NEET", True, "Illustrative NEET chapter matrix (sample data, not calibrated)"),
    ("JEE Main", False, "Matrix not loaded in this PoC"),
    ("JEE Advanced", False, "Matrix not loaded in this PoC"),
    ("CAT", False, "Matrix not loaded in this PoC"),
    ("UPSC", False, "Matrix not loaded in this PoC"),
)

STRATEGY_TEXT = {
    "broad": ("Broad coverage", "Plenty of time: close foundational gaps across every assessed subject."),
    "focused": ("Focused improvement", "Concentrate study hours on the highest-return topics."),
    "revision": ("Revision sprint", "No large new topics this close to the exam: fix repeated errors."),
    "consolidation": ("Consolidation", "Final days: maintain secure topics and avoid new material."),
}
MODE_RULE = {
    "broad": "topics ranked by recoverable exam marks; foundational (<40%) topics allowed; one slot reserved "
             "per assessed subject with a gap",
    "focused": "topics ranked by ROI (marks recoverable per study hour, time factor 1 + 0.12 x exam marks/26)",
    "revision": "topics ranked by ROI with an error-rate time factor; no large new topics (effort above a third of "
                "the weekly budget, or mastery below 40%); topics with confusions or repeated gaps boosted 25%",
    "consolidation": "only topics at 50%+ mastery; maintain and secure marks, no new material",
}
TIME_FACTOR_RULE = {
    "broad": "1.0 (90+ days)",
    "focused": "1 + 0.12 x exam marks / 26 (30-89 days)",
    "revision": "0.76 + 0.5 x error rate (7-29 days)",
    "consolidation": "0.5 + 0.62 x mastery/100 + 0.25 x error rate (under 7 days)",
    None: "1.0 (exam date unknown - focused rule)",
}
ACTIVITY_NOTES = {
    "learn": "Concept lesson with worked examples, then 3 guided questions",
    "drill": "Timed practice on the missed question types",
    "fix_errors": "Re-attempt the missed questions, then 5 fresh items",
    "review": "Maintenance recall: 5 mixed questions",
}
ACTION_ACTIVITY = {"learn": "learn", "drill": "drill", "fix_errors": "fix_errors", "maintain": "review", "none": "review"}
_STOP = {"and", "the", "of", "in", "a", "an"}


# --------------------------------------------------------------------------- #
# REAL: urgency and exam-date rules (WP0)
# --------------------------------------------------------------------------- #
def percentage(result: EvaluationResult | Any) -> float:
    """Score as a 0-100 percentage of the rubric total (1 decimal)."""
    try:
        total = float(result.total_marks or 0)
        score = float(result.total_score or 0)
    except (TypeError, ValueError):
        return 0.0
    if total <= 0:
        return 0.0
    return round(max(0.0, min(100.0, score / total * 100.0)), 1)


def _fmt(value: float) -> str:
    return f"{value:g}" if float(value) == int(value) else f"{value:.1f}"


def classify_urgency(pct: float, topic_mastery: list[dict[str, Any]] | None) -> tuple[str, list[str]]:
    """>=70 on_track, 55-70 needs_attention, <55 at_risk; one level worse (capped at at_risk)
    when 2 or more topics have mastery < 40. Returns (urgency, reasons)."""
    pct = float(pct)
    if pct >= URGENCY_ON_TRACK:
        level = 0
        reasons = [f"Score {_fmt(pct)}% is in the on-track band (>= {_fmt(URGENCY_ON_TRACK)}%)."]
    elif pct >= URGENCY_AT_RISK:
        level = 1
        reasons = [
            f"Score {_fmt(pct)}% is in the needs-attention band "
            f"({_fmt(URGENCY_AT_RISK)}-{_fmt(URGENCY_ON_TRACK)}%)."
        ]
    else:
        level = 2
        reasons = [f"Score {_fmt(pct)}% is in the at-risk band (< {_fmt(URGENCY_AT_RISK)}%)."]

    low: list[tuple[str, float]] = []
    for topic in topic_mastery or []:
        if not isinstance(topic, dict):
            continue
        try:
            mastery = float(topic.get("mastery"))
        except (TypeError, ValueError):
            continue
        if mastery < LOW_TOPIC:
            low.append((str(topic.get("topic") or "Unnamed topic"), mastery))
    if low:
        listed = ", ".join(f"{name} ({_fmt(m)}%)" for name, m in low)
        if len(low) >= 2:
            if level < 2:
                level += 1
                reasons.append(f"{len(low)} topics below {_fmt(LOW_TOPIC)}%: {listed} - moved one level worse.")
            else:
                reasons.append(f"{len(low)} topics below {_fmt(LOW_TOPIC)}%: {listed}.")
        else:
            reasons.append(f"1 topic below {_fmt(LOW_TOPIC)}%: {listed}.")
    return URGENCY_LEVELS[level], reasons


def result_urgency(result: EvaluationResult) -> tuple[str, list[str], float]:
    pct = percentage(result)
    urgency, reasons = classify_urgency(pct, result.topic_mastery or [])
    return urgency, reasons, pct


def exam_date_for(batch: Batch | None) -> tuple[str | None, bool]:
    """(ISO exam date, assumed). NULL on the batch means the configured NEET_EXAM_DATE default."""
    stored = (getattr(batch, "exam_date", None) or "").strip() if batch is not None else ""
    if stored:
        return stored, False
    return get_settings().default_exam_date, True


def days_to_exam(batch: Batch | None, today: date | None = None) -> int | None:
    """Whole days from today (IST) to the batch's exam date; None if unknown or already past."""
    exam_date, _ = exam_date_for(batch)
    if not exam_date:
        return None
    try:
        exam = date.fromisoformat(exam_date)
    except ValueError:
        return None
    days = (exam - (today or ist_today())).days
    return days if days >= 0 else None


_days_to_exam = days_to_exam  # build_study_plan's keyword argument shadows the function name


def strategy_mode_for(days: int | None) -> str | None:
    """>= 90 broad, 30-89 focused, 7-29 revision, 0-6 consolidation; None when unknown."""
    if days is None:
        return None
    if days >= 90:
        return "broad"
    if days >= 30:
        return "focused"
    if days >= 7:
        return "revision"
    return "consolidation"


def _days_text(days: int | None) -> str:
    if days is None:
        return "exam date unknown"
    return f"{days} day{'s' if days != 1 else ''} to exam"


# --------------------------------------------------------------------------- #
# Weightage matrix (illustrative)
# --------------------------------------------------------------------------- #
def exam_options() -> list[dict[str, Any]]:
    return [{"exam": exam, "enabled": enabled, "note": note} for exam, enabled, note in EXAM_OPTIONS]


def _exam_key(exam: str | None) -> str:
    return (exam or "").strip().upper()


@lru_cache(maxsize=8)
def _load_matrix_file(name: str) -> dict[str, Any]:
    return json.loads((MATRIX_DIR / name).read_text(encoding="utf-8"))


def load_matrix(exam: str | None = "NEET") -> dict[str, Any] | None:
    """The chapter weightage matrix for an exam (read-only - do not mutate), or None."""
    name = MATRIX_FILES.get(_exam_key(exam))
    if name is None:
        return None
    try:
        return _load_matrix_file(name)
    except (OSError, ValueError):
        return None


def _key(text: Any) -> str:
    words = re.findall(r"[a-z0-9]+", str(text or "").casefold())
    return " ".join(w for w in words if w not in _STOP)


@lru_cache(maxsize=8)
def _matrix_index(name: str) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], float]:
    matrix = _load_matrix_file(name)
    by_name: dict[str, dict[str, Any]] = {}
    by_alias: dict[str, dict[str, Any]] = {}
    for row in matrix.get("chapters") or []:
        by_name.setdefault(_key(row.get("chapter")), row)
        for alias in row.get("aliases") or []:
            by_alias.setdefault(_key(alias), row)
    # Bottom third of the top-level chapters (sub-chapter rows carry a 'parent').
    marks = sorted(float(row.get("avg_marks") or 0) for row in matrix.get("chapters") or [] if not row.get("parent"))
    lower_third = marks[max(0, math.ceil(len(marks) / 3) - 1)] if marks else 0.0
    return by_name, by_alias, lower_third


def _subject_ok(row_subject: Any, subject: Any) -> bool:
    row, own = str(row_subject or "").casefold(), str(subject or "").casefold()
    known = {"physics", "chemistry", "biology", "botany", "zoology"}
    if own not in known or row == own:
        return True
    return row == "biology" and own in ("botany", "zoology")


def map_chapter(topic: str, subject: str | None, rubric_chapter: str | None, exam: str | None = "NEET") -> dict[str, Any] | None:
    """Matrix row for a topic: exact chapter name, then alias, then the rubric's chapter field."""
    name = MATRIX_FILES.get(_exam_key(exam))
    if name is None or load_matrix(exam) is None:
        return None
    by_name, by_alias, _ = _matrix_index(name)
    for candidate in (topic, rubric_chapter):
        key = _key(candidate)
        if not key:
            continue
        for index in (by_name, by_alias):
            row = index.get(key)
            if row is not None and _subject_ok(row.get("subject"), subject):
                return row
    return None


def default_effort_hours(topic: str, subject: str | None = None, chapter: str | None = None) -> float | None:
    """Matrix from_mid effort for a topic (rubric drafting default), or None when unmapped."""
    row = map_chapter(topic, subject, chapter)
    if row is None:
        return None
    return float((row.get("effort_hours") or {}).get("from_mid") or 0) or None


def _lower_third_marks(exam: str | None) -> float:
    name = MATRIX_FILES.get(_exam_key(exam))
    if name is None or load_matrix(exam) is None:
        return 0.0
    return _matrix_index(name)[2]


# --------------------------------------------------------------------------- #
# Defaults for stored lists (old rows lack the newer keys)
# --------------------------------------------------------------------------- #
def _rubric_questions(rubric: Rubric | None) -> list[dict[str, Any]]:
    content = (rubric.content if rubric is not None else None) or {}
    return [q for q in content.get("questions") or [] if isinstance(q, dict)]


def _criteria_by_question(rubric: Rubric | None) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {}
    for q in _rubric_questions(rubric):
        try:
            out[int(q.get("question"))] = [str(c) for c in q.get("grading_criteria") or [] if str(c).strip()]
        except (TypeError, ValueError):
            continue
    return out


def _question_items(result: EvaluationResult) -> list[dict[str, Any]]:
    items = []
    for raw in result.question_evaluations or []:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        item["outcome"] = item.get("outcome") or question_outcome(item)
        item.setdefault("source_pages", [])
        item.setdefault("uncertain_words", [])
        item.setdefault("corrected_by_faculty", False)
        items.append(item)
    return items


def _topic_items(result: EvaluationResult, questions: list[dict[str, Any]], rubric: Rubric | None) -> list[dict[str, Any]]:
    chapters: dict[str, str] = {}
    for q in _rubric_questions(rubric):
        if q.get("chapter") and q.get("topic"):
            chapters.setdefault(str(q["topic"]), str(q["chapter"]))
    by_topic: dict[str, list[dict[str, Any]]] = {}
    for q in questions:
        by_topic.setdefault(str(q.get("topic")), []).append(q)
    ranks = {
        str(p.get("topic")): index
        for index, p in enumerate(result.roi_recommendations or [], start=1)
        if isinstance(p, dict)
    }
    items = []
    for raw in result.topic_mastery or []:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        topic_questions = by_topic.get(str(item.get("topic")), [])
        outcomes = Counter(q["outcome"] for q in topic_questions)
        if not item.get("chapter"):
            item["chapter"] = chapters.get(str(item.get("topic")))
        item.setdefault("questions", [q.get("question") for q in topic_questions])
        item.setdefault("n", len(topic_questions))
        item.setdefault("full", outcomes["FULL"])
        item.setdefault("partial", outcomes["PARTIAL"])
        item.setdefault("zero", outcomes["ZERO"])
        item.setdefault("blank", outcomes["BLANK"])
        item["priority_rank"] = ranks.get(str(item.get("topic")))
        items.append(item)
    return items


def _nudge_items(result: EvaluationResult) -> list[dict[str, Any]]:
    items = []
    for raw in result.teaching_nudges or []:
        if not isinstance(raw, dict) or not raw.get("label") or not raw.get("text"):
            continue
        item = dict(raw)
        if item.get("priority") not in ("high", "medium", "low"):
            item["priority"] = "medium"
        item.setdefault("topic", None)
        item.setdefault("question_refs", [])
        if item.get("source") not in ("ai", "template", "faculty"):
            item["source"] = "ai"
        items.append(item)
    return items


def _confusion_items(result: EvaluationResult) -> list[dict[str, Any]]:
    items = []
    for raw in result.confusions or []:
        if isinstance(raw, dict) and raw.get("concept_a") and raw.get("concept_b"):
            item = dict(raw)
            item.setdefault("question", None)
            item.setdefault("evidence", "")
            items.append(item)
    return items[: insights.MAX_CONFUSIONS]


def outcome_counts(questions: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(q.get("outcome") or question_outcome(q) for q in questions)
    return {
        "full": counts["FULL"],
        "partial": counts["PARTIAL"],
        "zero": counts["ZERO"],
        "blank": counts["BLANK"],
        "mapped": sum(1 for q in questions if str(q.get("student_answer") or "").strip()),
        "total_questions": len(questions),
    }


def _subject_rollup(topics: list[dict[str, Any]], questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    subject_of = {str(t.get("topic")): str(t.get("subject") or "General") for t in topics}
    groups: dict[str, list[dict[str, Any]]] = {}
    for q in questions:
        groups.setdefault(subject_of.get(str(q.get("topic")), "General"), []).append(q)
    rollup = []
    for subject, items in groups.items():
        counts = outcome_counts(items)
        score = round(sum(float(q.get("estimated_marks") or 0) for q in items), 2)
        max_marks = round(sum(float(q.get("max_marks") or 0) for q in items), 2)
        rollup.append(
            {
                "subject": subject,
                "questions": len(items),
                "full": counts["full"],
                "partial": counts["partial"],
                "zero": counts["zero"],
                "blank": counts["blank"],
                "score": score,
                "max_marks": max_marks,
                "pct": round(score / max_marks * 100, 1) if max_marks > 0 else 0.0,
            }
        )
    return rollup


def _ocr_mean(questions: list[dict[str, Any]]) -> float | None:
    values = []
    for q in questions:
        if str(q.get("student_answer") or "").strip():
            try:
                values.append(float(q.get("confidence") or 0))
            except (TypeError, ValueError):
                continue
    return round(fmean(values), 3) if values else None


def _num(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(number) else number


def _g(value: float, digits: int = 2) -> str:
    """Compact number: 24.0 -> '24', 1.111 -> '1.11'."""
    rounded = round(float(value), digits)
    return f"{rounded:g}" if rounded == int(rounded) else f"{rounded:.{digits}f}".rstrip("0").rstrip(".")


def _short_topic(topic: str) -> str:
    words = [w for w in str(topic).split() if w not in ("&", "and", "-")]
    return " ".join(words[:2]) or str(topic)


# --------------------------------------------------------------------------- #
# Engine v2: study plan
# --------------------------------------------------------------------------- #
def _time_factor(days: int | None, exam_marks: float, mastery: float, err: float) -> float:
    if days is None or days >= 90:
        return 1.0
    if days >= 30:
        return 1.0 + 0.12 * (exam_marks / 26.0)
    if days >= 7:
        return 0.76 + 0.5 * err
    return 0.5 + 0.62 * (mastery / 100.0) + 0.25 * err


def _effort_band(mastery: float, bands: dict[str, Any]) -> float:
    if mastery < FOUNDATIONAL_MASTERY:
        value = bands.get("from_low")
    elif mastery < WEAK_MASTERY:
        value = bands.get("from_mid")
    else:
        value = bands.get("from_high")
    return _num(value)


def _plan_rows(
    topics: list[dict[str, Any]],
    questions: list[dict[str, Any]],
    confusions: list[dict[str, Any]],
    *,
    exam: str,
    days: int | None,
    ocr_mean: float | None,
) -> list[dict[str, Any]]:
    """One engine row per topic (with private helper keys prefixed by '_')."""
    matrix = load_matrix(exam) or {}
    matrix_conf = _num(matrix.get("confidence"), 0.3)
    topic_of_question = {q.get("question"): str(q.get("topic")) for q in questions}
    confused_topics = {topic_of_question.get(c.get("question")) for c in confusions if c.get("question") is not None}
    subject_totals: dict[str, float] = {}
    for t in topics:
        subject_totals[str(t.get("subject") or "General")] = subject_totals.get(str(t.get("subject") or "General"), 0.0) + _num(t.get("max_marks"))
    rows = []
    for t in topics:
        name = str(t.get("topic") or "")
        subject = str(t.get("subject") or "General")
        mastery = max(0.0, min(100.0, _num(t.get("mastery"))))
        max_marks, score = _num(t.get("max_marks")), _num(t.get("score"))
        row = map_chapter(name, subject, t.get("chapter"), exam)
        if row is not None:
            exam_marks = _num(row.get("avg_marks"))
            effort = _effort_band(mastery, row.get("effort_hours") or {})
            hist_err = row.get("historic_error_rate")
            confidence = _num(row.get("confidence"), matrix_conf)
            chapter = str(row.get("chapter"))
        else:
            weightage = t.get("weightage")
            if weightage is None:
                share = max_marks / subject_totals[subject] if subject_totals.get(subject) else 0.0
                weightage = NEET_SUBJECT_WEIGHTS.get(subject.casefold(), 1.0 / max(1, len(subject_totals))) * share
            exam_marks = _num(weightage) * EXAM_TOTAL_MARKS
            effort, hist_err, confidence = 0.0, None, matrix_conf
            chapter = t.get("chapter") or None
        if effort <= 0:
            effort = _num(t.get("effort_hours"), 1.0) or 1.0
        if max_marks > 0:
            err = max(0.0, min(1.0, (max_marks - score) / max_marks))
        else:
            err = _num(hist_err, 0.5)
        gain = exam_marks * max(0.0, TARGET_MASTERY - mastery) / 100.0
        factor = _time_factor(days, exam_marks, mastery, err)
        n = int(_num(t.get("n"), 0)) or sum(1 for q in questions if str(q.get("topic")) == name)
        not_full = n - int(_num(t.get("full"), 0))
        boosted = strategy_mode_for(days) == "revision" and (name in confused_topics or not_full >= 2)
        if boosted:
            factor *= REVISION_BOOST
        refs = [int(q) for q in t.get("questions") or [] if isinstance(q, (int, float))] or [
            int(q.get("question")) for q in questions if str(q.get("topic")) == name and isinstance(q.get("question"), int)
        ]
        rows.append(
            {
                "topic": name,
                "subject": subject,
                "chapter": chapter,
                "mastery": round(mastery, 1),
                "exam_marks": round(exam_marks, 2),
                "gain_marks": round(gain, 2),
                # The level gain_marks and effort_hours refer to (never the window's partial step).
                "target_mastery": round(max(mastery, TARGET_MASTERY), 1),
                "effort_hours": round(effort, 2),
                "time_factor": round(factor, 3),
                "roi": round(gain * factor / effort, 3),
                "allocated_hours": 0.0,
                "rank": None,
                "question_refs": sorted(set(refs)),
                "_mapped": row is not None,
                "_confidence": confidence,
                "_n": n,
                "_err": err,
                "_boosted": boosted,
                "_lost": max(0.0, max_marks - score),
                "_max_marks": max_marks,
                "_ocr_mean": ocr_mean,
            }
        )
    return rows


def _rank_key(mode: str):
    if mode == "broad":
        return lambda r: (-r["gain_marks"], -r["roi"], r["topic"])
    return lambda r: (-r["roi"], -r["gain_marks"], r["topic"])


def _mode_filter(
    eligible: list[dict[str, Any]], keep, reason, rescue_key
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Apply a mode's exclusion rule. When it would leave fewer than RESCUE_SIZE topics (e.g. an
    at-risk student with every topic below 40% two weeks out), the best excluded candidates by
    rescue_key stay in (marked _rescued) so a struggling student is never left with nothing to do."""
    kept = [r for r in eligible if keep(r)]
    dropped = [r for r in eligible if not keep(r)]
    rescued: list[dict[str, Any]] = []
    if len(kept) < RESCUE_SIZE and dropped:
        rescued = sorted(dropped, key=rescue_key)[: RESCUE_SIZE - len(kept)]
        for r in rescued:
            r["_rescued"] = True
    rescued_ids = {id(r) for r in rescued}
    deprioritised = [{"topic": r["topic"], "reason": reason(r)} for r in dropped if id(r) not in rescued_ids]
    return kept + rescued, deprioritised


def _select_focus(rows: list[dict[str, Any]], mode: str, days: int | None, study_hours: float) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    days_text = _days_text(days)
    eligible = [r for r in rows if r["gain_marks"] > 0]
    deprioritised: list[dict[str, str]] = []
    if mode == "revision":
        eligible, deprioritised = _mode_filter(
            eligible,
            keep=lambda r: r["effort_hours"] <= study_hours / 3 and r["mastery"] >= FOUNDATIONAL_MASTERY,
            reason=lambda r: (
                f"No large new topics this close to the exam ({days_text}): mastery {_g(r['mastery'], 1)}%, "
                f"{_g(r['exam_marks'])} exam marks, needs ~{_g(r['effort_hours'])} h "
                f"(over a third of {_g(study_hours)} h or below {_g(FOUNDATIONAL_MASTERY)}% mastery)."
            ),
            rescue_key=lambda r: (r["effort_hours"] > study_hours / 3, -r["roi"], r["topic"]),
        )
    elif mode == "consolidation":
        eligible, deprioritised = _mode_filter(
            eligible,
            keep=lambda r: r["mastery"] >= CONSOLIDATION_MIN_MASTERY,
            reason=lambda r: (
                f"Mastery {_g(r['mastery'], 1)}% is below {_g(CONSOLIDATION_MIN_MASTERY)}% - too little time "
                f"to secure it ({days_text}; {_g(r['exam_marks'])} exam marks). Protect marks in stronger topics."
            ),
            rescue_key=lambda r: (-r["mastery"], -r["roi"], r["topic"]),
        )

    ranked = sorted(eligible, key=_rank_key(mode))
    if mode == "broad":
        reserved: list[dict[str, Any]] = []
        seen_subjects: set[str] = set()
        for r in ranked:
            if r["subject"] not in seen_subjects:
                seen_subjects.add(r["subject"])
                reserved.append(r)
        reserved = reserved[:FOCUS_SIZE]
        rest = [r for r in ranked if r not in reserved]
        focus = sorted(reserved + rest[: FOCUS_SIZE - len(reserved)], key=_rank_key(mode))
    else:
        focus = ranked[:FOCUS_SIZE]
    for position, r in enumerate(ranked, start=1):
        if r in focus:
            continue
        deprioritised.append({
            "topic": r["topic"],
            "reason": (
                f"Ranked #{position} - outside this week's top {FOCUS_SIZE} ({MODE_RULE[mode].split(';')[0]}); "
                f"mastery {_g(r['mastery'], 1)}%, {_g(r['exam_marks'])} exam marks, ROI {r['roi']:.2f}, {days_text}. "
                "Revisit once P1-P3 reach target."
            ),
        })
    return focus, deprioritised


def _action(row: dict[str, Any], mode: str, in_focus: bool) -> str:
    if in_focus:
        if mode == "broad":
            return "learn" if row["mastery"] < FOUNDATIONAL_MASTERY else "drill"
        return {"focused": "drill", "revision": "fix_errors", "consolidation": "maintain"}[mode]
    return "maintain" if row["mastery"] >= TARGET_MASTERY else "none"


def _window_hours(study_hours: float, days: int | None) -> float:
    """Study hours before the next checkpoint: the weekly budget, or days/7 of it when the exam is
    under a week away (at least one day's worth)."""
    if days is not None and days < 7:
        return round(study_hours * max(1, days) / 7.0, 1)
    return float(study_hours)


def _allocate(focus: list[dict[str, Any]], study_hours: float) -> float:
    """Split the window's hours over the focus topics in half-hour steps, never above a topic's
    effort. Pass 1 gives every focus topic an equal share (so no ranked topic is left at 0 h with a
    positive projected gain); pass 2 tops up in rank order. Returns the unallocated hours."""
    remaining = float(study_hours)
    for row in focus:
        row["allocated_hours"] = 0.0
    if not focus:
        return round(max(0.0, remaining), 2)
    share = math.floor(remaining / len(focus) * 2) / 2
    for row in focus:
        hours = math.floor(min(row["effort_hours"], share, remaining) * 2) / 2
        row["allocated_hours"] = max(0.0, hours)
        remaining -= row["allocated_hours"]
    for row in focus:
        extra = math.floor(min(row["effort_hours"] - row["allocated_hours"], remaining) * 2) / 2
        if extra > 0:
            row["allocated_hours"] += extra
            remaining -= extra
    return round(max(0.0, remaining), 2)


def _ranges(row: dict[str, Any]) -> None:
    gain = row["gain_marks"]
    spread = (1.0 - max(0.0, min(1.0, row["_confidence"]))) * gain
    if row["_n"] <= 1 or row["_ocr_mean"] is None or row["_ocr_mean"] < 0.9:
        spread *= 1.5
    row["gain_low"] = round(max(0.0, gain - spread), 2)
    row["gain_high"] = round(gain + spread, 2)


def _quadrants(rows: list[dict[str, Any]], days: int | None) -> float:
    top = max((r["roi"] for r in rows), default=0.0)
    days_text = _days_text(days)
    for r in rows:
        weak = r["mastery"] < WEAK_MASTERY
        high = top > 0 and r["roi"] >= HIGH_ROI_SHARE * top
        r["quadrant"] = (
            ("priority_focus" if weak else "maintain") if high else ("deprioritise" if weak else "no_action")
        )
        r["quadrant_reason"] = (
            f"Mastery {_g(r['mastery'], 1)}% ({'weak, below' if weak else 'strong, at or above'} {_g(WEAK_MASTERY)}%); "
            f"ROI {r['roi']:.2f} is {'at least' if high else 'below'} half the top ROI {top:.2f} "
            f"({'high' if high else 'low'} return); {_g(r['exam_marks'])} exam marks; {days_text}."
        )
    return top


def _effort_flags(
    rows: list[dict[str, Any]], focus: list[dict[str, Any]], top: float, exam: str, days: int | None
) -> list[dict[str, str]]:
    flags = []
    days_text = _days_text(days)
    cutoff = _lower_third_marks(exam)
    first = focus[0]["topic"] if focus else None
    for r in rows:
        if r["mastery"] >= OVER_INVEST_MASTERY and cutoff > 0 and r["exam_marks"] <= cutoff:
            target = f"move the hours to #1 {first}" if first and first != r["topic"] else "move the hours to weaker topics"
            flags.append({
                "topic": r["topic"],
                "kind": "over_investing",
                "message": (
                    f"Mastery {_g(r['mastery'], 1)}% on a {_g(r['exam_marks'])}-mark chapter (bottom third of the "
                    f"illustrative matrix, <= {_g(cutoff)} marks; {days_text}): maintain with a 20-minute weekly "
                    f"refresher; {target}."
                ),
            })
        elif r["mastery"] < WEAK_MASTERY and top > 0 and r["roi"] < LOW_RETURN_SHARE * top:
            flags.append({
                "topic": r["topic"],
                "kind": "low_marginal_return",
                "message": (
                    f"Mastery {_g(r['mastery'], 1)}% but ROI {r['roi']:.2f} is under a quarter of the top ROI "
                    f"{top:.2f} ({_g(r['exam_marks'])} exam marks, ~{_g(r['effort_hours'])} h, {days_text}): "
                    "defer until P1-P3 reach target."
                ),
            })
    return flags


def _projected(rows: list[dict[str, Any]], focus: list[dict[str, Any]], current: float) -> dict[str, Any]:
    weight = sum(r["_max_marks"] for r in rows)
    delta = low = high = 0.0
    if weight > 0:
        for r in focus:
            # Credit this window's share of the gap: allocated / effort hours of the way to target.
            share = min(1.0, r["allocated_hours"] / r["effort_hours"]) if r["effort_hours"] > 0 else 0.0
            improvement = share * max(0.0, r["target_mastery"] - r["mastery"])
            gain = r["gain_marks"]
            ratio_low = r["gain_low"] / gain if gain > 0 else 1.0
            ratio_high = r["gain_high"] / gain if gain > 0 else 1.0
            delta += r["_max_marks"] * improvement
            low += r["_max_marks"] * improvement * ratio_low
            high += r["_max_marks"] * improvement * ratio_high
        delta, low, high = delta / weight, low / weight, high / weight
    return {
        "current": round(current, 1),
        "expected": round(min(100.0, current + delta), 1),
        "low": round(min(100.0, current + low), 1),
        "high": round(min(100.0, current + high), 1),
        "scale_max": 100.0,
        "label": PROJECTION_LABEL,
    }


def _blocks(minutes: int) -> list[int]:
    """Split minutes (multiple of 30) into 30-60 minute blocks."""
    out = []
    while minutes > 0:
        size = 60 if minutes >= 60 else 30
        out.append(size)
        minutes -= size
    return out


def _round30(minutes: float) -> int:
    return int(math.ceil(max(0.0, minutes) / 30.0)) * 30


def _block_note(row: dict[str, Any], activity: str) -> str:
    refs = ", ".join(f"Q{n}" for n in row.get("question_refs") or [])
    base = ACTIVITY_NOTES.get(activity, ACTIVITY_NOTES["review"])
    return f"{base} ({refs})" if refs and activity != "review" else base


def _calendar(
    rows: list[dict[str, Any]], focus: list[dict[str, Any]], days: int | None, start: date
) -> list[dict[str, Any]]:
    """7 days (or days_to_exam when 1-6): study days of 30-60 minute blocks from the allocated
    hours, then a 45-minute checkpoint mini-test. Rules: at most 2 topics a day; at most 1 heavy
    (mastery < 40%) topic a day, paired with a maintenance topic; a heavy topic never on two
    consecutive days; subjects interleaved. Topics with the most minutes still to place per
    remaining slot go first, so a large heavy topic is spread over alternate days."""
    n_days = 7 if days is None or days >= 7 else max(1, days)
    has_checkpoint = n_days >= 2
    study_days = n_days - 1 if has_checkpoint else n_days
    remaining = {r["topic"]: _round30(r["allocated_hours"] * 60) for r in focus if r["allocated_hours"] > 0}
    heavy = {r["topic"] for r in rows if r["mastery"] < FOUNDATIONAL_MASTERY}
    by_topic = {r["topic"]: r for r in rows}
    order = {r["topic"]: i for i, r in enumerate(focus)}
    secure = [r for r in rows if r["topic"] not in heavy and r["mastery"] >= WEAK_MASTERY]
    maintenance = sorted(
        secure or [r for r in rows if r["topic"] not in heavy],
        key=lambda r: (r["topic"] in remaining, -r["mastery"], r["topic"]),
    )

    def activity_of(row: dict[str, Any]) -> str:
        return ACTION_ACTIVITY.get(row.get("action") or "none", "review")

    calendar: list[dict[str, Any]] = []
    prev_heavy: str | None = None
    prev_subjects: set[str] = set()
    rotation = 0
    for day in range(1, study_days + 1):
        days_left = study_days - day + 1

        def need(topic: str) -> float:
            slots = math.ceil(days_left / 2) if topic in heavy else days_left
            return remaining[topic] / max(1, slots)

        avail = [t for t in remaining if remaining[t] > 0 and t != prev_heavy]
        plan: list[tuple[dict[str, Any], int, str]] = []  # (row, minutes, activity) per topic
        if avail:
            primary = max(
                avail, key=lambda t: (need(t), by_topic[t]["subject"] not in prev_subjects, -order[t])
            )
            # A heavy primary is paired with a maintenance topic, never with a second study topic.
            others = [] if primary in heavy else [t for t in avail if t != primary]
            secondary = (
                max(others, key=lambda t: (
                    by_topic[t]["subject"] != by_topic[primary]["subject"], need(t), -order[t]
                ))
                if others else None
            )
            partner = None
            if secondary is None and primary in heavy:
                partner = next((r for r in maintenance if r["topic"] != primary), None)
            reserve = 30 if (secondary is not None or partner is not None) else 0
            p_minutes = min(remaining[primary], max(30, _round30(need(primary))), MAX_DAY_MINUTES - reserve)
            plan.append((by_topic[primary], p_minutes, activity_of(by_topic[primary])))
            remaining[primary] -= p_minutes
            if secondary is not None:
                s_minutes = min(remaining[secondary], max(30, _round30(need(secondary))), MAX_DAY_MINUTES - p_minutes)
                if s_minutes > 0:
                    plan.append((by_topic[secondary], s_minutes, activity_of(by_topic[secondary])))
                    remaining[secondary] -= s_minutes
            elif partner is not None:
                plan.append((partner, 30, "review"))
        elif any(remaining.values()) and maintenance:
            partner = maintenance[rotation % len(maintenance)]
            rotation += 1
            plan.append((partner, 30, "review"))
        elif focus or maintenance:
            pool = focus or maintenance
            row = pool[rotation % len(pool)]
            rotation += 1
            plan.append((row, 30, "review"))

        blocks: list[dict[str, Any]] = []
        groups = [[(row, m, activity) for m in _blocks(minutes)] for row, minutes, activity in plan]
        for i in range(max((len(g) for g in groups), default=0)):  # interleave the two topics
            for group in groups:
                if i < len(group):
                    row, minutes, activity = group[i]
                    if activity != "review" or row["topic"] in remaining:
                        note = _block_note(row, activity)
                    elif any(remaining.values()) and prev_heavy and not avail:
                        note = "Rest day for the heavy topic: maintenance recall only"
                    elif len(plan) > 1:
                        note = "Maintenance pairing: keep a secure topic warm (5 mixed questions)"
                    else:
                        note = "Spaced review of the week's work (5 mixed questions)"
                    blocks.append({"topic": row["topic"], "minutes": minutes, "activity": activity, "note": note})
        today = [row["topic"] for row, _m, _a in plan]
        prev_heavy = next((t for t in today if t in heavy and t in remaining), None)
        prev_subjects = {by_topic[t]["subject"] for t in today if t in by_topic}
        calendar.append({"day": day, "date": (start + timedelta(days=day - 1)).isoformat(), "blocks": blocks})
    if has_checkpoint:
        names = ", ".join(r["topic"] for r in focus) or "all assessed topics"
        calendar.append({
            "day": n_days,
            "date": (start + timedelta(days=n_days - 1)).isoformat(),
            "blocks": [{
                "topic": "Checkpoint mini-test",
                "minutes": CHECKPOINT_MINUTES,
                "activity": "checkpoint",
                "note": f"{CHECKPOINT_MINUTES}-minute mini-test on this week's topics ({names}); target >=4/5 per topic.",
            }],
        })
    return calendar


def _roadmap(focus: list[dict[str, Any]], rows: list[dict[str, Any]], days: int | None) -> list[dict[str, Any]]:
    labels = [f"P{i} {r['topic']}" for i, r in enumerate(focus[:3], start=1)]
    p1 = labels[0] if labels else "the weakest topic"
    rest = " and ".join(labels[1:3]) if len(labels) > 1 else "the next weakest topics"
    all_p = " / ".join(labels) if labels else "the priority topics"
    secure = [r["topic"] for r in sorted(rows, key=lambda r: -r["mastery"]) if r["mastery"] >= WEAK_MASTERY][:2]
    secure_text = ", ".join(secure) if secure else "the secure topics"
    days_text = _days_text(days)

    def applicable(start: int) -> bool:
        return days is None or days >= start

    return [
        {
            "horizon": "7",
            "title": "Initial diagnostic correction",
            "days_label": "Days 1-7",
            "tasks": [
                f"Correct the diagnosed errors in {p1} from the trigger questions",
                f"Targeted practice on {rest}",
                "Teacher-administered fresh mixed checkpoint at the end of the week",
            ],
            "checkpoint": "Measure correct/attempted on distinct new items per topic; flag unreviewed teacher-key disagreements.",
            "condition": f"Applies now ({days_text}); adjusted to the actual exam date.",
            "applicable": True,
        },
        {
            "horizon": "30",
            "title": "Four-week consolidation",
            "days_label": "Days 8-30",
            "tasks": [
                f"Rotate {all_p} lessons with corrected explanations",
                "Weekly distinct-item mini-tests with dates and question IDs",
                f"Keep {secure_text} warm with a short weekly refresher",
                "Teacher reviews error causes from worked steps only",
            ],
            "checkpoint": "Track new-item accuracy by topic, not repeated same answers.",
            "condition": f"Only if at least 8 days remain before the exam ({days_text}).",
            "applicable": applicable(8),
        },
        {
            "horizon": "60",
            "title": "Transfer across formats",
            "days_label": "Days 31-60",
            "tasks": [
                "Mixed-topic novel questions across every assessed subject",
                "Cross-check diagram and calculation reasoning",
                "Compare only blueprint-equated assessments",
                "Re-rank the priorities from new comparable evidence",
            ],
            "checkpoint": "At least two comparable follow-up assessments per priority topic.",
            "condition": f"Only if at least 31 days remain before the exam ({days_text}).",
            "applicable": applicable(31),
        },
        {
            "horizon": "90",
            "title": "Syllabus consolidation",
            "days_label": "Days 61-90",
            "tasks": [
                "Educator-calibrated full-syllabus tests",
                "Retest every remaining weak cluster",
                "Calibrate effort and ROI against historical weightage before trusting projections",
                "Prepare the final targeted revision from the evidence",
            ],
            "checkpoint": "Comparable test progression and documented revision priorities.",
            "condition": f"Only if at least 61 days remain before the exam ({days_text}).",
            "applicable": applicable(61),
        },
    ]


def _explanation(row: dict[str, Any] | None, mode: str, days: int | None) -> dict[str, Any] | None:
    if row is None:
        return None
    rule = TIME_FACTOR_RULE[mode if days is not None else None]
    boost = f" incl. x{REVISION_BOOST:g} repeated-error boost" if row["_boosted"] else ""
    return {
        "topic": row["topic"],
        "formula": (
            f"ROI = exam marks x ({_g(TARGET_MASTERY)} - mastery)/100 x time factor / effort hours; "
            f"time factor {rule}{boost}; {_days_text(days)}."
        ),
        "arithmetic": (
            f"{_g(row['exam_marks'])} marks x ({_g(TARGET_MASTERY)} - {_g(row['mastery'], 1)})/100 x "
            f"{row['time_factor']:.3f} / {_g(row['effort_hours'])} h = {row['roi']:.2f} "
            f"(mastery {_g(row['mastery'], 1)}%, {_g(row['exam_marks'])} exam marks, {_days_text(days)})"
        ),
        "inputs": {
            "exam_marks": row["exam_marks"],
            "mastery": row["mastery"],
            "target_mastery": TARGET_MASTERY,
            "time_factor": row["time_factor"],
            "effort_hours": row["effort_hours"],
            "roi": row["roi"],
        },
    }


def _strategy(mode: str, days: int | None, exam: str, exam_date: str | None, assumed: bool, study_hours: float) -> tuple[str, str]:
    title, text = STRATEGY_TEXT[mode]
    when = f"{exam} on {exam_date}{' (assumed date)' if assumed else ''}" if exam_date else exam
    if days is None:
        return f"Exam date unknown · {title}", (
            f"{text} No usable exam date for {exam}: the focused rule is used with time factor 1. "
            f"Rule: {MODE_RULE['focused']}. Budget {_g(study_hours)} h this week."
        )
    return f"{days} days left · {title}", (
        f"{text} {days} day{'s' if days != 1 else ''} to {when}. Rule: {MODE_RULE[mode]}. "
        f"Budget {_g(study_hours)} h this week."
    )


def _plan(
    topics: list[dict[str, Any]],
    questions: list[dict[str, Any]],
    confusions: list[dict[str, Any]],
    *,
    current_pct: float,
    batch: Batch | None,
    days: int | None,
    exam_date: str | None,
    assumed: bool,
    study_hours: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(StudyPlan dict, engine rows incl. private keys)."""
    settings = get_settings()
    exam = (getattr(batch, "exam", None) or settings.default_exam) if batch is not None else settings.default_exam
    matrix = load_matrix(exam) or load_matrix("NEET") or {}
    mode = strategy_mode_for(days) or "focused"
    rows = _plan_rows(topics, questions, confusions, exam=exam, days=days, ocr_mean=_ocr_mean(questions))
    focus, deprioritised = _select_focus(rows, mode, days, study_hours)
    # Hours until the next checkpoint: the weekly budget, pro-rated when the exam is under 7 days away.
    window_hours = _window_hours(study_hours, days)
    leftover = _allocate(focus, window_hours)
    focus_ids = {id(r) for r in focus}
    for rank, r in enumerate(focus, start=1):
        r["rank"] = rank
    for r in rows:
        in_focus = id(r) in focus_ids
        r["action"] = _action(r, mode, in_focus)
        _ranges(r)
    top = _quadrants(rows, days)
    ordered = focus + sorted((r for r in rows if id(r) not in focus_ids), key=_rank_key(mode))
    title, text = _strategy(mode, days, exam, exam_date, assumed, study_hours)
    rescued = [r["topic"] for r in focus if r.get("_rescued")]
    if rescued:
        cut = (
            f"above a third of {_g(study_hours)} h or below {_g(FOUNDATIONAL_MASTERY)}% mastery"
            if mode == "revision" else f"below {_g(CONSOLIDATION_MIN_MASTERY)}% mastery"
        )
        text += (
            f" Fewer than {RESCUE_SIZE} topics pass the cut-off ({cut}), so {', '.join(rescued)} "
            f"{'stays' if len(rescued) == 1 else 'stay'} in the plan as the most workable; review with the teacher."
        )
    parts = [f"{_short_topic(r['topic'])} {_g(r['allocated_hours'])} h" for r in focus if r["allocated_hours"] > 0]
    if leftover > 0 and parts:
        parts.append(f"{_g(leftover)} h mixed revision")
    window = f"Next {_g(window_hours, 1)} h" + (
        f" ({_days_text(days)}; {_g(study_hours)} h/week pro-rated)" if window_hours < study_hours else ""
    )
    if parts:
        note = f"{window}: " + " · ".join(parts)
    elif any(r["mastery"] < TARGET_MASTERY for r in rows):
        note = f"{window}: mixed timed practice; the weaker topics are deferred (see deprioritised)."
    else:
        note = f"{window}: no topic below {_g(TARGET_MASTERY)}% - mixed timed practice."
    public_keys = (
        "topic", "subject", "chapter", "mastery", "exam_marks", "gain_marks", "gain_low", "gain_high",
        "target_mastery", "effort_hours", "time_factor", "roi", "quadrant", "quadrant_reason", "action",
        "allocated_hours", "rank", "question_refs",
    )

    def public(r: dict[str, Any]) -> dict[str, Any]:
        return {k: r[k] for k in public_keys}

    plan = {
        "calculation_version": CALCULATION_VERSION,
        "matrix_version": str(matrix.get("version") or "none"),
        "exam": exam,
        "exam_date": exam_date,
        "days_to_exam": days,
        "strategy_mode": mode,
        "strategy_title": title,
        "strategy_text": text,
        "study_hours": float(study_hours),
        "calibrated": False,
        "topics": [public(r) for r in ordered],
        "focus": [public(r) for r in focus],
        "deprioritised": deprioritised,
        "effort_flags": _effort_flags(rows, focus, top, exam, days),
        "projected_score": _projected(rows, focus, current_pct),
        "weekly_calendar": _calendar(rows, focus, days, ist_today()),
        "roadmap": _roadmap(focus, rows, days),
        "explanation": _explanation(focus[0] if focus else None, mode, days),
        "allocation_note": note,
    }
    return plan, rows


def _plan_inputs(
    result: EvaluationResult, rubric: Rubric | None, batch: Batch | None, days_override: int | None
) -> tuple[int | None, str | None, bool]:
    if days_override is not None:
        days = max(0, int(days_override))
        return days, (ist_today() + timedelta(days=days)).isoformat(), False
    exam_date, assumed = exam_date_for(batch)
    return _days_to_exam(batch), exam_date, assumed


def build_study_plan(
    *,
    result: EvaluationResult,
    rubric: Rubric,
    batch: Batch,
    days_to_exam: int | None = None,
    study_hours: float | None = None,
) -> dict[str, Any]:
    """A StudyPlan dict (engine v2). days_to_exam / study_hours override the batch date and
    STUDY_HOURS_PER_WEEK (what-if planning); everything is deterministic."""
    plan, _rows = _study_plan_with_rows(
        result=result, rubric=rubric, batch=batch, days_override=days_to_exam, study_hours=study_hours
    )
    return plan


def _study_plan_with_rows(
    *, result: EvaluationResult, rubric: Rubric | None, batch: Batch | None,
    days_override: int | None = None, study_hours: float | None = None,
    questions: list[dict[str, Any]] | None = None, topics: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    hours = float(study_hours if study_hours is not None else get_settings().default_study_hours)
    hours = max(1.0, min(80.0, hours))
    questions = questions if questions is not None else _question_items(result)
    topics = topics if topics is not None else _topic_items(result, questions, rubric)
    days, exam_date, assumed = _plan_inputs(result, rubric, batch, days_override)
    return _plan(
        topics, questions, _confusion_items(result),
        current_pct=percentage(result), batch=batch, days=days, exam_date=exam_date, assumed=assumed,
        study_hours=hours,
    )


# --------------------------------------------------------------------------- #
# Result extras
# --------------------------------------------------------------------------- #
def _strongest_weakest(topics: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not topics:
        return None, None
    strongest = min(topics, key=lambda t: (-_num(t.get("mastery")), -_num(t.get("max_marks")), str(t.get("topic"))))
    weakest = min(
        topics,
        key=lambda t: (_num(t.get("mastery")), -(_num(t.get("max_marks")) - _num(t.get("score"))), str(t.get("topic"))),
    )
    return strongest, weakest


def _frac(t: dict[str, Any]) -> str:
    return f"{_g(_num(t.get('score')))}/{_g(_num(t.get('max_marks')))}"


def _executive_summary(
    result: EvaluationResult, questions: list[dict[str, Any]], topics: list[dict[str, Any]],
    priorities: list[dict[str, Any]], pct: float,
) -> list[str]:
    counts = outcome_counts(questions)
    mean = _ocr_mean(questions)
    coverage = (
        f"{counts['mapped']} of {counts['total_questions']} rubric questions transcribed and mapped; "
        + (f"mean OCR confidence {mean:.2f}; " if mean is not None else "mean OCR confidence not recorded; ")
        + f"{counts['blank']} blank ({counts['full']} full, {counts['partial']} partial, {counts['zero']} zero marks)."
    )
    strongest, weakest = _strongest_weakest(topics)
    result_line = f"Draft result {_g(_num(result.total_score))}/{_g(_num(result.total_marks))} ({_g(pct, 1)}%)."
    if strongest is not None and weakest is not None and strongest is not weakest:
        result_line += (
            f" Strongest topic: {strongest.get('topic')} ({_frac(strongest)}); "
            f"weakest topic: {weakest.get('topic')} ({_frac(weakest)})."
        )
    elif strongest is not None:
        result_line += f" Only topic assessed: {strongest.get('topic')} ({_frac(strongest)})."
    actions = []
    for index, p in enumerate(priorities[:2], start=1):
        intervention = p.get("intervention") or {}
        teach = str(intervention.get("teach") or f"Re-teach {p.get('topic')}").rstrip(".")
        actions.append(f"P{index} {p.get('topic')} - {teach}")
    if actions:
        action_line = f"Highest-value actions: {'; '.join(actions)}. {PROVISIONAL_NOTE}"
    else:
        action_line = f"No topic is below {_g(insights.MASTERED_THRESHOLD)}%: maintain with timed mixed practice. {PROVISIONAL_NOTE}"
    return [coverage, result_line, action_line]


def summary_line(result: EvaluationResult, rubric: Rubric | None = None) -> str:
    """Deterministic one-line summary (for student cards / PDFs when no AI summary was stored)."""
    urgency, _reasons, pct = result_urgency(result)
    questions = _question_items(result)
    topics = _topic_items(result, questions, rubric)
    priorities = [p for p in result.roi_recommendations or [] if isinstance(p, dict)]
    return _summary_line(result, topics, priorities, pct, urgency)


def _summary_line(result: EvaluationResult, topics: list[dict[str, Any]], priorities: list[dict[str, Any]], pct: float, urgency: str) -> str:
    strongest, weakest = _strongest_weakest(topics)
    line = f"Scored {_g(_num(result.total_score))}/{_g(_num(result.total_marks))} ({_g(pct, 1)}%, {URGENCY_LABELS[urgency]})"
    if strongest is not None and weakest is not None and strongest is not weakest:
        line += f"; strongest {strongest.get('topic')} ({_frac(strongest)}), weakest {weakest.get('topic')} ({_frac(weakest)})"
    if priorities:
        line += f"; top priority {priorities[0].get('topic')}"
    return line + "."


def _qualitative_ranks(priorities: list[dict[str, Any]], topics: list[dict[str, Any]]) -> dict[str, int]:
    by_topic = {str(t.get("topic")): t for t in topics}

    def key(p: dict[str, Any]) -> tuple:
        t = by_topic.get(str(p.get("topic")), {})
        lost = _num(t.get("max_marks")) - _num(t.get("score"))
        return (-lost, -int(_num(t.get("blank"))), -int(_num(t.get("n"))), str(p.get("topic")))

    return {str(p.get("topic")): rank for rank, p in enumerate(sorted(priorities, key=key), start=1)}


def _priority_items(
    result: EvaluationResult,
    questions: list[dict[str, Any]],
    topics: list[dict[str, Any]],
    rubric: Rubric | None,
    plan: dict[str, Any] | None = None,
    rows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    stored = [dict(p) for p in result.roi_recommendations or [] if isinstance(p, dict)]
    criteria = _criteria_by_question(rubric)
    qualitative = _qualitative_ranks(stored, topics)
    by_topic = {r["topic"]: r for r in rows or []}
    days = plan.get("days_to_exam") if plan else None
    mode = plan.get("strategy_mode") if plan else None
    items = []
    for item in stored:
        topic = str(item.get("topic") or "")
        row = by_topic.get(topic)
        if not isinstance(item.get("trigger_questions"), list):
            item["trigger_questions"] = insights.trigger_questions(topic, questions)
        if not isinstance(item.get("intervention"), dict):
            item["intervention"] = insights.topic_intervention(topic, questions, criteria)
        item["projected_gain_marks"] = row["gain_marks"] if row else None
        item["target_mastery"] = row["target_mastery"] if row else None
        item["gain_low"] = row["gain_low"] if row else None
        item["gain_high"] = row["gain_high"] if row else None
        item["qualitative_rank"] = qualitative.get(topic)
        item["calibrated"] = False
        rationale = str(item.get("rationale") or "")
        if row is not None and "Illustrative matrix:" not in rationale:
            placement = f"study-plan rank #{row['rank']}" if row.get("rank") else "outside this week's study-plan top 5"
            item["rationale"] = (
                f"{rationale} Illustrative matrix: {_g(row['exam_marks'])} of {_g(EXAM_TOTAL_MARKS)} exam marks; "
                f"{_days_text(days)} ({mode} mode): {placement}."
            ).strip()
        items.append(item)
    return items


def result_extras(
    db: Session,
    *,
    sub: StudentSubmission,
    result: EvaluationResult,
    rubric: Rubric,
    batch: Batch,
    institution: Institution,
) -> dict[str, Any]:
    """Keys: urgency, urgency_reasons, percentage, summary, executive_summary, teaching_nudges,
    confusions, outcome_counts, subject_rollup, scoring_controls, roi_basis, study_plan,
    topic_mastery, roi_recommendations, question_evaluations (the last three replace the
    stored lists in result_view.build_result)."""
    urgency, reasons, pct = result_urgency(result)
    questions = _question_items(result)
    topics = _topic_items(result, questions, rubric)
    plan, rows = _study_plan_with_rows(result=result, rubric=rubric, batch=batch, questions=questions, topics=topics)
    priorities = _priority_items(result, questions, topics, rubric, plan, rows)
    item_sum = round(sum(float(q.get("estimated_marks") or 0) for q in questions), 4)
    matrix = load_matrix(plan["exam"]) or {}
    stored_summary = " ".join(str(result.summary or "").split())
    return {
        "urgency": urgency,
        "urgency_reasons": reasons,
        "percentage": pct,
        # The AI summary when one was stored; null otherwise (the frozen contract test pins null for
        # rows without one) - executive_summary always carries the deterministic narrative.
        "summary": stored_summary or None,
        "executive_summary": _executive_summary(result, questions, topics, priorities, pct),
        "teaching_nudges": _nudges(result, priorities, questions),
        "confusions": _confusion_items(result),
        "outcome_counts": outcome_counts(questions),
        "subject_rollup": _subject_rollup(topics, questions),
        "scoring_controls": {
            # DEFAULT_MARKING_RULE (== MARKING_RULE) unless the rubric has MCQs or a marking policy.
            "marking_rule": marking.marking_rule_text(rubric.content if rubric is not None else None),
            "rubric_version": rubric.version,
            "rubric_status": rubric.status if rubric.status in ("AUTHOR_DRAFT", "FACULTY_APPROVED") else "AUTHOR_DRAFT",
            "rubric_hash": result.rubric_hash or rubric.rubric_hash or "",
            "item_sum": item_sum,
            "reported_total": float(result.total_score),
            "parity": abs(item_sum - float(result.total_score)) < 1e-6,
            "llm_total_used": False,
        },
        "roi_basis": {
            "calculation_version": CALCULATION_VERSION,
            "matrix_version": str(matrix.get("version") or "none"),
            "weightage_source": str(matrix.get("source") or "NEET subject weights x rubric marks share"),
            "effort_source": "Matrix effort bands by mastery (from_low <40%, from_mid 40-70%, from_high 70%+); "
                             "rubric effort_hours for unmapped topics",
            "forecast_status": "UNAVAILABLE",
            "reason": FORECAST_REASON,
            "calibrated": False,
        },
        "study_plan": plan,
        "topic_mastery": topics,
        "roi_recommendations": priorities,
        # Legacy and seeded rows gain the wave-2 question keys at read time (never re-scored).
        "question_evaluations": marking.annotate_questions(questions, rubric.content if rubric is not None else None),
    }


def _nudges(result: EvaluationResult, priorities: list[dict[str, Any]], questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stored = _nudge_items(result)
    if len(stored) >= insights.MIN_NUDGES:
        return stored[: insights.MAX_NUDGES]
    return insights.top_up_nudges(stored, priorities, questions)


def nudges_for(result: EvaluationResult) -> list[dict[str, Any]]:
    """TeachingNudge dicts for a student card: the stored nudges, else deterministic templates."""
    questions = _question_items(result)
    priorities = [p for p in result.roi_recommendations or [] if isinstance(p, dict)]
    return _nudges(result, priorities, questions)


def focus_items(
    *, result: EvaluationResult, rubric: Rubric, batch: Batch, limit: int = 3
) -> list[dict[str, Any]]:
    """FocusItem dicts: the top study-plan focus topics (engine v2) with their quadrant."""
    plan = build_study_plan(result=result, rubric=rubric, batch=batch)
    return [
        {
            "topic": row["topic"],
            "roi": row["roi"],
            "rank": int(row["rank"] or index),
            "projected_gain_marks": row["gain_marks"],
            "quadrant": row["quadrant"],
        }
        for index, row in enumerate(plan["focus"][: max(0, limit)], start=1)
    ]


# --------------------------------------------------------------------------- #
# Cohort extras
# --------------------------------------------------------------------------- #
def _norm(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


def _common_errors(pairs: list[tuple[StudentSubmission, EvaluationResult]]) -> list[dict[str, Any]]:
    """Grader gaps shared by 2+ students, grouped by (question, topic, case/whitespace-normalised
    text) - the topic keeps Q3 of two different tests apart in a mixed-rubric cohort."""
    groups: dict[tuple[int, str, str], dict[str, Any]] = {}
    for sub, result in pairs:
        for q in result.question_evaluations or []:
            if not isinstance(q, dict) or not isinstance(q.get("question"), int):
                continue
            for gap in q.get("gaps") or []:
                text = " ".join(str(gap or "").split())
                if not text:
                    continue
                group = groups.setdefault(
                    (q["question"], _norm(q.get("topic")), _norm(text)),
                    {"question": q["question"], "topic": str(q.get("topic") or ""), "error": text, "students": []},
                )
                if sub.student_name not in group["students"]:
                    group["students"].append(sub.student_name)
    denominator = len(pairs)
    rows = [
        {**g, "count": len(g["students"]), "denominator": denominator}
        for g in groups.values() if len(g["students"]) >= 2
    ]
    rows.sort(key=lambda r: (-r["count"], r["question"], r["error"].casefold()))
    return [
        {"question": r["question"], "topic": r["topic"], "error": r["error"], "count": r["count"],
         "denominator": r["denominator"], "students": r["students"]}
        for r in rows[:8]
    ]


def _confusion_clusters(pairs: list[tuple[StudentSubmission, EvaluationResult]]) -> list[dict[str, Any]]:
    clusters: dict[tuple[str, str], dict[str, Any]] = {}
    for sub, result in pairs:
        for c in _confusion_items(result):
            key = tuple(sorted((_norm(c["concept_a"]), _norm(c["concept_b"]))))
            cluster = clusters.setdefault(
                key, {"concept_a": str(c["concept_a"]).strip(), "concept_b": str(c["concept_b"]).strip(), "students": []}
            )
            if sub.student_name not in cluster["students"]:
                cluster["students"].append(sub.student_name)
    out = [{**c, "count": len(c["students"])} for c in clusters.values()]
    out.sort(key=lambda c: (-c["count"], c["concept_a"].casefold(), c["concept_b"].casefold()))
    return [{"concept_a": c["concept_a"], "concept_b": c["concept_b"], "count": c["count"], "students": c["students"]}
            for c in out]


def _class_interventions(
    pairs: list[tuple[StudentSubmission, EvaluationResult]],
    common_errors: list[dict[str, Any]],
    clusters: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    denominator = len(pairs)
    per_topic: dict[str, list[float]] = {}
    weak: dict[str, list[str]] = {}
    for sub, result in pairs:
        for t in result.topic_mastery or []:
            if not isinstance(t, dict) or not t.get("topic"):
                continue
            mastery = _num(t.get("mastery"))
            per_topic.setdefault(str(t["topic"]), []).append(mastery)
            if mastery < TOPIC_GAP_MASTERY:
                weak.setdefault(str(t["topic"]), []).append(sub.student_name)
    ranked = sorted(
        (topic for topic in weak if weak[topic]),
        key=lambda topic: (-len(weak[topic]), fmean(per_topic[topic]), topic),
    )
    out = []
    for topic in ranked[:3]:
        count = len(weak[topic])
        error = next((e for e in common_errors if e["topic"] == topic), None)
        rationale = (
            f"{count} of {denominator} students below {_g(TOPIC_GAP_MASTERY)}% in {topic} "
            f"(class mean {fmean(per_topic[topic]):.1f}%)."
        )
        if error:
            rationale += f" Most common error: \"{error['error']}\" ({error['count']}/{error['denominator']}, Q{error['question']})."
        out.append({
            "topic": topic,
            "action": f"10-min re-teach + 5 unseen questions for {count} student{'s' if count != 1 else ''}",
            "students_count": count,
            "rationale": rationale,
        })
    for cluster in clusters:
        if len(out) >= 4 or cluster["count"] < 2:
            break
        out.append({
            "topic": f"{cluster['concept_a']} vs {cluster['concept_b']}",
            "action": (
                f"Side-by-side contrast table + 3 discriminating questions for {cluster['count']} students"
            ),
            "students_count": cluster["count"],
            "rationale": (
                f"{cluster['count']} of {denominator} students merged or swapped {cluster['concept_a']} and "
                f"{cluster['concept_b']} in their answers."
            ),
        })
    return out


def cohort_extras(
    *,
    pairs: list[tuple[StudentSubmission, EvaluationResult]],
    rubrics: dict[int, Rubric],
    batch: Batch | None,
) -> dict[str, Any]:
    """Keys: urgency_counts, ranking, at_risk, common_errors, interventions, confusion_clusters.
    Every list uses the analysed (completed) students as its denominator."""
    counts = {level: 0 for level in URGENCY_LEVELS}
    rows = []
    at_risk = []
    for sub, result in pairs:
        urgency, reasons, pct = result_urgency(result)
        counts[urgency] += 1
        rows.append(
            {
                "submission_id": sub.id,
                "student_name": sub.student_name,
                "student_ref": sub.student_ref or student_ref_for(sub.student_name),
                "score": float(result.total_score),
                "total_marks": float(result.total_marks),
                "pct": pct,
                "urgency": urgency,
            }
        )
        if urgency == "at_risk":
            top = next((p for p in result.roi_recommendations or [] if isinstance(p, dict)), None)
            at_risk.append(
                {
                    "submission_id": sub.id,
                    "student_name": sub.student_name,
                    "pct": pct,
                    "reasons": reasons,
                    "top_gap": str(top.get("topic")) if top else None,
                }
            )
    rows.sort(key=lambda r: (-r["pct"], r["student_name"].casefold(), r["submission_id"]))
    ranking = [{"rank": index, **row} for index, row in enumerate(rows, start=1)]
    at_risk.sort(key=lambda r: (r["pct"], r["student_name"].casefold()))
    common_errors = _common_errors(pairs)
    clusters = _confusion_clusters(pairs)
    return {
        "urgency_counts": counts,
        "ranking": ranking,
        "at_risk": at_risk,
        "common_errors": common_errors,
        "interventions": _class_interventions(pairs, common_errors, clusters),
        "confusion_clusters": clusters,
    }
