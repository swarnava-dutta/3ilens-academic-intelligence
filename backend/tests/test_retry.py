"""Worker failures (BRD exception 'worker job fails repeatedly'): transient retries with
exponential backoff, the dead-letter queue, operator re-drive, custody and concurrency."""
from __future__ import annotations

import json
import types
from pathlib import Path

import pytest


def transient(message: str = "The anthropic service is temporarily unavailable (HTTP 529).",
              code: str = "provider_unavailable"):
    import ai

    return ai.AIServiceError(message, transient=True, code=code)


@pytest.fixture
def flaky_ocr(fake_ai, monkeypatch):
    """ai.run_ocr fails transiently `failures` times (reporting an error usage like the real AI
    layer), then behaves like the fake."""
    import ai
    from ai_schemas import ModelUsage

    state = {"failures": 2, "calls": 0}

    def run_ocr(pages, rubric_content, **kwargs):
        state["calls"] += 1
        if state["calls"] <= state["failures"]:
            on_usage = kwargs.get("on_usage")
            if on_usage:
                on_usage(ModelUsage(purpose="ocr", provider="anthropic", model_requested="claude-sonnet-5-5",
                                    request_id=f"req_err_{state['calls']}", status="error",
                                    error_code="provider_unavailable", latency_ms=900))
            raise transient()
        return fake_ai.run_ocr(pages, rubric_content, **kwargs)

    monkeypatch.setattr(ai, "run_ocr", run_ocr)
    return state


def body_of(client, submission_id: int) -> dict:
    return client.get(f"/api/results/{submission_id}").json()


def dead_letter(tmp_path: Path, submission_id: int) -> dict:
    return json.loads((tmp_path / "artifacts" / str(submission_id) / "dead_letter.json").read_text(encoding="utf-8"))


def test_transient_errors_are_retried_then_complete(upload, flaky_ocr, fake_ai, client):
    sub = upload().json()
    body = body_of(client, sub["id"])
    assert body["submission"]["status"] == "COMPLETED"
    assert body["submission"]["attempts"] == 3 and body["submission"]["max_attempts"] == 3
    assert flaky_ocr["calls"] == 3 and fake_ai.calls["evaluation"] == 1
    log = [e["message"] for e in body["processing_log"]]
    assert any("Attempt 2/3 after 0 s backoff (provider_unavailable; request req_err_1)" in m for m in log)
    assert any("Attempt 3/3 after 0 s backoff (provider_unavailable; request req_err_2)" in m for m in log)
    statuses = [(i["purpose"], i["status"]) for i in client.get(f"/api/submissions/{sub['id']}/invocations").json()]
    assert statuses == [("ocr", "error"), ("ocr", "error"), ("ocr", "ok"), ("evaluation", "ok")]


def test_backoff_is_exponential_with_jitter(upload, flaky_ocr, client, monkeypatch):
    import pipeline

    slept: list[float] = []
    monkeypatch.setattr(pipeline, "time", types.SimpleNamespace(monotonic=pipeline.time.monotonic,
                                                                 sleep=slept.append))
    monkeypatch.setenv("RETRY_BACKOFF_BASE_SECONDS", "2")
    sub = upload().json()
    assert body_of(client, sub["id"])["submission"]["status"] == "COMPLETED"
    assert len(slept) == 2
    assert 4 <= slept[0] <= 5  # 2 x 2^(2-1) + jitter <= base/2
    assert 8 <= slept[1] <= 9  # 2 x 2^(3-1) + jitter


def test_retries_exhausted_go_to_the_dlq_with_every_attempt(upload, flaky_ocr, fake_ai, client, tmp_path):
    flaky_ocr["failures"] = 99
    sub = upload().json()
    body = body_of(client, sub["id"])
    assert body["status"] == "FAILED"
    submission = body["submission"]
    assert submission["attempts"] == 3 and submission["last_error_code"] == "provider_unavailable"
    assert "No approved fallback model configured - held (FR-3.10 fallback needs residency approval)" in body["detail"]
    assert "req_err_3" in body["detail"]  # the provider request id of the last failure
    assert flaky_ocr["calls"] == 3 and fake_ai.calls["evaluation"] == 0
    letter = dead_letter(tmp_path, sub["id"])
    assert letter["failed_step"] == "OCR & Parse" and letter["error_code"] == "provider_unavailable"
    assert [a["attempt"] for a in letter["attempts"]] == [1, 2, 3]
    assert all(a["transient"] for a in letter["attempts"]) and letter["mode"] == "full"
    assert letter["error_message"] == body["detail"]


