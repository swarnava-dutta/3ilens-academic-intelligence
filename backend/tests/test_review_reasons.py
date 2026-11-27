"""Why a sheet is held for faculty review (review_reason) and what the gate says about it.

- review_decision(): the pure gate - the page legibility as the sheet confidence when nothing was
  mapped, and every hold reason in its order;
- paper_match.shape_check(): a long printed paper against a small non-MCQ rubric;
- the handwriting reader's text-layer paper check (a printed MCQ PDF uploaded with a descriptive rubric),
  and what it must leave alone: a typed answer sheet for the right rubric (its text is the student's
  answers), and a rubric for one section of a longer printed paper;
- recheck_held_sheets(): the start-up backfill of sheets held by an older build (no AI call).
AI and pre-processing are always faked - no network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import seed
from ai_schemas import OcrAnswer, OcrResult, PageAssessment
from schemas import RubricMatch

THRESHOLD = 0.80
LABEL = "'Biology - Genetics' (v1)"


def rubric(n: int = 5, *, mcqs: int = 0) -> dict:
    return {
        "name": "Rubric", "subject": "Biology",
        "questions": [
            {"question": q, "topic": f"Topic {q}", "max_marks": 4, "effort_hours": 1,
             **({"question_type": "mcq", "options": ["a", "b", "c", "d"], "correct_option": "A"} if q <= mcqs else {})}
            for q in range(1, n + 1)
        ],
    }


def ocr(answers: dict[int, float] | None = None, pages: list[float] | None = None, *, text: str = "An answer.") -> OcrResult:
    answers = answers or {}
    items = [OcrAnswer(question=q, answer=text, confidence=c) for q, c in answers.items()]
    overall = sum(answers.values()) / len(answers) if answers else 0.0
    return OcrResult(
        answers=items, overall_confidence=overall, provider="anthropic", model="fake",
        page_assessments=[PageAssessment(page=i, legibility_confidence=c) for i, c in enumerate(pages or [], start=1)],
    )


def decide(result: OcrResult, page_total: int, content: dict | None = None, **kwargs):
    import pipeline

    return pipeline.review_decision(result, page_total, content or rubric(), THRESHOLD, rubric_label=LABEL, **kwargs)


# --------------------------------------------------------------------------- #
# review_decision
# --------------------------------------------------------------------------- #
def test_a_legible_sheet_with_no_answers_uses_the_page_legibility_and_says_why():
    decision = decide(ocr(pages=[0.90, 0.85, 0.85, 0.90]), 4)
    assert decision.hold and decision.reason == "no_answers"
    assert decision.confidence == 0.875 and decision.page_legibility is True and decision.flagged == []
    assert decision.message == (
        "No answers found for rubric 'Biology - Genetics' (v1): none of its 5 questions has a transcribed answer "
        "although the pages read clearly (page legibility 85-90%) - check that the sheet was uploaded with the "
        "right rubric; routed to faculty review; AI evaluation skipped."
    )
    assert "OCR confidence 0.00" not in decision.message


def test_no_answers_message_for_a_one_question_rubric_and_one_page():
    decision = decide(ocr(pages=[0.95]), 1, rubric(1))
    assert decision.reason == "no_answers"
    assert "its only question has no transcribed answer" in decision.message
    assert "(page legibility 95%)" in decision.message


def test_an_illegible_sheet_with_no_answers_is_a_confidence_hold():
    low = decide(ocr(pages=[0.50, 0.60]), 2)
    assert low.reason == "low_confidence" and low.confidence == 0.55 and low.flagged == [1, 2]
    assert low.message.startswith("OCR confidence 0.55 is below the 0.80 threshold")
    one_page = decide(ocr(pages=[0.95, 0.70]), 2)  # sheet 0.825 passes, page 2 does not
    assert one_page.reason == "low_page_confidence" and one_page.flagged == [2]
    assert one_page.message.startswith("Page 2 below the 0.80 threshold (overall 0.82)")


def test_no_answers_without_page_assessments_keeps_the_old_confidence():
    decision = decide(ocr(), 1)
    assert decision.reason == "low_confidence" and decision.confidence == 0.0 and decision.page_legibility is False


def test_voice_with_nothing_mapped_is_a_no_answers_hold():
    decision = decide(ocr(), 0, rubric(3), voice=True)
    assert decision.hold and decision.reason == "no_answers" and decision.confidence == 0.0
    assert decision.message == (
        "No part of the recording could be mapped to a question of rubric 'Biology - Genetics' (v1) - routed to "
        "faculty review; AI evaluation skipped."
    )
    one = decide(ocr({1: 0.85}), 0, rubric(3), voice=True)  # a voice answer to one question is not mostly blank
    assert not one.hold and one.reason is None


@pytest.mark.parametrize(
    ("result", "page_total", "reason", "start"),
    [
        (ocr({q: 0.55 for q in range(1, 6)}), 1, "low_confidence", "OCR confidence 0.55 is below the 0.80 threshold"),
        (ocr({q: 0.93 for q in range(1, 6)}, pages=[0.95, 0.62]), 2, "low_page_confidence", "Page 2 below the 0.80"),
        (ocr({1: 0.93, 2: 0.93}), 1, "mostly_blank", "Mostly blank sheet - confirm before grading: only 2/5"),
    ],
)
def test_each_confidence_and_coverage_reason(result, page_total, reason, start):
    decision = decide(result, page_total)
    assert decision.hold and decision.reason == reason and decision.message.startswith(start)


@pytest.mark.parametrize(("verdict", "reason"), [("mismatch", "paper_mismatch"), ("reordered", "paper_reordered")])
def test_a_paper_check_hold_comes_first(verdict, reason):
    check = RubricMatch(verdict=verdict, message="Another paper.")
    decision = decide(ocr(pages=[0.4]), 1, paper_check=check)  # also illegible and unanswered
    assert decision.hold and decision.reason == reason and decision.message == "Another paper."


@pytest.mark.parametrize("verdict", ["match", "unknown"])
def test_other_paper_verdicts_never_hold(verdict):
    decision = decide(ocr({q: 0.93 for q in range(1, 6)}), 1, paper_check=RubricMatch(verdict=verdict))
    assert not decision.hold and decision.reason is None and decision.message is None
    assert decision.confidence == 0.93 and decision.answered == 5 and decision.questions == 5


def test_blank_answers_count_as_no_answers():
    decision = decide(ocr({1: 0.9, 2: 0.9}, pages=[0.9], text="  "), 1)
    assert decision.reason == "no_answers" and decision.answered == 0 and decision.confidence == 0.9


TEXT_MISMATCH = RubricMatch(
    verdict="mismatch", compared=12, matched=0,
    message=(
        "The sheet's printed questions do not match the rubric (0 of 12 compared) - it looks like a different paper."
    ),
)
SHAPE_MISMATCH = RubricMatch(
    verdict="mismatch", message="This is a printed question paper - it is not this paper's rubric."
)


@pytest.mark.parametrize("answers", [{q: 0.93 for q in range(1, 6)}, {1: 0.93, 2: 0.93, 3: 0.93}])
def test_a_text_layer_comparison_is_set_aside_when_the_answers_map(answers):
    """A typed answer sheet's text is the student's answers, which never read like the rubric's
    questions: with at least half the rubric answered, the text-layer comparison does not hold."""
    decision = decide(ocr(answers, pages=[0.95]), 1, paper_check=TEXT_MISMATCH, text_layer=True)
    assert not decision.hold and decision.reason is None and decision.paper_check_set_aside is True
    reordered = TEXT_MISMATCH.model_copy(update={"verdict": "reordered", "moved": 12})
    assert not decide(ocr(answers, pages=[0.95]), 1, paper_check=reordered, text_layer=True).hold


def test_a_text_layer_comparison_still_explains_a_sheet_the_reader_could_not_map():
    for result in (ocr(pages=[0.9, 0.9]), ocr({1: 0.93, 2: 0.93}, pages=[0.95, 0.95])):  # none / 2 of 5 mapped
        decision = decide(result, 2, paper_check=TEXT_MISMATCH, text_layer=True)
        assert decision.hold and decision.reason == "paper_mismatch" and decision.message == TEXT_MISMATCH.message
        assert decision.paper_check_set_aside is False


def test_a_set_aside_comparison_leaves_the_other_holds():
    decision = decide(ocr({q: 0.55 for q in range(1, 6)}), 1, paper_check=TEXT_MISMATCH, text_layer=True)
    assert decision.reason == "low_confidence" and decision.paper_check_set_aside is True


def test_the_shape_verdict_and_the_marks_readers_check_hold_whatever_was_mapped():
    import paper_match

    mapped = ocr({q: 0.93 for q in range(1, 6)}, pages=[0.95])
    assert paper_match.structural(SHAPE_MISMATCH) and not paper_match.structural(TEXT_MISMATCH)
    shape = decide(mapped, 1, paper_check=SHAPE_MISMATCH, text_layer=True)
    assert shape.hold and shape.reason == "paper_mismatch" and shape.paper_check_set_aside is False
    marks = decide(mapped, 1, paper_check=TEXT_MISMATCH)  # text_layer=False: the marks reader's own stems
    assert marks.hold and marks.reason == "paper_mismatch" and marks.message == TEXT_MISMATCH.message


# --------------------------------------------------------------------------- #
# shape_check
# --------------------------------------------------------------------------- #
def test_shape_check_holds_a_long_printed_paper_against_a_small_descriptive_rubric():
    import paper_match

    match = paper_match.shape_check(174, rubric(5), rubric_label=LABEL)
    assert match is not None and match.verdict == "mismatch"
    assert (match.compared, match.matched, match.moved, match.examples) == (0, 0, 0, [])
    assert match.message == (  # the fact only: intake shows it before anything is uploaded
        "This is a printed question paper with about 174 numbered questions, but rubric 'Biology - Genetics' (v1) "
        "has 5 questions, none of them MCQs - it is not this paper's rubric."
    )
    assert paper_match.structural(match)
    some = paper_match.shape_check(40, rubric(6, mcqs=2))
    assert some is not None and "but the selected rubric has 6 questions, 2 of them MCQs" in some.message
    assert "paper" in some.message and "rubric" in some.message  # the legacy frontend regex


@pytest.mark.parametrize(
    ("numbered", "content"),
    [
        (174, rubric(180, mcqs=180)),   # an MCQ-heavy rubric: the printed-question comparison decides
        (174, rubric(12, mcqs=10)),     # 83% MCQs is MCQ-heavy too
        (9, rubric(1)),                 # too few numbered questions to call it a printed paper
        (20, rubric(10)),               # the rubric covers half of the paper
        (174, {"questions": []}),       # empty rubric
        (174, None),
    ],
)
def test_shape_check_passes(numbered, content):
    import paper_match

    assert paper_match.shape_check(numbered, content) is None


# --------------------------------------------------------------------------- #
# The handwriting reader's text-layer paper check
# --------------------------------------------------------------------------- #
def printed_mcq_pdf(questions: int = 40) -> bytes:
    from tests.test_paper_detect import _paper

    return _paper(range(1, questions + 1), key=False, header=["NEET 2016 Question Paper", "BIOLOGY"])


def body(client, submission_id: int) -> dict:
    return client.get(f"/api/results/{submission_id}").json()


def messages(payload: dict) -> list[str]:
    return [entry["message"] for entry in payload["processing_log"]]


def mcq_rubric(prompts: list[str]) -> dict:
    return {
        "name": "NEET mock", "subject": "Physics",
        "questions": [
            {"question": n, "topic": f"Topic {n}", "max_marks": 4, "effort_hours": 2, "question_type": "mcq",
             "options": ["one", "two", "three", "four"], "correct_option": "A", "prompt": prompt}
            for n, prompt in enumerate(prompts, start=1)
        ],
    }


def test_document_paper_check_order(make_pdf):
    import pipeline
    from tests.test_paper_detect import _printed_paper
    from tests.test_paper_match import OTHER_PAPER, QUESTIONS

    paper = _printed_paper(QUESTIONS)  # 16 printed MCQs with their question text
    assert pipeline.document_paper_check(paper, mcq_rubric(QUESTIONS)).verdict == "match"
    other = pipeline.document_paper_check(paper, mcq_rubric(OTHER_PAPER))
    assert other.verdict == "mismatch" and other.message.startswith("The sheet's printed questions do not match")
    shape = pipeline.document_paper_check(paper, rubric(5), rubric_label=LABEL)
    assert shape.verdict == "mismatch" and shape.message.startswith(
        "This is a printed question paper with about 16 numbered questions, but rubric 'Biology - Genetics' (v1)"
    )
    # The hold adds what to do (shape_check itself states the fact only).
    assert shape.message.endswith(f"- it is not this paper's rubric. {pipeline.PAPER_SHAPE_ACTION}")
    assert pipeline.document_paper_check(paper, rubric(10)) is None  # covers more than half: nothing to say
    assert pipeline.document_paper_check(make_pdf(2), rubric(5)) is None  # not a printed paper


def test_a_printed_mcq_paper_read_as_handwriting_is_held_as_another_papers_sheet(upload, fake_ai, client, tmp_path):
    import pipeline

    response = upload(filename="2016_paper.pdf", content=printed_mcq_pdf())
    assert response.status_code == 202, response.text
    payload = body(client, response.json()["id"])
    sub = payload["submission"]
    assert payload["status"] == "HUMAN_REVIEW_REQUIRED" and sub["review_reason"] == "paper_mismatch"
    assert sub["error_message"] == (
        "This is a printed question paper with about 40 numbered questions, but rubric 'Biology - Genetics' (v1) "
        "has 5 questions, none of them MCQs - it is not this paper's rubric. Re-run the sheet with the paper's "
        "rubric, or approve it to score it with this rubric anyway."
    )
    log = messages(payload)
    assert f"{pipeline.PAPER_CHECK_PREFIX}{sub['error_message']}" in log and pipeline.PAPER_HOLD_MESSAGE in log
    assert fake_ai.calls["ocr"] == 1 and fake_ai.calls["evaluation"] == 0  # the transcript is kept for approval
    stored = json.loads((tmp_path / "artifacts" / str(sub["id"]) / "ocr.json").read_text(encoding="utf-8"))
    assert stored["paper_check"]["verdict"] == "mismatch" and stored["paper_check"]["message"] == sub["error_message"]
    assert stored["paper_check_source"] == pipeline.CHECK_SOURCE_TEXT_LAYER


# A typed answer sheet for the 12-question 'NEET Mixed - Mock 08' rubric: 12 numbered answers, some
# with lettered (a)-(d) sub-parts. Its text is the student's answers, not the paper's questions.
TYPED_ANSWERS = [
    ["1. Children of this couple, one quarter each:", "(a) IA IB - AB", "(b) IA i - A", "(c) IB i - B", "(d) i i - O"],
    ["2. Every F1 seed is RrYy and looks round and yellow; selfing it gives:", "(a) 9 round yellow",
     "(b) 3 round green", "(c) 3 wrinkled yellow", "(d) 1 wrinkled green"],
    ["3. Respiring muscle makes more acid and heat, so the Bohr shift helps unloading there."],
    ["4. Comparing both divisions:", "(a) two cells versus four cells", "(b) 2n versus n",
     "(c) no chiasmata versus chiasmata in prophase I", "(d) growth and repair versus gametes"],
    ["5. Step one is slow ionisation giving a carbocation; step two is fast attack by water; first order overall."],
    ["6. Only about ten percent passes up each level, so producers hold most and the top carnivores least."],
    ["7. Choosing a coaxial cylinder, flux through the curved surface gives lambda over two pi epsilon zero r."],
    ["8. Comparing both kinds of plants:", "(a) RuBP versus PEP", "(b) PGA versus OAA",
     "(c) no Kranz anatomy versus Kranz anatomy", "(d) high versus negligible photorespiration"],
    ["9. Resolving the launch velocity:", "(a) 17.3 m/s across", "(b) 10 m/s upward", "(c) flight lasts 2 s",
     "(d) lands 34.6 m away after rising 5 m"],
    ["10. Change in kinetic energy equals net work; speed at the bottom comes out as ten metres per second."],
    ["11. Internal energy stays constant at fixed temperature, so heat absorbed equals work by the gas."],
    ["12. Ammonia is pyramidal near 107 degrees while water is bent near 104.5 degrees owing to two lone pairs."],
]
# Two more answers with sub-parts: 7 option groups for 12 numbers passes paper_detect.printed_paper, so
# only review_decision's text-layer rule keeps it from being held.
MORE_PARTS = {
    2: ["3. The curve moves to the right when:", "(a) pCO2 rises", "(b) acidity rises", "(c) temperature rises",
        "(d) 2,3-BPG rises"],
    9: ["10. Energy bookkeeping for the block:", "(a) loses 100 J of potential energy",
        "(b) gains 100 J of kinetic energy", "(c) friction does no work", "(d) final speed 10 m/s"],
}


def typed_lines(*, more_parts: bool = False) -> list[str]:
    blocks = [MORE_PARTS.get(i, block) if more_parts else block for i, block in enumerate(TYPED_ANSWERS)]
    return [line for block in blocks for line in block]


def typed_sheet(kind: str, *, more_parts: bool = False) -> bytes:
    """The typed answer sheet as a Word document (built like tests/test_rubric_parse.py) or a text PDF."""
    lines = typed_lines(more_parts=more_parts)
    if kind == "docx":
        from tests.test_rubric_parse import _docx

        return _docx(["Answer sheet - Riya Patel - NEET Mixed Mock 08", *lines])
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_textbox(pymupdf.Rect(36, 36, 560, 800), "\n".join(["Answer sheet - Riya Patel", *lines]), fontsize=9)
    data = doc.tobytes()
    doc.close()
    return data


def mock08_id(client) -> int:
    content = seed.load_mixed_rubric()
    response = client.post("/api/rubrics", json={"content": content, "approved": False})
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.mark.parametrize("kind", ["docx", "pdf"])
def test_a_typed_answer_sheet_with_sub_parts_is_not_a_printed_paper(kind):
    import config
    import paper_detect
    import pipeline

    data = typed_sheet(kind)
    inspection, texts = paper_detect.inspect_document(data, config.get_settings())
    # classify() alone calls it a printed MCQ paper (12 numbered questions, 5 option groups) ...
    assert (inspection.role, inspection.numbered_questions, inspection.option_groups) == ("question_paper", 12, 5)
    content = seed.load_mixed_rubric()
    # ... and its answers compared with the rubric's questions read as another paper.
    assert paper_detect.match_rubric(texts, content).verdict == "mismatch"
    # The printed-paper gate: option lists for fewer than half its numbers - not checked anywhere.
    assert not paper_detect.printed_paper(inspection)
    assert paper_detect.rubric_check(inspection, texts, content) is None
    assert pipeline.document_paper_check(data, content) is None
    mime = config.DOCX_MIME if kind == "docx" else "application/pdf"
    assert paper_detect.ingestion_hint(data, mime, config.get_settings(), rubric_content=content,
                                       rubric_label="'NEET Mixed - Mock 08' (v1)") is None


@pytest.mark.parametrize("more_parts", [False, True])
@pytest.mark.parametrize("kind", ["docx", "pdf"])
def test_a_typed_answer_sheet_for_the_right_rubric_is_graded_not_held(upload, fake_ai, client, kind, more_parts):
    import pipeline

    rubric_id = mock08_id(client)
    response = upload(filename=f"riya_mock08.{kind}", content=typed_sheet(kind, more_parts=more_parts),
                      rubric_id=str(rubric_id))
    assert response.status_code == 202, response.text
    payload = body(client, response.json()["id"])
    assert payload["submission"]["status"] == "COMPLETED", payload.get("detail")
    assert payload["submission"]["review_reason"] is None and len(payload["question_evaluations"]) == 12
    assert fake_ai.calls["evaluation"] == 1
    log = messages(payload)
    hints = [m for m in log if "Printed MCQ paper detected" in m]
    checks = [m for m in log if m.startswith(pipeline.PAPER_CHECK_PREFIX)]
    if more_parts:  # the gate passes: compared, logged, and set aside because 12 of 12 answers mapped
        assert len(hints) == 1 and hints[0].endswith(
            "The sheet will be held for faculty review unless its answers map to at least half of the rubric's "
            "questions."
        )
        assert checks[0].startswith("Paper check: The sheet's printed questions do not match the rubric")
        assert checks[1] == (
            "Paper check: not applied - 12 of 12 rubric questions have a transcribed answer, so the document's text "
            "is read as the student's answers, not another paper's questions."
        )
    else:  # not a printed paper: no hint, no check
        assert hints == [] and checks == []


def test_a_section_rubric_printed_on_a_longer_paper_is_not_held(upload, fake_ai, client):
    """A 5-question descriptive rubric whose questions are printed on a 32-question paper: the
    comparison finds them (5 of 5), so the shape check never calls it another paper's rubric."""
    from tests.test_paper_detect import _descriptive, _printed_paper
    from tests.test_paper_match import OTHER_PAPER, QUESTIONS

    section = {**_descriptive(QUESTIONS[:5], "Section A"), "questions": [
        {**q, "expected_answer": "A worked answer.", "grading_criteria": ["Full marks for a worked answer."]}
        for q in _descriptive(QUESTIONS[:5], "Section A")["questions"]
    ]}
    created = client.post("/api/rubrics", json={"content": section, "approved": False})
    assert created.status_code == 201, created.text
    response = upload(filename="section_a.pdf", content=_printed_paper(QUESTIONS + OTHER_PAPER),
                      rubric_id=str(created.json()["id"]))
    payload = body(client, response.json()["id"])
    assert payload["submission"]["status"] == "COMPLETED", payload.get("detail")
    assert (
        "Paper check: The sheet's printed questions match the rubric (5 of 5 compared) - too few to confirm the "
        "paper and its version."
    ) in messages(payload)


