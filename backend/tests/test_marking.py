"""marking.py: MCQ option parsing and +4/-1 scoring, marking-scheme rules, rule text (FR-3.8, FR-4.8)."""
from __future__ import annotations

import pytest

import analytics
import insights
import marking
import seed

NEET = {"partial_credit": "steps", "mark_step": 0.5, "negative_marks": 1.0, "scheme_name": "NEET +4/-1 (sample)"}
MCQ = {"question": 1, "topic": "Cell", "max_marks": 4, "question_type": "mcq", "options": ["a", "b", "c", "d"],
       "correct_option": "B"}


@pytest.mark.parametrize(
    ("raw", "n_options", "expected"),
    [
        ("b", None, "B"), ("(B)", None, "B"), ("b)", None, "B"), ("b.", None, "B"), ("[b]", None, "B"),
        ("Option c", None, "C"), ("opt b", None, "B"), ("ans b", None, "B"), ("ans: d", None, "D"),
        ("answer: b", None, "B"), ("b - mitochondria", None, "B"), ("(b) mitochondria", None, "B"),
        ("2", 4, "B"), ("2", None, "B"), ("6", 4, "UNKNOWN"),
        ("B, C", None, "MULTI"), ("b and c", None, "MULTI"), ("BC", None, "MULTI"), ("B, B", None, "B"),
        ("mitochondria", None, "UNKNOWN"), ("a cell wall", None, "UNKNOWN"), ("E", 4, "UNKNOWN"),
        ("-", None, None), ("", None, None), (None, None, None), ("?", None, None), ("[illegible]", None, None),
        ("Not attempted", None, None), ("skip", None, None),
    ],
)
def test_normalise_option(raw, n_options, expected):
    assert marking.normalise_option(raw, n_options) == expected


def test_score_mcq_plus_four_minus_one():
    correct = marking.score_mcq(MCQ, "B", NEET)
    assert (correct["marks"], correct["penalty"], correct["note"]) == (4.0, 0.0, "Correct option B (+4)")
    wrong = marking.score_mcq(MCQ, "c", NEET)
    assert (wrong["marks"], wrong["penalty"], wrong["selected_option"]) == (-1.0, 1.0, "C")
    assert wrong["note"] == "Marked C, correct B (-1)"
    blank = marking.score_mcq(MCQ, "", NEET)
    assert (blank["marks"], blank["penalty"], blank["note"]) == (0.0, 0.0, "Not attempted (0)")
    multi = marking.score_mcq(MCQ, "B, C", NEET)
    assert (multi["marks"], multi["selected_option"]) == (-1.0, "MULTI")
    assert multi["note"] == "More than one option marked - scored as wrong (-1)"
    unknown = marking.score_mcq(MCQ, "mitochondria", NEET)
    assert (unknown["marks"], unknown["penalty"], unknown["selected_option"]) == (0.0, 0.0, "UNKNOWN")
    # per-question negative marks override the policy and are clamped to max_marks
    assert marking.score_mcq({**MCQ, "negative_marks": 2}, "A", NEET)["marks"] == -2.0
    assert marking.score_mcq({**MCQ, "negative_marks": 9}, "A", NEET)["marks"] == -4.0
    # no negative marking by default
    assert marking.score_mcq(MCQ, "A", marking.DEFAULT_POLICY)["marks"] == 0.0


def test_default_policy_matches_the_original_bounded_marks():
    for eighths in range(-4, 40):
        value = eighths / 8
        got = marking.score_descriptive({"max_marks": 4}, estimated_marks=value, criteria_awards=[],
                                        policy=marking.DEFAULT_POLICY)
        assert got["marks"] == insights._bounded_marks(value, 4), value
        assert got["note"] is None and got["breakdown"] == []
    assert marking.round_to_step(1.25, 0.5) == 1.5 and marking.round_to_step(1.24, 0.5) == 1.0
    assert marking.score_descriptive({"max_marks": 4}, estimated_marks=None, criteria_awards=None,
                                     policy=marking.DEFAULT_POLICY)["marks"] == 0.0


SCHEME_Q = {"question": 3, "max_marks": 4, "marking_scheme": [
    {"criterion": "Correct cross", "marks": 1, "required": True},
    {"criterion": "Ratio", "marks": 1},
    {"criterion": "F2 phenotypes", "marks": 2},
]}


def test_scheme_awards_are_summed_and_clamped():
    out = marking.score_descriptive(
        SCHEME_Q, estimated_marks=1,
        criteria_awards=[{"index": 0, "awarded": 1}, {"index": 1, "awarded": 0.7}, {"index": 2, "awarded": 5}],
        policy=marking.DEFAULT_POLICY,
    )
    assert out["marks"] == 3.5  # 1 + 0.5 (0.7 rounded to the step) + 2 (clamped from 5)
    assert [b["awarded"] for b in out["breakdown"]] == [1.0, 0.5, 2.0]
    assert out["breakdown"][0] == {"criterion": "Correct cross", "marks": 1.0, "awarded": 1.0, "required": True}


def test_unmet_required_step_scores_zero():
    out = marking.score_descriptive(
        SCHEME_Q, estimated_marks=3, criteria_awards=[{"index": 0, "awarded": 0.2}, {"index": 2, "awarded": 2}],
        policy=marking.DEFAULT_POLICY,
    )
    assert out["marks"] == 0.0 and out["note"] == "Required step 'Correct cross' not met -> 0"


