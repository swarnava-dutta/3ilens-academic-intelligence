"""Intake paper detection (paper_detect.py, POST /api/intake/inspect, the upload log hint).

Synthetic PDFs / DOCX only: printed MCQ papers with and without an answer key, an answer-key
table, a typed student sheet and an image-only scan. No AI call is ever made.
"""
from __future__ import annotations

import io

import pymupdf
import pytest

import config
import paper_detect
from tests.test_contract import check_interface
from tests.test_docx import DOCM_MAIN, make_docx


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
def _pdf_from_pages(pages: list[list[str]]) -> bytes:
    doc = pymupdf.open()
    for lines in pages:
        page = doc.new_page()
        page.insert_text((40, 40), "\n".join(lines), fontsize=7)
    data = doc.tobytes()
    doc.close()
    return data


def _mcq_block(number: int, answer: int | None = None, *, split_answer: bool = False) -> list[str]:
    lines = [
        f"{number}. A body moves with uniform acceleration from rest; find its displacement after {number} s.",
        "(1) 10 m",
        "(2) 20 m",
        "(3) 30 m",
        "(4) 40 m",
    ]
    if answer is not None:
        lines += ["Ans.", f"( {answer} )"] if split_answer else [f"Ans. ({answer})"]
    return lines


def _paper(numbers: range, *, key: bool, header: list[str] | None = None, per_page: int = 8, **kwargs) -> bytes:
    pages: list[list[str]] = []
    current = list(header or [])
    for count, number in enumerate(numbers, start=1):
        current += _mcq_block(number, (number % 4) + 1 if key else None, **kwargs)
        if count % per_page == 0:
            pages.append(current)
            current = []
    if current:
        pages.append(current)
    return _pdf_from_pages(pages)


def _image_only_pdf(pages: int = 1) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (300, 400), "white").save(buffer, "PNG")
    doc = pymupdf.open()
    for _ in range(pages):
        page = doc.new_page()
        page.insert_image(page.rect, stream=buffer.getvalue())
    data = doc.tobytes()
    doc.close()
    return data


def _inspect(data: bytes):
    return paper_detect.inspect_bytes(data, config.get_settings())


HEADER = ["FINAL NEET(UG) 2025 (EXAMINATION)", "PHYSICS", "TEST PAPER WITH ANSWER"]


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #
def test_question_paper_with_inline_answer_key():
    result = _inspect(_paper(range(1, 25), key=True, header=HEADER))
    assert result.role == "answer_key_paper"
    assert result.file_type == "pdf" and result.pages == 3 and result.text_layer is True
    assert result.numbered_questions == 24 and result.answer_markers == 24 and result.option_groups == 24
    assert result.subjects == ["Physics"]
    assert result.title == "FINAL NEET(UG) 2025 (EXAMINATION)"
    assert result.within_page_limit is True and result.max_pdf_pages == 40
    assert result.message.startswith("Question paper with its answer key (24 questions, 24 answers found)")


def test_answer_marker_split_across_lines_still_counts():
    result = _inspect(_paper(range(1, 13), key=True, split_answer=True))
    assert result.answer_markers == 12
    assert result.role == "answer_key_paper"


def test_printed_mcq_paper_without_a_key():
    result = _inspect(_paper(range(1, 16), key=False, header=["NEET 2016 Question Paper", "CHEMISTRY"]))
    assert result.role == "question_paper"
    assert result.numbered_questions == 15 and result.answer_markers == 0 and result.option_groups == 15
    assert result.subjects == ["Chemistry"]
    assert "Printed MCQ paper (2 pages, about 15 questions)" in result.message
    assert "use it as the answer key instead" in result.message


def test_answer_key_table_at_the_end_of_the_paper():
    questions = [line for n in range(1, 13) for line in _mcq_block(n)]
    key = ["ANSWER KEY", " ".join(f"{n}. ({(n % 4) + 1})" for n in range(1, 13))]
    result = _inspect(_pdf_from_pages([questions, key]))
    assert result.answer_markers == 12
    assert result.role == "answer_key_paper"


def test_answer_key_grid_rows_count_each_answer():
    questions = [line for n in range(1, 7) for line in _mcq_block(n)]
    key = ["Answer Key", "Que. 1 2 3 4 5 6", "Ans. 2 4 1 3 2 1"]
    markers, table = paper_detect.count_answer_markers("\n".join(questions + key))
    assert (markers, table) == (6, True)