def test_a_handwritten_pdf_and_a_photo_get_no_text_layer_check(upload, fake_ai, client, make_pdf):
    for kwargs in ({"filename": "sheet.pdf", "content": make_pdf(2)}, {}):
        sub = upload(**kwargs).json()
        response = client.get(f"/api/results/{sub['id']}")
        assert response.status_code == 200, response.text
        assert not any(m.startswith("Paper check: ") for m in messages(response.json()))
        assert response.json()["submission"]["review_reason"] is None


def test_a_failing_text_layer_check_never_fails_the_job(upload, fake_ai, client, monkeypatch):
    import paper_detect

    def broken(*_args, **_kwargs):
        raise RuntimeError("detector bug")

    monkeypatch.setattr(paper_detect, "inspect_document", broken)
    sub = upload(filename="2016_paper.pdf", content=printed_mcq_pdf()).json()
    response = client.get(f"/api/results/{sub['id']}")
    assert response.status_code == 200, response.text
    assert "Paper check: skipped - the printed questions could not be compared with the rubric." in messages(
        response.json()
    )


def test_a_rescan_run_skips_the_text_layer_check_and_clears_the_reason(upload, fake_ai, client, db_session):
    import database
    import pipeline

    sub = upload(filename="2016_paper.pdf", content=printed_mcq_pdf()).json()
    assert body(client, sub["id"])["submission"]["review_reason"] == "paper_mismatch"
    row = db_session.get(database.StudentSubmission, sub["id"])
    row.status = database.SubmissionStatus.PENDING
    db_session.commit()
    pipeline.process_submission(sub["id"], mode=pipeline.MODE_FULL, reason="rescan")
    response = client.get(f"/api/results/{sub['id']}")
    assert response.status_code == 200, response.text
    assert response.json()["submission"]["review_reason"] is None
    assert len([m for m in messages(response.json()) if m.startswith("Paper check: ")]) == 1  # the upload's only
    db_session.expire_all()
    assert db_session.get(database.StudentSubmission, sub["id"]).review_reason is None


