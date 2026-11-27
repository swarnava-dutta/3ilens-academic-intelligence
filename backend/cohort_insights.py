"""Cohort page figures over one student set S (one latest sheet per student, see sittings.py).

Pure functions over completed submissions (sub.result loaded). Every figure the cohort page shows
(tiles, cards, tabs and the summary sentences) comes from here, so the same number never has two
sources. Percentages are 0-100 with one decimal; shares of questions are 0-1.
"""
from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Iterable
from decimal import Decimal
from statistics import fmean, quantiles
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

import analytics
import marking
import provenance
import sittings
from analytics import norm as _norm, num as _num
from database import InterventionRecord, ModelInvocation, ReleaseStatus, StudentSubmission
from sittings import MIN_CLASS_STUDENTS, change_pts, mean1, median1, r1, student_key

SUBJECT_NAMES = {"physics", "chemistry", "biology", "botany", "zoology"}
SUBJECT_ORDER = ["physics", "chemistry", "biology", "botany", "zoology"]
RETEACH_LINE = analytics.TOPIC_GAP_MASTERY  # 60: a chapter "needs a re-teach" for students below this
LOW_CHAPTER = analytics.LOW_TOPIC  # 40: two chapters below this move a student one urgency level
MIN_ITEM_SHEETS = 5  # question analysis needs one test with this many graded sheets
MIN_DISCRIMINATION_N = 8  # discrimination (top 27% vs bottom 27%) only from this many answers
HARD_P = 0.40
OFTEN_SKIPPED = 0.30
WEAK_D = 0.10
KEY_ERROR_MIN_WRONG = 3
HEAVY_SKIPPER = 0.25  # students who left this share of the MCQs blank
DROP_WATCH = 10.0  # "also watch": not at risk but down this many points since the previous test
RETEACH_SHARE = 1 / 3  # a class re-teach: at least a third of the students who sat the chapter below 60%
RETEACH_MIN = 2  # ... and at least this many students

Subs = list[StudentSubmission]


def _pct(sub: StudentSubmission) -> float:
    return analytics.percentage(sub.result)


def _questions(sub: StudentSubmission) -> list[dict[str, Any]]:
    return [
        q for q in (sub.result.question_evaluations or [])
        if isinstance(q, dict) and isinstance(q.get("question"), int)
    ]


def _is_mcq(q: dict[str, Any]) -> bool:
    return str(q.get("question_type") or "").lower() == "mcq"


def _is_bonus(q: dict[str, Any]) -> bool:
    """A question the key made a bonus (full marks to everyone): never an attempt, a right answer
    or an item to analyse (the same rule as patterns.negative_marking_profile)."""
    return q.get("bonus") is True or marking.bonus_note(q)


def _scored(sub: StudentSubmission) -> list[dict[str, Any]]:
    """The questions of a sheet without bonus questions."""
    return [q for q in _questions(sub) if not _is_bonus(q)]


def _mcqs(sub: StudentSubmission) -> list[dict[str, Any]]:
    return [q for q in _scored(sub) if _is_mcq(q)]


def _state(q: dict[str, Any]) -> str:
    """right | partial | wrong | blank. An MCQ is right or wrong (no partial credit)."""
    outcome = str(q.get("outcome") or "").upper()
    if outcome not in {"FULL", "PARTIAL", "ZERO", "BLANK"}:
        answer = q.get("selected_option") or q.get("student_answer")
        marks, top = _num(q.get("estimated_marks")), _num(q.get("max_marks"))
        if not answer and marks <= 0:
            outcome = "BLANK"
        elif top > 0 and marks >= top:
            outcome = "FULL"
        else:
            outcome = "PARTIAL" if marks > 0 else "ZERO"
    if outcome == "BLANK":
        return "blank"
    if outcome == "FULL":
        return "right"
    if outcome == "PARTIAL" and not _is_mcq(q):
        return "partial"
    return "wrong"


def _penalty(q: dict[str, Any]) -> float:
    """Marks lost to a wrong MCQ (penalty is stored positive; older rows only carry negative marks)."""
    if not _is_mcq(q) or _state(q) != "wrong":
        return 0.0
    penalty = abs(_num(q.get("penalty")))
    if penalty == 0 and _num(q.get("estimated_marks")) < 0:
        penalty = abs(_num(q.get("estimated_marks")))
    return penalty


def _fraction(q: dict[str, Any]) -> float:
    """Share of the question's marks earned (0-1, negative marks count as 0)."""
    state = _state(q)
    if state == "right":
        return 1.0
    if state != "partial":
        return 0.0
    top = _num(q.get("max_marks"))
    return max(0.0, min(1.0, _num(q.get("estimated_marks")) / top)) if top > 0 else 0.0


def _option(value: Any) -> str | None:
    text = " ".join(str(value or "").split()).upper()
    return text or None


