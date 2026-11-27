"""End to end, offline: one intake with its own drafted answer key (no saved rubric) - several
accepted options and a bonus MCQ (K1), the question paper and answer-key files sent with the first
upload and previewed from the report (K2), then a one-call re-grade with an edited key (K3).
Real preprocessing on the sheet image; OCR and grading are fakes; temp DB / upload / artifact dirs."""
from __future__ import annotations

import io
import json

import pymupdf
import pytest
from PIL import Image, ImageDraw

from tests.test_contract import check_interface

OPTIONS = ["Nucleus", "Mitochondria", "Ribosome", "Golgi body"]
KEY = {1: "B", 2: "A", 3: "D", 5: "C", 6: "A", 8: "D", 9: "B", 10: "C"}  # Q4 bonus, Q7 "2 or 3"
KEY_TEXT = "NEET answer key - Code A\n" + "".join(
    f"{n}. ({'Bonus' if n == 4 else '2 or 3' if n == 7 else 'ABCD'.index(KEY[n]) + 1})\n" for n in range(1, 11)
)


def mcq(number: int, **key) -> dict:
    return {"question": number, "topic": f"Cell biology {number}", "subject": "Biology", "max_marks": 4,
            "effort_hours": 1, "question_type": "mcq", "options": list(OPTIONS), **key}


def rubric(changes: dict[int, dict] | None = None) -> dict:
    """The intake's drafted key: 10 MCQs, +4/-1; Q4 bonus, Q7 accepts B or C."""
    questions = []
    for n in range(1, 11):
        key = {"bonus": True} if n == 4 else {"accepted_options": ["B", "C"]} if n == 7 else {"correct_option": KEY[n]}
        questions.append(mcq(n, **(changes or {}).get(n, key)))
    return {"name": "NEET Biology mock (drafted)", "subject": "Biology",
            "marking_policy": {"partial_credit": "steps", "mark_step": 0.5, "negative_marks": 1,
                               "scheme_name": "NEET +4/-1"},
            "questions": questions}


def paper_pdf(pages: int = 3) -> bytes:
    doc = pymupdf.open()
    for index in range(pages):
        doc.new_page().insert_text((72, 72), f"NEET Biology mock - question paper page {index + 1}")
    data = doc.tobytes()
    doc.close()
    return data


def sheet_png() -> bytes:
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    for row in range(10):
        draw.text((120, 120 + row * 140), f"{row + 1}.  (1)  (2)  (3)  (4)", fill="black")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


class Fakes:
    """OCR returns the marked letters of the sheet being processed. The pipeline still calls
    ai.run_evaluation for an all-MCQ key (the real one returns at once without a provider call), so
    the fake answers the same empty output; marks come from marking.score_mcq only."""

    def __init__(self) -> None:
        self.marks: dict[int, str] = {}
        self.ocr = 0
        self.evaluation = 0

    def run_ocr(self, pages, rubric_content, **kwargs):
        from ai_schemas import OcrAnswer, OcrResult

        self.ocr += 1
        assert pages, "the real pre-processing must hand the pages over"
        answers = [OcrAnswer(question=n, answer=f"({a})", confidence=0.96) for n, a in self.marks.items()]
        return OcrResult(answers=answers, overall_confidence=0.96, provider="anthropic", model="fake-vision-model")

    def run_evaluation(self, answers, rubric_content, **kwargs):
        from ai_schemas import EvaluationOutput

        self.evaluation += 1
        return EvaluationOutput(evaluations=[], overall_strengths=[], overall_gaps=[])


@pytest.fixture
def fakes(monkeypatch, ai_ready) -> Fakes:
    import ai
    import mcq_marks

    fake = Fakes()
    monkeypatch.setattr(ai, "run_ocr", fake.run_ocr)
    # A photo of a printed all-MCQ sheet goes to the tick reader (pipeline.ocr_reader).
    monkeypatch.setattr(mcq_marks, "read_marked_options", fake.run_ocr)
    monkeypatch.setattr(ai, "run_evaluation", fake.run_evaluation)
    return fake