def no_answer_ocr(monkeypatch, fake_ai, pages: list[float]) -> None:
    """ai.run_ocr returns no answers with legible pages, like the real reader on another paper."""
    import ai

    def run_ocr(prepared, rubric_content, **kwargs):
        fake_ai.calls["ocr"] += 1
        return OcrResult(
            answers=[], overall_confidence=0.0, provider="anthropic", model="fake-vision-model",
            page_assessments=[PageAssessment(page=i, legibility_confidence=c) for i, c in enumerate(pages, start=1)],
        )

    monkeypatch.setattr(ai, "run_ocr", run_ocr)


def test_a_legible_sheet_with_no_answers_is_held_as_no_answers(upload, fake_ai, client, monkeypatch, tmp_path):
    no_answer_ocr(monkeypatch, fake_ai, [0.9])
    sub = upload().json()
    payload = body(client, sub["id"])
    held = payload["submission"]
    assert payload["status"] == "HUMAN_REVIEW_REQUIRED" and held["review_reason"] == "no_answers"
    assert held["ocr_confidence"] == 0.9 and held["flagged_pages"] == []
    assert held["error_message"].startswith("No answers found for rubric 'Biology - Genetics' (v1): none of its 5")
    assert payload["detail"] == held["error_message"]
    assert (
        "Extracted 0 answer(s); no rubric question has an answer, so the sheet confidence is the page legibility "
        "0.90; page confidence p1 0.90."
    ) in messages(payload)
    stored = json.loads((tmp_path / "artifacts" / str(sub["id"]) / "ocr.json").read_text(encoding="utf-8"))
    assert stored["overall_confidence"] == 0.0  # the raw model output is unchanged
    assert fake_ai.calls["evaluation"] == 0


