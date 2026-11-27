"""Faculty re-run of a held or failed sheet (POST /api/submissions/{id}/rerun): a full run from the
stored upload, optionally against another rubric (the sheet was uploaded with the wrong one)."""
from __future__ import annotations

import json

import pytest

from seed import load_genetics_rubric


@pytest.fixture
def held(upload, fake_ai, client):
    """A sheet held for review by low OCR confidence (0.55 < 0.80) on the Genetics rubric."""
    fake_ai.answer_confidence = 0.55
    sub = upload().json()
    assert client.get(f"/api/results/{sub['id']}").json()["status"] == "HUMAN_REVIEW_REQUIRED"
    fake_ai.answer_confidence = 0.93
    return sub


@pytest.fixture
def queued(monkeypatch):
    """Records pipeline.process_submission calls instead of running them."""
    import pipeline

    calls: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(pipeline, "process_submission", lambda *args, **kwargs: calls.append((args, kwargs)))
    return calls


def other_rubric(client) -> dict:
    """Genetics without Q5, under another name: 4 questions."""
    content = load_genetics_rubric()
    content = {**content, "name": "Biology - Genetics Section B",
               "questions": [q for q in content["questions"] if q["question"] != 5]}
    response = client.post("/api/rubrics", json={"content": content, "approved": False})
    assert response.status_code == 201, response.text
    return response.json()


def results(client, submission_id: int) -> dict:
    return client.get(f"/api/results/{submission_id}").json()


def log_of(client, submission_id: int) -> list[str]:
    return [e["message"] for e in results(client, submission_id)["processing_log"]]


def set_fields(db_session, submission_id: int, **fields) -> None:
    from database import StudentSubmission

    row = db_session.get(StudentSubmission, submission_id)
    for name, value in fields.items():
        setattr(row, name, value)
    db_session.commit()


# --------------------------------------------------------------------------- #
# Happy paths
# --------------------------------------------------------------------------- #
def test_held_sheet_is_rerun_with_another_rubric(held, client, ai_ready, queued, db_session):
    import pipeline

    set_fields(db_session, held["id"], review_reason="paper_mismatch")
    target = other_rubric(client)
    response = client.post(f"/api/submissions/{held['id']}/rerun",
                           json={"rubric_id": target["id"], "reviewer": "  Dr.   Rao "})
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "PENDING" and body["current_step"] == "Queued - re-run"
    assert body["rubric_id"] == target["id"]
    assert body["error_message"] is None and body["last_error_code"] is None
    assert body.get("review_reason") is None
    assert body["flagged_pages"] == [] and body["ocr_confidence"] is None
    assert queued == [((held["id"],), {"mode": pipeline.MODE_FULL, "reason": "rerun"})]
    assert (
        f"Faculty re-run with rubric 'Biology - Genetics Section B' ({target['version']}) by Dr. Rao - full re-run "
        "from the stored upload (was 'Biology - Genetics' (v1))."
    ) in log_of(client, held["id"])
    from database import StudentSubmission

    db_session.expire_all()
    assert db_session.get(StudentSubmission, held["id"]).review_reason is None


def test_rerun_runs_ocr_again_and_grades_against_the_new_rubric(held, client, fake_ai, ai_ready):
    target = other_rubric(client)
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric_id": target["id"]})
    assert response.status_code == 202, response.text
    body = results(client, held["id"])
    assert body["submission"]["status"] == "COMPLETED", body.get("detail")
    assert fake_ai.calls["ocr"] == 2 and fake_ai.calls["preprocess"] == 2 and fake_ai.calls["evaluation"] == 1
    assert [q["question"] for q in body["question_evaluations"]] == [1, 2, 3, 4]
    assert body["submission"]["rubric_id"] == target["id"]
    log = [e["message"] for e in body["processing_log"]]
    assert any(m.startswith(f"Faculty re-run with rubric 'Biology - Genetics Section B' ({target['version']}) by "
                            "Faculty reviewer") for m in log)


