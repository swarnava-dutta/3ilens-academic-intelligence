"""Faculty OCR review (BRD FR-2.4, exception 'unreadable handwritten page'): the per-page gate,
GET /ocr, approve / correct (graded without a new OCR call) and rescan."""
from __future__ import annotations

import io
import json

import pytest
from PIL import Image


@pytest.fixture
def ai_ready(monkeypatch):
    import ai

    monkeypatch.setattr(ai, "ai_readiness", lambda: (True, []))


@pytest.fixture
def held(upload, fake_ai, client):
    """A sheet held for review by low OCR confidence (0.55 < 0.80)."""
    fake_ai.answer_confidence = 0.55
    sub = upload().json()
    assert client.get(f"/api/results/{sub['id']}").json()["status"] == "HUMAN_REVIEW_REQUIRED"
    fake_ai.answer_confidence = 0.93
    return sub


def other_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (90, 60), "white").save(buffer, "PNG")
    return buffer.getvalue()


def pending(client, submission_id: int) -> dict:
    return client.get(f"/api/results/{submission_id}").json()


# --------------------------------------------------------------------------- #
# Gate
# --------------------------------------------------------------------------- #
def test_low_confidence_page_is_flagged_and_held(held, client, fake_ai):
    body = pending(client, held["id"])
    assert body["submission"]["flagged_pages"] == [1]
    log = [e["message"] for e in body["processing_log"]]
    assert any(m == "Page 1 average 0.55 < 0.80 - held for faculty review." for m in log)
    assert any(m.startswith("Mapped 5/5 rubric questions") for m in log)
    assert fake_ai.calls["evaluation"] == 0


def test_one_bad_page_holds_the_whole_sheet(upload, fake_ai, client, monkeypatch, make_pdf):
    """Overall confidence passes, but page 2 is barely legible -> held (any page < threshold)."""
    import ai
    import preprocessing
    from ai_schemas import PageAssessment, PreparedPage

    original = fake_ai.run_ocr
    one_page = fake_ai.preprocess

    def preprocess(file_path, mime_type, artifact_dir, log, **kwargs):
        first = one_page(file_path, mime_type, artifact_dir, log, **kwargs)[0]
        return [first, PreparedPage(page_number=2, media_type="image/png", data=first.data, path=first.path)]

    def run_ocr(pages, rubric_content, **kwargs):
        assert len(pages) == 2
        result = original(pages, rubric_content, **kwargs)
        for index, answer in enumerate(result.answers):
            answer.pages = [1 if index < 3 else 2]
        result.page_assessments = [PageAssessment(page=1, legibility_confidence=0.95),
                                   PageAssessment(page=2, legibility_confidence=0.62)]
        return result

    monkeypatch.setattr(preprocessing, "preprocess_document", preprocess)
    monkeypatch.setattr(ai, "run_ocr", run_ocr)
    sub = upload(filename="two.pdf", content=make_pdf(2)).json()
    body = pending(client, sub["id"])
    assert body["status"] == "HUMAN_REVIEW_REQUIRED"
    assert body["submission"]["ocr_confidence"] == 0.93 and body["submission"]["flagged_pages"] == [2]
    assert "Page 2 below the 0.80 threshold" in body["detail"]
    review = client.get(f"/api/submissions/{sub['id']}/ocr").json()
    assert review["page_confidences"] == [{"page": 1, "confidence": 0.95}, {"page": 2, "confidence": 0.62}]
    assert review["answers"][4]["source_pages"] == [2]


def test_dropped_and_unattempted_questions_are_logged(upload, fake_ai, client, monkeypatch):
    import ai

    original = fake_ai.run_ocr

    def run_ocr(pages, rubric_content, **kwargs):
        result = original(pages, rubric_content, **kwargs)
        result.answers = [a for a in result.answers if a.question != 5]
        result.dropped_questions = [7]
        return result

    monkeypatch.setattr(ai, "run_ocr", run_ocr)
    sub = upload().json()
    log = [e["message"] for e in pending(client, sub["id"])["processing_log"]]
    assert "Mapped 4/5 rubric questions; Q5 not attempted; model returned Q7 (not in rubric) - discarded." in log


# --------------------------------------------------------------------------- #
# GET /ocr
# --------------------------------------------------------------------------- #
def test_get_ocr_returns_transcript_prompts_and_pages(held, client):
    review = client.get(f"/api/submissions/{held['id']}/ocr").json()
    assert review["status"] == "HUMAN_REVIEW_REQUIRED" and review["has_transcript"] is True
    assert review["threshold"] == 0.80 and review["flagged_pages"] == [1]
    assert [a["question"] for a in review["answers"]] == [1, 2, 3, 4, 5]
    first = review["answers"][0]
    assert first["topic"] == "Mendelian Inheritance" and first["prompt"].startswith("In pea plants")
    assert first["answer"].startswith("Student answer for") and first["confidence"] == 0.55
    assert len(review["pages"]) == 1 and review["pages"][0]["url"].endswith("/pages/1?variant=processed")
    assert review["reviews"] == []
    assert client.get("/api/submissions/987654/ocr").status_code == 404