def test_the_blurry_mock_is_a_low_confidence_hold(upload, forbid_ai, client):
    sub = upload(filename="blurry_scan.png").json()
    assert body(client, sub["id"])["submission"]["review_reason"] == "low_confidence"


def test_completed_and_failed_sheets_have_no_reason(upload, fake_ai, client):
    import ai

    done = upload().json()
    assert body(client, done["id"])["submission"]["review_reason"] is None
    fake_ai.ocr_error = ai.AIServiceError("The AI provider call failed.")
    failed = body(client, upload().json()["id"])
    assert failed["status"] == "FAILED" and failed["submission"]["review_reason"] is None


# --------------------------------------------------------------------------- #
# recheck_held_sheets: the start-up backfill
# --------------------------------------------------------------------------- #
LEGACY_MESSAGE = "OCR confidence 0.00 is below the 0.80 threshold - routed to faculty review; AI evaluation skipped."


def make_legacy(
    db_session, submission_id: int, tmp_path: Path, *, keep_check_lines: bool = False, rescan: bool = False
) -> None:
    """What an older build left behind: no review_reason, a 0.00 sheet confidence and its message,
    no paper check (in ocr.json or the log) for a sheet read as handwriting."""
    import database
    import pipeline

    row = db_session.get(database.StudentSubmission, submission_id)
    row.review_reason = None
    row.ocr_confidence = 0.0
    row.error_message = LEGACY_MESSAGE
    if not keep_check_lines:
        row.processing_log = [
            e for e in row.processing_log or [] if not e["message"].startswith(pipeline.PAPER_CHECK_PREFIX)
        ]
    db_session.commit()
    folder = tmp_path / "artifacts" / str(submission_id)
    data = json.loads((folder / "ocr.json").read_text(encoding="utf-8"))
    data.pop("paper_check", None)
    (folder / "ocr.json").write_text(json.dumps(data), encoding="utf-8")
    if rescan:
        run = json.loads((folder / "run.json").read_text(encoding="utf-8"))
        (folder / "run.json").write_text(json.dumps({**run, "reason": "rescan"}), encoding="utf-8")


