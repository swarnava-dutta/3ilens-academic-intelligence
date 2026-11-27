"""POST /api/rubrics/parse (FR-3.4) and POST /api/rubrics. No network: JSON rubrics are parsed
locally; the AI path uses a fake Anthropic client (ai._anthropic_client) or a fake ai.parse_rubric."""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import ai  # noqa: E402
import seed  # noqa: E402
from tests.test_contract import check_interface  # noqa: E402

GENETICS = seed.load_genetics_rubric()
TEST_KEY = "sk-ant-test-rubric-parse-0000"

DRAFT_REPLY = {
    "name": "Mock 09 - Genetics",
    "subject": "Biology",
    "questions": [
        {"question": 1, "topic": "Mendelian Inheritance", "subject": "Biology", "chapter": "Genetics",
         "max_marks": 4, "prompt": "Explain a test cross.", "expected_answer": "Tt x tt gives 1 Tt : 1 tt.",
         "grading_criteria": ["2 marks: correct cross", "2 marks: 1:1 ratio"], "effort_hours": 0,
         "ai_drafted_answer": True},
        {"question": 2, "topic": "Chromosomal Disorders", "subject": "Biology", "chapter": "Genetics",
         "max_marks": 2, "prompt": "Cause of Down syndrome?", "expected_answer": "Trisomy 21.",
         "grading_criteria": ["1 mark: trisomy", "1 mark: chromosome 21"], "effort_hours": 1.5,
         "ai_drafted_answer": False},
    ],
}


class FakeAnthropic:
    """Records beta.messages.create kwargs and returns one canned structured reply."""

    def __init__(self, reply: dict[str, Any]) -> None:
        self.calls: list[dict[str, Any]] = []
        self._reply = reply
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs: Any) -> SimpleNamespace:
        self.calls.append(kwargs)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=json.dumps(self._reply))],
            stop_reason="end_turn",
            stop_details=None,
            model="claude-sonnet-5-5",
            usage=SimpleNamespace(input_tokens=2400, output_tokens=1800, cache_creation_input_tokens=0,
                                  cache_read_input_tokens=0, iterations=None),
            _request_id="req_rubric_1",
        )


@pytest.fixture
def no_ai(monkeypatch):
    """Any AI rubric drafting or SDK client creation fails the test."""
    def forbidden(*_args, **_kwargs):
        raise AssertionError("no AI call expected")

    monkeypatch.setattr(ai, "parse_rubric", forbidden)
    monkeypatch.setattr(ai, "_anthropic_client", forbidden)


@pytest.fixture
def fake_claude(monkeypatch) -> FakeAnthropic:
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    fake = FakeAnthropic(DRAFT_REPLY)
    monkeypatch.setattr(ai, "_anthropic_client", lambda settings: fake)
    return fake


def _docx(paragraphs: list[str], table: list[list[str]] | None = None) -> bytes:
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    if table:
        rows = "".join(
            "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row) + "</w:tr>"
            for row in table
        )
        body += f"<w:tbl>{rows}</w:tbl>"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.'
            'wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr("word/document.xml", f'<?xml version="1.0"?><w:document xmlns:w="{w}"><w:body>{body}</w:body></w:document>')
    return buffer.getvalue()


def _pdf(text: str) -> bytes:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    if text:
        page.insert_textbox(pymupdf.Rect(36, 36, 560, 800), text, fontsize=10)
    data = doc.tobytes()
    doc.close()
    return data


def _parse(client, *, file: tuple[str, bytes, str] | None = None, **form: str):
    files = {"file": file} if file is not None else None
    return client.post("/api/rubrics/parse", data=form, files=files)


# --------------------------------------------------------------------------- #
# JSON: parsed locally, no AI, no key needed
# --------------------------------------------------------------------------- #
def test_json_rubric_file_is_parsed_without_ai(client, no_ai):
    response = _parse(client, file=("genetics.json", json.dumps(GENETICS).encode(), "application/json"))
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "RubricDraft")
    assert body["source"] == "json" and body["ai_drafted_questions"] == []
    assert body["draft"]["name"] == GENETICS["name"]
    assert [q["question"] for q in body["draft"]["questions"]] == [1, 2, 3, 4, 5]
    assert body["warnings"][-1] == "Total: 5 question(s), 20 marks."