def test_rerun_without_a_body_keeps_the_rubric(held, client, ai_ready, queued):
    response = client.post(f"/api/submissions/{held['id']}/rerun")
    assert response.status_code == 202, response.text
    assert response.json()["rubric_id"] == held["rubric_id"]
    assert (
        "Faculty re-run with rubric 'Biology - Genetics' (v1) by Faculty reviewer - full re-run from the stored "
        "upload (same rubric)."
    ) in log_of(client, held["id"])
    assert len(queued) == 1 and queued[0][1]["reason"] == "rerun"


def test_failed_sheet_rerun_drops_the_stale_reviewed_transcript(held, client, fake_ai, ai_ready, tmp_path):
    """Approved, then grading failed: the reviewed transcript belongs to that run (and rubric). A re-run
    removes it, so the next hold (or grade) uses the fresh OCR."""
    import ai

    fake_ai.evaluation_error = ai.AIServiceError("Refused.", code="refusal")
    approve = client.post(f"/api/submissions/{held['id']}/review",
                          json={"reviewer": "Ms. Iyer", "action": "approve"})
    assert approve.status_code == 202, approve.text
    assert results(client, held["id"])["status"] == "FAILED"
    job_dir = tmp_path / "artifacts" / str(held["id"])
    assert (job_dir / "ocr_reviewed.json").is_file()

    fake_ai.evaluation_error = None
    fake_ai.answer_confidence = 0.55  # held again, by the fresh OCR
    target = other_rubric(client)
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric_id": target["id"]})
    assert response.status_code == 202, response.text
    assert results(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED"
    assert not (job_dir / "ocr_reviewed.json").exists()
    review = client.get(f"/api/submissions/{held['id']}/ocr").json()
    assert [a["question"] for a in review["answers"]] == [1, 2, 3, 4]
    assert all(a["confidence"] == 0.55 for a in review["answers"])  # the fresh OCR, not the approved copy
    raw = json.loads((job_dir / "ocr.json").read_text(encoding="utf-8"))
    assert raw["rubric_questions"] == [1, 2, 3, 4]


def test_a_current_result_is_archived(upload, fake_ai, client, ai_ready, db_session, monkeypatch):
    import pipeline

    sub = upload().json()
    assert results(client, sub["id"])["submission"]["status"] == "COMPLETED"
    set_fields(db_session, sub["id"], status="FAILED")
    monkeypatch.setattr(pipeline, "process_submission", lambda *args, **kwargs: None)
    response = client.post(f"/api/submissions/{sub['id']}/rerun")
    assert response.status_code == 202, response.text
    assert (
        "Faculty re-run with rubric 'Biology - Genetics' (v1) by Faculty reviewer - full re-run from the stored "
        "upload (same rubric). Result v1 (v1: 14/20) archived."
    ) in log_of(client, sub["id"])
    versions = client.get(f"/api/results/{sub['id']}/versions").json()
    assert [v["current"] for v in versions] == [False]


# --------------------------------------------------------------------------- #
# Inline rubric (the answer key drafted on the fly and edited after grading)
# --------------------------------------------------------------------------- #
def section_b() -> dict:
    content = load_genetics_rubric()
    return {**content, "name": "Biology - Genetics Section B",
            "questions": [q for q in content["questions"] if q["question"] != 5]}


def rubric_count(db_session) -> int:
    from sqlalchemy import func, select

    from database import Rubric

    return db_session.scalar(select(func.count()).select_from(Rubric))


def test_rerun_with_an_inline_rubric_creates_a_snapshot_and_regrades(held, client, fake_ai, ai_ready, db_session):
    before = rubric_count(db_session)
    response = client.post(f"/api/submissions/{held['id']}/rerun",
                           json={"rubric": section_b(), "reviewer": "Dr. Rao"})
    assert response.status_code == 202, response.text
    snapshot_id = response.json()["rubric_id"]
    assert snapshot_id != held["rubric_id"]
    assert rubric_count(db_session) == before + 1

    snapshot = next(r for r in client.get("/api/rubrics").json() if r["id"] == snapshot_id)
    assert (snapshot["name"], snapshot["version"], snapshot["status"]) == (
        "Biology - Genetics Section B", "custom-1", "AUTHOR_DRAFT")
    assert snapshot["parent_id"] is None and [q["question"] for q in snapshot["content"]["questions"]] == [1, 2, 3, 4]

    body = results(client, held["id"])
    assert body["submission"]["status"] == "COMPLETED", body.get("detail")
    assert body["submission"]["rubric_id"] == snapshot_id
    assert [q["question"] for q in body["question_evaluations"]] == [1, 2, 3, 4]
    assert fake_ai.calls["ocr"] == 2 and fake_ai.calls["evaluation"] == 1
    assert (
        "Faculty re-run with rubric 'Biology - Genetics Section B' (custom-1) by Dr. Rao - full re-run from the "
        "stored upload (was 'Biology - Genetics' (v1))."
    ) in log_of(client, held["id"])


def test_rerun_rejects_an_invalid_inline_rubric_like_upload(held, client, ai_ready, queued, db_session):
    before = rubric_count(db_session)
    bad = section_b()
    bad["questions"][0] = {**bad["questions"][0], "max_marks": 0}
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric": bad})
    assert response.status_code == 422 and response.json()["code"] == "invalid_rubric"
    assert response.json()["detail"].startswith("Invalid rubric - questions[0].max_marks")
    not_object = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric": ["no"]})
    assert not_object.status_code == 422 and not_object.json()["code"] == "invalid_rubric"
    assert results(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED" and queued == []
    assert rubric_count(db_session) == before


def test_rerun_with_both_rubric_and_rubric_id_is_refused(held, client, ai_ready, queued, db_session):
    before = rubric_count(db_session)
    response = client.post(f"/api/submissions/{held['id']}/rerun",
                           json={"rubric": section_b(), "rubric_id": held["rubric_id"]})
    assert response.status_code == 422 and response.json()["code"] == "invalid_rubric"
    assert queued == [] and rubric_count(db_session) == before


def test_inline_rubric_snapshot_is_not_stored_when_the_rerun_is_refused(held, client, queued, db_session):
    """AI not configured: 503 and no orphan snapshot row."""
    before = rubric_count(db_session)
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric": section_b()})
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    assert queued == [] and rubric_count(db_session) == before


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
def test_rerun_only_for_held_or_failed_sheets(upload, fake_ai, client, ai_ready):
    sub = upload().json()
    response = client.post(f"/api/submissions/{sub['id']}/rerun")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert "HUMAN_REVIEW_REQUIRED or FAILED" in response.json()["detail"]
    assert client.post("/api/submissions/987654/rerun").status_code == 404


def test_rerun_with_an_unknown_rubric(held, client, ai_ready, queued):
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric_id": 987654})
    assert response.status_code == 422 and response.json()["code"] == "unknown_rubric"
    assert results(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED" and queued == []


def test_rerun_needs_the_stored_upload(held, client, ai_ready, tmp_path, queued):
    for stored in (tmp_path / "uploads").iterdir():
        stored.unlink()
    response = client.post(f"/api/submissions/{held['id']}/rerun")
    assert response.status_code == 409 and response.json()["code"] == "upload_missing"
    assert results(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED" and queued == []


def test_rerun_needs_a_configured_ai(held, client, queued):
    response = client.post(f"/api/submissions/{held['id']}/rerun")
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    assert results(client, held["id"])["status"] == "HUMAN_REVIEW_REQUIRED" and queued == []


def test_reviewer_name_is_limited(held, client, ai_ready, queued):
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"reviewer": "x" * 121})
    assert response.status_code == 422 and queued == []


# --------------------------------------------------------------------------- #
# review_reason is cleared by every endpoint that queues the sheet again
# --------------------------------------------------------------------------- #
def test_review_and_retry_clear_the_review_reason(held, client, fake_ai, ai_ready, db_session, queued):
    from database import StudentSubmission

    set_fields(db_session, held["id"], review_reason="low_confidence")
    assert client.post(f"/api/submissions/{held['id']}/review",
                       json={"reviewer": "Dr. Rao", "action": "approve"}).status_code == 202
    db_session.expire_all()
    assert db_session.get(StudentSubmission, held["id"]).review_reason is None

    set_fields(db_session, held["id"], status="FAILED", review_reason="no_answers")
    assert client.post(f"/api/submissions/{held['id']}/retry").status_code == 202
    db_session.expire_all()
    assert db_session.get(StudentSubmission, held["id"]).review_reason is None


def test_rescan_clears_the_review_reason(held, client, db_session, queued):
    from database import StudentSubmission
    from tests.test_review import other_png

    set_fields(db_session, held["id"], review_reason="mostly_blank")
    response = client.post(f"/api/submissions/{held['id']}/rescan",
                           files={"file": ("rescan.png", other_png(), "image/png")})
    assert response.status_code == 202, response.text
    db_session.expire_all()
    assert db_session.get(StudentSubmission, held["id"]).review_reason is None


# --------------------------------------------------------------------------- #
# The user's case: a printed MCQ paper uploaded with a small descriptive rubric
# --------------------------------------------------------------------------- #
def test_printed_paper_with_the_wrong_rubric_is_held_then_rerun(upload, fake_ai, client, ai_ready):
    """A 15-question printed MCQ paper uploaded with the 5-question Genetics rubric is held as another
    paper (shape check); re-run with a rubric that fits, it is read and graded."""
    from tests.test_paper_detect import _paper

    sub = upload(filename="neet_ticked.pdf", content=_paper(range(1, 16), key=False)).json()
    held = results(client, sub["id"])
    assert held["status"] == "HUMAN_REVIEW_REQUIRED"
    assert held["submission"].get("review_reason") == "paper_mismatch"
    assert "rubric 'Biology - Genetics' (v1) has 5 questions, none of them MCQs" in held["detail"]

    content = {**load_genetics_rubric(), "name": "Physics short answers"}
    content["questions"] = [
        {**content["questions"][0], "question": n, "topic": f"Topic {n}", "prompt": f"Explain device {n}"}
        for n in range(1, 9)
    ]
    created = client.post("/api/rubrics", json={"content": content, "approved": False})
    assert created.status_code == 201, created.text
    response = client.post(f"/api/submissions/{sub['id']}/rerun",
                           json={"rubric_id": created.json()["id"], "reviewer": "Dr. Rao"})
    assert response.status_code == 202, response.text
    done = results(client, sub["id"])
    assert done["submission"]["status"] == "COMPLETED", done.get("detail")
    assert done["submission"].get("review_reason") is None
    assert len(done["question_evaluations"]) == 8 and fake_ai.calls["ocr"] == 2


def test_voice_question_missing_from_the_new_rubric_is_dropped(upload, fake_ai, fake_transcriber, client, ai_ready,
                                                                 wav_bytes, monkeypatch):
    import ai
    import pipeline

    fake_transcriber.error = ai.AIServiceError("Refused.", code="refusal")
    sub = upload(filename="answer.wav", content=wav_bytes, voice_question="5").json()
    assert results(client, sub["id"])["status"] == "FAILED"
    monkeypatch.setattr(pipeline, "process_submission", lambda *args, **kwargs: None)
    target = other_rubric(client)
    response = client.post(f"/api/submissions/{sub['id']}/rerun", json={"rubric_id": target["id"]})
    assert response.status_code == 202, response.text
    assert response.json()["voice_question"] is None
    assert any(m.endswith(f"Q5 is not in rubric {target['version']} - the whole recording is mapped to its questions.")
               for m in log_of(client, sub["id"]))


# --------------------------------------------------------------------------- #
# A re-run drops the earlier run's files that would steer a later run
# --------------------------------------------------------------------------- #
def _stale_failure(job_dir) -> None:
    """dead_letter.json of an earlier evaluation-only run (an approved transcript whose grading failed)."""
    (job_dir / "dead_letter.json").write_text(
        json.dumps({"mode": "evaluation_only", "reason": "review", "error_code": "refusal"}), encoding="utf-8"
    )


def test_rerun_with_another_rubric_clears_the_run_records_and_the_old_ocr(held, client, ai_ready, queued,
                                                                           tmp_path, db_session):
    """Accepted, then the server stops before the worker starts: on restart the sheet is FAILED
    (interrupted) and Retry must run the full pipeline against the new rubric - not grade the old
    rubric's transcript from the stale dead-letter / run records."""
    import pipeline

    job_dir = tmp_path / "artifacts" / str(held["id"])
    _stale_failure(job_dir)
    assert (job_dir / "run.json").is_file() and (job_dir / "ocr.json").is_file()
    assert pipeline.last_run_mode(held["id"]) == pipeline.MODE_EVALUATION_ONLY  # what Retry would have done
    target = other_rubric(client)
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric_id": target["id"]})
    assert response.status_code == 202, response.text
    for name in ("dead_letter.json", "run.json", "ocr.json", "ocr_reviewed.json"):
        assert not (job_dir / name).exists(), name

    db_session.expire_all()
    assert pipeline.recover_interrupted_jobs(db_session) == 1
    assert results(client, held["id"])["status"] == "FAILED"
    assert pipeline.last_run_mode(held["id"]) == pipeline.MODE_FULL
    assert client.post(f"/api/submissions/{held['id']}/retry").status_code == 202
    assert queued[-1] == ((held["id"],), {"mode": pipeline.MODE_FULL, "reason": "retry"})


def test_rerun_with_the_same_rubric_keeps_its_ocr(held, client, ai_ready, queued, tmp_path):
    job_dir = tmp_path / "artifacts" / str(held["id"])
    _stale_failure(job_dir)
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric_id": held["rubric_id"]})
    assert response.status_code == 202, response.text
    assert (job_dir / "ocr.json").is_file()  # mapped against this rubric: still the sheet's transcript
    assert not (job_dir / "dead_letter.json").exists() and not (job_dir / "run.json").exists()


def test_inline_rubric_rerun_clears_the_old_ocr(held, client, ai_ready, queued, tmp_path):
    job_dir = tmp_path / "artifacts" / str(held["id"])
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric": section_b()})
    assert response.status_code == 202, response.text
    assert not (job_dir / "ocr.json").exists() and not (job_dir / "run.json").exists()


def test_a_file_that_cannot_be_removed_refuses_the_rerun(held, client, ai_ready, queued, monkeypatch, db_session):
    from pathlib import Path

    original = Path.unlink

    def locked(self, *args, **kwargs):
        if self.name == "run.json":
            raise PermissionError("in use")
        return original(self, *args, **kwargs)

    before = rubric_count(db_session)
    monkeypatch.setattr(Path, "unlink", locked)
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric": section_b()})
    monkeypatch.setattr(Path, "unlink", original)
    assert response.status_code == 500
    body = results(client, held["id"])
    assert body["status"] == "HUMAN_REVIEW_REQUIRED" and body["submission"]["rubric_id"] == held["rubric_id"]
    assert queued == [] and rubric_count(db_session) == before


# --------------------------------------------------------------------------- #
# Atomic status transitions: of two concurrent requests one wins, the other changes nothing
# --------------------------------------------------------------------------- #
def flip_status(submission_id: int, status: str) -> None:
    """Another request moved the sheet in the meantime (a separate session, committed)."""
    from database import SessionLocal, StudentSubmission

    with SessionLocal() as session:
        session.get(StudentSubmission, submission_id).status = status
        session.commit()


@pytest.fixture
def ai_ready_then_flip(monkeypatch):
    """ai_readiness() is the last check before the status transition: the sheet is flipped to
    PENDING there (set target["id"] to arm it)."""
    import ai

    target: dict[str, int] = {}

    def ready():
        if "id" in target:
            flip_status(target["id"], "PENDING")
        return True, []

    monkeypatch.setattr(ai, "ai_readiness", ready)
    return target


def test_a_concurrent_rerun_loses_without_side_effects(held, client, queued, tmp_path, db_session,
                                                       ai_ready_then_flip):
    job_dir = tmp_path / "artifacts" / str(held["id"])
    (job_dir / "ocr_reviewed.json").write_text("{}", encoding="utf-8")
    before = rubric_count(db_session)
    ai_ready_then_flip["id"] = held["id"]
    response = client.post(f"/api/submissions/{held['id']}/rerun", json={"rubric": section_b()})
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert response.json()["detail"].startswith(f"Submission {held['id']} is PENDING;")
    assert queued == [] and rubric_count(db_session) == before
    for name in ("ocr_reviewed.json", "run.json", "ocr.json"):
        assert (job_dir / name).is_file(), name
    assert not any(m.startswith("Faculty re-run") for m in log_of(client, held["id"]))


def test_a_concurrent_review_loses_without_writing_the_transcript(held, client, queued, tmp_path,
                                                                   ai_ready_then_flip):
    ai_ready_then_flip["id"] = held["id"]
    response = client.post(f"/api/submissions/{held['id']}/review",
                           json={"reviewer": "Dr. Rao", "action": "approve"})
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert not (tmp_path / "artifacts" / str(held["id"]) / "ocr_reviewed.json").exists()
    assert client.get(f"/api/submissions/{held['id']}/ocr").json()["reviews"] == [] and queued == []


def test_a_concurrent_retry_loses(held, client, queued, monkeypatch):
    import pipeline

    flip_status(held["id"], "FAILED")
    real = pipeline.last_run_mode

    def mode_then_flip(submission_id):
        flip_status(submission_id, "PENDING")
        return real(submission_id)

    monkeypatch.setattr(pipeline, "last_run_mode", mode_then_flip)
    response = client.post(f"/api/submissions/{held['id']}/retry")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert queued == [] and not any("Operator re-drive" in m for m in log_of(client, held["id"]))


def test_a_concurrent_rescan_loses_and_keeps_the_stored_scan(held, client, queued, tmp_path, monkeypatch):
    import uploads
    from tests.test_review import other_png

    stored_before = sorted(p.name for p in (tmp_path / "uploads").iterdir())
    real = uploads.inspect_document

    def inspect_then_flip(*args, **kwargs):
        flip_status(held["id"], "PENDING")
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads, "inspect_document", inspect_then_flip)
    response = client.post(f"/api/submissions/{held['id']}/rescan",
                           files={"file": ("rescan.png", other_png(), "image/png")})
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert sorted(p.name for p in (tmp_path / "uploads").iterdir()) == stored_before  # new scan discarded
    assert (tmp_path / "artifacts" / str(held["id"]) / "ocr.json").is_file() and queued == []


def test_editing_the_key_moves_held_sheets_to_the_new_version(held, client, fake_ai, ai_ready, tmp_path):
    """Approving a sheet held before the key was edited grades it with the edited key."""
    reviewed = tmp_path / "artifacts" / str(held["id"]) / "ocr_reviewed.json"
    reviewed.write_text("{}", encoding="utf-8")
    response = client.post(f"/api/rubrics/{held['rubric_id']}/versions",
                           json={"content": {**section_b(), "name": "Biology - Genetics"}, "reprocess": False})
    assert response.status_code == 201, response.text
    assert response.json()["compatibility"]["reusable"] is False
    assert not reviewed.exists()  # mapped to the old question numbers
    assert (
        "Answer key edited - moved to rubric 'Biology - Genetics' (v2) (was 'Biology - Genetics' (v1)). The "
        "question numbers changed, so any faculty-reviewed transcript was cleared."
    ) in log_of(client, held["id"])
    approve = client.post(f"/api/submissions/{held['id']}/review", json={"reviewer": "Ms. Iyer", "action": "approve"})
    assert approve.status_code == 202, approve.text
    body = results(client, held["id"])
    assert body["rubric"]["version"] == "v2"
    assert [q["question"] for q in body["question_evaluations"]] == [1, 2, 3, 4]