def recheck(db_session) -> int:
    import pipeline

    count = pipeline.recheck_held_sheets(db_session)
    db_session.expire_all()
    return count


def rechecked_lines(payload: dict) -> list[str]:
    import pipeline

    return [m for m in messages(payload) if m.startswith(pipeline.RECHECK_PREFIX)]


def test_recheck_updates_a_legacy_no_answer_row_once(upload, fake_ai, client, monkeypatch, db_session, tmp_path):
    no_answer_ocr(monkeypatch, fake_ai, [0.95])
    sub = upload().json()
    make_legacy(db_session, sub["id"], tmp_path)
    legacy = body(client, sub["id"])["submission"]
    assert legacy["review_reason"] is None and legacy["ocr_confidence"] == 0.0

    assert recheck(db_session) == 1
    payload = body(client, sub["id"])
    held = payload["submission"]
    assert held["status"] == "HUMAN_REVIEW_REQUIRED" and held["review_reason"] == "no_answers"
    assert held["ocr_confidence"] == 0.95 and held["error_message"].startswith("No answers found for rubric")
    assert rechecked_lines(payload) == [
        f"Re-checked with the updated review rules (no AI call): {held['error_message']}"
    ]

    assert recheck(db_session) == 0  # idempotent
    again = body(client, sub["id"])
    assert again["processing_log"] == payload["processing_log"] and again["submission"] == held