@pytest.mark.parametrize("codec", ["utf-16", "utf-16-be"])
def test_a_utf16_json_rubric_file_is_parsed_like_utf8(client, no_ai, codec):
    """Notepad's "Unicode" (UTF-16 with a byte-order mark) used to be refused as binary (415)."""
    text = json.dumps(GENETICS)
    data = ("\ufeff" + text).encode(codec) if codec == "utf-16-be" else text.encode(codec)  # both with a BOM
    response = _parse(client, file=("genetics.json", data, "application/json"))
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "json" and response.json()["draft"]["name"] == GENETICS["name"]


def test_pasted_json_text_is_parsed_without_ai(client, no_ai):
    response = _parse(client, text=json.dumps(GENETICS), subject="Biology")
    assert response.status_code == 200 and response.json()["source"] == "json"


@pytest.mark.parametrize(
    "payload",
    ['{"name": "x", "questions": [', '{"name": "No questions", "questions": []}', '{"questions": "nope"}'],
)
def test_invalid_json_rubric_is_rejected(client, no_ai, payload):
    response = _parse(client, text=payload)
    assert response.status_code == 422 and response.json()["code"] == "invalid_rubric"


# --------------------------------------------------------------------------- #
# Input validation
# --------------------------------------------------------------------------- #
def test_empty_source_is_rejected(client, no_ai):
    for kwargs in ({}, {"text": "   "}, {"file": ("empty.txt", b"", "text/plain")}):
        response = _parse(client, **kwargs)
        assert response.status_code == 422 and response.json()["code"] == "empty_rubric_source", kwargs


def test_unsupported_signatures_are_rejected(client, no_ai, png_bytes):
    response = _parse(client, file=("key.png", png_bytes, "image/png"))  # a photo of a key: read by AI
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("notes.txt", "not a word document")
    response = _parse(client, file=("paper.zip", buffer.getvalue(), "application/zip"))
    assert response.status_code == 415 and response.json()["code"] == "unsupported_signature"


def test_corrupt_pdf_and_docx_are_rejected(client, no_ai):
    response = _parse(client, file=("paper.pdf", b"%PDF-1.7 garbage", "application/pdf"))
    assert response.status_code == 422 and response.json()["code"] == "corrupt_pdf"
    response = _parse(client, file=("paper.docx", b"PK\x03\x04garbage", "application/octet-stream"))
    assert response.status_code == 422 and response.json()["code"] == "corrupt_docx"


def test_ai_drafting_without_a_key_is_503(client, no_ai):
    response = _parse(client, text="Q1. Explain a test cross. (4 marks)")
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# AI drafting with a fake client
# --------------------------------------------------------------------------- #
def test_text_is_drafted_by_a_fake_client_and_the_call_is_recorded(client, db_session, fake_claude):
    response = _parse(client, text="Q1. Explain a test cross. (4 marks)\nQ2. Cause of Down syndrome? (2)",
                      subject="Biology", exam="NEET")
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "RubricDraft")
    assert body["source"] == "text" and body["ai_drafted_questions"] == [1]
    q1, q2 = body["draft"]["questions"]
    assert q1["effort_hours"] == 2.0  # 0 from the model -> illustrative matrix (Mendelian Inheritance)
    assert q2["effort_hours"] == 1.5
    assert any("drafted by AI" in w for w in body["warnings"])

    (request,) = fake_claude.calls
    text = request["messages"][0]["content"][0]["text"]
    assert text.startswith("<source_document>\nQ1. Explain a test cross.") and "Exam: NEET. Subject: Biology." in text

    from database import ModelInvocation

    (row,) = db_session.query(ModelInvocation).all()
    assert (row.purpose, row.status, row.submission_id, row.request_id) == ("rubric_parse", "ok", None, "req_rubric_1")
    assert row.input_tokens == 2400 and row.cost_inr is not None and row.cost_inr > 0