def _topic_rows(sub: StudentSubmission) -> list[dict[str, Any]]:
    return [t for t in (sub.result.topic_mastery or []) if isinstance(t, dict) and t.get("topic")]


def subject_level(row: dict[str, Any]) -> bool:
    """A topic that is really a whole subject ('Physics' on a paper tagged only by subject)."""
    topic = str(row.get("topic") or "").strip().casefold()
    subject = str(row.get("subject") or "").strip().casefold()
    return bool(topic) and (topic == subject or (topic in SUBJECT_NAMES and not row.get("chapter")))


def _subject_rank(subject: str) -> tuple[int, str]:
    key = subject.casefold()
    return (SUBJECT_ORDER.index(key) if key in SUBJECT_ORDER else len(SUBJECT_ORDER), key)


# --------------------------------------------------------------------------- #
# Headline
# --------------------------------------------------------------------------- #
def headline(subs: Subs, *, single_test: bool) -> dict[str, Any]:
    """Class average and spread over S. Marks only for one test with one total."""
    pcts = [_pct(s) for s in subs]
    out: dict[str, Any] = {
        # Exact (decimal, half-up) mean and median of the shown 1-dp percentages: the same rule as
        # the sittings list, so a test's average never differs by 0.1 between the tile and the trend.
        "average_pct": mean1(pcts) if pcts else None,
        "median_pct": median1(pcts) if pcts else None,
        "p25_pct": None,
        "p75_pct": None,
        "average_marks": None,
        "total_marks": None,
        "top_pct": None,
        "top_student": None,
        "top_submission_id": None,
        "negative_scores": sum(1 for s in subs if _num(s.result.total_score) < 0),
    }
    if len(pcts) >= 2:
        q1, _q2, q3 = quantiles([Decimal(repr(p)) for p in pcts], n=4, method="inclusive")
        out["p25_pct"], out["p75_pct"] = r1(q1), r1(q3)
    elif pcts:
        out["p25_pct"] = out["p75_pct"] = pcts[0]
    if subs:
        top = max(subs, key=lambda s: (_pct(s), -s.id))
        out.update(top_pct=_pct(top), top_student=top.student_name, top_submission_id=top.id)
    totals = {float(s.result.total_marks) for s in subs}
    if single_test and len(totals) == 1:
        out["average_marks"] = mean1([float(s.result.total_score) for s in subs])
        out["total_marks"] = totals.pop()
    out["lowest_pct"] = min(pcts) if pcts else None
    if subs:
        low = min(subs, key=lambda s: (_pct(s), s.id))
        out.update(lowest_student=low.student_name, lowest_submission_id=low.id)
    return out


# --------------------------------------------------------------------------- #
# Students
# --------------------------------------------------------------------------- #
def _short_reason(urgency: str, pct: float) -> str | None:
    if urgency == "at_risk":
        return "below_55" if pct < analytics.URGENCY_AT_RISK else "low_chapters"
    if urgency == "needs_attention":
        return "below_70" if pct < analytics.URGENCY_ON_TRACK else "low_chapters"
    return None


def _weakest(rows: list[dict[str, Any]]) -> str | None:
    """Lowest-mastery chapter (subject-level rows only when there is nothing finer)."""
    chapters = [t for t in rows if not subject_level(t)] or rows
    if not chapters:
        return None
    worst = min(chapters, key=lambda t: (_num(t.get("mastery"), 100.0), -_num(t.get("n")), str(t["topic"])))
    return str(worst["topic"])


def _mcq_counts(sub: StudentSubmission) -> dict[str, Any]:
    mcqs = _mcqs(sub)
    states = Counter(_state(q) for q in mcqs)
    attempted = states["right"] + states["wrong"]
    return {
        "mcq_count": len(mcqs),
        "attempted": attempted,
        "right": states["right"],
        "wrong": states["wrong"],
        "blanks": states["blank"],
        "negative_marks": round(sum(_penalty(q) for q in mcqs), 2),
        "accuracy_attempted": round(states["right"] / attempted * 100, 1) if attempted else None,
    }


