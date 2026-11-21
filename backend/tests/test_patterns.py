"""Exam-behaviour patterns (FR-4.8 negative marking, FR-4.10 fatigue, FR-4.11 memorisation vs
transfer): the section-11 rules on constructed results, the Genetics demo read-out and the
cohort aggregation (including a mixed-rubric cohort)."""
from __future__ import annotations

import pytest

import patterns
from tests.test_contract import check_interface

POLICY = {"partial_credit": "steps", "mark_step": 0.5, "negative_marks": 1, "scheme_name": "NEET +4/-1 (test)"}


def _mcq_content(n: int, topic: str = "Organic Chemistry") -> dict:
    return {
        "name": "MCQ test", "subject": "Chemistry", "marking_policy": POLICY,
        "questions": [
            {"question": i, "topic": topic, "subject": "Chemistry", "max_marks": 4, "effort_hours": 2,
             "question_type": "mcq", "options": ["a", "b", "c", "d"], "correct_option": "A"}
            for i in range(1, n + 1)
        ],
    }


def _mcq_items(states: list[str], topic: str = "Organic Chemistry") -> list[dict]:
    """One answered item per state: c (correct), w (wrong), m (two options), u (unreadable), b (blank)."""
    selected = {"c": "A", "w": "C", "m": "MULTI", "u": "UNKNOWN", "b": None}
    marks = {"c": 4.0, "w": -1.0, "m": -1.0, "u": 0.0, "b": 0.0}
    return [
        {"question": i, "topic": topic, "question_type": "mcq", "max_marks": 4.0, "estimated_marks": marks[s],
         "selected_option": selected[s], "correct_option": "A", "penalty": 1.0 if s in "wm" else 0.0,
         "student_answer": "" if s == "b" else str(selected[s])}
        for i, s in enumerate(states, start=1)
    ]


def _neg(states: list[str]) -> dict:
    profile = patterns.negative_marking_profile(_mcq_items(states), _mcq_content(len(states)))
    assert profile is not None
    return profile


# --------------------------------------------------------------------------- #
# FR-4.8 negative marking
# --------------------------------------------------------------------------- #
def test_three_wrong_of_four_attempted_is_high_risk():
    profile = _neg(["c", "w", "w", "w"])
    topic = profile["topics"][0]
    assert (topic["attempted"], topic["correct"], topic["wrong"], topic["blank"]) == (4, 1, 3, 0)
    assert topic["risk"] == "high" and topic["over_attempting"] is True
    assert topic["skip_threshold"] == 0.5 and topic["eliminate_options"] == 2 and topic["marks_lost"] == 3
    assert topic["advice"].startswith("Over-attempting Organic Chemistry: 3 wrong of 4 attempted (-3 marks).")
    assert profile["risk"] == "high" and profile["scheme"] == "+4 / -1" and profile["break_even"] == 0.2
    assert profile["net_marks"] == 1 and profile["accuracy"] == 0.25
    assert "3 marks are recoverable" in profile["recommendation"]


@pytest.mark.parametrize(
    ("states", "a_s", "ev", "risk", "skip", "eliminate"),
    [
        (["c", "c", "w"], 0.6, 2.0, "low", 0.2, 0),     # EV exactly 2.0 is NOT < 2.0
        (["c", "w"], 0.5, 1.5, "medium", 0.34, 1),
        (["w", "w"], 0.25, 0.25, "high", 0.5, 2),
        (["c", "m", "u"], 0.5, 1.5, "medium", 0.34, 1),  # MULTI = wrong; UNKNOWN = not attempted
    ],
)
def test_risk_boundaries_are_strict(states, a_s, ev, risk, skip, eliminate):
    topic = _neg(states)["topics"][0]
    correct, wrong = topic["correct"], topic["wrong"]
    assert (correct + 1) / (correct + wrong + 2) == pytest.approx(a_s)
    assert (correct + 1) / (correct + wrong + 2) * 4 - (1 - a_s) * 1 == pytest.approx(ev)
    assert (topic["risk"], topic["skip_threshold"], topic["eliminate_options"]) == (risk, skip, eliminate)