def test_typed_student_sheet_with_ans_lines_is_not_an_answer_key():
    lines = ["Answer sheet - Roll 42"] + [f"{n}. Ans: {'ABCD'[n % 4]} because the net force is zero" for n in range(1, 9)]
    lines += ["The student explains each step of the working in full sentences here."] * 4
    result = _inspect(_pdf_from_pages([lines]))
    assert result.answer_markers == 8
    assert result.role == "answer_sheet"


def test_prose_instructions_are_not_answer_markers():
    text = "Answer the following questions.\nAnswer any 3 questions from Section B.\nAnswer all parts."
    assert paper_detect.count_answer_markers(text) == (0, False)


def test_decimals_and_split_question_numbers():
    text = "2.365 W\n0 .25\n15\n. In some experiment\n1 3 . In a cell\n2 1. Two cities\nQ.7 Which one\nQ8) What"
    assert paper_detect.question_numbers(text) == {7, 8, 13, 15, 21}


def test_option_groups_count_lettered_options_that_start_a_line():
    text = "1. Question\na) one\nb) two\nc) three\nd) four\n2. Next\nA. one\nB. two\nC. three\nD. four"
    assert paper_detect.count_option_groups(text) == 2
    # numbered lines are question numbers, not options; a lone "C. V. Raman" line is no group
    assert paper_detect.count_option_groups("3) first question\n4) second question\nC. V. Raman") == 0


def test_option_groups_need_a_third_option_before_the_fourth():
    assert paper_detect.count_option_groups("(1) a (2) b (3) c (4) d\n(a) x (b) y (c) z (d) w") == 2
    assert paper_detect.count_option_groups("f(4) and g(4) and Ans. (4)") == 0


def test_question_stems_are_the_first_words_after_each_number():
    text = "\n".join(_mcq_block(1, 2) + _mcq_block(2, 3, split_answer=True))
    assert paper_detect.question_stems([text]) == {
        1: "A body moves with uniform acceleration from rest; find its displacement after",
        2: "A body moves with uniform acceleration from rest; find its displacement after",
    }
    pages = ["1 3 .\nIn\na certain camera, four similar thin convex lenses are arranged axially in contact.",
             "15\n. A siren emitting a sound of\nfrequency 800 Hz moves away"]
    assert paper_detect.question_stems(pages) == {
        13: "In a certain camera, four similar thin convex lenses are arranged axially",
        15: "A siren emitting a sound of frequency 800 Hz moves away",
    }


def test_question_stems_of_a_two_column_scan():
    text = (
        "1. \n2. \nFiom a disc of radius Rand mass M, a circular hole\n(1)\n15 MR2/32\n"
        "A square loop ABCD carrying a current i\n"
        "3.\nThe magnetic susceptibility is negative for :\n"
        "4. \n(2)\nparamagnetic material only\n"
        "5. 8 1 2 s vl I® J A capacitor of 2 uF is charged as shown\n"
        "6. Ans. (2)\n"
        "3. Which one of the following is a repeated number\n"
    )
    assert paper_detect.question_stems([text]) == {
        1: "Fiom a disc of radius Rand mass M, a circular hole (1)",  # the stack's text goes to its first number
        3: "The magnetic susceptibility is negative for :",
        5: "A capacitor of 2 uF is charged as shown",  # leading noise skipped
    }  # 2: stacked; 4: options only; 6: an answer line; the second "3." never replaces the first


def test_paper_code_from_the_text_layer():
    assert paper_detect.paper_code("ALLEN\nCODE \n- 45\nCAREER INSTITUTE\n1. A ball") == "Code 45"
    assert paper_detect.paper_code("Test Booklet Code: P\nThis booklet contains 24 pages.") == "Code P"
    assert paper_detect.paper_code("NEET 2016\nPaper Code A/P/W\n") == "Code A/P/W"
    assert paper_detect.paper_code("Mock Test\nSet 2\n1. Question") == "Set 2"
    assert paper_detect.paper_code("Match the columns\nCode:\nA B C D\n(1) iii iv ii i") is None
    assert paper_detect.paper_code("") is None


def test_section_headings_only_when_standalone():
    text = "PHYSICS\nA question about physics and chemistry?\nSECTION-B : CHEMISTRY\nBotany\nzoology is fun to read"
    assert paper_detect.section_subjects(text) == ["Physics", "Chemistry", "Botany"]


def test_image_only_scan_is_an_answer_sheet():
    result = _inspect(_image_only_pdf(2))
    assert result.text_layer is False and result.role == "answer_sheet" and result.pages == 2
    assert result.numbered_questions == result.answer_markers == result.option_groups == 0