def student_rows(
    subs: Subs, paired: list[sittings.Pair] | None = None, families: sittings.Families | None = None
) -> list[dict[str, Any]]:
    """One row per student in S, best first (competition ranking: equal % share a rank). `paired`:
    sittings.pairs of S; prev_pct is the earlier sheet's %, and change_pts / prev_urgency /
    newly_at_risk are set only when the pair is comparable (sittings.comparable)."""
    prev = {after.id: before for before, after in paired or []}
    rows = []
    for sub in subs:
        result = sub.result
        urgency, reasons, pct = analytics.result_urgency(result)
        topics = _topic_rows(sub)
        before = prev.get(sub.id)
        prev_pct = _pct(before) if before is not None else None
        if before is not None and not (families is not None and sittings.comparable(before, sub, families)):
            before = None  # not comparable: the earlier % is shown, never a change
        prev_urgency = analytics.result_urgency(before.result)[0] if before is not None else None
        rows.append({
            "submission_id": sub.id,
            "student_ref": student_key(sub),
            "student_name": sub.student_name,
            "rubric_id": sub.rubric_id,
            "score": float(result.total_score),
            "total_marks": float(result.total_marks),
            "pct": pct,
            "urgency": urgency,
            "short_reason": _short_reason(urgency, pct),
            "reasons": reasons,
            "low_chapters": sum(1 for t in topics if _num(t.get("mastery"), 100.0) < LOW_CHAPTER),
            "weakest_topic": _weakest(topics),
            **_mcq_counts(sub),
            "prev_pct": prev_pct,
            "change_pts": change_pts(prev_pct, pct) if before is not None and prev_pct is not None else None,
            "prev_urgency": prev_urgency,
            "newly_at_risk": urgency == "at_risk" and before is not None and prev_urgency != "at_risk",
            "release_status": result.release_status or ReleaseStatus.PROVISIONAL,
            "topics": [
                {
                    "topic": str(t["topic"]),
                    "mastery": round(_num(t.get("mastery")), 1),
                    "right": int(_num(t.get("full"))),
                    "questions": int(_num(t.get("n"), len(t.get("questions") or []))),
                }
                for t in topics
            ],
        })
    rows.sort(key=lambda r: (-r["pct"], r["student_name"].casefold(), r["submission_id"]))
    rank = 0
    for index, row in enumerate(rows):
        if index == 0 or row["pct"] != rows[index - 1]["pct"]:
            rank = index + 1
        row["rank"] = rank
    return rows


# --------------------------------------------------------------------------- #
# MCQ attempts and negative marking
# --------------------------------------------------------------------------- #
def attempt_summary(subs: Subs) -> dict[str, Any] | None:
    """Pooled over every MCQ answer in S (not a mean of per-student rates). None without MCQs."""
    total = Counter()
    neg = 0.0
    with_mcq = 0
    lengths: set[int] = set()
    bonus = 0
    subjects: dict[str, str] = {}
    subject_rows: set[str] = set()
    by_topic: dict[str, dict[str, Any]] = {}
    for sub in subs:
        for t in _topic_rows(sub):
            subjects.setdefault(str(t["topic"]), str(t.get("subject") or ""))
            if subject_level(t):
                subject_rows.add(str(t["topic"]))
        bonus += sum(1 for q in _questions(sub) if _is_mcq(q) and _is_bonus(q))
        mcqs = _mcqs(sub)
        with_mcq += bool(mcqs)
        if mcqs:
            lengths.add(len(mcqs))
        for q in mcqs:
            state = _state(q)
            penalty = _penalty(q)
            total[state] += 1
            neg += penalty
            topic = str(q.get("topic") or "Untagged")
            row = by_topic.setdefault(topic, {"answers": 0, "right": 0, "wrong": 0, "blanks": 0, "neg": 0.0})
            row["answers"] += 1
            row["right" if state == "right" else "blanks" if state == "blank" else "wrong"] += 1
            row["neg"] += penalty
    answers = sum(total.values())
    if not answers:
        return None
    n = with_mcq  # per-student figures over the students who had MCQs (all of S on one MCQ test)
    attempted = total["right"] + total["wrong"]
    topics = []
    for topic, row in by_topic.items():
        tried = row["right"] + row["wrong"]
        topics.append({
            "topic": topic,
            "subject": subjects.get(topic, ""),
            "answers": row["answers"],
            "attempted": tried,
            "right": row["right"],
            "wrong": row["wrong"],
            "blanks": row["blanks"],
            "negative_marks": round(row["neg"], 2),
            "accuracy_attempted": round(row["right"] / tried * 100, 1) if tried else None,
            "blank_rate": round(row["blanks"] / row["answers"] * 100, 1),
            "subject_level": topic in subject_rows,
        })
    topics.sort(key=lambda t: (-t["negative_marks"], -t["wrong"], t["topic"].casefold()))
    return {
        "students": with_mcq,
        "mcq_answers": answers,
        "questions_per_student": r1(answers / n) if n else 0.0,
        "attempted": attempted,
        "right": total["right"],
        "wrong": total["wrong"],
        "blanks": total["blank"],
        "attempt_rate": round(attempted / answers * 100, 1),
        "accuracy_attempted": round(total["right"] / attempted * 100, 1) if attempted else None,
        # The blank share is its own figure (blanks / answers), never 100 - attempt_rate re-rounded.
        "blank_rate": round(total["blank"] / answers * 100, 1),
        "blanks_per_student": r1(total["blank"] / n) if n else 0.0,
        "negative_marks_total": round(neg, 2),
        "negative_per_student": r1(neg / n) if n else 0.0,
        # Papers of different lengths: a per-student count of blanks means little, use the rate.
        "same_length": len(lengths) <= 1,
        "bonus_answers": bonus,
        "by_topic": topics,
    }


