"""Pipeline worker tests (steps 3-7): blurry mock, happy path, human review, DLQ failures,
startup recovery. AI and pre-processing are always faked - no network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

RESULT_KEYS = {
    "submission", "total_score", "total_marks", "overall_mastery", "ocr_confidence", "topic_mastery",
    "roi_recommendations", "strengths_gaps", "question_evaluations", "processing_log", "rubric",
    # contract v2 (urgency, narrative, controls, provenance, plan)
    "urgency", "urgency_reasons", "percentage", "summary", "executive_summary", "teaching_nudges", "confusions",
    "outcome_counts", "subject_rollup", "scoring_controls", "roi_basis", "report_meta", "release", "custody",
    "extraction", "cost", "latency", "history", "versions", "deliveries", "study_plan",
}
TOPIC_KEYS = {
    "topic", "subject", "score", "max_marks", "mastery", "weightage", "effort_hours",
    "chapter", "questions", "n", "full", "partial", "zero", "blank", "priority_rank",
}
PRIORITY_KEYS = {
    "topic", "subject", "roi", "weightage", "gain_potential", "effort_hours", "rationale", "mastery",
    "projected_gain_marks", "target_mastery", "gain_low", "gain_high", "trigger_questions", "intervention",
    "qualitative_rank", "calibrated",
}
QUESTION_KEYS = {
    "question", "topic", "estimated_marks", "max_marks", "evidence", "strengths", "gaps", "student_answer",
    "confidence", "outcome", "source_pages", "uncertain_words", "corrected_by_faculty",
}


def job_dir(tmp_path: Path, submission_id: int) -> Path:
    return tmp_path / "artifacts" / str(submission_id)


def pending_body(client, submission_id: int) -> dict:
    response = client.get(f"/api/results/{submission_id}")
    assert response.status_code == 202, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# Phase 4: the "blurry" human-review mock
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("filename", ["blurry_sheet.png", "Student_BLURRY_Scan.png"])
def test_blurry_upload_routes_to_human_review_without_any_ai_call(upload, forbid_ai, client, tmp_path, filename):
    sub = upload(filename=filename).json()
    body = pending_body(client, sub["id"])

    assert forbid_ai == []  # no pre-processing, no OCR, no evaluation, no SDK client
    assert body["status"] == "HUMAN_REVIEW_REQUIRED"
    assert body["submission"]["ocr_confidence"] == 0.65
    assert body["submission"]["current_step"] == "Human review"
    assert "0.65" in body["detail"] and "0.80" in body["detail"]
    assert body["submission"]["total_score"] is None
    assert not job_dir(tmp_path, sub["id"]).exists() or not any(job_dir(tmp_path, sub["id"]).glob("*.json"))

    # The mock stops before pre-processing: the audit trail must not claim that step ran.
    steps = [entry["step"] for entry in body["processing_log"]]
    assert steps == ["Ingestion", "Queue", "Queue", "Human review"]
    assert "Pre-processing" not in steps
    review = body["processing_log"][-1]["message"]
    assert "blurry" in review and "no AI call" in review and "0.65" in review and "0.80" in review


def test_blurry_mock_works_with_no_api_keys(upload, client, no_network_clients):
    sub = upload(filename="blurry.png").json()
    assert pending_body(client, sub["id"])["status"] == "HUMAN_REVIEW_REQUIRED"
    assert no_network_clients == []


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #
def test_happy_path_completes_and_returns_contract_shaped_result(upload, fake_ai, client, tmp_path):
    sub = upload(student_name="Ananya Iyer").json()
    assert sub["status"] == "PENDING"

    response = client.get(f"/api/results/{sub['id']}")
    assert response.status_code == 200, response.text
    result = response.json()
    assert fake_ai.calls == {"preprocess": 1, "ocr": 1, "evaluation": 1}

    assert set(result) == RESULT_KEYS
    assert result["submission"]["status"] == "COMPLETED"
    assert result["submission"]["current_step"] == "Completed"
    assert result["submission"]["error_message"] is None
    assert result["submission"]["total_score"] == 14
    assert result["total_score"] == 14
    assert result["total_marks"] == 20
    assert result["overall_mastery"] == 70
    assert result["ocr_confidence"] == pytest.approx(0.93)
    from hashing import rubric_hash
    from seed import load_genetics_rubric

    assert result["rubric"] == {
        "id": sub["rubric_id"], "version": "v1", "name": "Biology - Genetics", "total_marks": 20,
        "status": "AUTHOR_DRAFT", "rubric_hash": rubric_hash(load_genetics_rubric()),
    }
    assert result["urgency"] == "on_track" and result["percentage"] == 70
    assert result["custody"]["sha256"] == sub["file_sha256"] and result["custody"]["size_bytes"] > 0
    assert result["cost"]["synthetic"] is False
    assert [q["outcome"] for q in result["question_evaluations"]] == ["FULL", "PARTIAL", "PARTIAL", "PARTIAL",
                                                                      "PARTIAL"]

    assert len(result["topic_mastery"]) == 5
    assert all(set(t) == TOPIC_KEYS for t in result["topic_mastery"])
    assert all(0 <= t["mastery"] <= 100 for t in result["topic_mastery"])
    priorities = result["roi_recommendations"]
    assert 0 < len(priorities) <= 5
    assert all(set(p) == PRIORITY_KEYS for p in priorities)
    assert [p["roi"] for p in priorities] == sorted((p["roi"] for p in priorities), reverse=True)
    assert set(result["strengths_gaps"]) == {"strengths", "gaps"}
    assert result["strengths_gaps"]["strengths"]
    assert [q["question"] for q in result["question_evaluations"]] == [1, 2, 3, 4, 5]
    assert all(set(q) == QUESTION_KEYS for q in result["question_evaluations"])
    assert result["question_evaluations"][0]["student_answer"].startswith("Student answer for")

    log = result["processing_log"]
    assert all(set(entry) == {"step", "message", "timestamp"} for entry in log)
    steps = [entry["step"] for entry in log]
    for expected in ["Ingestion", "Queue", "Pre-processing", "OCR & Parse", "Rubric Evaluation",
                     "Insights & ROI", "Persistence"]:
        assert expected in steps
    assert any("Simulating Deskew and 300 DPI Contrast Enhancement." in e["message"] for e in log)
    assert all(e["timestamp"].endswith("Z") for e in log)

    artifacts = job_dir(tmp_path, sub["id"])
    for name in ("ocr.json", "evaluation.json", "report.json"):
        assert (artifacts / name).is_file()
    assert json.loads((artifacts / "report.json").read_text(encoding="utf-8"))["total_score"] == 14
    assert not (artifacts / "dead_letter.json").exists()
    assert "file_path" not in response.text


def test_low_ocr_confidence_routes_to_human_review_and_skips_evaluation(upload, fake_ai, client, tmp_path):
    fake_ai.answer_confidence = 0.55
    sub = upload().json()
    body = pending_body(client, sub["id"])

    assert body["status"] == "HUMAN_REVIEW_REQUIRED"
    assert body["submission"]["ocr_confidence"] == 0.55
    assert "0.55" in body["detail"] and "0.80" in body["detail"]
    assert fake_ai.calls["ocr"] == 1 and fake_ai.calls["evaluation"] == 0
    assert (job_dir(tmp_path, sub["id"]) / "ocr.json").is_file()


# --------------------------------------------------------------------------- #
# Failures -> FAILED (simulated DLQ)
# --------------------------------------------------------------------------- #
def assert_failed(client, tmp_path, submission_id: int, *, contains: str, failed_step: str) -> dict:
    body = pending_body(client, submission_id)
    assert body["status"] == "FAILED"
    assert body["submission"]["current_step"] == "Failed"
    message = body["submission"]["error_message"]
    assert contains in message
    assert body["detail"] == message
    assert "Traceback" not in message
    dead_letter = json.loads((job_dir(tmp_path, submission_id) / "dead_letter.json").read_text(encoding="utf-8"))
    assert dead_letter["failed_step"] == failed_step
    assert dead_letter["error_message"] == message
    return body


def test_ai_service_error_marks_failed(upload, fake_ai, client, tmp_path):
    import ai

    fake_ai.ocr_error = ai.AIServiceError("The vision model returned invalid JSON for the OCR step.")
    sub = upload().json()
    body = assert_failed(client, tmp_path, sub["id"], contains="invalid JSON", failed_step="OCR & Parse")
    assert fake_ai.calls["evaluation"] == 0
    assert body["submission"]["total_score"] is None
    assert body["submission"]["ocr_confidence"] is None


def test_invalid_evaluation_json_marks_failed(upload, fake_ai, client, tmp_path):
    import ai

    fake_ai.evaluation_error = ai.AIServiceError("Claude returned invalid JSON for the evaluation step.")
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="invalid JSON", failed_step="Rubric Evaluation")


def test_missing_api_key_marks_failed_with_configuration_message(upload, fake_ai, client, tmp_path):
    import ai

    fake_ai.ocr_error = ai.AIConfigurationError("ANTHROPIC_API_KEY is not configured.")
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="ANTHROPIC_API_KEY", failed_step="OCR & Parse")


def test_real_ai_layer_without_keys_fails_cleanly(upload, monkeypatch, client, tmp_path, no_network_clients):
    """Only pre-processing is faked: the real ai.run_ocr must refuse (no key) before any SDK call."""
    import preprocessing
    from tests.conftest import FakeAI

    monkeypatch.setattr(preprocessing, "preprocess_document", FakeAI().preprocess)
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="ANTHROPIC_API_KEY", failed_step="OCR & Parse")
    assert no_network_clients == []


def test_preprocessing_error_marks_failed(upload, fake_ai, client, tmp_path):
    import preprocessing

    fake_ai.preprocess_error = preprocessing.PreprocessingError("the PDF could not be rasterised.")
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="Pre-processing failed", failed_step="Pre-processing")
    assert fake_ai.calls["ocr"] == 0


def test_evaluation_inconsistent_with_rubric_marks_failed(upload, fake_ai, client, tmp_path):
    fake_ai.extra_grade_question = 99  # graded a question that is not in the rubric
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="inconsistent with the rubric", failed_step="Insights & ROI")


def test_schema_validation_error_marks_failed(upload, fake_ai, client, tmp_path):
    from ai_schemas import OcrAnswer

    try:
        OcrAnswer.model_validate({"question": "one"})
    except Exception as exc:  # noqa: BLE001 - build a real pydantic ValidationError
        fake_ai.evaluation_error = exc
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="expected JSON schema", failed_step="Rubric Evaluation")


def test_unexpected_error_uses_generic_message(upload, fake_ai, client, tmp_path):
    fake_ai.ocr_error = KeyError("internal detail /secret/path")
    sub = upload().json()
    body = assert_failed(client, tmp_path, sub["id"], contains="Unexpected processing error", failed_step="OCR & Parse")
    assert "/secret/path" not in body["submission"]["error_message"]


def test_api_keys_are_scrubbed_from_error_messages(upload, fake_ai, client, tmp_path, monkeypatch):
    import ai

    secret = "sk-ant-api03-very-secret-value"
    monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
    fake_ai.ocr_error = ai.AIServiceError(f"Authentication failed for key {secret}")
    sub = upload().json()
    assert_failed(client, tmp_path, sub["id"], contains="[redacted]", failed_step="OCR & Parse")
    assert secret not in client.get("/api/submissions").text
    assert secret not in (job_dir(tmp_path, sub["id"]) / "dead_letter.json").read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# Worker robustness & startup recovery
# --------------------------------------------------------------------------- #
def test_process_submission_never_raises(client):
    import pipeline

    pipeline.process_submission(987654)  # unknown id: logged, not raised


def test_process_submission_skips_jobs_that_are_not_pending(upload, fake_ai, client):
    import pipeline

    sub = upload().json()
    assert fake_ai.calls["ocr"] == 1
    pipeline.process_submission(sub["id"])  # already COMPLETED
    assert fake_ai.calls["ocr"] == 1
    assert client.get(f"/api/results/{sub['id']}").status_code == 200


def test_interrupted_jobs_are_failed_on_startup(client, db_session):
    from fastapi.testclient import TestClient

    import main
    from database import StudentSubmission

    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    batch_id = client.get("/api/health").json()["batch"]["id"]
    ids = []
    for status in ("PENDING", "PROCESSING"):
        sub = StudentSubmission(
            student_name=f"{status} Student", original_filename="x.png", mime_type="image/png", status=status,
            current_step="OCR & answer structuring", processing_log=[], batch_id=batch_id, rubric_id=rubric_id,
        )
        db_session.add(sub)
        db_session.commit()
        ids.append(sub.id)

    with TestClient(main.app) as restarted:  # a new lifespan = server restart
        for submission_id in ids:
            body = restarted.get(f"/api/results/{submission_id}").json()
            assert body["status"] == "FAILED"
            assert body["submission"]["error_message"] == "Interrupted by server restart - use Retry to re-run."
            assert body["submission"]["last_error_code"] == "interrupted"