def test_an_all_blank_topic_is_low_risk_with_nothing_attempted():
    profile = _neg(["b", "b", "b"])
    topic = profile["topics"][0]
    assert topic["risk"] == "low" and topic["attempted"] == 0 and topic["accuracy"] is None
    assert topic["blank"] == 3 and topic["marks_lost"] == 0
    assert profile["accuracy"] is None and "left blank" in profile["recommendation"]


def test_no_negative_marks_means_no_profile():
    content = _mcq_content(3)
    content["marking_policy"] = {**POLICY, "negative_marks": 0}
    assert patterns.negative_marking_profile(_mcq_items(["c", "w", "w"]), content) is None


def test_worst_topic_sets_the_student_risk_and_topics_sort_by_risk():
    items = _mcq_items(["c", "c", "c"], "Ecology") + [
        {**q, "question": q["question"] + 3} for q in _mcq_items(["w", "w", "w"], "Mechanics")
    ]
    content = _mcq_content(6)
    for q in content["questions"]:
        q["topic"] = "Ecology" if q["question"] <= 3 else "Mechanics"
    profile = patterns.negative_marking_profile(items, content)
    assert profile["risk"] == "high" and [t["topic"] for t in profile["topics"]] == ["Mechanics", "Ecology"]


# --------------------------------------------------------------------------- #
# FR-4.10 fatigue
# --------------------------------------------------------------------------- #
def _desc(marks: list[float | None]) -> list[dict]:
    """Descriptive items out of 10; None = blank."""
    return [
        {"question": i, "topic": "T", "question_type": "descriptive", "max_marks": 10.0,
         "estimated_marks": 0.0 if m is None else m, "student_answer": "" if m is None else "answer",
         "outcome": "BLANK" if m is None else "PARTIAL"}
        for i, m in enumerate(marks, start=1)
    ]


def test_a_30_point_drop_without_peers_is_flagged_high():
    profile = patterns.fatigue_profile(_desc([10] * 6 + [7] * 3), None, 1)
    assert profile["final_third_from"] == 7 and profile["questions"] == 9
    assert profile["drop_pts"] == 30.0 and profile["adjusted_drop_pts"] is None
    assert profile["flagged"] is True and profile["severity"] == "high"
    assert profile["reasons"][0] == "Accuracy fell 30 pts in Q7-Q9"
    assert profile["recommendation"].startswith("Endurance practice")
    assert [q["final_third"] for q in profile["series"]] == [False] * 6 + [True] * 3


def test_the_cohort_adjustment_cancels_a_drop_every_peer_shares():
    peers = {n: (1.0 if n <= 6 else 0.7) for n in range(1, 10)}
    profile = patterns.fatigue_profile(_desc([10] * 6 + [7] * 3), peers, 5)
    assert profile["drop_pts"] == 30.0 and profile["adjusted_drop_pts"] == pytest.approx(0.0, abs=0.01)
    assert profile["flagged"] is False and profile["severity"] == "low" and profile["cohort_size"] == 5
    assert profile["series"][8]["cohort_accuracy"] == 0.7
    assert "cohort-adjusted 0 pts" in profile["reasons"][0]
    # Below COHORT_ADJUST_MIN peers the raw drop is used.
    assert patterns.fatigue_profile(_desc([10] * 6 + [7] * 3), peers, 4)["flagged"] is True


def test_a_blank_rate_jump_of_a_quarter_is_flagged_medium():
    profile = patterns.fatigue_profile(_desc([8] * 8 + [10, 10, 10, None]), None, 1)
    assert profile["early_blank_rate"] == 0 and profile["late_blank_rate"] == 0.25
    assert profile["drop_pts"] == 5.0
    assert profile["flagged"] is True and profile["severity"] == "medium"
    assert "Blank rate rose from 0% to 25% in the final third" in profile["reasons"]


def test_fewer_than_six_questions_gives_no_fatigue_profile():
    assert patterns.fatigue_profile(_desc([4] * 5), None, 1) is None