def test_blurry_mock_has_no_transcript_but_shows_the_scan(upload, forbid_ai, client):
    sub = upload(filename="blurry_scan.png").json()
    review = client.get(f"/api/submissions/{sub['id']}/ocr").json()
    assert review["has_transcript"] is False
    assert [a["answer"] for a in review["answers"]] == [""] * 5
    assert all(a["confidence"] is None for a in review["answers"])
    assert len(review["pages"]) == 1 and review["pages"][0]["original_url"] is None  # rendered lazily
    assert forbid_ai == []


# --------------------------------------------------------------------------- #
# Approve / correct
# --------------------------------------------------------------------------- #
def test_correct_grades_without_a_new_ocr_call(held, client, fake_ai, ai_ready, tmp_path):
    response = client.post(f"/api/submissions/{held['id']}/review", json={
        "reviewer": "Dr. Rao", "action": "correct", "note": "Q2 and Q4 misread",
        "answers": [
            {"question": 2, "answer": "Incomplete dominance: snapdragon pink flowers; codominance: AB blood group."},
            {"question": 4, "answer": "Half the sons are colour-blind; daughters are carriers."},
            {"question": 1, "answer": "Student answer for Mendelian Inheritance."},  # unchanged
        ],
    })
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "PENDING"

    result = client.get(f"/api/results/{held['id']}")
    assert result.status_code == 200, result.text
    body = result.json()
    assert fake_ai.calls["ocr"] == 1 and fake_ai.calls["evaluation"] == 1  # one OCR call in total
    corrected = {q["question"]: q["corrected_by_faculty"] for q in body["question_evaluations"]}
    assert corrected == {1: False, 2: True, 3: False, 4: True, 5: False}
    assert body["question_evaluations"][1]["student_answer"].startswith("Incomplete dominance")
    assert body["extraction"]["corrected_by_faculty"] is True
    log = [e["message"] for e in body["processing_log"]]
    assert "Faculty corrected Q2, Q4 - cleared for grading by Dr. Rao." in log
    assert any(m.startswith("OCR reused - no vision call, Rs 0.00 (faculty-reviewed transcript") for m in log)
    # The cost of the result includes the OCR call made before the review.
    assert body["cost"]["ocr_inr"] > 0 and body["cost"]["evaluation_inr"] > 0

    reviewed = json.loads((tmp_path / "artifacts" / str(held["id"]) / "ocr_reviewed.json").read_text("utf-8"))
    sources = {a["question"]: (a["source"], a["confidence"]) for a in reviewed["answers"]}
    assert sources[2] == ("faculty", 1.0) and sources[1] == ("ocr", 0.55)
    assert reviewed["reviewed_by"] == "Dr. Rao" and reviewed["changed_questions"] == [2, 4]
    raw = json.loads((tmp_path / "artifacts" / str(held["id"]) / "ocr.json").read_text("utf-8"))
    assert all(a["source"] == "ocr" for a in raw["answers"])  # corrections never touch the OCR output

    reviews = client.get(f"/api/submissions/{held['id']}/ocr").json()["reviews"]
    assert [(r["reviewer"], r["action"], r["changed_questions"], r["note"]) for r in reviews] == [
        ("Dr. Rao", "correct", [2, 4], "Q2 and Q4 misread")
    ]


def test_approve_grades_the_transcript_as_is(held, client, fake_ai, ai_ready):
    response = client.post(f"/api/submissions/{held['id']}/review",
                           json={"reviewer": "Ms. Iyer", "action": "approve", "answers": []})
    assert response.status_code == 202, response.text
    body = client.get(f"/api/results/{held['id']}").json()
    assert body["submission"]["status"] == "COMPLETED" and body["total_score"] == 14
    assert fake_ai.calls["ocr"] == 1
    assert "Faculty approved the OCR transcript - cleared for grading by Ms. Iyer." in [
        e["message"] for e in body["processing_log"]
    ]


def test_blurry_mock_can_be_typed_in_and_graded_without_ocr(upload, fake_ai, client, ai_ready):
    sub = upload(filename="blurry_scan.png").json()
    assert pending(client, sub["id"])["status"] == "HUMAN_REVIEW_REQUIRED"
    response = client.post(f"/api/submissions/{sub['id']}/review", json={
        "reviewer": "Dr. Rao", "action": "correct",
        "answers": [{"question": q, "answer": f"Typed answer {q}"} for q in (1, 2, 3)],
    })
    assert response.status_code == 202, response.text
    body = client.get(f"/api/results/{sub['id']}").json()
    assert body["submission"]["status"] == "COMPLETED"
    assert fake_ai.calls == {"preprocess": 0, "ocr": 0, "evaluation": 1}
    graded = {q["question"]: (q["outcome"], q["corrected_by_faculty"]) for q in body["question_evaluations"]}
    assert graded[1] == ("FULL", True) and graded[4] == ("BLANK", False)


