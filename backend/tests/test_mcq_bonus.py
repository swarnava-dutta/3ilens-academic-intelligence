"""MCQ keys that accept several options (accepted_options) or make a question a bonus (bonus):
rubric validation, deterministic scoring with the negative-marking rules, the result / report
fields, patterns, rubric versions and AI rubric drafting. Real case: the NEET 2016 key accepts
"2 or 3" on Q51, Q53, Q111, Q112 and makes Q71, Q98 bonus questions."""
from __future__ import annotations

import json

import pytest

from tests.test_contract import check_interface

OPTIONS = ["Nucleus", "Mitochondria", "Ribosome", "Golgi body"]
NEET = {"partial_credit": "steps", "mark_step": 0.5, "negative_marks": 1.0, "scheme_name": "NEET +4/-1 (sample)"}


def mcq(number: int, **key) -> dict:
    return {"question": number, "topic": "Cell Organelles", "subject": "Biology", "max_marks": 4, "effort_hours": 2,
            "question_type": "mcq", "options": list(OPTIONS), **key}


RUBRIC = {
    "name": "NEET MCQ keys (sample)",
    "subject": "Biology",
    "marking_policy": {"negative_marks": 1, "scheme_name": "NEET +4/-1 (sample)"},
    "questions": [
        mcq(1, correct_option="B"),
        mcq(2, accepted_options=["2", "c"]),           # "2 or 3" -> B or C
        mcq(3, accepted_options=["B", "C"], correct_option="B"),
        mcq(4, bonus=True),
        mcq(5, bonus=True, correct_option="A"),
        mcq(6, accepted_options=["A", "D"]),
    ],
}


def validated(rubric: dict | None = None) -> dict:
    from schemas import RubricContentIn

    return RubricContentIn.model_validate(rubric or RUBRIC).model_dump(exclude_none=True)


def by_number(content: dict) -> dict[int, dict]:
    return {q["question"]: q for q in content["questions"]}


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def test_valid_keys_are_normalised_with_default_answers_and_criteria():
    qs = by_number(validated())
    assert qs[1]["correct_option"] == "B" and "accepted_options" not in qs[1] and "bonus" not in qs[1]
    assert qs[2]["accepted_options"] == ["B", "C"] and "correct_option" not in qs[2]
    assert qs[2]["expected_answer"] == "Option B or C"
    assert qs[2]["grading_criteria"] == [
        "4 marks for option B or C; a wrong option follows the negative-marking rule; 0 if blank"
    ]
    assert qs[3]["correct_option"] == "B" and qs[3]["accepted_options"] == ["B", "C"]
    assert qs[4]["bonus"] is True and "correct_option" not in qs[4]
    assert qs[4]["expected_answer"] == "Bonus question"
    assert qs[4]["grading_criteria"] == ["4 marks to every student (bonus question)"]
    assert qs[5]["bonus"] is True and qs[5]["correct_option"] == "A" and qs[5]["expected_answer"] == "Bonus question"
    assert qs[6]["expected_answer"] == "Option A or D"


def test_unused_fields_keep_old_dumps_and_hashes():
    """bonus=false / accepted_options null or [] never reach the stored content, so every
    existing rubric keeps its hash."""
    import hashing

    plain = {**RUBRIC, "questions": [mcq(1, correct_option="B")]}
    noisy = {**RUBRIC, "questions": [mcq(1, correct_option="B", bonus=False, accepted_options=[])]}
    nulls = {**RUBRIC, "questions": [mcq(1, correct_option="B", bonus=None, accepted_options=None)]}
    assert validated(plain) == validated(noisy) == validated(nulls)
    assert hashing.rubric_hash(validated(plain)) == hashing.rubric_hash(validated(noisy))
    assert set(validated(plain)["questions"][0]) >= {"correct_option"}
    assert not {"bonus", "accepted_options"} & set(validated(plain)["questions"][0])