def test_docx_built_in_test_is_extracted_and_sent_as_text(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    seen: dict[str, Any] = {}

    def fake_parse_rubric(**kwargs):
        seen.update(kwargs)
        return ai.finalise_rubric_draft(DRAFT_REPLY)

    monkeypatch.setattr(ai, "parse_rubric", fake_parse_rubric)
    data = _docx(["NEET Mock 09", "Q1. Explain a test cross. (4 marks)"], table=[["Q2", "Cause of Down syndrome?", "2"]])
    response = _parse(client, file=("mock09.docx", data, "application/octet-stream"), subject="Biology")
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "docx"
    assert seen["text"] == "NEET Mock 09\nQ1. Explain a test cross. (4 marks)\nQ2 | Cause of Down syndrome? | 2"
    assert seen["pdf_bytes"] is None and seen["subject_hint"] == "Biology"


def test_text_pdf_is_sent_as_text_and_a_scan_as_a_document(client, fake_claude):
    paper = "NEET Mock 09 - Genetics question paper. " * 8 + "\nQ1. Explain a test cross. (4 marks)"
    response = _parse(client, file=("paper.pdf", _pdf(paper), "application/pdf"))
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "pdf"
    content = fake_claude.calls[-1]["messages"][0]["content"]
    assert content[0]["type"] == "text" and "Explain a test cross" in content[0]["text"]

    response = _parse(client, file=("scan.pdf", _pdf(""), "application/pdf"))
    assert response.status_code == 200, response.text
    content = fake_claude.calls[-1]["messages"][0]["content"]
    assert content[0]["type"] == "document" and content[0]["source"]["media_type"] == "application/pdf"


def test_ai_failures_map_to_502_with_the_error_code(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)

    def failing(**_kwargs):
        raise ai.AIServiceError("Claude declined the rubric drafting request.", code="refusal")

    monkeypatch.setattr(ai, "parse_rubric", failing)
    response = _parse(client, text="Q1 ...")
    assert response.status_code == 502 and response.json()["code"] == "refusal"


# --------------------------------------------------------------------------- #
# POST /api/rubrics
# --------------------------------------------------------------------------- #
def test_create_rubric_draft_approved_and_versioned(client):
    content = {**GENETICS, "name": "Genetics drill"}
    response = client.post("/api/rubrics", json={"content": content, "approved": False})
    assert response.status_code == 201, response.text
    draft = response.json()
    check_interface(draft, "Rubric")
    assert draft["status"] == "AUTHOR_DRAFT" and draft["version"].startswith("custom-")
    assert draft["total_marks"] == 20 and len(draft["rubric_hash"]) == 64 and draft["parent_id"] is None

    child = client.post(
        "/api/rubrics",
        json={"content": content, "parent_id": draft["id"], "change_note": "Faculty sign-off", "approved": True},
    ).json()
    assert child["status"] == "FACULTY_APPROVED" and child["parent_id"] == draft["id"]
    assert child["version"] == "v2" and child["change_note"] == "Faculty sign-off"
    assert {r["id"] for r in client.get("/api/rubrics").json()} >= {draft["id"], child["id"]}


def test_create_rubric_validation(client):
    response = client.post("/api/rubrics", json={"content": GENETICS, "parent_id": 999})
    assert response.status_code == 404 and response.json()["code"] == "unknown_rubric"
    bad = {**GENETICS, "questions": [{**GENETICS["questions"][0], "max_marks": 0}]}
    assert client.post("/api/rubrics", json={"content": bad}).status_code == 422


# --------------------------------------------------------------------------- #
# MCQ, Bloom and marking-scheme fields in AI drafts (FR-3.8, FR-3.9, FR-4.8)
# --------------------------------------------------------------------------- #
MCQ_DRAFT_REPLY = {
    "name": "NEET Mock 10",
    "subject": "Biology",
    "questions": [
        {"question": 1, "topic": "Cell Organelles", "subject": "Biology", "chapter": "Cell: The Unit of Life",
         "max_marks": 4, "prompt": "Site of aerobic respiration? (a) Nucleus (b) Mitochondria (c) Ribosome (d) Golgi",
         "expected_answer": "", "grading_criteria": [], "effort_hours": 1, "ai_drafted_answer": False,
         "question_type": "mcq", "options": ["Nucleus", "Mitochondria", "Ribosome", "Golgi"],
         "correct_option": "(b)", "bloom_level": "K1"},
        {"question": 2, "topic": "Cell Cycle", "subject": "Biology", "chapter": "Cell Cycle and Cell Division",
         "max_marks": 4, "prompt": "Crossing over occurs in (a) leptotene (b) zygotene (c) pachytene (d) diplotene",
         "expected_answer": "", "grading_criteria": [], "effort_hours": 1, "ai_drafted_answer": False,
         "question_type": "mcq", "options": ["leptotene", "zygotene", "pachytene", "diplotene"],
         "correct_option": None, "bloom_level": "K9"},
        {"question": 3, "topic": "Mendelian Inheritance", "subject": "Biology", "chapter": "Genetics",
         "max_marks": 4, "prompt": "Show a test cross.", "expected_answer": "Tt x tt gives 1 Tt : 1 tt.",
         "grading_criteria": ["1 mark: cross", "1 mark: gametes", "2 marks: 1:1 ratio"], "effort_hours": 2,
         "ai_drafted_answer": False, "question_type": "descriptive", "options": [], "correct_option": None,
         "bloom_level": "K3"},
    ],
}


def test_draft_keeps_mcq_bloom_and_scheme_fields():
    result = ai.finalise_rubric_draft(MCQ_DRAFT_REPLY)
    q1, q2, q3 = result["draft"]["questions"]
    assert (q1["question_type"], q1["options"], q1["correct_option"]) == (
        "mcq", ["Nucleus", "Mitochondria", "Ribosome", "Golgi"], "B"
    )
    assert (q1["bloom_level"], q1["bloom_source"]) == ("K1", "ai")
    assert "bloom_level" not in q2  # 'K9' is not a level: left for faculty (heuristic at read time)
    assert [(st["criterion"], st["marks"]) for st in q3["marking_scheme"]] == [
        ("cross", 1), ("gametes", 1), ("1:1 ratio", 2),
    ]
    assert (q3["bloom_level"], q3["bloom_source"], "question_type" in q3) == ("K3", "ai", False)
    assert result["draft"]["marking_policy"]["negative_marks"] == 1
    warnings = "\n".join(result["warnings"])
    assert "Q2 is an MCQ without an answer key - set correct_option." in warnings
    assert warnings.startswith("Fix before saving:")  # Q2 cannot be saved until the key is set
    assert ai.MCQ_POLICY_WARNING in warnings and "confirm with the academic lead" in warnings


def test_complete_mcq_draft_validates_and_saves(client, monkeypatch):
    reply = {**MCQ_DRAFT_REPLY, "questions": [MCQ_DRAFT_REPLY["questions"][0], MCQ_DRAFT_REPLY["questions"][2]]}
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    fake = FakeAnthropic(reply)
    monkeypatch.setattr(ai, "_anthropic_client", lambda settings: fake)
    body = _parse(client, text="Q1. Site of aerobic respiration? (a) ... Answer key: 1-b").json()
    check_interface(body, "RubricDraft")
    assert not any(w.startswith("Fix before saving") for w in body["warnings"])
    draft = body["draft"]
    assert draft["questions"][0]["expected_answer"] == "Option B"  # filled by the rubric validator
    schema = fake.calls[0]["output_config"]["format"]["schema"]
    wire = schema["$defs"]["_RubricQuestionWire"]
    assert {"question_type", "options", "correct_option", "bloom_level"} <= set(wire["required"])
    assert "do not solve it yourself" in fake.calls[0]["system"]
    saved = client.post("/api/rubrics", json={"content": draft, "approved": False})
    assert saved.status_code == 201, saved.text
    assert ai.RUBRIC_PARSE_PROMPT_VERSION == "rubric-v3"