def test_permanent_errors_skip_the_retries(upload, fake_ai, client, tmp_path):
    import ai

    fake_ai.ocr_error = ai.AIServiceError("Claude refused the OCR request.", code="refusal")
    sub = upload().json()
    body = body_of(client, sub["id"])
    assert body["status"] == "FAILED" and body["submission"]["attempts"] == 1
    assert body["submission"]["last_error_code"] == "refusal"
    assert fake_ai.calls["ocr"] == 1
    letter = dead_letter(tmp_path, sub["id"])
    assert len(letter["attempts"]) == 1 and letter["attempts"][0]["transient"] is False
    assert "No approved fallback" not in body["detail"]


@pytest.mark.parametrize(
    ("make_error", "code"),
    [
        (lambda: __import__("ai").AIConfigurationError("ANTHROPIC_API_KEY is not configured."), "ai_not_configured"),
        (lambda: __import__("preprocessing").PreprocessingError("bad page", "corrupt_pdf"), "corrupt_pdf"),
        (lambda: KeyError("x"), "internal_error"),
    ],
)
def test_error_codes_are_recorded(upload, fake_ai, client, make_error, code):
    if code == "corrupt_pdf":
        fake_ai.preprocess_error = make_error()
    else:
        fake_ai.ocr_error = make_error()
    sub = upload().json()
    assert body_of(client, sub["id"])["submission"]["last_error_code"] == code


def test_retry_redrives_a_failed_sheet(upload, fake_ai, client):
    import ai

    fake_ai.ocr_error = ai.AIServiceError("Refused.", code="refusal")
    sub = upload().json()
    assert body_of(client, sub["id"])["status"] == "FAILED"

    fake_ai.ocr_error = None
    response = client.post(f"/api/submissions/{sub['id']}/retry")
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "PENDING" and response.json()["error_message"] is None
    body = body_of(client, sub["id"])
    assert body["submission"]["status"] == "COMPLETED"
    assert body["submission"]["attempts"] == 2 and body["submission"]["last_error_code"] is None
    assert any("Operator re-drive from DLQ (attempt 2)" in e["message"] for e in body["processing_log"])
    assert fake_ai.calls["ocr"] == 2 and fake_ai.calls["preprocess"] == 2
    # The re-drive reuses the stored upload: custody is re-verified against the ingestion hash.
    assert body["custody"]["verified"] is True


def test_retry_only_for_failed_sheets(upload, fake_ai, client):
    sub = upload().json()
    response = client.post(f"/api/submissions/{sub['id']}/retry")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert client.post("/api/submissions/987654/retry").status_code == 404


def test_retry_needs_the_stored_upload(upload, fake_ai, client, tmp_path):
    import ai

    fake_ai.ocr_error = ai.AIServiceError("Refused.", code="refusal")
    sub = upload().json()
    for stored in (tmp_path / "uploads").iterdir():
        stored.unlink()
    response = client.post(f"/api/submissions/{sub['id']}/retry")
    assert response.status_code == 409 and response.json()["code"] == "upload_missing"


def test_interrupted_jobs_can_be_retried(upload, fake_ai, client, db_session):
    import pipeline
    from database import StudentSubmission

    sub = upload().json()
    row = db_session.get(StudentSubmission, sub["id"])
    row.status = "PROCESSING"
    db_session.commit()
    assert pipeline.recover_interrupted_jobs(db_session) == 1
    assert body_of(client, sub["id"])["submission"]["error_message"] == pipeline.INTERRUPTED_MESSAGE
    assert client.post(f"/api/submissions/{sub['id']}/retry").status_code == 202
    assert body_of(client, sub["id"])["submission"]["status"] == "COMPLETED"


def test_tampered_upload_fails_custody(upload, fake_ai, client, db_session, tmp_path):
    """The stored file changed after ingestion -> permanent failure, nothing sent to the AI."""
    import pipeline
    from database import StudentSubmission

    sub = upload().json()
    row = db_session.get(StudentSubmission, sub["id"])
    Path(row.file_path).write_bytes(Path(row.file_path).read_bytes() + b"tampered")
    row.status = "PENDING"
    db_session.commit()
    ocr_calls = fake_ai.calls["ocr"]

    pipeline.process_submission(sub["id"])
    body = body_of(client, sub["id"])
    assert body["status"] == "FAILED" and body["submission"]["last_error_code"] == "custody_mismatch"
    assert "Chain of custody failed" in body["detail"]
    assert fake_ai.calls["ocr"] == ocr_calls
    db_session.refresh(row)
    assert row.custody_verified is False