def marks_of(result: dict) -> dict[int, float]:
    return {q["question"]: q["estimated_marks"] for q in result["question_evaluations"]}


def notes_of(result: dict) -> dict[int, str]:
    return {q["question"]: q["marking_note"] for q in result["question_evaluations"]}


def test_intake_with_bonus_accepted_options_sources_and_one_call_regrade(bare_client, fakes):
    client = bare_client
    sheet = sheet_png()

    # 1) First upload of the intake: the drafted key inline + the files it was drafted from.
    fakes.marks = {1: "2", 2: "1", 3: "4", 5: "3", 6: "1", 7: "2", 8: "4", 9: "2", 10: "1"}  # Q4 blank, Q10 wrong
    first = client.post(
        "/api/upload",
        data={"student_name": "Aarav Sharma", "rubric_json": json.dumps(rubric()), "intake_batch_id": "intake-e2e"},
        files={
            "file": ("aarav.png", sheet, "image/png"),
            "rubric_source_file": ("neet_mock_paper.pdf", paper_pdf(3), "application/pdf"),
            "rubric_key_file": ("neet_mock_key.txt", KEY_TEXT.encode(), "text/plain"),
        },
    )
    assert first.status_code == 202, first.text
    sub_a = first.json()
    rubric_id = sub_a["rubric_id"]

    # 2) A later upload of the same intake reuses the snapshot by id (no files, as the frontend does).
    fakes.marks = {1: "2", 2: "1", 3: "4", 4: "4", 5: "3", 6: "1", 7: "3", 8: "4", 9: "2"}  # Q4 D (bonus), Q10 blank
    second = client.post(
        "/api/upload",
        data={"student_name": "Diya Rao", "rubric_id": str(rubric_id), "intake_batch_id": "intake-e2e"},
        files={"file": ("diya.png", sheet, "image/png")},
    )
    assert second.status_code == 202, second.text
    sub_b = second.json()
    assert sub_b["rubric_id"] == rubric_id

    # 3) Grades: the bonus scores full marks blank or wrong; B and C both score on Q7.
    result_a = client.get(f"/api/results/{sub_a['id']}").json()
    result_b = client.get(f"/api/results/{sub_b['id']}").json()
    assert result_a["submission"]["status"] == "COMPLETED", result_a["submission"].get("error_message")
    assert result_b["submission"]["status"] == "COMPLETED", result_b["submission"].get("error_message")
    check_interface(result_a, "Result")
    assert marks_of(result_a) == {1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: -1}
    assert marks_of(result_b) == {1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 0}
    assert (result_a["total_score"], result_b["total_score"], result_a["total_marks"]) == (35, 36, 40)
    assert notes_of(result_a)[4] == "Bonus question - full marks to everyone (+4)"
    assert notes_of(result_b)[4] == "Bonus question - full marks to everyone (+4)"
    assert notes_of(result_a)[7] == "Accepted options B or C (+4)"
    assert notes_of(result_b)[7] == "Accepted options B or C (+4)"
    assert notes_of(result_a)[10] == "Marked A, correct C (-1)"
    q4_a = result_a["question_evaluations"][3]
    assert (q4_a["outcome"], q4_a["selected_option"], q4_a["penalty"]) == ("FULL", None, 0)  # bonus = full credit
    assert q4_a["bonus"] is True and result_a["question_evaluations"][0]["bonus"] is False
    q7_b = result_b["question_evaluations"][6]
    assert (q7_b["selected_option"], q7_b["correct_option"]) == ("C", "C")
    rule = result_a["scoring_controls"]["marking_rule"]
    assert "Q7 accepts more than one option" in rule and "bonus Q4: full marks to everyone" in rule
    assert fakes.ocr == 2 and fakes.evaluation == 2
    snapshot = next(r for r in client.get("/api/rubrics").json() if r["id"] == rubric_id)
    stored = {q["question"]: q for q in snapshot["content"]["questions"]}
    assert stored[4]["bonus"] is True and "correct_option" not in stored[4]
    assert stored[7]["accepted_options"] == ["B", "C"] and "bonus" not in stored[7]
    assert stored[1]["correct_option"] == "B" and not {"bonus", "accepted_options"} & set(stored[1])
    assert (stored[4]["expected_answer"], stored[7]["expected_answer"]) == ("Bonus question", "Option B or C")

    # 4) The key's source files are listed and preview, the sheet's own page too.
    listing = client.get(f"/api/rubrics/{rubric_id}/sources")
    assert listing.status_code == 200
    assert listing.json() == [
        {"kind": "paper", "role": "question_paper", "filename": "neet_mock_paper.pdf", "file_type": "pdf", "pages": 3},
        {"kind": "key", "role": "answer_key", "filename": "neet_mock_key.txt", "file_type": "text", "pages": 1},
    ]
    paper = client.get(f"/api/rubrics/{rubric_id}/sources/paper/preview", params={"page": 2, "width": 960},
                       headers={"Origin": "http://localhost:3000"})
    assert paper.status_code == 200, paper.text
    assert paper.headers["content-type"] in ("image/png", "image/jpeg")
    assert (paper.headers["x-page-count"], paper.headers["x-file-type"]) == ("3", "pdf")
    assert {"x-page-count", "x-file-type"} <= {
        h.strip().lower() for h in paper.headers["access-control-expose-headers"].split(",")
    }
    assert Image.open(io.BytesIO(paper.content)).width <= 960
    key = client.get(f"/api/rubrics/{rubric_id}/sources/key/preview", params={"page": 1, "width": 960})
    assert key.status_code == 200 and key.headers["x-file-type"] == "text"
    Image.open(io.BytesIO(key.content)).verify()
    sheet_page = client.get(f"/api/submissions/{sub_a['id']}/pages/1", params={"variant": "processed"})
    assert sheet_page.status_code == 200 and sheet_page.headers["content-type"].startswith("image/")
    log = [e["message"] for e in result_a["processing_log"]]
    assert any(m.startswith("Answer key drafted from question paper neet_mock_paper.pdf (PDF, 3 pages) and answer "
                            "key neet_mock_key.txt (text, 1 page)") for m in log)

    # 5) One-call re-grade with an edited key (Q10 made a bonus, Q9 accepts A or B): no new OCR.
    both = client.post(f"/api/submissions/{sub_a['id']}/reevaluate",
                       json={"rubric_id": rubric_id, "rubric": rubric()})
    assert (both.status_code, both.json()["code"]) == (422, "invalid_rubric")
    edited = rubric({10: {"bonus": True}, 9: {"accepted_options": ["A", "B"]}})
    regrade = client.post(f"/api/submissions/{sub_a['id']}/reevaluate", json={"rubric": edited})
    assert regrade.status_code == 202, regrade.text
    new_rubric_id = regrade.json()["rubric_id"]
    assert new_rubric_id != rubric_id
    regraded = client.get(f"/api/results/{sub_a['id']}").json()
    assert regraded["submission"]["status"] == "COMPLETED"
    assert marks_of(regraded)[10] == 4 and regraded["total_score"] == 40
    assert notes_of(regraded)[9] == "Accepted options A or B (+4)"
    assert fakes.ocr == 2, "a re-grade reuses the stored transcript"
    versions = client.get(f"/api/results/{sub_a['id']}/versions").json()
    assert len(versions) == 2 and sum(1 for v in versions if v["current"]) == 1
    # The other sheet stays on the intake's snapshot; the drafted key has no files of its own.
    assert client.get(f"/api/results/{sub_b['id']}").json()["total_score"] == 36
    assert client.get(f"/api/rubrics/{new_rubric_id}/sources").json() == []
    assert len(client.get(f"/api/rubrics/{rubric_id}/sources").json()) == 2