@pytest.mark.parametrize(
    ("question", "message"),
    [
        (mcq(1), "Q1 is an MCQ: correct_option is required"),
        (mcq(1, bonus=False, accepted_options=[]), "correct_option is required"),
        (mcq(1, accepted_options=["B"]), "accepted_options needs 2-6 option letters"),
        (mcq(1, accepted_options=["B", "b"]), "accepted_options must not repeat an option"),
        (mcq(1, accepted_options=["B", "E"]), "accepted_options must be option letters A-F within the options"),
        (mcq(1, accepted_options=["B", "mitochondria"]), "accepted_options must be option letters"),
        (mcq(1, accepted_options="B or C"), "accepted_options must be a list"),
        (mcq(1, accepted_options=["B", "C"], correct_option="A"), "correct_option A must be one of accepted_options (B or C)"),
        (mcq(1, bonus="maybe", correct_option="A"), "valid boolean"),
        ({**mcq(1, correct_option="B"), "question_type": "descriptive", "options": None, "correct_option": None,
          "expected_answer": "x", "grading_criteria": ["x"], "bonus": True}, "Q1 bonus is only allowed"),
        ({**mcq(1), "question_type": None, "options": None, "expected_answer": "x", "grading_criteria": ["x"],
          "accepted_options": ["A", "B"]}, "Q1 accepted_options is only allowed"),
    ],
)
def test_invalid_keys_are_rejected(question, message):
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as exc:
        validated({**RUBRIC, "questions": [question]})
    assert message in str(exc.value)


def test_upload_rejects_an_invalid_key_as_invalid_rubric(upload, forbid_ai):
    rubric = {**RUBRIC, "questions": [mcq(1, accepted_options=["B"])]}
    response = upload(rubric_json=json.dumps(rubric))
    assert response.status_code == 422 and response.json()["code"] == "invalid_rubric"
    assert "accepted_options needs 2-6 option letters" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("answer", "selected", "correct"),
    [("C", "C", "C"), ("(a)", "A", "A"), ("", None, None), ("B, C", "MULTI", None), ("mitochondria", "UNKNOWN", None)],
)
def test_bonus_scores_full_marks_whatever_was_marked(answer, selected, correct):
    import marking

    q = by_number(validated())[4]
    scored = marking.score_mcq(q, answer, NEET)
    assert (scored["marks"], scored["penalty"], scored["selected_option"]) == (4.0, 0.0, selected)
    assert scored["correct_option"] == correct
    assert scored["note"] == "Bonus question - full marks to everyone (+4)"
    # a bonus that also names an option still gives everyone full marks
    keyed = by_number(validated())[5]
    assert marking.score_mcq(keyed, answer, NEET)["marks"] == 4.0
    assert marking.score_mcq(keyed, "", NEET)["correct_option"] == "A"


def test_accepted_options_score_full_marks_and_follow_the_negative_rules():
    import marking

    q = by_number(validated())[2]  # B or C, no single correct_option
    for answer in ("B", "(c)", "3", "option 2"):
        scored = marking.score_mcq(q, answer, NEET)
        assert (scored["marks"], scored["penalty"]) == (4.0, 0.0), answer
        assert scored["note"] == "Accepted options B or C (+4)"
        assert scored["correct_option"] == scored["selected_option"]  # the UI / patterns see a correct attempt
    wrong = marking.score_mcq(q, "D", NEET)
    assert (wrong["marks"], wrong["penalty"], wrong["selected_option"], wrong["correct_option"]) == (-1.0, 1.0, "D", "B")
    assert wrong["note"] == "Marked D, accepted B or C (-1)"
    multi = marking.score_mcq(q, "B, C", NEET)  # marking both accepted options is still two marks
    assert (multi["marks"], multi["selected_option"]) == (-1.0, "MULTI")
    assert multi["note"] == "More than one option marked - scored as wrong (-1)"
    blank = marking.score_mcq(q, "", NEET)
    assert (blank["marks"], blank["penalty"], blank["note"]) == (0.0, 0.0, "Not attempted (0)")
    unknown = marking.score_mcq(q, "?? smudge", NEET)
    assert (unknown["marks"], unknown["penalty"], unknown["selected_option"]) == (0.0, 0.0, "UNKNOWN")
    # per-question negative marks and the default (no negative marking) policy still apply
    assert marking.score_mcq({**q, "negative_marks": 2}, "A", NEET)["marks"] == -2.0
    assert marking.score_mcq(q, "A", marking.DEFAULT_POLICY)["marks"] == 0.0
    # with a correct_option among the accepted ones, a wrong answer shows that option
    keyed = by_number(validated())[3]
    assert marking.score_mcq(keyed, "A", NEET)["correct_option"] == "B"
    assert marking.score_mcq(keyed, "C", NEET)["correct_option"] == "C"


