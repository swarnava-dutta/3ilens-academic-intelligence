"""OCR cache by SHA-256 (BRD FR-2.5): same bytes + rubric questions + OCR engine + prompt version
+ language hints -> no second vision call. AI is always faked."""
from __future__ import annotations

import io
import json

import pytest
from PIL import Image


@pytest.fixture
def cache_on(monkeypatch):
    monkeypatch.setenv("OCR_CACHE", "1")


def other_png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (70, 50), "white").save(buffer, "PNG")
    return buffer.getvalue()


def result(client, submission_id: int) -> dict:
    response = client.get(f"/api/results/{submission_id}")
    assert response.status_code == 200, response.text
    return response.json()


def messages(body: dict) -> list[str]:
    return [entry["message"] for entry in body["processing_log"]]


def test_same_bytes_twice_makes_one_vision_call(cache_on, upload, fake_ai, client):
    first = upload(student_name="First Copy").json()
    second = upload(student_name="Second Copy").json()

    assert fake_ai.calls["ocr"] == 1  # the second sheet re-used the cached transcript
    assert fake_ai.calls["preprocess"] == 2  # page images are still produced for the viewer
    assert fake_ai.calls["evaluation"] == 2

    one, two = result(client, first["id"]), result(client, second["id"])
    assert one["submission"]["ocr_cache_hit"] is False
    assert two["submission"]["ocr_cache_hit"] is True
    assert two["extraction"]["ocr_cache_hit"] is True and two["cost"]["ocr_cache_hit"] is True
    assert two["question_evaluations"] == one["question_evaluations"]
    log = messages(two)
    assert any("OCR cache hit - no vision call (Rs 0.00)" in m for m in log)
    assert any("reused 1x" in m for m in log)
    assert any(f"Same file bytes as submission #{first['id']}" in m and "OCR cache will be reused" in m for m in log)
    assert not any(m.startswith("AI call 1 (OCR)") for m in log)

    invocations = client.get(f"/api/submissions/{second['id']}/invocations").json()
    assert [(i["purpose"], i["status"]) for i in invocations] == [("ocr", "cache_hit"), ("evaluation", "ok")]
    hit = invocations[0]
    assert hit["cost_inr"] == 0 and hit["input_tokens"] == 0 and hit["provider"] == "cache"
    # The second student only paid for grading.
    assert two["cost"]["ocr_inr"] == 0 and two["cost"]["llm_cost_inr"] == two["cost"]["evaluation_inr"]
    assert two["cost"]["llm_cost_inr"] < one["cost"]["llm_cost_inr"]


def test_cache_hit_count_grows(cache_on, upload, fake_ai, client, db_session):
    from database import OcrCache

    for name in ("A One", "B Two", "C Three"):
        upload(student_name=name)
    assert fake_ai.calls["ocr"] == 1
    rows = db_session.query(OcrCache).all()
    assert len(rows) == 1 and rows[0].hit_count == 2 and rows[0].last_hit_at is not None
    import ai

    assert rows[0].prompt_version == ai.OCR_PROMPT_VERSION and rows[0].language_hints == ["en"]
    last = client.get("/api/submissions").json()[0]
    assert any("reused 2x" in m for m in messages(result(client, last["id"])))


def test_different_bytes_miss(cache_on, upload, fake_ai):
    upload()
    upload(content=other_png())
    assert fake_ai.calls["ocr"] == 2


def test_different_language_hints_miss(cache_on, upload, fake_ai):
    upload(language_hints="en")
    upload(language_hints="en,hi")
    assert fake_ai.calls["ocr"] == 2
    assert fake_ai.ocr_kwargs[1]["language_hints"] == ["en", "hi"]
    upload(language_hints="hi,en")  # same set, different order -> hit
    assert fake_ai.calls["ocr"] == 2


def test_different_rubric_questions_miss_but_mark_changes_hit(cache_on, upload, fake_ai, client):
    from tests.test_api import genetics_rubric

    upload()
    rubric = genetics_rubric()
    marks_only = {**rubric, "name": "Genetics (re-marked)",
                  "questions": [{**q, "max_marks": 5} for q in rubric["questions"]]}
    upload(rubric_json=json.dumps(marks_only))
    assert fake_ai.calls["ocr"] == 1  # OCR only sees question/topic/prompt: re-used

    fewer = {**rubric, "name": "Genetics (short)", "questions": rubric["questions"][:3]}
    upload(rubric_json=json.dumps(fewer))
    assert fake_ai.calls["ocr"] == 2  # different question list -> new OCR


def test_cache_disabled_reads_again(upload, fake_ai, client):
    first = upload().json()
    second = upload().json()
    assert fake_ai.calls["ocr"] == 2
    log = messages(result(client, second["id"]))
    assert any(f"Same file bytes as submission #{first['id']}" in m and "OCR cache is off" in m for m in log)
    assert not any("OCR cache hit" in m for m in log)


def test_held_sheets_and_errors_are_never_cached(cache_on, upload, fake_ai, client, db_session):
    import ai
    from database import OcrCache

    fake_ai.answer_confidence = 0.55  # held for faculty review
    assert client.get(f"/api/results/{upload().json()['id']}").json()["status"] == "HUMAN_REVIEW_REQUIRED"
    fake_ai.ocr_error = ai.AIServiceError("Refused.", code="refusal")
    assert client.get(f"/api/results/{upload().json()['id']}").json()["status"] == "FAILED"
    assert db_session.query(OcrCache).count() == 0

    fake_ai.ocr_error = None
    fake_ai.answer_confidence = 0.93
    upload()
    assert fake_ai.calls["ocr"] == 3  # nothing to re-use: read again, then cached
    assert db_session.query(OcrCache).count() == 1


def test_retry_of_a_failed_sheet_reuses_the_cache(cache_on, upload, fake_ai, client):
    """Grading failed after OCR succeeded: the operator re-drive needs no second vision call."""
    import ai

    upload(student_name="Cached Earlier")  # puts the transcript in the cache
    fake_ai.evaluation_error = ai.AIServiceError("Grading refused.", code="refusal")
    failed = upload(student_name="Failed Grading").json()
    assert client.get(f"/api/results/{failed['id']}").json()["status"] == "FAILED"
    fake_ai.evaluation_error = None
    assert client.post(f"/api/submissions/{failed['id']}/retry").status_code == 202
    assert fake_ai.calls["ocr"] == 1
    assert result(client, failed["id"])["submission"]["ocr_cache_hit"] is True


def test_cache_key_covers_engine_and_prompt_version(isolated_env, monkeypatch):
    import ai
    import pipeline
    from database import Batch, Rubric, StudentSubmission

    rubric = Rubric(id=1, name="R", version="v1", content={"questions": [{"question": 1, "topic": "T"}]},
                    total_marks=4)
    sub = StudentSubmission(id=1, file_hash="ab" * 32, batch=Batch(institution_id=7), rubric=rubric)
    key = pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"])
    assert key == pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"])
    assert key != pipeline.ocr_cache_key(sub, rubric, "openai", "gpt-4o", ["en"])
    assert key != pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-opus-5-5", ["en"])
    monkeypatch.setattr(ai, "OCR_PROMPT_VERSION", f"{ai.OCR_PROMPT_VERSION}-next")
    assert key != pipeline.ocr_cache_key(sub, rubric, "anthropic", "claude-sonnet-5-5", ["en"])