# --------------------------------------------------------------------------- #
# Item analysis (one test)
# --------------------------------------------------------------------------- #
def item_analysis(subs: Subs) -> list[dict[str, Any]] | None:
    """Per question over the sheets in S whose key has it. None below MIN_ITEM_SHEETS sheets.
    Discrimination D = share right in the top 27% minus the bottom 27% (by total %, at least 2
    per group), only from MIN_DISCRIMINATION_N answers."""
    if len(subs) < MIN_ITEM_SHEETS:
        return None
    subjects: dict[str, str] = {}
    for sub in subs:
        for t in _topic_rows(sub):
            subjects.setdefault(str(t["topic"]), str(t.get("subject") or ""))
    per_q: dict[int, list[tuple[StudentSubmission, dict[str, Any]]]] = {}
    for sub in subs:
        for q in _scored(sub):  # a bonus question is full marks to everyone: nothing to analyse
            per_q.setdefault(q["question"], []).append((sub, q))
    rows = []
    for number in sorted(per_q):
        items = per_q[number]
        n = len(items)
        mcq = any(_is_mcq(q) for _, q in items)
        states = Counter(_state(q) for _, q in items)
        keys = Counter(_option(q.get("correct_option")) for _, q in items if _option(q.get("correct_option")))
        key = keys.most_common(1)[0][0] if keys else None
        options = Counter(
            _option(q.get("selected_option")) for _, q in items
            if _state(q) != "blank" and _option(q.get("selected_option"))
        )
        wrong_picks = Counter(
            _option(q.get("selected_option")) for _, q in items
            if _state(q) == "wrong" and _option(q.get("selected_option"))
        )
        top_wrong, top_wrong_count = wrong_picks.most_common(1)[0] if wrong_picks else (None, 0)
        tied = sum(1 for count in wrong_picks.values() if count == top_wrong_count) > 1
        fractions = [_fraction(q) for _, q in items]
        p = fmean(fractions) if fractions else 0.0
        d = None
        top_group = top_group_chose = 0
        if n >= MIN_DISCRIMINATION_N:
            ranked = sorted(items, key=lambda it: (-_pct(it[0]), it[0].student_name.casefold(), it[0].id))
            g = max(2, round(0.27 * n))
            top, bottom = ranked[:g], ranked[-g:]
            d = round(fmean(_fraction(q) for _, q in top) - fmean(_fraction(q) for _, q in bottom), 2)
            top_group = g
            if top_wrong:
                top_group_chose = sum(1 for _, q in top if _state(q) == "wrong" and _option(q.get("selected_option")) == top_wrong)
        first = items[0][1]
        topic = str(first.get("topic") or "")
        flags = []
        if mcq and n >= MIN_DISCRIMINATION_N and top_wrong_count >= KEY_ERROR_MIN_WRONG \
                and top_wrong_count > states["right"] and d is not None and d <= 0:
            flags.append("possible_key_error")
        if p < HARD_P:
            flags.append("hard")
        if states["blank"] / n >= OFTEN_SKIPPED:
            flags.append("often_skipped")
        if d is not None and d < WEAK_D:
            flags.append("weak_discrimination")
        rows.append({
            "question": number,
            "topic": topic,
            "subject": subjects.get(topic, ""),
            "type": "mcq" if mcq else str(first.get("question_type") or "descriptive"),
            "max_marks": _num(first.get("max_marks")),
            "key": key if mcq else None,
            "n": n,
            "correct": states["right"],
            "partial": states["partial"],
            "wrong": states["wrong"],
            "blank": states["blank"],
            "options": [{"option": k, "count": v} for k, v in sorted(options.items())] if mcq else [],
            "top_wrong_option": top_wrong,
            "top_wrong_count": top_wrong_count,
            "top_wrong_tied": tied,
            "top_group_size": top_group,
            "top_group_chose_wrong": top_group_chose,
            "negative_marks": round(sum(_penalty(q) for _, q in items), 2),
            "p": round(p, 3),
            "discrimination": d,
            "flags": flags,
        })
    return rows


# --------------------------------------------------------------------------- #
# Chapters and subjects
# --------------------------------------------------------------------------- #
def _topic_means(subs: Subs) -> dict[str, float]:
    values: dict[str, list[float]] = {}
    for sub in subs:
        for t in _topic_rows(sub):
            values.setdefault(str(t["topic"]).casefold(), []).append(round(_num(t.get("mastery")), 1))
    return {k: mean1(v) for k, v in values.items()}


def neet_weight(topic: str, subject: str | None, chapter: str | None, exam: str | None = "NEET") -> float | None:
    """The chapter's share of the exam from the chapter matrix (avg marks / exam total, 0-1), or
    None when the chapter is not in the matrix. Never this paper's own mark share."""
    row = analytics.map_chapter(topic, subject, chapter, exam)
    matrix = analytics.load_matrix(exam)
    if row is None or not matrix:
        return None
    total = _num(matrix.get("total_marks"), analytics.EXAM_TOTAL_MARKS)
    marks = _num(row.get("avg_marks"))
    return round(marks / total, 4) if marks > 0 and total > 0 else None