def test_single_key_scoring_is_unchanged():
    import marking

    q = by_number(validated())[1]
    assert marking.score_mcq(q, "B", NEET)["note"] == "Correct option B (+4)"
    assert marking.score_mcq(q, "c", NEET)["note"] == "Marked C, correct B (-1)"
    assert marking.score_mcq({**q, "accepted_options": None, "bonus": False}, "c", NEET)["marks"] == -1.0


def test_option_letters_and_answer_key_entries():
    import marking

    assert marking.option_letters("2 or 3", 4) == ["B", "C"]
    assert marking.option_letters("(1), (4)") == ["A", "D"]
    assert marking.option_letters("C/B") == ["B", "C"]
    assert marking.option_letters("b") == ["B"]
    assert marking.option_letters("2 or 5", 4) == [] and marking.option_letters("mitochondria") == []
    assert marking.option_letters("") == []
    assert marking.parse_answer_key("2", 4) == {"correct_option": "B"}
    assert marking.parse_answer_key("2 or 3", 4) == {"accepted_options": ["B", "C"]}
    for bonus in ("Bonus", "BONUS", "*", "Dropped", "all options", "(Bonus)"):
        assert marking.parse_answer_key(bonus, 4) == {"bonus": True}, bonus
    assert marking.parse_answer_key("mitochondria", 4) is None and marking.parse_answer_key("", 4) is None


def test_rule_texts_name_the_special_keys():
    import marking

    content = {**validated(), "marking_policy": NEET}
    qs = by_number(content)
    assert marking.rule_for_question(qs[1], NEET) == "+4 correct / -1 wrong / 0 blank"
    assert marking.rule_for_question(qs[2], NEET) == "+4 for B or C / -1 wrong / 0 blank"
    assert marking.rule_for_question(qs[4], NEET) == "Bonus question: +4 to everyone"
    assert marking.marking_rule_text(content) == (
        "NEET +4/-1 (sample): MCQs +4 correct, -1 wrong, 0 blank; Q2-Q3, Q6 accept more than one option; "
        "bonus Q4-Q5: full marks to everyone; totals summed server-side"
    )
    plain = {**content, "questions": [qs[1]]}
    assert marking.marking_rule_text(plain) == "NEET +4/-1 (sample): MCQs +4 correct, -1 wrong, 0 blank; totals summed server-side"


def test_annotate_fills_the_shown_option_on_legacy_rows():
    import marking

    content = validated()
    rows = [{"question": 2, "student_answer": "(c)"}, {"question": 2, "student_answer": "A"},
            {"question": 4, "student_answer": "D"}, {"question": 1, "student_answer": "C"}]
    out = marking.annotate_questions(rows, content)
    assert [(q["selected_option"], q["correct_option"]) for q in out] == [("C", "C"), ("A", "B"), ("D", "D"), ("C", "B")]


# --------------------------------------------------------------------------- #
# Report, patterns, versions
# --------------------------------------------------------------------------- #
def report_for(answers: dict[int, str]) -> dict:
    import insights
    from ai_schemas import EvaluationOutput, OcrAnswer

    content = validated()
    ocr = [OcrAnswer(question=n, answer=a, confidence=0.95) for n, a in answers.items()]
    return insights.build_evaluation_report(content, ocr, EvaluationOutput(evaluations=[], overall_strengths=[],
                                                                            overall_gaps=[]))


