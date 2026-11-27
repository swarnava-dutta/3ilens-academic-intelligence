"""Exam-behaviour patterns (FR-4.8 negative marking, FR-4.10 fatigue, FR-4.11 memorisation vs
transfer) and the Bloom profile.

Read-side only: result_view / cohort call result_extras / cohort_extras through guarded hooks,
so an exception here never breaks a report. Deterministic, no AI call. Every threshold below is
a DEFAULT - confirm with the academic lead (labelled so in the payload notes and the UI).

Rules (contract v3 section 11):
* Accuracy per question: clamp(estimated_marks / max_marks, 0, 1). Blank = 0; a wrong MCQ at -1 = 0.
* Negative marking: smoothed topic accuracy a_s = (correct + 1) / (attempted + 2); EV per attempt
  = a_s x mean_max - (1 - a_s) x mean_neg; high risk when EV < 1.0 and wrong >= 2, medium when
  EV < 2.0 and wrong >= 1. BREAK_EVEN = neg / (max + neg) (0.2 for +4/-1).
* Fatigue: needs >= 6 questions; final third vs the rest on ANSWERED questions only (blanks are a
  blank rate, never a wrong answer; accuracy counts only with min(5, half the side) answers),
  cohort-adjusted when >= 5 results share the rubric; flagged at >= 15 pts (high >= 25) or a
  blank-rate jump >= 0.20 (high >= 0.35). When subjects sit in fixed sections the paper-wide split
  compares subjects, so the flag rests on the change within each subject (first vs second half).
* Bloom profile: net marks (penalties included); informative only with 2+ levels and a real tag.
* Transfer: concept groups with >= 1 recall (K1-K2) and >= 1 transfer (K3-K5) question;
  foundational_gap / memorisation / inconsistent / transferable / developing (first match wins).

Units: every `accuracy` field (TopicRisk, NegativeMarkingProfile, QuestionAccuracy, FatigueProfile
early/late, CohortTopicRisk, CohortFatigue, BloomBucket) is a FRACTION 0-1. ConceptTransfer
recall/transfer_accuracy and gap_pts, and FatigueProfile drop_pts, are PERCENTAGE POINTS 0-100.
"""
from __future__ import annotations

import math
from collections import Counter
from statistics import fmean
from typing import Any

from sqlalchemy import func, select

import analytics
import bloom
import hashing
import insights
import marking

THRESHOLD_LABEL = "default - confirm with academic lead"
THRESHOLD_NOTE = f"Pattern thresholds: {THRESHOLD_LABEL}"

# --- negative marking (FR-4.8) -----------------------------------------------------------
NEG_HIGH_EV = 1.0
NEG_MEDIUM_EV = 2.0
SKIP_THRESHOLD = {"high": 0.50, "medium": 0.34}  # low = break-even
ELIMINATE_OPTIONS = {"high": 2, "medium": 1, "low": 0}
NO_NEGATIVE_MCQ_NOTE = "No negatively-marked MCQs in this test"

# --- fatigue (FR-4.10) --------------------------------------------------------------------
MIN_FATIGUE_QUESTIONS = 6
COHORT_ADJUST_MIN = 5
FATIGUE_FLAG_PTS = 15.0
FATIGUE_HIGH_PTS = 25.0
FATIGUE_BLANK_JUMP = 0.20
FATIGUE_HIGH_BLANK_JUMP = 0.35
# Accuracy on answered questions is only compared when each side has enough answers:
# at least min(5, half of its scorable questions).
MIN_FATIGUE_ANSWERED = 5
FATIGUE_NOTE = "Needs at least 6 questions (this test has {n})"
FATIGUE_RECOMMENDATION = (
    "Endurance practice: 2 full-length timed mocks per week; in one of them start from the last section; "
    "take a 60-second reset at the two-thirds mark; track accuracy per third."
)
NO_FATIGUE_RECOMMENDATION = "No end-of-paper fatigue at the default thresholds; keep the current pacing."

# --- memorisation vs transfer (FR-4.11) ---------------------------------------------------
TRANSFER_LOW = 40.0
TRANSFER_HIGH = 60.0
TRANSFER_GAP = 25.0
TRANSFER_NOTE = "Needs the same concept at recall (K1-K2) and application (K3-K5) levels"
REPEATED_NOTE = "{n} students sat more than one test: each is listed once, for their latest test - filter by test to see the others"
TRANSFER_ADVICE = {
    "memorisation": (
        "Recall is solid but application lags in {concept}: switch to application questions (K3-K4) and "
        "explain-your-reasoning drills."
    ),
    "foundational_gap": (
        "Rebuild the basics of {concept} first (definitions and core facts), then move to simple "
        "application items."
    ),
    "inconsistent": (
        "Application is ahead of recall in {concept}: revise definitions and key facts so easy recall marks "
        "are not dropped."
    ),
    "transferable": "{concept} transfers: recall and application are both secure - maintain with mixed timed practice.",
    "developing": "{concept} is developing: keep practising recall and application items side by side.",
}

PEER_CAP = 500
# (db url, rubric_id) -> (peer-set token, peers_acc, cohort_size); see _peer_stats.
_PEER_STATS: dict[tuple[str, int], tuple[tuple[Any, ...], dict[int, float] | None, int]] = {}
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}


def break_even(max_marks: float, negative_marks: float) -> float:
    """Accuracy at which attempting breaks even: neg / (max + neg). 0.2 for +4/-1."""
    total = float(max_marks) + float(negative_marks)
    return round(float(negative_marks) / total, 4) if total > 0 else 0.0