def reteach_eligible(row: dict[str, Any], *, short_paper: bool) -> bool:
    """A class re-teach: a real chapter (not a whole subject) sat by 3+ students, with at least a
    third of them (and 2 or more) below 60%, measured on 2+ questions. On a short paper where every
    chapter has one question, a chapter with 3+ students below 60% still counts, as a hint."""
    if row["subject_level"] or row["students"] < MIN_CLASS_STUDENTS:
        return False
    below = row["below_60"]
    if below < RETEACH_MIN or below * 3 < row["students"]:
        return False
    return row["questions"] >= 2 or (short_paper and below >= MIN_CLASS_STUDENTS)


def chapters(
    subs: Subs,
    prev_subs: Subs | None = None,
    items: list[dict[str, Any]] | None = None,
    family_of: Any = None,
    exam: str | None = "NEET",
) -> list[dict[str, Any]]:
    """One row per topic over S: class mean, students below 60 / 40, NEET weight (chapter matrix),
    thin and subject-level flags, change since the previous sitting and the re-teach rank (1 = first)."""
    family_of = family_of or (lambda rubric_id: rubric_id)
    agg: dict[str, dict[str, Any]] = {}
    for sub in subs:
        for t in _topic_rows(sub):
            name = str(t["topic"])
            row = agg.setdefault(name, {
                "subject": str(t.get("subject") or ""), "chapter": t.get("chapter"), "subject_level": subject_level(t),
                "questions": set(), "students": [], "weightage": [],
            })
            for q in t.get("questions") or []:
                row["questions"].add((family_of(sub.rubric_id), q))
            row["students"].append((sub, round(_num(t.get("mastery")), 1)))
            row["weightage"].append(_num(t.get("weightage")))
    prev_means = _topic_means(prev_subs or [])
    hardest: dict[str, dict[str, Any]] = {}
    for item in items or []:
        key = item["topic"].casefold()
        if item["n"] and (key not in hardest or (item["p"], -item["n"]) < (hardest[key]["p"], -hardest[key]["n"])):
            hardest[key] = item
    out = []
    for name, row in agg.items():
        values = [m for _, m in row["students"]]
        mean = mean1(values)
        below = sorted((pair for pair in row["students"] if pair[1] < RETEACH_LINE), key=lambda p: (p[1], p[0].student_name))
        prev_mean = prev_means.get(name.casefold())
        hard = hardest.get(name.casefold())
        questions = len(row["questions"])
        out.append({
            "topic": name,
            "subject": row["subject"],
            "questions": questions,
            "students": len(values),
            "mean": mean,
            "below_60": len(below),
            "below_40": sum(1 for v in values if v < LOW_CHAPTER),
            "weightage": round(fmean(row["weightage"]), 4) if row["weightage"] else 0.0,
            "neet_weight": None if row["subject_level"] else neet_weight(name, row["subject"], row["chapter"], exam),
            "subject_level": row["subject_level"],
            "thin": questions < 2 or len(values) < MIN_CLASS_STUDENTS,
            "hint": False,
            "prev_mean": prev_mean,
            "change": change_pts(prev_mean, mean) if prev_mean is not None else None,
            "hardest_question": (
                {"question": hard["question"], "correct": hard["correct"], "n": hard["n"], "type": hard["type"],
                 "p": hard["p"]} if hard else None
            ),
            "below_60_students": [
                {"submission_id": s.id, "student_name": s.student_name, "student_ref": student_key(s), "mastery": m}
                for s, m in below
            ],
            "reteach_rank": None,
        })
    real = [c for c in out if not c["subject_level"] and c["students"] >= MIN_CLASS_STUDENTS]
    short_paper = bool(real) and all(c["questions"] < 2 for c in real)
    eligible = [c for c in out if reteach_eligible(c, short_paper=short_paper)]
    eligible.sort(key=lambda c: (-c["below_60"], -(c["neet_weight"] or 0.0), c["mean"], c["topic"].casefold()))
    for rank, row in enumerate(eligible, start=1):
        row["reteach_rank"] = rank
        row["hint"] = row["questions"] < 2
    out.sort(key=lambda c: (_subject_rank(c["subject"]), c["mean"], c["topic"].casefold()))
    return out


def _subject_means(subs: Subs) -> dict[str, tuple[str, float, int]]:
    """subject key -> (label, mean over students of sum(score)/sum(max) in that subject, students)."""
    per: dict[str, list[float]] = {}
    labels: dict[str, str] = {}
    for sub in subs:
        sums: dict[str, list[float]] = {}
        for t in _topic_rows(sub):
            subject = str(t.get("subject") or "").strip()
            if not subject:
                continue
            labels.setdefault(subject.casefold(), subject)
            pair = sums.setdefault(subject.casefold(), [0.0, 0.0])
            pair[0] += _num(t.get("score"))
            pair[1] += _num(t.get("max_marks"))
        for key, (score, top) in sums.items():
            if top > 0:
                # Rounded like a student's % (analytics.percentage), so a one-subject paper's
                # subject mean equals the class average exactly.
                per.setdefault(key, []).append(round(max(0.0, min(100.0, score / top * 100)), 1))
    return {k: (labels[k], mean1(v) or 0.0, len(v)) for k, v in per.items()}