def test_report_scores_bonus_and_accepted_questions():
    report = report_for({1: "B", 2: "C", 3: "D", 5: "B, C", 6: "A"})  # Q4 left blank
    qs = {q["question"]: q for q in report["question_evaluations"]}
    assert [qs[n]["estimated_marks"] for n in range(1, 7)] == [4.0, 4.0, -1.0, 4.0, 4.0, 4.0]
    assert report["total_score"] == 19.0 and report["total_marks"] == 24.0
    assert qs[2]["evidence"] == "Auto-scored MCQ: Accepted options B or C (+4)"
    assert qs[2]["strengths"] == ["Correct option C"] and qs[2]["gaps"] == []
    assert qs[2]["marking_note"] == "Accepted options B or C (+4)" and qs[2]["outcome"] == "FULL"
    assert qs[3]["gaps"] == ["Chose D; correct B or C (-1)"] and qs[3]["penalty"] == 1.0
    assert qs[3]["correct_option"] == "B"
    assert qs[4]["evidence"] == "Auto-scored MCQ: Bonus question - full marks to everyone (+4)"
    assert qs[4]["selected_option"] is None and qs[4]["strengths"] == [] and qs[4]["gaps"] == []
    assert qs[4]["outcome"] == "FULL"  # nothing marked, but a bonus is full credit
    assert qs[5]["selected_option"] == "MULTI" and qs[5]["penalty"] == 0.0 and qs[5]["gaps"] == []


def test_negative_marking_profile_skips_bonus_and_counts_accepted_options_as_correct():
    import patterns

    report = report_for({1: "B", 2: "C", 3: "D", 4: "A", 5: "B, C", 6: "D"})
    content = {**validated(), "marking_policy": NEET}
    profile = patterns.negative_marking_profile(report["question_evaluations"], content)
    topic = profile["topics"][0]
    # Q4 / Q5 (bonus) are left out; Q1, Q2, Q6 correct, Q3 wrong
    assert (topic["attempted"], topic["correct"], topic["wrong"], topic["blank"]) == (4, 3, 1, 0)
    assert topic["marks_lost"] == 1.0


def test_changing_a_key_marks_the_question_changed():
    import rubric_store

    old = validated()
    new = json.loads(json.dumps(old))
    by_number(new)[1]["bonus"] = True
    by_number(new)[6]["accepted_options"] = ["A", "C"]
    assert rubric_store.compatibility(old, new) == {"reusable": True, "added": [], "removed": [], "changed": [1, 6]}
    assert rubric_store.compatibility(old, old)["changed"] == []


def test_upload_and_regrade_with_bonus_and_accepted_keys_end_to_end(upload, fake_ai, client, monkeypatch, ai_ready):
    import ai
    from ai_schemas import OcrAnswer, OcrResult

    letters = {1: "c", 2: "3", 3: "c", 5: "d", 6: "a"}  # Q4 blank

    def letters_ocr(pages, rubric_content, **kwargs):
        fake_ai.calls["ocr"] += 1
        answers = [OcrAnswer(question=n, answer=f"({a})", confidence=0.95) for n, a in letters.items()]
        return OcrResult(answers=answers, overall_confidence=0.95, provider="anthropic", model="fake-vision-model")

    monkeypatch.setattr(ai, "run_ocr", letters_ocr)
    queued = upload(student_name="Bonus Student", rubric_json=json.dumps(RUBRIC))
    assert queued.status_code == 202, queued.text
    result = client.get(f"/api/results/{queued.json()['id']}").json()
    check_interface(result, "Result")
    qs = {q["question"]: q for q in result["question_evaluations"]}
    assert [qs[n]["estimated_marks"] for n in range(1, 7)] == [-1, 4, 4, 4, 4, 4]
    assert result["total_score"] == 19 and result["total_marks"] == 24
    assert result["scoring_controls"]["parity"] is True
    # The blank bonus Q4 is neither mapped nor blank: named so 5 mapped + 0 blank + 1 adds up to 6.
    assert result["executive_summary"][0].startswith("5 of 6 rubric questions transcribed and mapped; ")
    assert "0 blank, plus 1 bonus question left blank but scored full (Q4) (" in result["executive_summary"][0]
    import reports
    from schemas import ResultOut

    assert "unattempted Q4 (bonus, full marks)" in repr(reports._section_coverage(ResultOut.model_validate(result)))
    rule = result["scoring_controls"]["marking_rule"]
    assert "Q2-Q3, Q6 accept more than one option" in rule and "bonus Q4-Q5: full marks to everyone" in rule
    stored = by_number(next(r for r in client.get("/api/rubrics").json() if r["id"] == result["rubric"]["id"])["content"])
    assert stored[2]["accepted_options"] == ["B", "C"] and stored[4]["bonus"] is True

    # Faculty make Q1 a bonus too: the new version re-scores it without new OCR.
    content = json.loads(json.dumps(RUBRIC))
    content["questions"][0]["bonus"] = True
    version = client.post(f"/api/rubrics/{result['rubric']['id']}/versions",
                          json={"content": content, "change_note": "Q1 bonus", "reprocess": False})
    assert version.status_code == 201, version.text
    assert version.json()["compatibility"]["changed"] == [1]
    response = client.post(f"/api/submissions/{queued.json()['id']}/reevaluate",
                           json={"rubric_id": version.json()["rubric"]["id"]})
    assert response.status_code == 202, response.text
    regraded = client.get(f"/api/results/{queued.json()['id']}").json()
    assert regraded["total_score"] == 24 and fake_ai.calls["ocr"] == 1
    q1 = regraded["question_evaluations"][0]
    assert q1["marking_note"] == "Bonus question - full marks to everyone (+4)" and q1["penalty"] == 0


