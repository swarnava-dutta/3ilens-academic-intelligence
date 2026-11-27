"""Typed answer sheets read from their text layer (typed_sheets) and the pipeline route that uses
it. Offline: no provider call; the text-only mapping call is a fake of ai.structure_transcript."""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

import pymupdf
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import ai  # noqa: E402
import pipeline  # noqa: E402
import typed_sheets  # noqa: E402
from ai_schemas import ModelUsage, OcrAnswer, OcrResult  # noqa: E402

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"


def _mcq(number: int, correct: str = "B") -> dict[str, Any]:
    return {"question": number, "topic": "Ray Optics", "subject": "Physics", "max_marks": 4, "question_type": "mcq",
            "options": ["one", "two", "three", "four"], "correct_option": correct, "expected_answer": f"Option {correct}",
            "grading_criteria": [f"4 marks: option {correct}"], "effort_hours": 1}


MCQ_RUBRIC = {"name": "NEET Mock (typed)", "questions": [_mcq(n) for n in range(1, 13)],
              "marking_policy": {"partial_credit": "all_or_nothing", "negative_marks": 1}}
# Q1 B, Q2 (3) = C, Q3 blank, Q4 "2, 3", Q5-Q10 B, Q11 "-" blank, Q12 not listed
TYPED_LIST = ["Name: Aarav Sharma   Roll no. 17", "1. B", "2. (3)", "3. -", "4. 2, 3", *[f"{n}. B" for n in range(5, 11)],
              "11. -"]
GENETICS = json.loads((BACKEND_DIR / "rubrics" / "biology_genetics_v1.json").read_text(encoding="utf-8"))
WRITTEN = [
    "Answer sheet - Aarav Sharma",
    "1. A cross between Tt and tt gives tall and dwarf plants in a one to one ratio in the offspring.",
    "2. Snapdragon flower colour shows incomplete dominance because pink appears between red and white.",
    "3. DNA replication is semi conservative as Meselson and Stahl showed with heavy nitrogen isotopes.",
]


def _pdf(lines: list[str], *, image: bool = False, per_page: int = 40) -> bytes:
    doc = pymupdf.open()
    for start in range(0, len(lines), per_page):
        page = doc.new_page()
        for i, line in enumerate(lines[start:start + per_page]):
            page.insert_text((72, 72 + 16 * i), line, fontname="helv", fontsize=11)
        if image:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 200), False)
            pix.clear_with(200)
            page.insert_image(pymupdf.Rect(72, 400, 400, 700), pixmap=pix)
    data = doc.tobytes()
    doc.close()
    return data