def test_short_typed_answer_sheet():
    lines = ["Answer sheet - Aarav Sharma", "1. Tt x tt gives 1 tall : 1 dwarf in the test cross."] + [
        "The F2 generation shows the 3 : 1 phenotypic ratio because tall is dominant over dwarf." for _ in range(6)
    ]
    result = _inspect(_pdf_from_pages([lines]))
    assert result.role == "answer_sheet" and result.message == "Handwritten or typed answer sheet."


def test_over_the_page_limit_is_described_not_rejected(monkeypatch):
    monkeypatch.setenv("MAX_PDF_PAGES", "2")
    result = _inspect(_paper(range(1, 25), key=False))
    assert result.pages == 3 and result.within_page_limit is False and result.max_pdf_pages == 2
    assert result.role == "question_paper"
    assert "It has 3 pages; the upload limit is 2 pages" in result.message


def test_docx_answer_key_paper():
    paragraphs = [line for n in range(1, 11) for line in _mcq_block(n, (n % 4) + 1)]
    result = _inspect(make_docx(paragraphs))
    assert result.file_type == "docx" and isinstance(result.pages, int) and result.pages >= 1
    assert result.role == "answer_key_paper" and result.answer_markers == 10


def test_docx_over_the_layout_cap_is_reported_over_the_limit(monkeypatch):
    import preprocessing

    def too_long(_data):
        raise preprocessing.PreprocessingError("The Word document has more than 60 pages.", "too_many_pages")

    monkeypatch.setattr(preprocessing, "docx_to_pdf", too_long)
    result = _inspect(make_docx())
    assert result.file_type == "docx" and result.pages is None
    assert result.within_page_limit is False
    assert result.message.endswith("It is longer than the 40-page upload limit - split it before uploading.")


def test_docx_over_the_page_limit_reports_its_pages(monkeypatch):
    import preprocessing

    monkeypatch.setenv("MAX_PDF_PAGES", "2")
    monkeypatch.setattr(preprocessing, "docx_to_pdf", lambda _data: (b"", 5, 0))
    result = _inspect(make_docx())
    assert (result.pages, result.within_page_limit) == (5, False)
    assert result.role == "answer_sheet" and result.message.startswith("Short typed answer sheet.")
    assert "It has 5 pages; the upload limit is 2 pages" in result.message


def test_audio_and_images(wav_bytes, png_bytes, monkeypatch):
    voice = _inspect(wav_bytes)
    assert (voice.file_type, voice.pages, voice.role) == ("wav", None, "answer_sheet")
    image = _inspect(png_bytes)
    assert (image.file_type, image.pages, image.role) == ("png", 1, "unknown")
    assert "vision model" in image.message
    monkeypatch.setenv("VOICE_ANSWERS", "0")
    with pytest.raises(Exception) as excinfo:
        _inspect(wav_bytes)
    assert getattr(excinfo.value, "code", None) == "voice_disabled"


def test_ingestion_hint_never_raises():
    settings = config.get_settings()
    assert paper_detect.ingestion_hint(b"%PDF-1.7 broken", "application/pdf", settings) is None
    assert paper_detect.ingestion_hint(b"\x89PNG", "image/png", settings) is None
    paper = paper_detect.ingestion_hint(_paper(range(1, 16), key=False), "application/pdf", settings)
    assert paper == (
        "Printed MCQ paper detected (about 15 numbered questions) - the student's ticked / circled / shaded "
        "options are read as answers."
    )
    keyed = paper_detect.ingestion_hint(_paper(range(1, 13), key=True), "application/pdf", settings)
    assert keyed is not None and keyed.startswith("This file looks like a question paper with its answer key (12 ")


# --------------------------------------------------------------------------- #
# POST /api/intake/inspect
# --------------------------------------------------------------------------- #
def _post(client, content: bytes, filename: str = "paper.pdf"):
    return client.post("/api/intake/inspect", files={"file": (filename, content, "application/octet-stream")})


def test_inspect_route_matches_types_ts(client, forbid_ai, tmp_path):
    response = _post(client, _paper(range(1, 25), key=True, header=HEADER))
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "PaperInspection")
    assert body["role"] == "answer_key_paper" and body["subjects"] == ["Physics"]
    assert forbid_ai == []
    assert not (tmp_path / "uploads").exists() or not any((tmp_path / "uploads").iterdir())  # nothing stored