def empty_student_patterns() -> dict[str, Any]:
    """A StudentPatterns with every profile null (the hook default)."""
    return {"negative_marking": None, "fatigue": None, "transfer": None, "bloom_profile": [], "notes": [],
            "bloom_informative": False}


def empty_cohort_patterns() -> dict[str, Any]:
    """A CohortPatterns with every profile null (the hook default)."""
    return {"negative_marking": None, "fatigue": None, "transfer": None, "bloom_profile": [], "notes": []}


# --------------------------------------------------------------------------- #
# Input helpers
# --------------------------------------------------------------------------- #
def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _qnum(item: dict[str, Any] | None) -> int | None:
    try:
        return int((item or {}).get("question"))
    except (TypeError, ValueError):
        return None


def _g(value: float, digits: int = 1) -> str:
    rounded = round(float(value), digits)
    return f"{rounded:g}"


def _content(rubric: Any) -> dict[str, Any]:
    content = getattr(rubric, "content", None) if rubric is not None else None
    return content if isinstance(content, dict) else {}


def rubric_questions(rubric_content: dict[str, Any] | None) -> dict[int, dict[str, Any]]:
    """The rubric's question dicts by number."""
    out: dict[int, dict[str, Any]] = {}
    for q in (rubric_content or {}).get("questions") or []:
        if isinstance(q, dict) and (n := _qnum(q)) is not None:
            out.setdefault(n, q)
    return out


def question_items(result: Any, rubric: Any) -> list[dict[str, Any]]:
    """The result's question evaluations with the v3 keys filled (never re-scored), in
    ascending question order."""
    items = marking.annotate_questions([dict(q) for q in result.question_evaluations or []], _content(rubric))
    return sorted((q for q in items if _qnum(q) is not None), key=lambda q: _qnum(q) or 0)


def accuracy(item: dict[str, Any]) -> float:
    """clamp(estimated_marks / max_marks, 0, 1)."""
    maximum = _num(item.get("max_marks"))
    if maximum <= 0:
        return 0.0
    return max(0.0, min(1.0, _num(item.get("estimated_marks")) / maximum))


def marks_plus(item: dict[str, Any]) -> float:
    return max(0.0, _num(item.get("estimated_marks")))


def is_blank(item: dict[str, Any]) -> bool:
    """Not attempted: an MCQ with no readable choice, or a descriptive answer with BLANK outcome."""
    if item.get("question_type") == "mcq":
        return item.get("selected_option") is None
    return insights.outcome_of(item) == "BLANK"


def topic_group(topic: Any, subject: Any = None, chapter: Any = None) -> str:
    """Matrix parent chapter (or chapter) of a topic, else the topic itself."""
    name = " ".join(str(topic or "").split())
    row = analytics.map_chapter(name, subject, chapter) if name or chapter else None
    if row is not None:
        return str(row.get("parent") or row.get("chapter") or name)
    return name


def concept_group(question_eval: dict[str, Any], rubric_question: dict[str, Any] | None) -> str:
    """The concept a question belongs to: rubric `concept`, else rubric `chapter`, else the
    weightage-matrix parent chapter (or chapter) of the topic, else the topic."""
    rq = rubric_question if isinstance(rubric_question, dict) else {}
    for key in ("concept", "chapter"):
        value = " ".join(str(rq.get(key) or "").split())
        if value:
            return value
    topic = rq.get("topic") or (question_eval or {}).get("topic")
    subject = rq.get("subject") or (question_eval or {}).get("subject")
    return topic_group(topic, subject, None) or bloom.concept_key(question_eval) or "General"


def _level(item: dict[str, Any], levels: dict[int, tuple[str, str]]) -> str | None:
    return bloom.parse_level(item.get("bloom_level")) or levels.get(_qnum(item) or -1, (None, None))[0]


# --------------------------------------------------------------------------- #
# FR-4.8 negative marking
# --------------------------------------------------------------------------- #
def _risk(ev: float, wrong: int) -> str:
    ev = round(ev, 6)
    if ev < NEG_HIGH_EV and wrong >= 2:
        return "high"
    if ev < NEG_MEDIUM_EV and wrong >= 1:
        return "medium"
    return "low"


def _topic_advice(topic: str, risk: str, *, wrong: int, attempted: int, lost: float, be: float) -> str:
    if risk == "high":
        return (
            f"Over-attempting {topic}: {wrong} wrong of {attempted} attempted (-{lost:g} marks). Attempt only when "
            f"you can eliminate at least 2 options (>= 50% sure); drill {topic} MCQs untimed first."
        )
    if risk == "medium":
        return f"Careful with {topic}: eliminate at least one option before answering (>= 34% sure)."
    if attempted == 0:
        return (
            f"No attempts in {topic}: an answer after ruling out one option is worth it here "
            f"(break-even {be:.0%})."
        )
    return f"Negative marking is not costing you in {topic}; keep attempting when you can rule out one option."