def test_recheck_finds_a_printed_paper_from_its_text_layer(upload, fake_ai, client, monkeypatch, db_session, tmp_path):
    no_answer_ocr(monkeypatch, fake_ai, [0.90])
    sub = upload(filename="2016_paper.pdf", content=printed_mcq_pdf(60)).json()
    make_legacy(db_session, sub["id"], tmp_path)

    assert recheck(db_session) == 1
    held = body(client, sub["id"])["submission"]
    assert held["review_reason"] == "paper_mismatch" and held["ocr_confidence"] == 0.9
    assert held["error_message"].startswith("This is a printed question paper with about 60 numbered questions")
    assert fake_ai.calls["ocr"] == 1  # no new reading


@pytest.mark.parametrize(("seen_check", "reason"), [(False, "paper_mismatch"), (True, "no_answers")])
def test_recheck_of_a_rescanned_sheet_checks_only_when_no_check_was_shown(
    upload, fake_ai, client, monkeypatch, db_session, tmp_path, seen_check, reason
):
    """A rescan skips the paper check because faculty already saw one - an older build never
    checked a sheet read as handwriting, so its rescan is checked by the backfill."""
    no_answer_ocr(monkeypatch, fake_ai, [0.90])
    sub = upload(filename="2016_paper.pdf", content=printed_mcq_pdf(60)).json()
    make_legacy(db_session, sub["id"], tmp_path, keep_check_lines=seen_check, rescan=True)

    assert recheck(db_session) == 1
    assert body(client, sub["id"])["submission"]["review_reason"] == reason