def _docx(paragraphs: list[str], *, superscript: tuple[str, str, str] | None = None, media: bool = False,
          strike: bool = False) -> bytes:
    """A minimal Word file: one run per paragraph; superscript = (before, raised, after) as an extra paragraph."""
    body = [f'<w:p><w:r>{"<w:rPr><w:strike/></w:rPr>" if strike and i == 1 else ""}'
            f'<w:t xml:space="preserve">{text}</w:t></w:r></w:p>' for i, text in enumerate(paragraphs)]
    if superscript:
        before, raised, after = superscript
        body.append(f'<w:p><w:r><w:t xml:space="preserve">{before}</w:t></w:r>'
                    f'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>{raised}</w:t></w:r>'
                    f'<w:r><w:t xml:space="preserve">{after}</w:t></w:r></w:p>')
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}">'
                f"<w:body>{''.join(body)}</w:body></w:document>")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",
                         '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/'
                         'package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
                         f'relationships+xml"/><Override PartName="/word/document.xml" ContentType="{DOCX_MAIN}"/></Types>')
        archive.writestr("_rels/.rels",
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                         'relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", document)
        if media:
            archive.writestr("word/media/image1.png", b"\x89PNG\r\n\x1a\n")
    return buffer.getvalue()


# --------------------------------------------------------------------------- #
# The gate and the typed-list reader
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("make", [_pdf, _docx], ids=["pdf", "docx"])
def test_a_typed_answer_list_is_read_without_any_ai_call(make):
    r = typed_sheets.route(make(TYPED_LIST), MCQ_RUBRIC)
    assert r.path == typed_sheets.PATH_MCQ, r.reason
    assert r.answered == 9 and "2 typed blank(s), 1 not listed" in r.reason
    ocr = typed_sheets.read_mcq(r)
    assert [(a.question, a.answer, a.confidence, a.source) for a in ocr.answers] == [
        (1, "B", 1.0, "typed"), (2, "C", 1.0, "typed"), (4, "B, C", 1.0, "typed"),
        *[(n, "B", 1.0, "typed") for n in range(5, 11)],
    ]
    assert ocr.provider == typed_sheets.PROVIDER and ocr.overall_confidence == 1.0


@pytest.mark.parametrize(("data", "reason"), [
    (b"\x89PNG\r\n\x1a\n" + b"\0" * 64, "no text layer"),
    (_pdf(["1. B", "1. C", *[f"{n}. B" for n in range(2, 11)]]), "listed twice"),
    (_pdf([*TYPED_LIST, "13. B"]), "not in the rubric"),
    (_pdf([*TYPED_LIST[:3], "3. E"]), "not an option of this paper"),
    (_pdf([f"{n}. B" for n in range(1, 13)]), "equals the key"),
    (_pdf(["1. B", "2. C", "3. -"]), "only 2 typed answers"),
    (_pdf([*TYPED_LIST, "I think question four could also be option one but I am not sure",
           "about it at all, and the same goes for the next three questions in this section",
           "because the figures were printed too small for me to read them during the test today"]),
     "words outside answer entries"),
    (_pdf(TYPED_LIST, image=True), "holds an image"),
    (_docx(TYPED_LIST, media=True), "embeds 1 image"),
    (_docx(TYPED_LIST, strike=True), "formatting that can carry an answer"),
])
def test_the_gate_keeps_todays_route_when_in_doubt(data, reason):
    r = typed_sheets.route(data, MCQ_RUBRIC)
    assert r.path == typed_sheets.PATH_KEEP and reason in r.reason


def test_a_printed_question_paper_keeps_the_tick_reader():
    lines = []
    for n in range(1, 13):
        lines += [f"{n}. A convex lens of focal length {n} cm forms an image of an object placed at a distance of",
                  "twice the focal length. The magnification produced by the lens is",
                  "(1) +1   (2) -1   (3) +2   (4) -2"]
    r = typed_sheets.route(_pdf(lines), MCQ_RUBRIC)
    assert r.path == typed_sheets.PATH_KEEP


def test_typed_written_answers_go_to_the_text_mapping_and_short_texts_do_not():
    assert typed_sheets.route(_pdf(WRITTEN), GENETICS).path == typed_sheets.PATH_STRUCTURE
    assert typed_sheets.route(_docx(WRITTEN), GENETICS).path == typed_sheets.PATH_STRUCTURE
    short = typed_sheets.route(_pdf(["Q1. Tt x tt gives 1 tall : 1 dwarf."]), GENETICS)
    assert short.path == typed_sheets.PATH_KEEP and "too little typed text" in short.reason


def test_word_superscripts_reach_the_mapping_as_carets_and_the_upload_is_unchanged():
    data = _docx(WRITTEN, superscript=("The cross X", "c", " Y gives carriers"))
    texts = typed_sheets.notation_text(data, typed_sheets.DOCX_MIME)
    assert len(texts) == 1 and "The cross X^c Y gives carriers" in texts[0]
    assert typed_sheets.notation_text(_docx(WRITTEN, superscript=("mv", "15", "")), typed_sheets.DOCX_MIME)[0].endswith("mv^15")
    assert typed_sheets.notation_text(_docx(WRITTEN, superscript=("a", "bc", "")), typed_sheets.DOCX_MIME)[0].endswith("a^(bc)")
    plain = _docx(WRITTEN)
    assert typed_sheets.notation_text(plain, typed_sheets.DOCX_MIME)[0] == "\n".join(WRITTEN)


def test_the_post_check_wants_the_sheets_own_words_and_most_of_them():
    r = typed_sheets.route(_pdf(WRITTEN), GENETICS)
    verbatim = OcrResult(answers=[OcrAnswer(question=n, answer=WRITTEN[n][3:], confidence=0.95) for n in (1, 2, 3)],
                         overall_confidence=0.95, provider="anthropic", model="m")
    assert typed_sheets.check_structure(r, verbatim)["ok"]
    rewritten = verbatim.model_copy(update={"answers": [
        *verbatim.answers[:2], OcrAnswer(question=3, answer="Replication follows the semiconservative model of "
                                                             "bacterial chromosomes", confidence=0.9)]})
    assert not typed_sheets.check_structure(r, rewritten)["ok"]  # words the sheet does not have
    partial = verbatim.model_copy(update={"answers": verbatim.answers[:1]})
    assert typed_sheets.check_structure(r, partial)["coverage"] < typed_sheets.MIN_COVERAGE


def test_read_structure_maps_the_caret_text_and_reports_the_call_as_ocr(monkeypatch):
    seen: dict[str, Any] = {}

    def structure(transcript, rubric_content, **kwargs):
        seen["text"] = transcript
        kwargs["on_usage"](ModelUsage(purpose="voice_mapping", provider="anthropic", model_requested="m",
                                      model_served="m", input_tokens=2000, output_tokens=600))
        return OcrResult(answers=[OcrAnswer(question=2, answer=WRITTEN[2][3:], confidence=0.9, source="voice")],
                         overall_confidence=0.9, provider="anthropic", model="m")

    monkeypatch.setattr(ai, "structure_transcript", structure)
    data = _docx(WRITTEN, superscript=("X", "c", " Y"))
    r = typed_sheets.route(data, GENETICS)
    usages: list[ModelUsage] = []
    ocr, sent = typed_sheets.read_structure(r, data, GENETICS, on_usage=usages.append)
    assert "X^c Y" in seen["text"] and sent.text == seen["text"]
    assert [u.purpose for u in usages] == ["ocr"]
    assert [(a.question, a.source, a.pages) for a in ocr.answers] == [(2, "typed", [1])]


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def _invocations(submission_id: int) -> list[str]:
    import database
    from database import ModelInvocation
    from sqlalchemy import select

    with database.SessionLocal() as session:
        return [row.purpose for row in session.scalars(
            select(ModelInvocation).where(ModelInvocation.submission_id == submission_id))]


def test_a_typed_mcq_list_is_scored_from_its_text_with_no_ai_call(client, upload, fake_ai, tmp_path):
    response = upload(filename="aarav_answers.pdf", content=_pdf(TYPED_LIST), rubric_json=json.dumps(MCQ_RUBRIC))
    assert response.status_code == 202, response.text
    body = client.get(f"/api/results/{response.json()['id']}").json()
    assert body["submission"]["status"] == "COMPLETED", body["submission"]
    assert fake_ai.calls["preprocess"] == 0 and fake_ai.calls["ocr"] == 0  # no pre-processing, no reader
    log = [entry["message"] for entry in body["processing_log"]]
    assert any(m.startswith(pipeline.TYPED_SHEET_MESSAGE) for m in log)
    assert any(m.startswith("Typed answer list read from the text layer: 9 answer(s) on 1 page(s)") for m in log)
    # Q1 and Q5-Q10 B correct (+4 each), Q2 "(3)" = C wrong (-1), Q4 two options (-1), Q3 / Q11 / Q12 blank
    assert body["total_score"] == 7 * 4 - 2
    assert "ocr" not in _invocations(response.json()["id"])
    pages = list((tmp_path / "artifacts" / str(response.json()["id"])).glob("page_*"))
    assert [p.name for p in pages] == ["page_1.png"]  # rendered for the review viewer


def test_the_typed_path_can_be_switched_off_and_a_rescan_reads_the_pages(client, upload, fake_ai, monkeypatch):
    import mcq_marks

    reads: list[int] = []

    def reader(pages, rubric_content, **kwargs):
        reads.append(len(pages))
        return OcrResult(answers=[OcrAnswer(question=1, answer="B", confidence=0.95)], overall_confidence=0.95,
                         provider="anthropic", model="claude-sonnet-5-5")

    monkeypatch.setattr(mcq_marks, "read_marked_options", reader)
    monkeypatch.setenv("TYPED_TEXT_PATH", "0")
    response = upload(filename="aarav_answers.pdf", content=_pdf(TYPED_LIST), rubric_json=json.dumps(MCQ_RUBRIC))
    assert response.status_code == 202, response.text
    assert fake_ai.calls["preprocess"] == 1

    monkeypatch.setenv("TYPED_TEXT_PATH", "1")
    sub_id = upload(filename="aarav_answers_2.pdf", content=_pdf([*TYPED_LIST, "12. A"]),
                    rubric_json=json.dumps(MCQ_RUBRIC)).json()["id"]
    assert fake_ai.calls["preprocess"] == 1  # read from the text
    import database
    from database import StudentSubmission, SubmissionStatus

    with database.SessionLocal() as session:
        session.get(StudentSubmission, sub_id).status = SubmissionStatus.PENDING
        session.commit()
    pipeline.process_submission(sub_id, reason="rescan")
    assert fake_ai.calls["preprocess"] == 2  # a rescan reads the page images


def test_typed_written_answers_are_mapped_from_the_text_then_graded(client, upload, fake_ai, monkeypatch):
    def structure(transcript, rubric_content, **kwargs):
        kwargs["on_usage"](ModelUsage(purpose="voice_mapping", provider="anthropic", model_requested="claude-sonnet-5-5",
                                      model_served="claude-sonnet-5-5", input_tokens=2000, output_tokens=600))
        return OcrResult(answers=[OcrAnswer(question=n, answer=WRITTEN[n][3:], confidence=0.9) for n in (1, 2, 3)],
                         overall_confidence=0.9, provider="anthropic", model="claude-sonnet-5-5")

    monkeypatch.setattr(ai, "structure_transcript", structure)
    response = upload(filename="aarav_typed.pdf", content=_pdf(WRITTEN))
    assert response.status_code == 202, response.text
    body = client.get(f"/api/results/{response.json()['id']}").json()
    assert body["submission"]["status"] in ("COMPLETED", "HUMAN_REVIEW_REQUIRED"), body["submission"]
    assert fake_ai.calls["preprocess"] == 0 and fake_ai.calls["ocr"] == 0
    assert _invocations(response.json()["id"])[0] == "ocr"
    log = [entry["message"] for entry in body["processing_log"]]
    assert any(m.startswith("Mapping the typed text of 1 page(s)") for m in log)


def test_a_mapping_that_fails_its_check_falls_back_to_the_page_images(client, upload, fake_ai, monkeypatch):
    def structure(transcript, rubric_content, **kwargs):
        return OcrResult(answers=[OcrAnswer(question=1, answer="An answer the student never typed at all", confidence=0.9)],
                         overall_confidence=0.9, provider="anthropic", model="claude-sonnet-5-5")

    monkeypatch.setattr(ai, "structure_transcript", structure)
    response = upload(filename="aarav_typed.pdf", content=_pdf(WRITTEN))
    body = client.get(f"/api/results/{response.json()['id']}").json()
    assert fake_ai.calls["preprocess"] == 1 and fake_ai.calls["ocr"] == 1
    log = [entry["message"] for entry in body["processing_log"]]
    assert any(m.startswith("Typed-text mapping set aside") for m in log)