def negative_marking_profile(questions: list[dict[str, Any]], rubric_content: dict[str, Any] | None) -> dict[str, Any] | None:
    """A NegativeMarkingProfile over the negatively-marked MCQs, or None when there are none."""
    policy = marking.policy_for(rubric_content)
    by_number = rubric_questions(rubric_content)
    groups: dict[str, list[dict[str, Any]]] = {}
    maxes: list[float] = []
    negs: list[float] = []
    bonus: list[tuple[int, float]] = []
    for q in questions:
        rq = by_number.get(_qnum(q) or -1)
        if rq is not None and marking.question_type(rq) == "mcq" and marking.is_bonus(rq):
            bonus.append((_qnum(q) or 0, _num(q.get("estimated_marks"))))
        if rq is None or marking.question_type(rq) != "mcq" or marking.is_bonus(rq):
            continue  # a bonus question carries no penalty risk (full marks to everyone)
        qp = marking.question_policy(rq, policy)
        neg = _num(qp.get("negative_marks"))
        if neg <= 0:
            continue
        max_marks = _num(rq.get("max_marks"), _num(q.get("max_marks")))
        selected = q.get("selected_option")
        correct = q.get("correct_option")
        if selected is None or selected == marking.UNKNOWN:
            state = "blank"
        elif selected != marking.MULTI and correct is not None and selected == correct:
            state = "correct"
        else:
            state = "wrong"
        penalty = _num(q.get("penalty")) or (neg if state == "wrong" else 0.0)
        topic = str(q.get("topic") or rq.get("topic") or f"Question {_qnum(q)}")
        groups.setdefault(topic, []).append({
            "state": state, "max": max_marks, "neg": neg, "penalty": penalty if state == "wrong" else 0.0,
            "marks": _num(q.get("estimated_marks")),
        })
        maxes.append(max_marks)
        negs.append(neg)
    if not groups:
        return None

    topics: list[dict[str, Any]] = []
    for topic, items in groups.items():
        correct = sum(1 for i in items if i["state"] == "correct")
        wrong = sum(1 for i in items if i["state"] == "wrong")
        blank = sum(1 for i in items if i["state"] == "blank")
        attempted = correct + wrong
        mean_max, mean_neg = fmean(i["max"] for i in items), fmean(i["neg"] for i in items)
        a_s = (correct + 1) / (attempted + 2)
        ev = a_s * mean_max - (1 - a_s) * mean_neg
        risk = _risk(ev, wrong)
        be = break_even(mean_max, mean_neg)
        lost = round(sum(i["penalty"] for i in items), 2)
        topics.append({
            "topic": topic,
            "attempted": attempted,
            "correct": correct,
            "wrong": wrong,
            "blank": blank,
            "accuracy": round(correct / attempted, 3) if attempted else None,
            "marks_lost": lost,
            "risk": risk,
            "over_attempting": risk == "high",
            "skip_threshold": SKIP_THRESHOLD.get(risk, be),
            "eliminate_options": ELIMINATE_OPTIONS[risk],
            "advice": _topic_advice(topic, risk, wrong=wrong, attempted=attempted, lost=lost, be=be),
        })
    topics.sort(key=lambda t: (-RISK_ORDER[t["risk"]], -t["marks_lost"], t["topic"]))

    correct = sum(t["correct"] for t in topics)
    wrong = sum(t["wrong"] for t in topics)
    blank = sum(t["blank"] for t in topics)
    attempted = correct + wrong
    lost = round(sum(t["marks_lost"] for t in topics), 2)
    net = round(sum(i["marks"] for items in groups.values() for i in items), 2)
    risk = max((t["risk"] for t in topics), key=lambda r: RISK_ORDER[r])
    mean_max, mean_neg = fmean(maxes), fmean(negs)
    be = break_even(mean_max, mean_neg)
    total_items = len(maxes)

    high = [t for t in topics if t["risk"] == "high"]
    medium = [t for t in topics if t["risk"] == "medium"]
    if high:
        recoverable = round(sum(t["marks_lost"] for t in high), 2)
        recommendation = (
            f"Negative marking cost {lost:g} marks ({wrong} wrong of {attempted} attempted). Over-attempting in "
            f"{', '.join(t['topic'] for t in high)}: about {recoverable:g} marks are recoverable by answering there "
            "only after eliminating 2 options."
        )
    elif medium:
        recommendation = (
            f"Negative marking cost {lost:g} marks. Eliminate at least one option before answering in "
            f"{', '.join(t['topic'] for t in medium)}."
        )
    elif wrong:
        recommendation = f"Negative marking is under control: {lost:g} marks lost across {attempted} attempts."
    else:
        recommendation = "No marks lost to negative marking."
    if blank >= max(3, math.ceil(0.25 * total_items)):
        # One denominator: the scorable MCQs (bonus questions excluded and said so).
        excluded = f" ({len(bonus)} bonus excluded)" if bonus else ""
        recommendation += (
            f" {blank} of {total_items} scorable MCQs{excluded} were left blank: with +{mean_max:g}/-{mean_neg:g} "
            f"an answer after ruling out one option has positive expected value (break-even {be:.0%})."
        )
    bonus_marks = round(sum(m for _, m in bonus), 2)
    total = round(sum(_num(q.get("estimated_marks")) for q in questions), 2)
    return {
        "scheme": f"+{mean_max:g} / -{mean_neg:g}",
        "break_even": be,
        "attempted": attempted,
        "correct": correct,
        "wrong": wrong,
        "blank": blank,
        "accuracy": round(correct / attempted, 3) if attempted else None,
        "marks_lost": lost,
        "net_marks": net,
        "risk": risk,
        "topics": topics,
        "recommendation": recommendation,
        "bonus_questions": sorted(n for n, _ in bonus),
        "bonus_marks": bonus_marks,
        # net_answered (right x marks - penalties) + bonus_marks (+ any non-MCQ marks) = total
        "reconciliation": {"net_answered": net, "bonus_marks": bonus_marks, "total": total},
    }