@pytest.mark.parametrize("stored_check", [False, True])
def test_recheck_applies_the_text_layer_rule(upload, fake_ai, client, db_session, tmp_path, stored_check):
    """The backfill gates like a run: a text-layer comparison of a sheet whose answers mapped is set
    aside - recomputed from the upload, or stored in ocr.json without its source (only the marks
    reader's OCR has printed stems)."""
    fake_ai.answer_confidence = 0.55  # held for its confidence, all 12 answers mapped
    sub = upload(filename="riya_mock08.pdf", content=typed_sheet("pdf", more_parts=True),
                 rubric_id=str(mock08_id(client))).json()
    assert body(client, sub["id"])["submission"]["review_reason"] == "low_confidence"
    path = tmp_path / "artifacts" / str(sub["id"]) / "ocr.json"
    check = json.loads(path.read_text(encoding="utf-8"))["paper_check"]
    assert check["verdict"] == "mismatch"
    make_legacy(db_session, sub["id"], tmp_path)
    if stored_check:
        path.write_text(json.dumps({**json.loads(path.read_text(encoding="utf-8")), "paper_check": check}),
                        encoding="utf-8")

    assert recheck(db_session) == 1
    held = body(client, sub["id"])["submission"]
    assert held["review_reason"] == "low_confidence" and held["error_message"].startswith("OCR confidence 0.55")