def subjects(subs: Subs, prev_subs: Subs | None = None) -> list[dict[str, Any]]:
    now = _subject_means(subs)
    before = _subject_means(prev_subs or [])
    out = []
    for key, (label, mean, count) in now.items():
        prev = before.get(key)
        out.append({
            "subject": label,
            "mean": mean,
            "students": count,
            "prev_mean": prev[1] if prev else None,
            "change": change_pts(prev[1], mean) if prev else None,
        })
    out.sort(key=lambda s: _subject_rank(s["subject"]))
    return out


# --------------------------------------------------------------------------- #
# Change since the previous sitting, batches on the same test
# --------------------------------------------------------------------------- #
def paired_change(paired: list[sittings.Pair], families: sittings.Families) -> dict[str, Any] | None:
    """Each student in S against the sheet they sat just before (sittings.pairs): sittings.progress
    of the comparable pairs (the same figures and up 5+ / down 5+ / steady counts as the owner
    page; `paired` = their count) plus every pair's row, the others flagged not comparable."""
    if not paired:
        return None
    rows = [
        {"submission_id": now.id, "student_ref": student_key(now), "name": now.student_name,
         "prev": _pct(prev), "now": _pct(now), "change": change_pts(_pct(prev), _pct(now)),
         "prev_test": sittings.short_test_name(families.name(prev.rubric_id)),
         "comparable": sittings.comparable(prev, now, families)}
        for prev, now in paired
    ]
    rows.sort(key=lambda r: (-r["change"], r["name"].casefold()))
    figures = sittings.progress(paired, families)
    return {"paired": figures.pop("students"), **figures, "rows": rows}


def batch_comparison(family_sittings: list[dict[str, Any]], current_batch_id: int | None) -> list[dict[str, Any]]:
    """Every batch that sat this test (sittings of one test family); empty for a single batch."""
    if len(family_sittings) < 2:
        return []
    rows = [
        {"batch_id": s["batch_id"], "batch_name": s["batch_name"], "students": s["students"],
         "average_pct": s["average_pct"], "date": s["date"], "is_current": s["batch_id"] == current_batch_id,
         "thin": s["students"] < MIN_CLASS_STUDENTS}
        for s in family_sittings
    ]
    rows.sort(key=lambda r: (-(r["average_pct"] or 0), r["batch_name"].casefold()))
    return rows


# --------------------------------------------------------------------------- #
# Summary sentences (built only from the figures above)
# --------------------------------------------------------------------------- #
def _f(value: float) -> str:
    return f"{value:.1f}"


def comparison(n: int, paired: dict[str, Any] | None, reason: str | None) -> tuple[bool, str | None]:
    """Is the class average fairly compared with the previous class sitting? Only when the two
    papers are comparable (`reason` = sittings.not_comparable_reason of their sheets is None) and at
    least half the class has a comparable earlier sheet. Otherwise the reason is said once."""
    both = paired["paired"] if paired else 0
    if reason is not None:
        return False, reason
    if both * 2 < n:
        return False, f"only {both} of {n} sat both"
    return True, None


def _pair_text(paired: dict[str, Any], name: str) -> str:
    who = "The 1 student who also sat" if paired["paired"] == 1 else f"The {paired['paired']} students who also sat"
    delta = paired["mean_change"]
    if delta > 0:
        return f"{who} {name} improved by {_f(delta)} pts on average."
    if delta < 0:
        return f"{who} {name} fell by {_f(-delta)} pts on average."
    return f"{who} {name} scored the same on average."