# --------------------------------------------------------------------------- #
# FR-4.10 fatigue
# --------------------------------------------------------------------------- #
def _side_accuracy(items: list[dict[str, Any]]) -> float:
    maximum = sum(_num(q.get("max_marks")) for q in items)
    return sum(marks_plus(q) for q in items) / maximum if maximum > 0 else 0.0


def _answered(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Answered, non-bonus questions: accuracy is measured on these only (a blank is not a wrong
    answer - blanks are reported as a blank rate)."""
    return [q for q in items if marking.result_kind(q) not in ("blank", "bonus")]


def _enough(answered: list[dict[str, Any]], items: list[dict[str, Any]]) -> bool:
    scorable = sum(1 for q in items if marking.result_kind(q) != "bonus")
    return bool(answered) and len(answered) >= min(MIN_FATIGUE_ANSWERED, math.ceil(scorable / 2))


def _blank_rate(items: list[dict[str, Any]]) -> float:
    scorable = [q for q in items if marking.result_kind(q) != "bonus"]
    return sum(1 for q in scorable if marking.result_kind(q) == "blank") / len(scorable) if scorable else 0.0


def _subject_blocks(ordered: list[dict[str, Any]], subject_of: dict[int, str] | None) -> dict[str, list[dict[str, Any]]]:
    blocks: dict[str, list[dict[str, Any]]] = {}
    for q in ordered:
        name = (subject_of or {}).get(_qnum(q) or -1) or str(q.get("subject") or "") or "General"
        blocks.setdefault(name, []).append(q)
    return blocks


def _contiguous(ordered: list[dict[str, Any]], blocks: dict[str, list[dict[str, Any]]]) -> bool:
    """Every subject sits in one unbroken run of the paper (fixed sections)."""
    position = {id(q): i for i, q in enumerate(ordered)}
    for items in blocks.values():
        spots = sorted(position[id(q)] for q in items)
        if spots[-1] - spots[0] + 1 != len(spots):
            return False
    return True


def subject_pacing(
    ordered: list[dict[str, Any]], subject_of: dict[int, str] | None
) -> tuple[list[dict[str, Any]], float | None, float | None]:
    """(SubjectPacing rows, question-weighted accuracy change in pts, question-weighted blank-rate
    change) - first half vs second half of each subject section, answered questions only."""
    rows: list[dict[str, Any]] = []
    weight = change_sum = blank_sum = 0.0
    for subject, items in _subject_blocks(ordered, subject_of).items():
        if len(items) < 2:
            continue
        half = math.ceil(len(items) / 2)
        first, second = items[:half], items[half:]
        a1, a2 = _answered(first), _answered(second)
        acc1 = _side_accuracy(a1) if a1 else None
        acc2 = _side_accuracy(a2) if a2 else None
        comparable = _enough(a1, first) and _enough(a2, second)
        change = (acc2 - acc1) * 100 if comparable and acc1 is not None and acc2 is not None else None
        b1, b2 = _blank_rate(first), _blank_rate(second)
        rows.append({
            "subject": subject,
            "first_from": _qnum(first[0]), "first_to": _qnum(first[-1]),
            "second_from": _qnum(second[0]), "second_to": _qnum(second[-1]),
            "first_right": sum(1 for q in a1 if marking.result_kind(q) == "right"), "first_attempted": len(a1),
            "second_right": sum(1 for q in a2 if marking.result_kind(q) == "right"), "second_attempted": len(a2),
            "first_accuracy": round(acc1, 3) if acc1 is not None else None,
            "second_accuracy": round(acc2, 3) if acc2 is not None else None,
            "change_pts": round(change, 1) if change is not None else None,
        })
        if change is not None:
            weight += len(items)
            change_sum += len(items) * change
            blank_sum += len(items) * (b2 - b1)
    if not weight:
        return rows, None, None
    return rows, change_sum / weight, blank_sum / weight


def _moved(change: float, digits: int = 0) -> str:
    """'rose 21 pts' / 'fell 4.5 pts' / 'held steady' - never a negative drop."""
    if round(change, digits) > 0:
        return f"rose {_g(change, digits)} pts"
    if round(change, digits) < 0:
        return f"fell {_g(-change, digits)} pts"
    return "held steady"


def fatigue_profile(
    questions: list[dict[str, Any]], peers_acc: dict[int, float] | None, cohort_size: int,
    subject_of: dict[int, str] | None = None,
) -> dict[str, Any] | None:
    """A FatigueProfile (final third vs the rest, on ANSWERED questions; blanks as a blank rate),
    or None with fewer than 6 questions. The cohort adjustment applies only when peers_acc is given
    and cohort_size >= COHORT_ADJUST_MIN. When the subjects sit in fixed sections (2+ subjects, each
    in one block) the early-vs-late split compares subjects, not stamina: the flag then rests on
    the question-weighted change WITHIN each subject (first half vs second half)."""
    ordered = sorted(questions, key=lambda q: _qnum(q) or 0)
    n = len(ordered)
    if n < MIN_FATIGUE_QUESTIONS:
        return None
    k = math.ceil(n / 3)
    early, late = ordered[: n - k], ordered[n - k:]
    early_ans, late_ans = _answered(early), _answered(late)
    early_acc = _side_accuracy(early_ans) if early_ans else 0.0
    late_acc = _side_accuracy(late_ans) if late_ans else 0.0
    drop = (early_acc - late_acc) * 100 if early_ans and late_ans else 0.0
    comparable = _enough(early_ans, early) and _enough(late_ans, late)
    adjust = bool(peers_acc) and cohort_size >= COHORT_ADJUST_MIN
    adjusted = None
    if adjust:
        assert peers_acc is not None

        def rel(items: list[dict[str, Any]]) -> float:
            if not items:
                return 0.0
            return fmean(accuracy(q) - peers_acc.get(_qnum(q) or -1, accuracy(q)) for q in items)

        adjusted = (rel(early_ans) - rel(late_ans)) * 100
    early_blank, late_blank = _blank_rate(early), _blank_rate(late)
    jump = late_blank - early_blank

    blocks = _subject_blocks(ordered, subject_of)
    pacing, within_change, within_blank = subject_pacing(ordered, subject_of)
    confounded = len(blocks) >= 2 and _contiguous(ordered, blocks)
    if confounded:
        signal = -within_change if within_change is not None else 0.0
        jump_signal = within_blank if within_blank is not None else 0.0
    else:
        signal = (adjusted if adjusted is not None else drop) if comparable else 0.0
        jump_signal = jump
    flagged = round(signal, 6) >= FATIGUE_FLAG_PTS or round(jump_signal, 6) >= FATIGUE_BLANK_JUMP
    if round(signal, 6) >= FATIGUE_HIGH_PTS or round(jump_signal, 6) >= FATIGUE_HIGH_BLANK_JUMP:
        severity = "high"
    else:
        severity = "medium" if flagged else "low"

    first_late, last = _qnum(late[0]), _qnum(ordered[-1])
    span = f"Q{first_late}-Q{last}"
    adj_text = f" (cohort-adjusted {_g(round(adjusted) or 0.0, 0)} pts)" if adjusted is not None else ""
    if confounded:
        reasons = [
            "Within each subject, accuracy on answered questions "
            + (f"{_moved(within_change, 1)} from the first half to the second" if within_change is not None
               else "could not be compared (too few answered questions)")
            + " - subjects sit in fixed sections, so the paper-wide early-vs-late split is not used"
        ]
        if within_blank is not None and within_blank > 0:
            reasons.append(f"Blank rate rose {within_blank * 100:.0f} pts from the first half to the second "
                           "within subjects")
    else:
        verb = _moved(-drop)
        reasons = [f"Accuracy {verb} in {span}{adj_text}" if verb != "held steady"
                   else f"Accuracy held steady in {span}{adj_text}"]
        if not comparable:
            reasons[0] += " - too few answered questions on one side to judge"
        if jump > 0:
            reasons.append(f"Blank rate rose from {early_blank:.0%} to {late_blank:.0%} in the final third")
    series = [
        {
            "question": _qnum(q),
            "accuracy": round(accuracy(q), 3),
            "cohort_accuracy": round(peers_acc[_qnum(q)], 3) if adjust and peers_acc and _qnum(q) in peers_acc else None,
            "final_third": index >= n - k,
            "blank": is_blank(q),
        }
        for index, q in enumerate(ordered)
    ]
    return {
        "questions": n,
        "final_third_from": first_late,
        "early_accuracy": round(early_acc, 3),
        "late_accuracy": round(late_acc, 3),
        "drop_pts": round(drop, 1),
        "adjusted_drop_pts": round(adjusted, 1) if adjusted is not None else None,
        "cohort_size": int(cohort_size),
        "early_blank_rate": round(early_blank, 3),
        "late_blank_rate": round(late_blank, 3),
        "flagged": flagged,
        "severity": severity,
        "reasons": reasons,
        "recommendation": FATIGUE_RECOMMENDATION if flagged else NO_FATIGUE_RECOMMENDATION,
        "series": series,
        "within_subject": pacing,
        "within_subject_change_pts": round(within_change, 1) if within_change is not None else None,
        "confounded_by_section": confounded,
    }


# --------------------------------------------------------------------------- #
# FR-4.11 memorisation vs transfer
# --------------------------------------------------------------------------- #
def classify_transfer(recall: float, transfer: float) -> str:
    """First match wins: foundational_gap, memorisation, inconsistent, transferable, developing."""
    if recall < TRANSFER_LOW and transfer < TRANSFER_LOW:
        return "foundational_gap"
    if recall >= TRANSFER_HIGH and recall - transfer >= TRANSFER_GAP:
        return "memorisation"
    if transfer - recall >= TRANSFER_GAP:
        return "inconsistent"
    if recall >= TRANSFER_HIGH and transfer >= TRANSFER_HIGH:
        return "transferable"
    return "developing"


def _names(items: list[str], limit: int = 4) -> str:
    shown = ", ".join(items[:limit])
    return shown + (f" +{len(items) - limit} more" if len(items) > limit else "")


def transfer_profile(questions: list[dict[str, Any]], rubric_content: dict[str, Any] | None) -> dict[str, Any] | None:
    """A TransferProfile over concepts tested at both recall and transfer levels, or None."""
    by_number = rubric_questions(rubric_content)
    levels = bloom.resolve_levels(rubric_content)
    groups: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for q in sorted(questions, key=lambda item: _qnum(item) or 0):
        level = _level(q, levels)
        if level is None:
            continue
        concept = concept_group(q, by_number.get(_qnum(q) or -1))
        side = "recall" if level in bloom.RECALL_LEVELS else "transfer"
        groups.setdefault(concept, {"recall": [], "transfer": []})[side].append(q)

    concepts: list[dict[str, Any]] = []
    for concept, sides in groups.items():
        if not sides["recall"] or not sides["transfer"]:
            continue
        recall = _side_accuracy(sides["recall"]) * 100
        transfer = _side_accuracy(sides["transfer"]) * 100
        cls = classify_transfer(round(recall, 6), round(transfer, 6))
        concepts.append({
            "concept": concept,
            "recall_questions": [_qnum(q) for q in sides["recall"]],
            "transfer_questions": [_qnum(q) for q in sides["transfer"]],
            "recall_accuracy": round(recall, 1),
            "transfer_accuracy": round(transfer, 1),
            "gap_pts": round(recall - transfer, 1),
            "classification": cls,
            "advice": TRANSFER_ADVICE[cls].format(concept=concept),
        })
    if not concepts:
        return None
    n = len(concepts)
    by_class: dict[str, list[str]] = {}
    for c in concepts:
        by_class.setdefault(c["classification"], []).append(c["concept"])
    memo, transferable, gaps = by_class.get("memorisation", []), by_class.get("transferable", []), by_class.get("foundational_gap", [])
    plural = "s" if n != 1 else ""
    if memo:
        summary = (
            f"Memorisation pattern in {len(memo)} of {n} concept{plural} ({_names(memo)}): recall is at least "
            f"{TRANSFER_GAP:g} pts ahead of application."
        )
    elif gaps and len(gaps) * 2 >= n:
        summary = (
            f"Foundational gaps in {len(gaps)} of {n} concept{plural} ({_names(gaps)}): recall and application "
            f"are both below {TRANSFER_LOW:g}%."
        )
    elif len(transferable) == n:
        summary = (
            f"Knowledge transfers: recall and application are both at or above {TRANSFER_HIGH:g}% in "
            f"{'all ' if n > 1 else ''}{n} concept{plural}."
        )
    else:
        summary = f"{len(transferable)} of {n} concept{plural} transfer to application; the rest are still developing."
    return {"concepts": concepts, "memorisation": len(memo), "transferable": len(transferable), "summary": summary}


# --------------------------------------------------------------------------- #
# Bloom profile
# --------------------------------------------------------------------------- #
def bloom_profile(questions: list[dict[str, Any]], levels: dict[int, tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    """One BloomBucket per level present (in K1..K5 order): questions, NET marks (penalties
    included, so the levels add up to the paper score), max, accuracy (0-1, net marks clamped at 0)."""
    buckets: dict[str, list[float]] = {}
    for q in questions:
        level = _level(q, levels or {})
        if level is None:
            continue
        bucket = buckets.setdefault(level, [0, 0.0, 0.0, 0.0])
        bucket[0] += 1
        bucket[1] += _num(q.get("estimated_marks"))
        bucket[2] += _num(q.get("max_marks"))
        bucket[3] += marks_plus(q)
    return [
        {
            "level": level,
            "questions": int(buckets[level][0]),
            "marks": round(buckets[level][1], 2),
            "max_marks": round(buckets[level][2], 2),
            "accuracy": round(max(0.0, buckets[level][1]) / buckets[level][2], 3) if buckets[level][2] > 0 else None,
            "marks_before_penalty": round(buckets[level][3], 2),
        }
        for level in bloom.LEVELS
        if level in buckets
    ]


def bloom_informative(questions: list[dict[str, Any]], levels: dict[int, tuple[str, str]] | None = None) -> bool:
    """The Bloom card says something: 2+ distinct levels, and not every tag is the heuristic default."""
    seen: set[str] = set()
    sources: set[str] = set()
    for q in questions:
        level = _level(q, levels or {})
        if level is None:
            continue
        seen.add(level)
        source = q.get("bloom_source") or (levels or {}).get(_qnum(q) or -1, (None, None))[1]
        sources.add(str(source or "heuristic"))
    return len(seen) >= 2 and sources != {"heuristic"}


# --------------------------------------------------------------------------- #
# Hooks
# --------------------------------------------------------------------------- #
def _peer_accuracy(question_lists: list[list[dict[str, Any]]]) -> dict[int, float]:
    """Mean per-question accuracy over a set of results' question evaluations."""
    sums: dict[int, list[float]] = {}
    for items in question_lists:
        for q in items or []:
            if isinstance(q, dict) and (n := _qnum(q)) is not None:
                sums.setdefault(n, []).append(accuracy(q))
    return {n: fmean(values) for n, values in sums.items()}


def student_patterns(
    questions: list[dict[str, Any]],
    rubric_content: dict[str, Any] | None,
    *,
    peers_acc: dict[int, float] | None,
    cohort_size: int,
) -> dict[str, Any]:
    """A StudentPatterns dict from annotated questions."""
    notes: list[str] = []
    negative = negative_marking_profile(questions, rubric_content)
    if negative is None:
        notes.append(NO_NEGATIVE_MCQ_NOTE)
    fatigue = fatigue_profile(questions, peers_acc, cohort_size, subject_map(rubric_content))
    if fatigue is None:
        notes.append(FATIGUE_NOTE.format(n=len(questions)))
    transfer = transfer_profile(questions, rubric_content)
    if transfer is None:
        notes.append(TRANSFER_NOTE)
    if negative or fatigue or transfer:
        notes.append(THRESHOLD_NOTE)
    levels = bloom.resolve_levels(rubric_content)
    return {
        "negative_marking": negative,
        "fatigue": fatigue,
        "transfer": transfer,
        "bloom_profile": bloom_profile(questions, levels),
        "notes": notes,
        "bloom_informative": bloom_informative(questions, levels),
    }


def subject_map(rubric_content: dict[str, Any] | None) -> dict[int, str]:
    """Question number -> subject (the rubric question's subject, else the rubric's)."""
    default = " ".join(str((rubric_content or {}).get("subject") or "").split()) or "General"
    return {
        n: " ".join(str(q.get("subject") or "").split()) or default
        for n, q in rubric_questions(rubric_content).items()
    }


def _rubric_peers(db: Any, rubric_id: int | None) -> list[list[dict[str, Any]]]:
    """question_evaluations of up to PEER_CAP COMPLETED results on a rubric (any batch, demo included)."""
    if db is None or rubric_id is None:
        return []
    from database import EvaluationResult, StudentSubmission, SubmissionStatus

    rows = db.scalars(
        select(EvaluationResult.question_evaluations)
        .join(StudentSubmission, EvaluationResult.submission_id == StudentSubmission.id)
        .where(StudentSubmission.rubric_id == rubric_id, StudentSubmission.status == SubmissionStatus.COMPLETED)
        .order_by(StudentSubmission.created_at.desc())
        .limit(PEER_CAP)
    ).all()
    return [list(r or []) for r in rows]


def _peer_stats(db: Any, rubric_id: int | None) -> tuple[dict[int, float] | None, int]:
    """(peers_acc, cohort_size) over _rubric_peers, memoised per rubric. One aggregate query keys the
    entry (count, max result id, max submission updated_at of the peer rows): a new, removed, re-run
    or re-graded sheet changes it (results are replaced, never edited in place), so a stale entry is
    never read and the peers' question JSON is decoded only when the peer set changed."""
    if db is None or rubric_id is None:
        return None, 0
    from database import EvaluationResult, StudentSubmission, SubmissionStatus

    token = tuple(db.execute(
        select(func.count(), func.max(EvaluationResult.id), func.max(StudentSubmission.updated_at))
        .join(StudentSubmission, EvaluationResult.submission_id == StudentSubmission.id)
        .where(StudentSubmission.rubric_id == rubric_id, StudentSubmission.status == SubmissionStatus.COMPLETED)
    ).one())
    key = (str(db.get_bind().url), rubric_id)
    cached = _PEER_STATS.get(key)
    if cached is not None and cached[0] == token:
        return cached[1], cached[2]
    peers = _rubric_peers(db, rubric_id)
    peers_acc = _peer_accuracy(peers) if len(peers) >= COHORT_ADJUST_MIN else None
    _PEER_STATS[key] = (token, peers_acc, len(peers))
    return peers_acc, len(peers)


def result_extras(db: Any, *, sub: Any, result: Any, rubric: Any) -> dict[str, Any]:
    """{"patterns": StudentPatterns} for one completed result."""
    questions = question_items(result, rubric)
    rubric_id = getattr(sub, "rubric_id", None) or getattr(result, "rubric_id", None)
    peers_acc, cohort_size = _peer_stats(db, rubric_id)
    return {"patterns": student_patterns(
        questions, _content(rubric), peers_acc=peers_acc, cohort_size=cohort_size
    )}


def _modal_risk(risks: list[str]) -> str:
    counts = Counter(risks)
    return max(counts, key=lambda r: (counts[r], RISK_ORDER[r]))


def _latest_test_only(profiles: list[tuple[Any, dict[str, Any]]], sections: list[dict[str, Any] | None]) -> int:
    """Keep one student-list row per student (their most recent flagged test) in each section.
    Returns how many students have more than one profiled test (0 when filtered to one test)."""
    def key(sub: Any) -> str:
        return getattr(sub, "student_ref", None) or hashing.student_ref_for(sub.student_name)

    tests = Counter(key(sub) for sub, _ in profiles)
    repeated = sum(1 for n in tests.values() if n > 1)
    if not repeated:
        return 0
    subs = {sub.id: sub for sub, _ in profiles}
    for section in sections:
        if not section:
            continue
        kept: dict[str, int] = {}
        for sid in sorted((r["submission_id"] for r in section["students"]), key=lambda i: (str(subs[i].created_at), i)):
            kept[key(subs[sid])] = sid  # the newest test wins
        section["students"] = [r for r in section["students"] if r["submission_id"] in kept.values()]
    return repeated


def cohort_extras(db: Any, *, pairs: list[tuple[Any, Any]], rubrics: dict[int, Any]) -> dict[str, Any]:
    """{"patterns": CohortPatterns} over the completed (submission, result) pairs. Each student is
    profiled against their own rubric; fatigue peers are the pairs on the same rubric."""
    by_rubric: dict[Any, list[tuple[Any, Any]]] = {}
    for sub, result in pairs:
        if result is None:
            continue
        by_rubric.setdefault(getattr(sub, "rubric_id", None), []).append((sub, result))

    profiles: list[tuple[Any, dict[str, Any]]] = []
    levels_by_q: list[tuple[list[dict[str, Any]], dict[int, tuple[str, str]]]] = []
    for rubric_id, group in by_rubric.items():
        rubric = rubrics.get(rubric_id) if rubric_id is not None else None
        content = _content(rubric)
        peers_acc = (
            _peer_accuracy([list(r.question_evaluations or []) for _, r in group])
            if len(group) >= COHORT_ADJUST_MIN else None
        )
        levels = bloom.resolve_levels(content)
        for sub, result in group:
            questions = question_items(result, rubric)
            levels_by_q.append((questions, levels))
            profiles.append((sub, student_patterns(questions, content, peers_acc=peers_acc, cohort_size=len(group))))

    notes: list[str] = []
    # --- negative marking ---
    neg_rows = [(sub, p["negative_marking"]) for sub, p in profiles if p["negative_marking"]]
    negative = None
    if neg_rows:
        topic_rows: dict[str, list[dict[str, Any]]] = {}
        for _, profile in neg_rows:
            for t in profile["topics"]:
                topic_rows.setdefault(t["topic"], []).append(t)
        topics = []
        for topic, rows in topic_rows.items():
            accs = [r["accuracy"] for r in rows if r["accuracy"] is not None]
            modal = _modal_risk([r["risk"] for r in rows])
            topics.append({
                "topic": topic,
                "students_profiled": len(rows),
                "students_over_attempting": sum(1 for r in rows if r["over_attempting"]),
                "mean_accuracy": round(fmean(accs), 3) if accs else None,
                "marks_lost": round(sum(r["marks_lost"] for r in rows), 2),
                "skip_threshold": next(r["skip_threshold"] for r in rows if r["risk"] == modal),
            })
        topics.sort(key=lambda t: (-t["students_over_attempting"], -t["marks_lost"], t["topic"]))
        students = [
            {
                "submission_id": sub.id,
                "student_name": sub.student_name,
                "value": p["marks_lost"],
                "detail": (
                    f"Over-attempting {', '.join(t['topic'] for t in p['topics'] if t['risk'] == 'high')}: "
                    f"{p['wrong']} wrong, -{p['marks_lost']:g} marks"
                ),
                "severity": "high",
            }
            for sub, p in neg_rows
            if p["risk"] == "high"
        ]
        students.sort(key=lambda s: (-s["value"], s["student_name"]))
        negative = {
            "students_profiled": len(neg_rows),
            "marks_lost_total": round(sum(p["marks_lost"] for _, p in neg_rows), 2),
            "topics": topics,
            "students": students,
        }
    else:
        notes.append(NO_NEGATIVE_MCQ_NOTE)

    # --- fatigue ---
    fat_rows = [(sub, p["fatigue"]) for sub, p in profiles if p["fatigue"]]
    fatigue = None
    if fat_rows:
        flagged = [(sub, f) for sub, f in fat_rows if f["flagged"]]

        def signal(f: dict[str, Any]) -> float:
            return f["adjusted_drop_pts"] if f["adjusted_drop_pts"] is not None else f["drop_pts"]

        fatigue = {
            "students_profiled": len(fat_rows),
            "flagged_count": len(flagged),
            "early_accuracy": round(fmean(f["early_accuracy"] for _, f in fat_rows), 3),
            "late_accuracy": round(fmean(f["late_accuracy"] for _, f in fat_rows), 3),
            "students": sorted(
                (
                    {
                        "submission_id": sub.id,
                        "student_name": sub.student_name,
                        "value": signal(f),
                        "detail": "; ".join(f["reasons"]),
                        "severity": f["severity"],
                    }
                    for sub, f in flagged
                ),
                key=lambda s: (-s["value"], s["student_name"]),
            ),
        }
    else:
        notes.append(f"Fatigue needs at least {MIN_FATIGUE_QUESTIONS} questions per test")

    # --- transfer ---
    tr_rows = [(sub, p["transfer"]) for sub, p in profiles if p["transfer"]]
    transfer = None
    if tr_rows:
        concept_rows: dict[str, list[str]] = {}
        for _, profile in tr_rows:
            for c in profile["concepts"]:
                concept_rows.setdefault(c["concept"], []).append(c["classification"])
        concepts = [
            {
                "concept": concept,
                "students": len(classes),
                "memorisation": classes.count("memorisation"),
                "transferable": classes.count("transferable"),
                "foundational_gap": classes.count("foundational_gap"),
            }
            for concept, classes in concept_rows.items()
        ]
        concepts.sort(key=lambda c: (-c["memorisation"], -c["students"], c["concept"]))
        students = []
        for sub, profile in tr_rows:
            memo = [c["concept"] for c in profile["concepts"] if c["classification"] == "memorisation"]
            if len(memo) >= 2:
                students.append({
                    "submission_id": sub.id,
                    "student_name": sub.student_name,
                    "value": float(len(memo)),
                    "detail": f"Memorisation in {_names(memo)}",
                    "severity": "high" if len(memo) >= 3 else "medium",
                })
        students.sort(key=lambda s: (-s["value"], s["student_name"]))
        transfer = {"students_profiled": len(tr_rows), "concepts": concepts, "students": students}
    else:
        notes.append(TRANSFER_NOTE)

    bloom_rows: list[dict[str, Any]] = []
    totals: dict[str, list[float]] = {}
    for questions, levels in levels_by_q:
        for bucket in bloom_profile(questions, levels):
            agg = totals.setdefault(bucket["level"], [0, 0.0, 0.0, 0.0])
            agg[0] += bucket["questions"]
            agg[1] += bucket["marks"]
            agg[2] += bucket["max_marks"]
            agg[3] += bucket.get("marks_before_penalty") or 0.0
    for level in bloom.LEVELS:
        if level in totals:
            q, marks, maximum, before = totals[level]
            bloom_rows.append({
                "level": level, "questions": int(q), "marks": round(marks, 2), "max_marks": round(maximum, 2),
                "accuracy": round(max(0.0, marks) / maximum, 3) if maximum > 0 else None,
                "marks_before_penalty": round(before, 2),
            })
    repeated = _latest_test_only(profiles, [negative, fatigue, transfer])
    if repeated:
        notes.append(REPEATED_NOTE.format(n=repeated))
    if negative or fatigue or transfer:
        notes.append(THRESHOLD_NOTE)
    return {"patterns": {
        "negative_marking": negative,
        "fatigue": fatigue,
        "transfer": transfer,
        "bloom_profile": bloom_rows,
        "notes": notes,
    }}