def test_inspect_route_flags_pages_over_the_limit(client, monkeypatch):
    monkeypatch.setenv("MAX_PDF_PAGES", "1")
    response = _post(client, _paper(range(1, 16), key=False))
    assert response.status_code == 200
    assert response.json()["within_page_limit"] is False and response.json()["pages"] == 2


def _encrypted_pdf() -> bytes:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Locked")
    data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
    doc.close()
    return data


@pytest.mark.parametrize(
    ("content", "status", "code"),
    [
        (b"", 422, "empty_file"),
        (b"hello, this is plain text and not a paper", 415, "unsupported_signature"),
        (b"#!AMR\n" + b"\0" * 64, 415, "unsupported_audio"),
        (b"%PDF-1.7\n this is not a valid pdf body", 422, "corrupt_pdf"),
        (_encrypted_pdf(), 422, "password_pdf"),
        (b"PK\x03\x04" + b"\x13" * 200, 422, "corrupt_docx"),
        (make_docx(paragraphs=[], extra_entries={"word/media/huge.bin": b"\0" * (51 * 1024 * 1024)}), 422,
         "docx_too_large"),
        (make_docx(main_type=DOCM_MAIN, extra_entries={"word/vbaProject.bin": b"\x00" * 32}), 415, "macro_docx"),
    ],
)
def test_inspect_route_errors(client, forbid_ai, content, status, code):
    response = _post(client, content)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def test_inspect_route_empty_documents_have_no_pages(client, monkeypatch):
    import preprocessing

    def empty(_data):
        raise preprocessing.PreprocessingError("The Word document is empty.", "no_pages")

    monkeypatch.setattr(preprocessing, "docx_to_pdf", empty)
    response = _post(client, make_docx(paragraphs=[]), "empty.docx")
    assert response.status_code == 422 and response.json()["code"] == "no_pages"


def test_inspect_route_size_limit_and_missing_file(client, png_bytes):
    response = _post(client, png_bytes + b"\0" * (20 * 1024 * 1024), "huge.png")
    assert response.status_code == 413 and response.json()["code"] == "too_large"
    missing = client.post("/api/intake/inspect", data={})
    assert missing.status_code == 422


# --------------------------------------------------------------------------- #
# POST /api/intake/inspect with rubric_id: the same-paper check
# --------------------------------------------------------------------------- #
def _printed_paper(prompts: list[str], header: list[str] | None = None) -> bytes:
    pages, current = [], list(header or [])
    for number, prompt in enumerate(prompts, start=1):
        current += [f"{number}. {prompt}", "(1) one", "(2) two", "(3) three", "(4) four"]
        if number % 8 == 0:
            pages.append(current)
            current = []
    if current:
        pages.append(current)
    return _pdf_from_pages(pages)


def _saved_rubric(client, prompts: list[str], name: str = "NEET mock") -> int:
    content = {
        "name": name, "subject": "Physics",
        "questions": [
            {"question": n, "topic": f"Topic {n}", "subject": "Physics", "max_marks": 4, "effort_hours": 2,
             "question_type": "mcq", "options": ["one", "two", "three", "four"], "correct_option": "A",
             "prompt": prompt}
            for n, prompt in enumerate(prompts, start=1)
        ],
    }
    response = client.post("/api/rubrics", json={"content": content, "approved": False})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _post_with_rubric(client, content: bytes, rubric_id: object, filename: str = "paper.pdf"):
    return client.post("/api/intake/inspect", data={"rubric_id": str(rubric_id)},
                       files={"file": (filename, content, "application/octet-stream")})


def test_inspect_route_checks_the_paper_against_a_rubric(client, forbid_ai, tmp_path):
    from tests.test_paper_match import QUESTIONS

    paper = _printed_paper(QUESTIONS, header=["NEET mock test", "Test Booklet Code: B"])
    plain = _post(client, paper).json()
    assert plain["rubric_match"] is None

    response = _post_with_rubric(client, paper, _saved_rubric(client, QUESTIONS, name="NEET mock Code A"))
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "PaperInspection")
    check_interface(body["rubric_match"], "RubricMatch")
    assert {k: v for k, v in body.items() if k != "rubric_match"} == {k: v for k, v in plain.items() if k != "rubric_match"}
    match = body["rubric_match"]
    assert (match["verdict"], match["compared"], match["matched"]) == ("reordered", 16, 16)  # code B vs A: held
    assert (match["sheet_code"], match["rubric_code"]) == ("B", "A")
    assert match["message"] == (
        "The sheet's printed questions match the rubric (16 of 16 compared), but its paper code (B) differs from "
        "the rubric's (A) - it looks like another version of the paper (options may be in another order); grade it "
        "with the rubric for code B."
    )
    assert forbid_ai == []
    assert not (tmp_path / "uploads").exists() or not any((tmp_path / "uploads").iterdir())  # nothing stored