def summary(
    *,
    mode: str,
    head: dict[str, Any],
    students: list[dict[str, Any]],
    counts: dict[str, int],
    previous: dict[str, Any] | None,
    paired: dict[str, Any] | None,
    chapter_rows: list[dict[str, Any]],
    items: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    n = len(students)
    if not n or head.get("average_pct") is None:
        return []
    out: list[dict[str, Any]] = []
    avg = head["average_pct"]
    if mode == "all":
        text = f"Average {_f(avg)}% across {marking.plural(n, 'student')}' latest tests (median {_f(head['median_pct'])}%)."
    elif n < MIN_CLASS_STUDENTS:
        text = (f"Only {marking.plural(n, 'student')} sat this test ({_f(avg)}%"
                f"{'' if n == 1 else ' on average'}), so it is not compared with other tests.")
    elif previous and previous.get("average_pct") is not None and previous.get("comparable", True):
        delta = head.get("delta_pts")
        if delta is None:
            delta = change_pts(previous["average_pct"], avg)
        name = previous["short_name"]
        if delta > 0:
            text = f"Class average {_f(avg)}%, up {_f(delta)} pts on {name} ({_f(previous['average_pct'])}%)."
        elif delta < 0:
            text = f"Class average {_f(avg)}%, down {_f(-delta)} pts on {name} ({_f(previous['average_pct'])}%)."
        else:
            text = f"Class average {_f(avg)}%, level with {name}."
        if paired and paired["paired"]:
            pdelta = paired["mean_change"]
            disagree = (pdelta > 0) != (delta > 0) or (pdelta < 0) != (delta < 0)
            if disagree or paired["paired"] != n:
                text += " " + _pair_text(paired, name)
    elif previous and paired and paired["paired"] and str(previous.get("note") or "").startswith("only "):
        # Comparable papers, mostly other students (comparison's "only n of N sat both"): the
        # students who sat both lead; the class delta is left out of the sentence.
        text = f"Class average {_f(avg)}% (median {_f(head['median_pct'])}%). " + _pair_text(paired, previous["short_name"])
    elif previous and previous.get("note"):
        text = (f"Class average {_f(avg)}% (median {_f(head['median_pct'])}%); not compared with "
                f"{previous['short_name']} ({previous['note']}).")
    else:
        text = f"Class average {_f(avg)}% (median {_f(head['median_pct'])}%)."
    out.append({"kind": "average", "text": text, "href": "?tab=students"})

    at_risk = counts.get("at_risk", 0)
    if at_risk:
        text = f"{at_risk} of {marking.plural(n, 'student')} at risk"
        new = sum(1 for s in students if s["newly_at_risk"])
        if previous and new:
            text += f" ({new} new since {previous['short_name']})"
        out.append({"kind": "students", "text": text + ".", "href": "?tab=students&urgency=at_risk"})
    else:
        attention = counts.get("needs_attention", 0)
        out.append({
            "kind": "students",
            "text": f"No student is at risk; {attention} of {n} need{'s' if attention == 1 else ''} attention.",
            "href": "?tab=students&urgency=needs_attention",
        })

    flagged = [i for i in items or [] if "possible_key_error" in i["flags"]]
    if flagged:
        refs = ", ".join(f"Q{i['question']}" for i in flagged[:3])
        verb = "may be mis-keyed" if len(flagged) == 1 else "may be mis-keyed - check the key"
        out.append({"kind": "key", "text": f"{refs} {verb}.", "href": "?tab=questions&flag=possible_key_error"})
    else:
        top = next((c for c in chapter_rows if c["reteach_rank"] == 1), None)
        if top:
            note = " (on its one question)" if top.get("hint") else ""
            out.append({
                "kind": "chapter",
                "text": f"{top['topic']} needs a re-teach: {top['below_60']} of {top['students']} below {RETEACH_LINE:g}%{note}.",
                "href": "?tab=chapters",
            })
    return out[:3]


# --------------------------------------------------------------------------- #
# Reading quality and cost (live sheets only), data version, interventions
# --------------------------------------------------------------------------- #
def reading(db: Session, *, scope_subs: Iterable[StudentSubmission], students: Subs) -> dict[str, Any]:
    """Reading confidence over S; time per sheet and AI cost over the live (non-demo) completed
    sheets in scope. Cost per live sheet divides only by live sheets that have traced calls."""
    # Demo sheets carry a made-up confidence: only sheets that were really read count.
    confidences = [float(s.ocr_confidence) for s in students if s.ocr_confidence is not None and not s.is_demo]
    live = [s for s in scope_subs if not s.is_demo and s.result is not None and s.status == "COMPLETED"]
    latencies = [v for v in (provenance.latency_seconds(s) for s in live) if v is not None]
    ids = [s.id for s in live]
    rows = list(db.scalars(select(ModelInvocation).where(ModelInvocation.submission_id.in_(ids))).all()) if ids else []
    traced = {r.submission_id for r in rows}
    cost = sum(float(r.cost_inr) for r in rows if r.cost_inr is not None)
    return {
        "mean_confidence": round(fmean(confidences), 3) if confidences else None,
        "avg_seconds_per_sheet": round(fmean(latencies), 1) if latencies else None,
        "live_sheets": len(live),
        "costed_sheets": len(traced),
        "cost_per_live_sheet_inr": round(cost / len(traced), 2) if traced else None,
        "live_cost_inr": round(cost, 2),
    }


def data_version(subs: Iterable[StudentSubmission], extra: Any = None) -> str:
    """Changes whenever a sheet in scope changes status, is re-graded or released."""
    parts = []
    for s in sorted(subs, key=lambda x: x.id):
        r = s.result
        parts.append((
            s.id, s.status, str(s.updated_at), s.rubric_id,
            r.id if r is not None else None, getattr(r, "version", None), getattr(r, "release_status", None),
            str(getattr(r, "reviewed_at", None)), getattr(r, "total_score", None),
        ))
    digest = hashlib.sha1(repr((parts, extra)).encode("utf-8")).hexdigest()
    return digest[:16]


def interventions_logged(db: Session, *, batch_id: int | None, institution_id: int | None) -> int:
    query = select(func.count(InterventionRecord.id))
    if batch_id is not None:
        query = query.where(InterventionRecord.batch_id == batch_id)
    elif institution_id is not None:
        query = query.where(InterventionRecord.institution_id == institution_id)
    return int(db.scalar(query) or 0)


def written_errors(subs: Subs) -> list[dict[str, Any]]:
    """Gaps in written (non-MCQ) answers shared by 2+ students. The denominator is the sheets in S
    that have the question; 'Not attempted' is not an error (blanks are counted separately)."""
    sheets: Counter[tuple[int, str]] = Counter()
    groups: dict[tuple[int, str, str], dict[str, Any]] = {}
    for sub in subs:
        for q in _questions(sub):
            if _is_mcq(q):
                continue
            key = (q["question"], _norm(q.get("topic")))
            sheets[key] += 1
            if _state(q) == "blank":
                continue
            for gap in q.get("gaps") or []:
                text = " ".join(str(gap or "").split())
                if not text or text.casefold() in {"not attempted", "not attempted."}:
                    continue
                group = groups.setdefault(
                    (*key, _norm(text)),
                    {"question": q["question"], "topic": str(q.get("topic") or ""), "error": text, "students": []},
                )
                if sub.student_name not in group["students"]:
                    group["students"].append(sub.student_name)
    rows = [
        {**g, "count": len(g["students"]), "denominator": sheets[(g["question"], _norm(g["topic"]))]}
        for g in groups.values() if len(g["students"]) >= 2
    ]
    rows.sort(key=lambda r: (-r["count"], r["question"], r["error"].casefold()))
    return [
        {"question": r["question"], "topic": r["topic"], "error": r["error"], "count": r["count"],
         "denominator": r["denominator"], "students": r["students"]}
        for r in rows[:8]
    ]


def confusion_denominators(subs: Subs, clusters: list[dict[str, Any]], family_of: Any = None) -> list[dict[str, Any]]:
    """Each confusion cluster with its denominator: the students in S who sat a test on which the
    confusion was seen (only they could show it), not every student in scope."""
    family_of = family_of or (lambda rubric_id: rubric_id)
    seen: dict[tuple[str, str], set[int]] = {}
    for sub in subs:
        for raw in sub.result.confusions or []:
            if isinstance(raw, dict) and raw.get("concept_a") and raw.get("concept_b"):
                key = tuple(sorted((_norm(raw["concept_a"]), _norm(raw["concept_b"]))))
                seen.setdefault(key, set()).add(family_of(sub.rubric_id))
    out = []
    for cluster in clusters:
        families = seen.get(tuple(sorted((_norm(cluster["concept_a"]), _norm(cluster["concept_b"])))), set())
        denominator = sum(1 for s in subs if family_of(s.rubric_id) in families)
        out.append({**cluster, "denominator": max(denominator, cluster["count"])})
    return out


def class_interventions(
    chapter_rows: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    clusters: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Class actions in the re-teach order of the page: the top 3 re-teach chapters (denominator =
    students who sat the chapter), then confusion clusters seen in 2+ students."""
    ranked = sorted((c for c in chapter_rows if c["reteach_rank"]), key=lambda c: c["reteach_rank"])[:3]
    out = []
    for c in ranked:
        count = c["below_60"]
        rationale = (
            f"{count} of {c['students']} students below {RETEACH_LINE:g}% in {c['topic']} "
            f"(class mean {_f(c['mean'])}%)."
        )
        if c.get("hint"):
            rationale += " Measured on one question - treat it as a hint."
        error = next((e for e in errors if _norm(e["topic"]) == _norm(c["topic"])), None)
        if error:
            rationale += (f" Most common gap: \"{error['error']}\" ({error['count']} of {error['denominator']}, "
                          f"Q{error['question']}).")
        out.append({
            "topic": c["topic"],
            "action": f"10-min re-teach + 5 unseen questions for {marking.plural(count, 'student')}",
            "students_count": count,
            "rationale": rationale,
        })
    for cluster in clusters:
        if len(out) >= 4 or cluster["count"] < 2:
            break
        denominator = cluster.get("denominator") or cluster["count"]
        out.append({
            "topic": f"{cluster['concept_a']} vs {cluster['concept_b']}",
            "action": f"Side-by-side contrast table + 3 discriminating questions for {cluster['count']} students",
            "students_count": cluster["count"],
            "rationale": (
                f"{cluster['count']} of {denominator} students who sat that test merged or swapped "
                f"{cluster['concept_a']} and {cluster['concept_b']}."
            ),
        })
    return out