# --------------------------------------------------------------------------- #
# AI rubric drafting
# --------------------------------------------------------------------------- #
def raw_mcq(number: int, **key) -> dict:
    return {"question": number, "topic": "Cell Organelles", "subject": "Biology", "max_marks": 4, "effort_hours": 2,
            "prompt": f"Q{number}. Which organelle ...?", "expected_answer": "", "grading_criteria": [],
            "question_type": "mcq", "options": list(OPTIONS), "correct_option": None, "accepted_options": [],
            "bonus": False, "ai_drafted_answer": False, **key}


def test_finalise_draft_keeps_accepted_options_and_bonus():
    import ai

    raw = {"name": "NEET 2016", "subject": "Biology", "questions": [
        raw_mcq(1, correct_option="2"),
        raw_mcq(51, accepted_options=["2", "3"]),
        raw_mcq(53, correct_option="2 or 3"),          # the key written into correct_option
        raw_mcq(54, accepted_options=["C"]),           # one letter is the correct option
        raw_mcq(55, accepted_options=["B", "C"], correct_option="A"),  # the accepted list wins
        raw_mcq(71, bonus=True),
        raw_mcq(98, bonus="true", correct_option="1"),
        raw_mcq(99),
    ]}
    result = ai.finalise_rubric_draft(raw)
    draft = by_number(result["draft"])  # not validated yet (Q99 has no key)
    assert result["warnings"][0].startswith("Fix before saving")
    assert draft[1]["correct_option"] == "B"
    assert draft[51]["accepted_options"] == ["B", "C"] and "correct_option" not in draft[51]
    assert draft[53]["accepted_options"] == ["B", "C"]
    assert draft[54]["correct_option"] == "C" and "accepted_options" not in draft[54]
    assert draft[55]["accepted_options"] == ["B", "C"] and "correct_option" not in draft[55]
    assert draft[71]["bonus"] is True and "correct_option" not in draft[71]
    assert draft[98]["bonus"] is True and draft[98]["correct_option"] == "A"
    warnings = result["warnings"]
    assert "Q99 is an MCQ without an answer key - set correct_option." in warnings
    assert not any(w.startswith(("Q51 is", "Q53 is", "Q71 is", "Q98 is")) for w in warnings)
    assert ("More than one accepted option for Q51 (B or C), Q53 (B or C), Q55 (B or C) - any of them scores full "
            "marks; check before approving.") in warnings
    assert "Bonus (full marks to everyone): Q71, Q98 - check before approving." in warnings
    # without Q99 (no key) the draft validates and saves as is
    keyed = ai.finalise_rubric_draft({**raw, "questions": raw["questions"][:-1]})
    assert not any(w.startswith("Fix before saving") for w in keyed["warnings"])
    content = validated(keyed["draft"])
    assert by_number(content)[71]["expected_answer"] == "Bonus question"
    assert by_number(content)[51]["expected_answer"] == "Option B or C"