def test_custody_is_verified_and_logged(upload, fake_ai, client):
    sub = upload().json()
    body = body_of(client, sub["id"])
    assert body["custody"]["verified"] is True and body["custody"]["verified_at"]
    assert any(e["step"] == "Custody" and f"({sub['file_sha256'][:8]}...)" in e["message"]
               for e in body["processing_log"])


def test_worker_concurrency_semaphore_follows_the_setting(isolated_env, monkeypatch):
    import pipeline

    monkeypatch.setenv("WORKER_CONCURRENCY", "2")
    slots = pipeline.worker_slots()
    assert slots is pipeline.worker_slots()
    assert slots.acquire(blocking=False) and slots.acquire(blocking=False)
    assert not slots.acquire(blocking=False)
    slots.release()
    slots.release()
    monkeypatch.setenv("WORKER_CONCURRENCY", "4")
    assert pipeline.worker_slots() is not slots


def test_a_job_queued_twice_runs_once(upload, fake_ai, client):
    import pipeline

    sub = upload().json()
    pipeline.process_submission(sub["id"])  # already COMPLETED: skipped
    assert fake_ai.calls["ocr"] == 1


# --------------------------------------------------------------------------- #
# Re-evaluation in flight (the report must say "Re-grading", not show old marks)
# --------------------------------------------------------------------------- #
def test_results_answer_202_while_a_reevaluation_is_queued_and_running(upload, fake_ai, client, monkeypatch):
    import ai
    import database
    import main
    import pipeline

    monkeypatch.setattr(ai, "ai_readiness", lambda: (True, []))
    sub = upload().json()
    assert client.get(f"/api/results/{sub['id']}").status_code == 200

    queued: list[tuple] = []
    real_process = pipeline.process_submission
    monkeypatch.setattr(pipeline, "process_submission", lambda *args, **kwargs: queued.append((args, kwargs)))
    assert client.post(f"/api/submissions/{sub['id']}/reevaluate").status_code == 202
    waiting = client.get(f"/api/results/{sub['id']}")
    assert waiting.status_code == 202
    body = waiting.json()
    assert body["status"] == "PENDING" and body["submission"]["current_step"] == "Re-grading (queued)"
    assert body["submission"]["total_score"] is None  # the old marks are archived, not shown

    seen: list[tuple] = []
    real_evaluation = fake_ai.run_evaluation

    def evaluation(answers, rubric_content, **kwargs):
        with database.SessionLocal() as db:  # what GET /api/results returns mid-run
            response = main.get_result(sub["id"], db)
            row = db.get(database.StudentSubmission, sub["id"])
            seen.append((response.status_code, row.status, row.current_step))
        return real_evaluation(answers, rubric_content, **kwargs)

    monkeypatch.setattr(ai, "run_evaluation", evaluation)
    (args, kwargs), = queued
    real_process(*args, **kwargs)
    assert seen == [(202, "PROCESSING", "Re-grading")]
    done = client.get(f"/api/results/{sub['id']}")
    assert done.status_code == 200 and done.json()["submission"]["status"] == "COMPLETED"


def test_operator_redrive_names_the_attempt(upload, flaky_ocr, fake_ai, client, tmp_path, monkeypatch):
    """attempts keeps counting past max_attempts after a re-drive; the queue step, the log and
    run.json name the attempt so the UI can show "attempt N" instead of "4/3"."""
    import pipeline

    flaky_ocr["failures"] = 3  # every automatic attempt of the first run fails
    sub = upload().json()
    first = body_of(client, sub["id"])["submission"]
    assert first["status"] == "FAILED" and first["attempts"] == 3 and first["max_attempts"] == 3

    real_process = pipeline.process_submission
    queued: list[tuple] = []
    monkeypatch.setattr(pipeline, "process_submission", lambda *args, **kwargs: queued.append((args, kwargs)))
    response = client.post(f"/api/submissions/{sub['id']}/retry").json()
    assert response["current_step"] == "Queued - operator retry (attempt 4)" and response["attempts"] == 3
    (args, kwargs), = queued
    real_process(*args, **kwargs)
    body = body_of(client, sub["id"])
    assert body["submission"]["status"] == "COMPLETED" and body["submission"]["attempts"] == 4
    assert any("Operator re-drive from DLQ (attempt 4)" in e["message"] for e in body["processing_log"])
    run = json.loads((tmp_path / "artifacts" / str(sub["id"]) / "run.json").read_text(encoding="utf-8"))
    assert run["reason"] == "retry" and run["attempt"] == 4 and run["max_attempts_per_run"] == 3
