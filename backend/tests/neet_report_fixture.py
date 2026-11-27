"""A 180-question NEET paper with report 1's exact distribution (the user's real /report/1: 402/720),
scored through the real marking engine. Shared by the report-redesign tests.

Physics   Q1-45:   18 right, 8 wrong, 19 blank            -> 64/180 (35.6%)
Chemistry Q46-90:  19 right, 8 wrong, 17 blank, bonus Q71 -> 72/180 (40.0%)
Biology   Q91-180: 68 right, 10 wrong, 11 blank, bonus Q98 -> 266/360 (73.9%)

Pacing within each subject (answered, non-bonus questions):
Physics Q1-23 6/10, Q24-45 12/16; Chemistry Q46-68 9/13, Q69-90 10/14; Biology Q91-135 33/38,
Q136-180 35/40. Q51 accepts B or C (marked A, wrong), Q53 accepts A or D (marked A, right),
Q111 accepts A or B (marked B, right), Q112 is blank, Q71 and Q98 are bonus (both answered).
"""
from __future__ import annotations

from typing import Any

SECTIONS = (("Physics", 1, 45), ("Chemistry", 46, 90), ("Biology", 91, 180))
POLICY = {"partial_credit": "all_or_nothing", "negative_marks": 1, "scheme_name": "+4 / -1"}
ACCEPTED = {51: ["B", "C"], 53: ["A", "D"], 111: ["A", "B"]}
BONUS = {71, 98}
LOW_CONFIDENCE = {42: 0.6, 51: 0.5, 60: 0.6, 108: 0.6}
# (first, last, right, wrong) per half-section; every other non-bonus question is blank.
HALVES = (
    (1, 23, 6, 4), (24, 45, 12, 4),
    (46, 68, 9, 4), (69, 90, 10, 4),
    (91, 135, 33, 5), (136, 180, 35, 5),
)
# Questions pinned to an outcome (the rest of each half is filled in question order).
PINNED = {51: "wrong", 53: "right", 111: "right", 112: "blank"}


def _outcomes() -> dict[int, str]:
    out: dict[int, str] = {n: "bonus" for n in BONUS}
    for first, last, right, wrong in HALVES:
        numbers = [n for n in range(first, last + 1) if n not in BONUS]
        quota = {"right": right, "wrong": wrong, "blank": len(numbers) - right - wrong}
        for n in numbers:
            if n in PINNED:
                out[n] = PINNED[n]
                quota[PINNED[n]] -= 1
        # Interleave right / wrong / blank so no half is front-loaded.
        cycle = ("right", "wrong", "blank")
        index = 0
        for n in numbers:
            if n in out:
                continue
            for _ in range(3):
                kind = cycle[index % 3]
                index += 1
                if quota[kind] > 0:
                    break
            else:
                kind = next(k for k, v in quota.items() if v > 0)
            out[n] = kind
            quota[kind] -= 1
        assert all(v == 0 for v in quota.values()), (first, quota)
    return out


OUTCOMES = _outcomes()


def subject_of(number: int) -> str:
    return next(name for name, first, last in SECTIONS if first <= number <= last)


def rubric_content() -> dict[str, Any]:
    questions = []
    for number in range(1, 181):
        subject = subject_of(number)
        q: dict[str, Any] = {
            "question": number, "topic": subject, "subject": subject, "max_marks": 4, "question_type": "mcq",
            "options": ["a", "b", "c", "d"], "expected_answer": "", "grading_criteria": ["4 marks: correct option"],
            "effort_hours": 1,
        }
        if number in ACCEPTED:
            q["accepted_options"] = list(ACCEPTED[number])
        else:
            q["correct_option"] = "A" if number % 2 else "C"
        if number in BONUS:
            q["bonus"] = True
        questions.append(q)
    return {"name": "NEET mock (report 1 fixture)", "subject": "NEET", "questions": questions,
            "marking_policy": dict(POLICY)}


def _answer(number: int, kind: str, content: dict[str, Any]) -> str:
    q = content["questions"][number - 1]
    key = (q.get("accepted_options") or [q.get("correct_option")])
    if number == 51:
        return "A"
    if number == 111:
        return "B"
    if kind == "right":
        return key[0]
    if kind == "bonus":
        return "A"
    if kind == "wrong":
        return next(letter for letter in "ABCD" if letter not in key)
    return ""


def answers() -> list[dict[str, Any]]:
    content = rubric_content()
    out = []
    for number in range(1, 181):
        text = _answer(number, OUTCOMES[number], content)
        if not text:
            continue
        page = 1 + (number - 1) // 20
        out.append({"question": number, "answer": text, "confidence": LOW_CONFIDENCE.get(number, 0.9),
                    "pages": [page]})
    return out


def report() -> dict[str, Any]:
    """insights.build_evaluation_report over the fixture (MCQs only, so no grading call)."""
    import insights
    from ai_schemas import EvaluationOutput

    empty = EvaluationOutput(evaluations=[], overall_strengths=[], overall_gaps=[])
    return insights.build_evaluation_report(rubric_content(), answers(), empty)


def install(db, sub) -> None:
    """Re-point a COMPLETED submission at the fixture rubric and replace its result with the fixture
    report (same session; commits). The report then reads exactly like /report/1."""
    import results_store
    import rubric_store
    from schemas import RubricContentIn

    rubric = rubric_store.create_rubric(db, RubricContentIn.model_validate(rubric_content()))
    sub.rubric_id = rubric.id
    sub.rubric = rubric
    old = sub.result
    if old is not None:
        db.delete(old)
        db.flush()
    sub.result = results_store.build_evaluation_result(report(), rubric=rubric, version=1)
    db.commit()


def transient(days_to_exam: int = 156):
    """(EvaluationResult, Rubric, Batch) - never saved - for the pure analytics functions."""
    from datetime import timedelta

    from database import Batch, EvaluationResult, Rubric, ist_today

    data = report()
    result = EvaluationResult(
        total_score=data["total_score"], total_marks=data["total_marks"], overall_mastery=data["overall_mastery"],
        topic_mastery=data["topic_mastery"], roi_recommendations=data["roi_recommendations"],
        strengths_gaps=data["strengths_gaps"], question_evaluations=data["question_evaluations"],
        summary=None, teaching_nudges=data["teaching_nudges"], confusions=data["confusions"],
        rubric_hash="f" * 64, version=1, release_status="PROVISIONAL",
    )
    content = rubric_content()
    rubric = Rubric(name=content["name"], version="custom-1", total_marks=720.0, content=content,
                    status="AUTHOR_DRAFT", rubric_hash="f" * 64)
    batch = Batch(name="NEET-A", exam_type="Mock-07", exam="NEET",
                  exam_date=(ist_today() + timedelta(days=days_to_exam)).isoformat())
    return result, rubric, batch