def test_paged_merge_reads_two_option_and_bonus_answer_key_entries():
    import ai

    def part(questions, key):
        return ai._RubricPagesParse.model_validate({"name": "", "subject": "Biology", "paper_code": "",
                                                     "questions": questions, "answer_key": key})

    parts = [
        part([raw_mcq(n) for n in (51, 52, 53)], []),
        part([raw_mcq(71), raw_mcq(72, correct_option="B")],
             [{"question": 51, "option": "2 or 3"}, {"question": 52, "option": "4"},
              {"question": 53, "option": "(1), (3)"}, {"question": 71, "option": "Bonus"},
              {"question": 72, "option": "2 or 3"}]),
    ]
    merged, notes = ai._merge_rubric_parts(parts)
    qs = by_number(merged)
    assert qs[51]["accepted_options"] == ["B", "C"] and qs[51]["expected_answer"] == "Option B or C"
    assert qs[52]["correct_option"] == "D" and qs[52]["expected_answer"] == "Option D"
    assert qs[53]["accepted_options"] == ["A", "C"]
    assert qs[71]["bonus"] is True and qs[71]["expected_answer"] == "Bonus question"
    assert qs[71]["grading_criteria"] == ["4 marks to every student (bonus question)"]
    assert qs[51]["grading_criteria"] == [
        "4 marks for option B or C; a wrong option follows the negative-marking rule; 0 if blank"
    ]
    assert "Answer key for Q51-Q53, Q71 taken from the answer-key table." in notes
    assert any("Q72 (table B/C, under the question B)" in n for n in notes)
    draft = ai.finalise_rubric_draft(merged)["draft"]
    content = by_number(validated(draft))
    assert content[51]["accepted_options"] == ["B", "C"] and content[71]["bonus"] is True


def test_merged_readings_keep_the_accepted_options_and_bonus():
    import ai

    head = raw_mcq(51, options=OPTIONS[:2], prompt="Q51. A long stem that runs onto the next page and more")
    tail = raw_mcq(51, options=OPTIONS, prompt="Q51.", accepted_options=["B", "C"], expected_answer="Option B or C")
    merged = ai._merge_entries(head, tail, {})
    assert merged["accepted_options"] == ["B", "C"] and merged["expected_answer"] == "Option B or C"
    clashes: dict = {}
    ai._merge_entries(raw_mcq(71, bonus=True), raw_mcq(71, correct_option="A"), clashes)
    assert clashes == {71: ("bonus", "A")}


def test_rubric_prompts_ask_for_accepted_options_and_bonus():
    import ai

    system = ai._rubric_parse_system_prompt()
    assert "- accepted_options: for an MCQ whose answer key accepts more than one option" in system
    assert "- bonus: true when the answer key makes an MCQ a bonus" in system
    assert "return their letters in accepted_options" in ai.RUBRIC_PAGES_ADDENDUM
    assert "return bonus true and correct_option null" in ai.RUBRIC_PAGES_ADDENDUM
    wire = ai.RubricPagesWire.model_json_schema()["$defs"]["_RubricQuestionWire"]
    assert {"accepted_options", "bonus"} <= set(wire["required"])


# --------------------------------------------------------------------------- #
# Option tokens back to back, bonus words, bonus outcome (review fixes)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("raw", "letters"),
    [
        ("(2)(3)", ["B", "C"]),
        ("(B)(C)", ["B", "C"]),
        ("b)c)", ["B", "C"]),
        ("[a][d]", ["A", "D"]),
        ("(1)(3)(4)", ["A", "C", "D"]),
        ("Ans: (2)(3)", ["B", "C"]),
        ("(2) (3)", ["B", "C"]),
    ],
)
def test_adjacent_option_tokens_are_several_options(raw, letters):
    """'(2)(3)' with no separator used to read as option 2 followed by text: as a key it silently
    became one correct option, and students who marked the other option lost 5 marks."""
    import marking

    assert marking.normalise_option(raw, 4) == marking.MULTI
    assert marking.option_letters(raw, 4) == letters
    assert marking.parse_answer_key(raw, 4) == {"accepted_options": letters}