def test_inspect_route_finds_another_version_and_another_paper(client, forbid_ai):
    from tests.test_paper_match import OTHER_PAPER, QUESTIONS, shuffled

    paper = _printed_paper(QUESTIONS)
    reordered = _post_with_rubric(client, paper, _saved_rubric(client, shuffled(QUESTIONS))).json()["rubric_match"]
    assert reordered["verdict"] == "reordered" and reordered["moved"] == 16
    assert reordered["message"].startswith("The sheet has the rubric's questions in a different order (e.g. sheet Q1")
    other = _post_with_rubric(client, paper, _saved_rubric(client, OTHER_PAPER)).json()["rubric_match"]
    assert other["verdict"] == "mismatch" and other["matched"] == 0


def test_inspect_route_without_question_text_has_no_rubric_match(client, png_bytes):
    from tests.test_paper_match import QUESTIONS

    rubric_id = _saved_rubric(client, QUESTIONS)
    for content, name in ((png_bytes, "photo.png"), (_image_only_pdf(2), "scan.pdf")):
        response = _post_with_rubric(client, content, rubric_id, name)
        assert response.status_code == 200 and response.json()["rubric_match"] is None
    blank = client.post("/api/intake/inspect", data={"rubric_id": " "},
                        files={"file": ("paper.pdf", _printed_paper(QUESTIONS), "application/octet-stream")})
    assert blank.status_code == 200 and blank.json()["rubric_match"] is None


@pytest.mark.parametrize(("rubric_id", "code"), [("abc", "invalid_rubric"), ("987654", "unknown_rubric")])
def test_inspect_route_rubric_id_errors(client, rubric_id, code):
    response = _post_with_rubric(client, _paper(range(1, 12), key=False), rubric_id)
    assert response.status_code == 422 and response.json()["code"] == code


# --------------------------------------------------------------------------- #
# POST /api/upload log hint
# --------------------------------------------------------------------------- #
def _log(client, submission_id: int) -> list[str]:
    body = client.get(f"/api/results/{submission_id}").json()
    return [entry["message"] for entry in body["processing_log"]]


def test_upload_logs_a_printed_mcq_paper(upload, fake_ai, client):
    response = upload(filename="ticked_paper.pdf", content=_paper(range(1, 16), key=False))
    assert response.status_code == 202, response.text
    log = _log(client, response.json()["id"])
    assert any(m.startswith("Printed MCQ paper detected (about 15 numbered questions)") for m in log)
    assert fake_ai.calls["ocr"] == 1  # processing is unchanged


def test_upload_logs_an_answer_key_paper_and_never_rejects_it(upload, fake_ai, client):
    response = upload(filename="key.pdf", content=_paper(range(1, 13), key=True))
    assert response.status_code == 202, response.text
    log = _log(client, response.json()["id"])
    assert any("looks like a question paper with its answer key (12 answer markers)" in m for m in log)


def test_plain_sheet_upload_has_no_paper_hint(upload, fake_ai, client, make_pdf):
    response = upload(filename="sheet.pdf", content=make_pdf(2))
    log = _log(client, response.json()["id"])
    assert not any("MCQ paper" in m or "answer key" in m for m in log)


def test_a_failing_detector_never_breaks_the_upload(upload, fake_ai, client, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("detector bug")

    monkeypatch.setattr(paper_detect, "inspect_bytes", boom)
    response = upload(filename="ticked_paper.pdf", content=_paper(range(1, 16), key=False))
    assert response.status_code == 202, response.text


def test_inspect_skips_the_rubric_check_for_typed_answer_sheets(client, tmp_path):
    import pymupdf

    from tests.test_paper_match import QUESTIONS

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((60, 60), "\n".join(f"{n}. The answer is that the ratio is 3 to 1 because of dominance." for n in range(1, 13)))
    data = doc.tobytes()
    doc.close()
    rubric_id = _saved_rubric(client, QUESTIONS, name="NEET mock Code A")
    response = client.post("/api/intake/inspect", files={"file": ("sheet.pdf", data, "application/pdf")},
                           data={"rubric_id": str(rubric_id)})
    assert response.status_code == 200
    body = response.json()
    assert body["role"] not in ("question_paper", "answer_key_paper") and body["rubric_match"] is None