def test_recheck_leaves_demo_reviewed_and_passing_rows_alone(demo_data, upload, fake_ai, client, db_session, tmp_path):
    import database

    assert client.post("/api/demo/seed").status_code == 200
    fake_ai.answer_confidence = 0.55  # held by the gate of the day ...
    reviewed = upload().json()
    make_legacy(db_session, reviewed["id"], tmp_path)
    (tmp_path / "artifacts" / str(reviewed["id"]) / "ocr_reviewed.json").write_text("{}", encoding="utf-8")

    passing = upload().json()
    assert body(client, passing["id"])["submission"]["review_reason"] == "low_confidence"
    row = db_session.get(database.StudentSubmission, passing["id"])
    path = tmp_path / "artifacts" / str(passing["id"]) / "ocr.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    for answer in data["answers"]:
        answer["confidence"] = 0.93  # ... and fine by today's
    data["overall_confidence"] = 0.93
    path.write_text(json.dumps(data), encoding="utf-8")
    row.review_reason = None
    db_session.commit()

    demo_rows = db_session.query(database.StudentSubmission).filter(
        database.StudentSubmission.is_demo.is_(True),
        database.StudentSubmission.status == database.SubmissionStatus.HUMAN_REVIEW_REQUIRED,
    ).all()
    assert demo_rows and all(r.review_reason == "low_confidence" for r in demo_rows)  # seeded with its reason
    for demo in demo_rows:
        demo.review_reason = None  # as seeded by an older build
    db_session.commit()
    assert recheck(db_session) == 0
    for submission_id in (reviewed["id"], passing["id"], *(r.id for r in demo_rows)):
        assert db_session.get(database.StudentSubmission, submission_id).review_reason is None
        assert rechecked_lines(body(client, submission_id)) == []


def test_recheck_runs_at_startup(monkeypatch):
    import pipeline

    calls: list[int] = []
    monkeypatch.setattr(pipeline, "recheck_held_sheets", lambda db: calls.append(1) or 0)
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app):
        pass
    assert calls == [1]