def test_an_option_and_its_text_stay_one_option():
    import marking

    for raw in ("(b) mitochondria", "(b)mitochondria", "b) mitochondria", "(2)", "b)", "(2)(2)"):
        assert marking.normalise_option(raw, 4) == "B", raw
        assert marking.parse_answer_key(raw, 4) == {"correct_option": "B"}, raw
    assert marking.parse_answer_key("(4) All of the above", 4) == {"correct_option": "D"}
    assert marking.option_letters("(2)(5)", 4) == []  # an option beyond the paper's four voids the key


def test_adjacent_tokens_score_as_a_multi_mark_or_an_accepted_key():
    import marking

    student = marking.score_mcq(mcq(1, correct_option="B"), "(2)(3)", NEET)
    assert student["selected_option"] == marking.MULTI and student["marks"] == -1.0
    key = mcq(2, **marking.parse_answer_key("(2)(3)", 4))
    assert marking.score_mcq(key, "C", NEET)["marks"] == 4.0  # the other accepted option scores too
    assert marking.score_mcq(key, "B", NEET)["marks"] == 4.0


def test_ai_draft_reads_adjacent_tokens_in_correct_option():
    import ai

    assert ai._draft_key(raw_mcq(51, correct_option="(2)(3)"), 4) == {"accepted_options": ["B", "C"]}
    draft = by_number(ai.finalise_rubric_draft({"name": "NEET", "subject": "Biology",
                                                "questions": [raw_mcq(51, correct_option="(B)(C)")]})["draft"])
    assert draft[51]["accepted_options"] == ["B", "C"]


BONUS_WORDS = ("Bonus", "*", "Dropped", "Deleted", "All options correct", "All are correct", "all options are correct",
               "Any option", "Grace", "Cancelled")


@pytest.mark.parametrize("word", BONUS_WORDS)
def test_bonus_words_make_a_bonus_key(word):
    import marking

    assert marking.is_bonus_key(word)
    assert marking.parse_answer_key(word, 4) == {"bonus": True}


@pytest.mark.parametrize("raw", ["all of the above", "None of these", "B", "(2) or (3)", "", None])
def test_other_entries_are_not_bonus_words(raw):
    import marking

    assert not marking.is_bonus_key(raw)


@pytest.mark.parametrize("word", BONUS_WORDS)
def test_ai_draft_treats_a_bonus_word_in_correct_option_as_bonus(word):
    """The model sometimes writes "Bonus" / "*" / "All options correct" into correct_option with
    bonus false; that question used to end up with no key at all."""
    import ai

    assert ai._draft_key(raw_mcq(71, correct_option=word, bonus=False), 4) == {"bonus": True}
    assert ai._draft_key(raw_mcq(71, accepted_options=[word], bonus=False), 4) == {"bonus": True}
    result = ai.finalise_rubric_draft({"name": "NEET", "subject": "Biology",
                                       "questions": [raw_mcq(71, correct_option=word, bonus=False)]})
    question = by_number(result["draft"])[71]
    assert question["bonus"] is True and "correct_option" not in question
    assert not any("without an answer key" in w for w in result["warnings"])
    assert by_number(validated(result["draft"]))[71]["bonus"] is True


def stored_row(**over) -> dict:
    """A question evaluation as stored before bonus questions counted as full credit."""
    row = {"question": 4, "topic": "Cell Organelles", "estimated_marks": 4.0, "max_marks": 4.0,
           "evidence": "Auto-scored MCQ: Bonus question - full marks to everyone (+4)", "strengths": [], "gaps": [],
           "student_answer": "", "confidence": 0.0, "outcome": "BLANK", "question_type": "mcq",
           "marking_note": "Bonus question - full marks to everyone (+4)"}
    return {**row, **over}


