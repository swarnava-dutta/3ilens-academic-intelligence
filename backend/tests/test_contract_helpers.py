"""Unit tests for the shared helper modules: errors, hashing, costing, docx_reader,
rubric_store, results_store and the REAL rules in analytics / provenance."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import date
from pathlib import Path

import pytest


# --------------------------------------------------------------------------- #
# hashing
# --------------------------------------------------------------------------- #
def test_hashing_helpers(tmp_path: Path):
    import hashlib

    import hashing

    data = b"answer sheet bytes" * 1000
    assert hashing.sha256_bytes(data) == hashlib.sha256(data).hexdigest()
    path = tmp_path / "f.bin"
    path.write_bytes(data)
    assert hashing.sha256_file(path, chunk=7) == hashing.sha256_bytes(data)
    assert hashing.sha256_json({"b": 1, "a": "é"}) == hashing.sha256_json({"a": "é", "b": 1})
    assert hashing.canonical_json({"b": 1, "a": "é"}) == '{"a":"é","b":1}'

    rubric = {"name": "R", "questions": [{"question": 1, "topic": "T", "prompt": "P", "max_marks": 4}]}
    edited_marks = {"name": "R", "questions": [{"question": 1, "topic": "T", "prompt": "P", "max_marks": 5}]}
    assert hashing.rubric_hash(rubric) != hashing.rubric_hash(edited_marks)
    assert hashing.rubric_questions_hash(rubric) == hashing.rubric_questions_hash(edited_marks)

    assert hashing.student_ref_for("  Aarav  Sharma ") == "aarav-sharma"
    assert hashing.student_ref_for("Aarav Sharma", " ab/12 ") == "AB/12"
    assert hashing.student_ref_for("Ananya_Iyer!!") == "ananya-iyer"
    assert hashing.student_ref_for("अनन्या") != "student"  # unicode letters are kept
    assert hashing.student_ref_for("***") == "student"


# --------------------------------------------------------------------------- #
# costing
# --------------------------------------------------------------------------- #
def test_costing_prices_and_prefix_match(monkeypatch):
    import costing
    from ai_schemas import ModelUsage

    usage = ModelUsage(purpose="evaluation", provider="anthropic", model_requested="claude-sonnet-5-5",
                       input_tokens=1_000_000, output_tokens=100_000, cache_creation_input_tokens=200_000,
                       cache_read_input_tokens=1_000_000)
    # 1M x $2 + 0.1M x $10 + 0.2M x $2.50 + 1M x $0.10
    assert costing.cost_usd("claude-sonnet-5-5", usage) == pytest.approx(2.0 + 1.0 + 0.5 + 0.1)
    assert costing.cost_usd("claude-sonnet-5-5-20261101", usage) == pytest.approx(3.6)
    assert costing.prices_for("claude-sonnet-5")["cache_read"] == 0.20
    assert costing.cost_usd("mystery-model", usage) is None
    monkeypatch.setenv("USD_INR", "85")
    assert costing.to_inr(1.0) == 85.0 and costing.to_inr(None) is None
    monkeypatch.setenv("LLM_PRICING_JSON", json.dumps({"claude-sonnet-5-5": {"input": 3}}))
    assert costing.prices_for("claude-sonnet-5-5")["input"] == 3.0
    assert costing.prices_for("claude-sonnet-5-5")["output"] == 10.0


# --------------------------------------------------------------------------- #
# docx_reader
# --------------------------------------------------------------------------- #
CT_DOCX = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="png" ContentType="image/png"/>'
    '<Override PartName="/word/document.xml" ContentType="{main}"/>'
    "</Types>"
)
MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
MACRO_MAIN = "application/vnd.ms-word.document.macroEnabled.main+xml"
DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>'
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Q1 Test cross</w:t></w:r></w:p>'
    "<w:p><w:r><w:t>Tt x tt gives </w:t></w:r><w:r><w:t>1:1 &lt;ratio&gt;</w:t></w:r></w:p>"
    '<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>'
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Tt</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>tt</w:t></w:r></w:p>"
    "</w:tc></w:tr></w:tbl>"
    "</w:body></w:document>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
    'Target="media/image1.png"/></Relationships>'
)


def make_docx(main_type: str = MAIN, extra: dict[str, bytes] | None = None, document: str = DOCUMENT) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", CT_DOCX.format(main=main_type))
        archive.writestr("word/document.xml", document)
        archive.writestr("word/_rels/document.xml.rels", RELS)
        archive.writestr("word/media/image1.png", b"\x89PNG\r\n\x1a\nfake")
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return buffer.getvalue()


def test_docx_reader_validates_and_extracts():
    import docx_reader

    data = make_docx()
    docx_reader.validate_docx(data)
    # The image-only paragraph becomes a blank line.
    assert docx_reader.docx_text(data) == "Q1 Test cross\nTt x tt gives 1:1 <ratio>\n\nTt | tt"
    html, images = docx_reader.docx_to_html(data)
    assert "<h2>Q1 Test cross</h2>" in html and "1:1 &lt;ratio&gt;" in html
    assert '<img src="image1.png"/>' in html and "<td><p>Tt</p></td>" in html
    assert list(images) == ["image1.png"] and images["image1.png"].startswith(b"\x89PNG")


@pytest.mark.parametrize(
    "data, code",
    [
        (b"PK\x03\x04 not really a zip", "corrupt_docx"),
        (make_docx(main_type=MACRO_MAIN), "macro_docx"),
        (make_docx(extra={"word/vbaProject.bin": b"\x00"}), "macro_docx"),
        (make_docx(main_type="application/xml"), "corrupt_docx"),
        (make_docx(document="<w:document"), "corrupt_docx"),
    ],
)
def test_docx_reader_rejections(data, code):
    import docx_reader

    with pytest.raises(docx_reader.DocxError) as exc:
        docx_reader.validate_docx(data)
    assert exc.value.code == code


def test_docx_reader_size_caps():
    import docx_reader

    with pytest.raises(docx_reader.DocxError) as exc:
        docx_reader.validate_docx(make_docx(), max_entries=2)
    assert exc.value.code == "docx_too_large"
    with pytest.raises(docx_reader.DocxError) as exc:
        docx_reader.validate_docx(make_docx(), max_uncompressed=100)
    assert exc.value.code == "docx_too_large"


# --------------------------------------------------------------------------- #
# analytics (REAL rules)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "pct, masteries, expected",
    [
        (85.0, [90, 80], "on_track"),
        (66.4, [70, 60], "needs_attention"),
        (53.3, [60, 50], "at_risk"),
        (77.5, [30, 90, 80], "on_track"),  # one weak topic does not shift
        (72.0, [30, 35, 90], "needs_attention"),  # two topics < 40% -> one level worse
        (60.0, [30, 35], "at_risk"),
        (40.0, [10, 20, 30], "at_risk"),  # capped
        (70.0, [], "on_track"),
        (55.0, [], "needs_attention"),
    ],
)
def test_classify_urgency(pct, masteries, expected):
    import analytics

    urgency, reasons = analytics.classify_urgency(pct, [{"topic": f"T{i}", "mastery": m} for i, m in enumerate(masteries)])
    assert urgency == expected
    assert reasons and f"{pct:g}%" in reasons[0]


def test_days_to_exam_and_strategy_mode(monkeypatch):
    import analytics
    from database import Batch

    monkeypatch.setenv("NEET_EXAM_DATE", "2027-05-02")
    assumed = Batch(name="B", exam_type="M", institution_id=1)
    assert analytics.exam_date_for(assumed) == ("2027-05-02", True)
    assert analytics.days_to_exam(assumed, today=date(2027, 4, 2)) == 30
    assert analytics.days_to_exam(assumed, today=date(2027, 5, 2)) == 0
    assert analytics.days_to_exam(assumed, today=date(2027, 5, 3)) is None
    explicit = Batch(name="B", exam_type="M", institution_id=1, exam_date="2027-01-31")
    assert analytics.exam_date_for(explicit) == ("2027-01-31", False)
    assert analytics.days_to_exam(explicit, today=date(2027, 1, 1)) == 30
    assert [analytics.strategy_mode_for(d) for d in (None, 120, 90, 89, 30, 29, 7, 6, 0)] == [
        None, "broad", "broad", "focused", "focused", "revision", "revision", "consolidation", "consolidation",
    ]


# --------------------------------------------------------------------------- #
# rubric_store / provenance with a database
# --------------------------------------------------------------------------- #
def test_rubric_store_versions_and_compatibility(client, db_session):
    import rubric_store
    import seed
    from schemas import RubricContentIn

    content = seed.load_genetics_rubric()
    parent = seed.get_default_rubric(db_session)
    edited = json.loads(json.dumps(content))
    edited["questions"][0]["max_marks"] = 5
    edited["questions"].append({**edited["questions"][1], "question": 6, "topic": "New Topic"})
    child = rubric_store.create_rubric(
        db_session, RubricContentIn.model_validate(edited), parent=parent, change_note=" Q1 worth 5 "
    )
    assert child.version == "v2" and child.parent_id == parent.id and child.change_note == "Q1 worth 5"
    assert child.total_marks == 25 and len(child.rubric_hash) == 64 and child.status == "AUTHOR_DRAFT"
    grandchild = rubric_store.create_rubric(db_session, RubricContentIn.model_validate(edited), parent=child,
                                            status="FACULTY_APPROVED")
    assert grandchild.version == "v3" and grandchild.status == "FACULTY_APPROVED"
    custom = rubric_store.create_rubric(db_session, RubricContentIn.model_validate(content))
    assert custom.version == "custom-1"

    compat = rubric_store.compatibility(content, edited)
    assert compat == {"reusable": False, "added": [6], "removed": [], "changed": [1]}
    assert rubric_store.compatibility(content, content)["reusable"] is True


def test_record_invocation_prices_calls(client, db_session, upload, fake_ai):
    import provenance
    from ai_schemas import ModelUsage
    from database import StudentSubmission

    sub_id = upload().json()["id"]
    sub = db_session.get(StudentSubmission, sub_id)
    usage = ModelUsage(purpose="ocr", provider="anthropic", model_requested="claude-sonnet-5-5",
                       model_served="claude-sonnet-5-5", input_tokens=10_000, output_tokens=1_000, image_count=2)
    row = provenance.record_invocation(db_session, usage=usage, submission=sub, commit=True)
    assert row.id and row.submission_id == sub_id and row.batch_id == sub.batch_id
    assert row.institution_id == sub.batch.institution_id
    assert row.cost_usd == pytest.approx((10_000 * 2 + 1_000 * 10) / 1_000_000)
    assert row.cost_inr == pytest.approx(row.cost_usd * 85, abs=1e-4)
    hit = provenance.record_invocation(
        db_session, usage=ModelUsage(purpose="ocr", provider="cache", model_requested="claude-sonnet-5-5",
                                     status="cache_hit"), submission=None)
    assert hit.cost_usd == 0.0 and hit.cost_inr == 0.0 and hit.submission_id is None
    assert provenance.OCR_CACHE_HIT_LABEL == "OCR cache hit - no vision call (Rs 0.00)"


def test_fake_ai_reports_usage_through_on_usage(fake_ai):
    from ai_schemas import PreparedPage

    seen = []
    pages = [PreparedPage(page_number=1, media_type="image/png", data=b"x", path=Path("p.png"))]
    rubric = {"questions": [{"question": 1, "topic": "T"}]}
    ocr = fake_ai.run_ocr(pages, rubric, language_hints=["en", "hi"], on_usage=seen.append)
    fake_ai.run_evaluation(ocr.answers, rubric, on_usage=seen.append, purpose="consistency")
    assert [u.purpose for u in seen] == ["ocr", "consistency"]
    assert seen[0].image_count == 1 and seen[0].input_tokens > 0 and ocr.language_hints == ["en", "hi"]


def test_api_error_handler_returns_detail_and_code():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from errors import ApiError, install_error_handlers

    app = FastAPI()
    install_error_handlers(app)

    @app.get("/boom")
    def boom():
        raise ApiError(409, "Only FAILED submissions can be retried.", "invalid_state")

    response = TestClient(app).get("/boom")
    assert response.status_code == 409
    assert response.json() == {"detail": "Only FAILED submissions can be retried.", "code": "invalid_state"}