def test_all_or_nothing_proportional_and_scheme_without_awards():
    aon = marking.score_descriptive({"max_marks": 4, "partial_credit": "all_or_nothing"}, estimated_marks=3,
                                    criteria_awards=[], policy=marking.DEFAULT_POLICY)
    assert aon == {"marks": 0.0, "breakdown": [], "note": "All-or-nothing: 3/4 -> 0"}
    full = marking.score_descriptive({"max_marks": 4, "partial_credit": "all_or_nothing"}, estimated_marks=4,
                                     criteria_awards=[], policy=marking.DEFAULT_POLICY)
    assert full["marks"] == 4.0 and full["note"] is None
    prop = marking.score_descriptive({"max_marks": 4}, estimated_marks=2.333, criteria_awards=[],
                                     policy={**marking.DEFAULT_POLICY, "partial_credit": "proportional"})
    assert prop["marks"] == 2.33
    no_awards = marking.score_descriptive(SCHEME_Q, estimated_marks=2.6, criteria_awards=[],
                                          policy=marking.DEFAULT_POLICY)
    assert no_awards["marks"] == 2.5 and no_awards["breakdown"] == []
    assert no_awards["note"] == "Marking scheme present but no per-step awards were returned - overall marks used"


def test_score_question_dispatches():
    mcq = marking.score_question(MCQ, answer_text="C", estimated_marks=4, criteria_awards=[], policy=NEET)
    assert mcq["question_type"] == "mcq" and mcq["marks"] == -1.0 and mcq["penalty"] == 1.0
    desc = marking.score_question({"max_marks": 4}, answer_text="x", estimated_marks=3.2, criteria_awards=[],
                                  policy=NEET)
    assert desc["question_type"] == "descriptive" and desc["marks"] == 3.0 and desc["penalty"] == 0.0
    assert desc["selected_option"] is None and desc["correct_option"] is None


def test_policy_for_and_question_policy():
    assert marking.policy_for({}) == marking.DEFAULT_POLICY
    policy = marking.policy_for({"marking_policy": {"partial_credit": "bogus", "mark_step": 0.3, "negative_marks": 1}})
    assert policy == {**marking.DEFAULT_POLICY, "negative_marks": 1.0}
    q = marking.question_policy({"max_marks": 4, "partial_credit": "proportional", "mark_step": 1}, policy)
    assert (q["partial_credit"], q["mark_step"], q["negative_marks"]) == ("proportional", 1.0, 1.0)


def test_marking_rule_text():
    genetics = seed.load_genetics_rubric()
    assert marking.marking_rule_text(genetics) == marking.DEFAULT_MARKING_RULE == analytics.MARKING_RULE
    mixed = seed.load_mixed_rubric()
    assert marking.marking_rule_text(mixed) == marking.DEFAULT_MARKING_RULE
    content = {"marking_policy": NEET, "questions": [
        MCQ,
        {"question": 25, "max_marks": 4, "marking_scheme": [{"criterion": "a", "marks": 2}, {"criterion": "b", "marks": 2}]},
        {"question": 26, "max_marks": 4, "partial_credit": "all_or_nothing", "marking_scheme": [{"criterion": "a", "marks": 4}]},
    ]}
    assert marking.marking_rule_text(content) == (
        "NEET +4/-1 (sample): MCQs +4 correct, -1 wrong, 0 blank; descriptive partial credit in 0.5-mark steps; "
        "marking schemes on Q25-Q26 (Q26 all-or-nothing); totals summed server-side"
    )
    assert marking.rule_for_question(MCQ, NEET) == "+4 correct / -1 wrong / 0 blank"
    assert marking.rule_for_question(SCHEME_Q, NEET) == "Steps 1+1+2 (step 1 required)"
    assert marking.rule_for_question({"max_marks": 4, "partial_credit": "all_or_nothing"}, NEET) == "All-or-nothing"
    assert marking.rule_for_question({"max_marks": 4}, NEET) == "Partial credit in 0.5-mark steps"


def test_annotate_questions_fills_only_missing_keys():
    genetics = seed.load_genetics_rubric()
    stored = [{"question": 1, "topic": "Monohybrid Cross", "estimated_marks": 3.0, "max_marks": 4.0},
              {"question": 5, "topic": "x", "estimated_marks": 1.0, "max_marks": 4.0, "penalty": 0.5,
               "bloom_level": "K4", "bloom_source": "ai"}]
    out = marking.annotate_questions(stored, genetics)
    assert stored[0].keys() == {"question", "topic", "estimated_marks", "max_marks"}  # inputs untouched
    assert out[0]["question_type"] == "descriptive" and out[0]["bloom_level"] == "K3"
    assert out[0]["bloom_source"] == "heuristic" and out[0]["penalty"] == 0.0
    assert out[0]["selected_option"] is None and out[0]["marking_breakdown"] == []
    assert out[1]["bloom_level"] == "K4" and out[1]["bloom_source"] == "ai" and out[1]["penalty"] == 0.5
    mcq = marking.annotate_questions([{"question": 1, "student_answer": "(c)"}], {"questions": [MCQ]})[0]
    assert (mcq["question_type"], mcq["selected_option"], mcq["correct_option"]) == ("mcq", "C", "B")


def test_plural_mcq_heavy_and_option_counts():
    assert [marking.plural(n, "question") for n in (0, 1, 2)] == ["0 questions", "1 question", "2 questions"]
    assert marking.plural(2, "copy", "copies") == "2 copies"
    mcqs = [{**MCQ, "question": n} for n in range(1, 9)]
    written = [{"question": n, "max_marks": 4} for n in (9, 10)]
    assert marking.mcq_heavy({"questions": mcqs + written})  # 8 of 10
    assert not marking.mcq_heavy({"questions": mcqs[:7] + written})  # 7 of 9: too few questions
    assert not marking.mcq_heavy({"questions": mcqs[:7] + written + [{"question": 11}]})  # 7 of 10
    assert marking.mcq_option_counts({"questions": mcqs[:2] + [{**MCQ, "question": 3, "options": None}] + written}) == {
        1: 4, 2: 4, 3: None}