# --------------------------------------------------------------------------- #
# FR-4.11 memorisation vs transfer
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("recall", "transfer", "expected"),
    [
        (39.9, 39.9, "foundational_gap"),
        (10, 39, "foundational_gap"),
        (40, 10, "developing"),
        (60, 35, "memorisation"),
        (85, 60, "memorisation"),        # first match wins over transferable
        (60, 35.1, "developing"),
        (59.9, 20, "developing"),
        (30, 55, "inconsistent"),
        (60, 60, "transferable"),
        (100, 90, "transferable"),
    ],
)
def test_transfer_classification_boundaries(recall, transfer, expected):
    assert patterns.classify_transfer(recall, transfer) == expected


def test_concept_group_prefers_concept_then_chapter_then_the_matrix_parent():
    assert patterns.concept_group({"topic": "x"}, {"concept": "Inheritance", "chapter": "Genetics"}) == "Inheritance"
    assert patterns.concept_group({"topic": "x"}, {"chapter": "Genetics"}) == "Genetics"
    assert patterns.concept_group({}, {"topic": "Mendelian Inheritance", "subject": "Biology"}) == "Genetics"
    assert patterns.concept_group({"topic": "Unmapped Topic"}, None) == "Unmapped Topic"


# --------------------------------------------------------------------------- #
# Genetics demo (pure read of the seeded rows) and the cohort
# --------------------------------------------------------------------------- #
def _ids_by_name(client) -> dict[str, int]:
    return {s["student_name"]: s["id"] for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED"}


def test_genetics_demo_patterns(client):
    assert client.post("/api/demo/seed").status_code == 200
    ids = _ids_by_name(client)
    for name, expected in (("Ananya Iyer", "transferable"), ("Priya Banerjee", "foundational_gap")):
        result = client.get(f"/api/results/{ids[name]}").json()
        check_interface(result, "Result")
        p = result["patterns"]
        assert p["negative_marking"] is None and p["fatigue"] is None
        assert "No negatively-marked MCQs in this test" in p["notes"]
        assert "Needs at least 6 questions (this test has 5)" in p["notes"]
        [concept] = p["transfer"]["concepts"]
        assert concept["concept"] == "Genetics"
        assert concept["recall_questions"] == [2, 3, 5] and concept["transfer_questions"] == [1, 4]
        assert concept["classification"] == expected
        assert [b["level"] for b in p["bloom_profile"]] == ["K1", "K2", "K3"]

    cohort = client.get("/api/cohort").json()
    check_interface(cohort, "Cohort")
    transfer = cohort["patterns"]["transfer"]
    assert [c["concept"] for c in transfer["concepts"]] == ["Genetics"]
    assert transfer["concepts"][0]["students"] == 12
    assert cohort["patterns"]["negative_marking"] is None and cohort["patterns"]["fatigue"] is None


def test_cohort_patterns_over_mixed_rubrics(client):
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27
    cohort = client.get("/api/cohort").json()
    check_interface(cohort, "Cohort")
    p = cohort["patterns"]
    assert cohort["mixed_rubrics"] is True
    # Mock 08 has 12 questions -> fatigue profiles; Genetics has 5 -> none (each on its own rubric).
    assert p["fatigue"]["students_profiled"] == 14
    assert p["transfer"]["students_profiled"] >= 12
    assert {b["level"] for b in p["bloom_profile"]} >= {"K1", "K2", "K3"}


def test_cohort_aggregates_negative_marking_per_topic():
    class Sub:
        def __init__(self, i: int):
            self.id, self.student_name, self.rubric_id = i, f"S{i}", 9

    class Res:
        def __init__(self, items):
            self.question_evaluations = items

    class Rub:
        content = _mcq_content(4)

    pairs = [(Sub(1), Res(_mcq_items(["c", "w", "w", "w"]))), (Sub(2), Res(_mcq_items(["c", "c", "c", "b"])))]
    cohort = patterns.cohort_extras(None, pairs=pairs, rubrics={9: Rub()})["patterns"]
    neg = cohort["negative_marking"]
    assert neg["students_profiled"] == 2 and neg["marks_lost_total"] == 3
    [topic] = neg["topics"]
    assert topic["students_over_attempting"] == 1 and topic["mean_accuracy"] == pytest.approx((0.25 + 1) / 2, abs=1e-3)
    assert [s["student_name"] for s in neg["students"]] == ["S1"] and neg["students"][0]["value"] == 3
    assert cohort["fatigue"] is None and patterns.THRESHOLD_NOTE in cohort["notes"]