def test_approve_without_a_transcript_is_rejected(upload, fake_ai, client, ai_ready):
    sub = upload(filename="blurry_scan.png").json()
    response = client.post(f"/api/submissions/{sub['id']}/review",
                           json={"reviewer": "Dr. Rao", "action": "approve"})
    assert response.status_code == 422 and response.json()["code"] == "no_transcript"
    empty = client.post(f"/api/submissions/{sub['id']}/review",
                        json={"reviewer": "Dr. Rao", "action": "correct", "answers": []})
    assert empty.status_code == 422 and empty.json()["code"] == "no_transcript"


def test_review_validation(held, client, ai_ready):
    url = f"/api/submissions/{held['id']}/review"
    bad_q = client.post(url, json={"reviewer": "Dr. Rao", "action": "correct",
                                   "answers": [{"question": 9, "answer": "x"}]})
    assert bad_q.status_code == 422 and bad_q.json()["code"] == "invalid_question"
    dup = client.post(url, json={"reviewer": "Dr. Rao", "action": "correct",
                                 "answers": [{"question": 1, "answer": "a"}, {"question": 1, "answer": "b"}]})
    assert dup.status_code == 422 and dup.json()["code"] == "invalid_question"
    assert client.post(url, json={"reviewer": "", "action": "approve"}).status_code == 422
    assert client.post(url, json={"reviewer": "x" * 121, "action": "approve"}).status_code == 422
    assert client.post(url, json={"reviewer": "Dr. Rao", "action": "rescan"}).status_code == 422
    too_long = client.post(url, json={"reviewer": "Dr. Rao", "action": "correct",
                                      "answers": [{"question": 1, "answer": "a" * 10001}]})
    assert too_long.status_code == 422
    assert pending(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED"  # nothing changed


def test_review_only_for_held_sheets(upload, fake_ai, client, ai_ready):
    sub = upload().json()
    response = client.post(f"/api/submissions/{sub['id']}/review", json={"reviewer": "Dr. Rao", "action": "approve"})
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"


def test_review_needs_a_configured_ai(held, client):
    response = client.post(f"/api/submissions/{held['id']}/review", json={"reviewer": "Dr. Rao", "action": "approve"})
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    assert pending(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED"


# --------------------------------------------------------------------------- #
# Rescan
# --------------------------------------------------------------------------- #
def test_rescan_replaces_the_file_and_reruns_everything(held, client, fake_ai, tmp_path):
    new_bytes = other_png()
    response = client.post(f"/api/submissions/{held['id']}/rescan",
                           files={"file": ("rescan.png", new_bytes, "image/png")}, data={"reviewer": "Dr. Rao"})
    assert response.status_code == 202, response.text
    import hashlib

    assert response.json()["file_sha256"] == hashlib.sha256(new_bytes).hexdigest()
    assert response.json()["original_filename"] == "rescan.png" and response.json()["flagged_pages"] == []
    body = client.get(f"/api/results/{held['id']}").json()
    assert body["submission"]["status"] == "COMPLETED"
    assert fake_ai.calls["ocr"] == 2 and fake_ai.calls["preprocess"] == 2
    assert body["custody"]["sha256"] == hashlib.sha256(new_bytes).hexdigest()
    assert any(e["message"].startswith("Rescan received - full re-run") for e in body["processing_log"])
    stored = list((tmp_path / "uploads").iterdir())
    assert len(stored) == 1 and stored[0].read_bytes() == new_bytes  # the old scan was replaced
    reviews = client.get(f"/api/submissions/{held['id']}/ocr").json()["reviews"]
    assert [(r["action"], r["reviewer"]) for r in reviews] == [("rescan", "Dr. Rao")]


def test_rescan_validates_like_upload(held, client, tmp_path):
    url = f"/api/submissions/{held['id']}/rescan"
    bad = client.post(url, files={"file": ("x.txt", b"plain text", "text/plain")})
    assert bad.status_code == 415 and bad.json()["code"] == "unsupported_signature"
    missing = client.post(url)
    assert missing.status_code == 422 and missing.json()["code"] == "missing_file"
    assert pending(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED"
    assert len(list((tmp_path / "uploads").iterdir())) == 1


def test_rescan_only_for_held_or_failed_sheets(upload, fake_ai, client):
    sub = upload().json()
    response = client.post(f"/api/submissions/{sub['id']}/rescan", files={"file": ("x.png", other_png(), "image/png")})
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