def test_a_blank_bonus_question_counts_as_full_credit_on_stored_rows():
    import analytics
    import insights
    from schemas import QuestionEvaluationOut

    bonus, blank = stored_row(), stored_row(question=5, marking_note="Not attempted (0)", estimated_marks=0.0)
    assert insights.outcome_of(bonus) == "FULL" and insights.outcome_of(blank) == "BLANK"
    assert QuestionEvaluationOut.model_validate(bonus).outcome == "FULL"
    assert QuestionEvaluationOut.model_validate(blank).outcome == "BLANK"
    assert QuestionEvaluationOut.model_validate(bonus).bonus is True  # read from the marking note
    assert QuestionEvaluationOut.model_validate(blank).bonus is False
    assert QuestionEvaluationOut.model_validate({**bonus, "question_type": "descriptive"}).bonus is False
    assert QuestionEvaluationOut.model_validate({**bonus, "outcome": None}).outcome == "FULL"
    counts = analytics.outcome_counts([bonus, blank])
    assert (counts["full"], counts["blank"]) == (1, 1)
    # a faculty override below full marks is no longer full credit
    assert insights.outcome_of(stored_row(estimated_marks=2.0)) == "BLANK"


def test_the_pdf_appendix_leaves_out_a_blank_bonus_question():
    from types import SimpleNamespace

    import reports
    from schemas import QuestionEvaluationOut

    rows = [QuestionEvaluationOut.model_validate(stored_row()),
            QuestionEvaluationOut.model_validate(stored_row(question=5, marking_note="Not attempted (0)",
                                                            estimated_marks=0.0))]
    blocks = reports._section_appendix(SimpleNamespace(question_evaluations=rows))
    table = next(b for b in blocks if isinstance(b, reports.Table))
    assert [row[0] for row in table.rows] == ["Q5"]


# --------------------------------------------------------------------------- #
# POST /api/rubrics/answer-key entries: one option, several accepted options or a bonus
# --------------------------------------------------------------------------- #
def test_answer_key_entry_single_letter_json_is_unchanged():
    from schemas import AnswerKeyEntry, AnswerKeyExtraction

    entry = AnswerKeyEntry(question=1, option="b")
    assert entry.model_dump(mode="json") == {"question": 1, "option": "B"}
    assert AnswerKeyEntry(question=2, option="(3)").option == "C"
    extraction = AnswerKeyExtraction(entries=[entry]).model_dump(mode="json")
    check_interface(extraction, "AnswerKeyExtraction")


def test_answer_key_entry_carries_accepted_options_and_bonus():
    from schemas import AnswerKeyEntry, AnswerKeyExtraction

    several = AnswerKeyEntry(question=51, accepted_options=["3", "b"])
    assert several.model_dump(mode="json") == {"question": 51, "option": None, "accepted_options": ["B", "C"]}
    bonus = AnswerKeyEntry.model_validate({"question": 71, "option": None, "bonus": True})
    assert bonus.model_dump(mode="json") == {"question": 71, "option": None, "bonus": True}
    extraction = AnswerKeyExtraction(entries=[several, bonus]).model_dump(mode="json")
    check_interface(extraction, "AnswerKeyExtraction")


@pytest.mark.parametrize("data", [
    {"question": 1},                                             # no key
    {"question": 1, "option": ""},                               # blank option, nothing else
    {"question": 1, "option": "B", "bonus": True},               # two keys
    {"question": 1, "option": "B", "accepted_options": ["B", "C"]},
    {"question": 1, "accepted_options": ["B", "C"], "bonus": True},
    {"question": 1, "option": "B or C"},                         # several letters belong in accepted_options
    {"question": 1, "option": "G"},
    {"question": 1, "accepted_options": ["B"]},                  # one letter is option
    {"question": 1, "accepted_options": ["B", "B"]},
    {"question": 1, "bonus": False},
])
def test_answer_key_entry_needs_exactly_one_key(data):
    from pydantic import ValidationError

    from schemas import AnswerKeyEntry

    with pytest.raises(ValidationError):
        AnswerKeyEntry.model_validate(data)
