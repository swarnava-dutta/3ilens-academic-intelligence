"""HTTP contract tests (API_CONTRACT.md): health, rubrics, upload validation, submissions,
results 200/202/404, cohort, CORS."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

SUBMISSION_KEYS = {
    "id", "student_name", "original_filename", "status", "ocr_confidence", "created_at", "updated_at",
    "error_message", "current_step", "is_demo", "total_score", "total_marks", "rubric_id", "batch_id",
    # contract v2 (custody, intake, worker, urgency, release, cost)
    "file_sha256", "file_size", "page_count", "language_hints", "student_ref", "intake_batch_id", "attempts",
    "max_attempts", "last_error_code", "flagged_pages", "ocr_cache_hit", "urgency", "percentage", "started_at",
    "completed_at", "release_status", "llm_cost_inr",
    # contract v3 (voice answers)
    "input_kind", "audio_seconds", "voice_question", "detected_languages",
}
COHORT_KEYS = {
    "institution", "batch", "total_submissions", "completed", "processing", "human_review", "failed",
    "average_score", "average_mastery", "total_marks", "topic_mastery", "score_distribution",
    "top_priorities", "is_demo", "demo_count", "real_count",
    # contract v2
    "filters", "rubric_versions", "mixed_rubrics", "urgency_counts", "ranking", "at_risk", "common_errors",
    "interventions", "confusion_clusters", "excluded", "operations", "release_counts",
    # contract v3
    "patterns",
}
PRIORITY_KEYS = {
    "topic", "subject", "roi", "weightage", "gain_potential", "effort_hours", "rationale", "mastery",
    # contract v2 (illustrative projections + intervention)
    "projected_gain_marks", "target_mastery", "gain_low", "gain_high", "trigger_questions", "intervention",
    "qualitative_rank", "calibrated",
}
HEALTH_KEYS = {
    "status", "ai_ready", "vision_provider", "missing_configuration", "ocr_confidence_threshold",
    "institution", "batch",
    # contract v2
    "ocr_adapter", "ocr_cache_enabled", "cost_target_inr", "latency_target_seconds", "batch_target_seconds",
    "whatsapp_mode", "max_upload_mb", "accepted_upload_types",
    # contract v3
    "voice_enabled", "voice_ready", "transcription_model", "accepted_voice_types", "llm_fallback", "lms_api_enabled",
}
BATCH_KEYS = {
    "id", "name", "exam_type", "exam", "exam_date", "exam_date_assumed", "days_to_exam", "strategy_mode",
    "faculty_lead",  # contract v3
}
RUBRIC_KEYS = {
    "id", "version", "name", "total_marks", "content", "status", "rubric_hash", "parent_id", "change_note",
    "created_at",
}
DISTRIBUTION_LABELS = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"]


def genetics_rubric() -> dict:
    path = Path(__file__).resolve().parents[1] / "rubrics" / "biology_genetics_v1.json"
    return json.loads(path.read_text(encoding="utf-8"))


def uploaded_files(tmp_path: Path) -> list[Path]:
    folder = tmp_path / "uploads"
    return [p for p in folder.iterdir() if p.is_file()] if folder.exists() else []


# --------------------------------------------------------------------------- #
# Health & rubrics
# --------------------------------------------------------------------------- #
def test_health_without_keys_reports_missing_configuration(client, monkeypatch):
    monkeypatch.delenv("NEET_EXAM_DATE", raising=False)
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == HEALTH_KEYS
    assert body["status"] == "ok"
    assert body["ai_ready"] is False
    assert "ANTHROPIC_API_KEY" in body["missing_configuration"]
    assert body["vision_provider"] == "anthropic"
    assert body["ocr_confidence_threshold"] == 0.80
    assert body["institution"]["name"] == "Instit-42"
    batch = body["batch"]
    assert set(batch) == BATCH_KEYS
    assert (batch["name"], batch["exam_type"], batch["exam"]) == ("NEET-A", "Mock-07", "NEET")
    assert batch["exam_date"] == "2027-05-02" and batch["exam_date_assumed"] is True  # assumed default
    assert batch["days_to_exam"] is None or batch["days_to_exam"] >= 0


def test_health_reports_the_configured_ocr_confidence_threshold(client, monkeypatch):
    monkeypatch.setenv("OCR_CONFIDENCE_THRESHOLD", "0.7")
    assert client.get("/api/health").json()["ocr_confidence_threshold"] == 0.7


def test_health_never_returns_secrets(client, monkeypatch):
    secret = "sk-ant-test-secret-do-not-leak-123"
    monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ai_ready"] is True
    assert secret not in response.text


def test_health_survives_a_broken_readiness_check(client, monkeypatch):
    import ai

    def boom():
        raise RuntimeError("readiness exploded")

    monkeypatch.setattr(ai, "ai_readiness", boom)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ai_ready"] is False
    assert response.json()["missing_configuration"]


def test_rubrics_lists_the_seeded_genetics_rubric(client):
    response = client.get("/api/rubrics")
    assert response.status_code == 200
    rubrics = response.json()
    assert len(rubrics) == 1
    rubric = rubrics[0]
    assert set(rubric) == RUBRIC_KEYS
    assert rubric["status"] == "AUTHOR_DRAFT" and rubric["parent_id"] is None
    from hashing import rubric_hash

    assert rubric["rubric_hash"] == rubric_hash(rubric["content"]) and len(rubric["rubric_hash"]) == 64
    assert rubric["name"] == "Biology - Genetics"
    assert rubric["version"] == "v1"
    assert rubric["total_marks"] == 20
    questions = rubric["content"]["questions"]
    assert [q["question"] for q in questions] == [1, 2, 3, 4, 5]
    assert len({q["topic"] for q in questions}) == 5


def test_startup_seeds_base_data_only(client):
    assert client.get("/api/submissions").json() == []
    cohort = client.get("/api/cohort").json()
    assert cohort["total_submissions"] == 0
    assert cohort["demo_count"] == 0


# --------------------------------------------------------------------------- #
# Upload validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", ["", "   ", None])
def test_upload_requires_student_name(upload, forbid_ai, tmp_path, name):
    response = upload(student_name=name)
    assert response.status_code == 422
    assert "Student name" in response.json()["detail"]
    assert response.json()["code"] == "invalid_student_name"
    assert uploaded_files(tmp_path) == []


def test_upload_rejects_overlong_student_name(upload, forbid_ai):
    response = upload(student_name="A" * 121)
    assert response.status_code == 422
    assert "120" in response.json()["detail"]


def test_upload_trims_student_name(upload, fake_ai):
    response = upload(student_name="  Diya   Reddy  ")
    assert response.status_code == 202
    assert response.json()["student_name"] == "Diya Reddy"


def test_upload_requires_a_file(client, forbid_ai):
    response = client.post("/api/upload", data={"student_name": "Aarav"})
    assert response.status_code == 422
    assert response.json()["code"] == "missing_file"


@pytest.mark.parametrize(
    "filename, content",
    [
        ("notes.txt", b"just some text, not an answer sheet"),
        ("fake.pdf", b"this is not really a PDF document at all"),
        ("photo.gif", b"GIF89a\x01\x00\x01\x00\x80\x00\x00"),
    ],
)
def test_upload_rejects_unsupported_types_by_content(upload, forbid_ai, tmp_path, filename, content):
    response = upload(filename=filename, content=content)
    assert response.status_code == 415
    assert "PDF, JPEG, PNG, WEBP or DOCX" in response.json()["detail"]
    assert response.json()["code"] == "unsupported_signature"
    assert uploaded_files(tmp_path) == []


def test_upload_rejects_empty_file(upload, forbid_ai):
    response = upload(content=b"")
    assert response.status_code == 422
    assert "empty" in response.json()["detail"]
    assert response.json()["code"] == "empty_file"


def test_upload_rejects_files_over_20_mb(upload, forbid_ai, tmp_path, png_bytes):
    too_big = png_bytes + b"\0" * (20 * 1024 * 1024)
    response = upload(filename="huge.png", content=too_big)
    assert response.status_code == 413
    assert "20 MB" in response.json()["detail"]
    assert response.json()["code"] == "too_large"
    assert uploaded_files(tmp_path) == []


def test_upload_rejects_pdf_over_10_pages(upload, forbid_ai, make_pdf, tmp_path):
    response = upload(filename="long.pdf", content=make_pdf(11))
    assert response.status_code == 422
    assert "11 pages" in response.json()["detail"]
    assert response.json()["code"] == "too_many_pages"
    assert uploaded_files(tmp_path) == []


def test_upload_rejects_corrupt_pdf(upload, forbid_ai, tmp_path):
    response = upload(filename="broken.pdf", content=b"%PDF-1.7\n this is not a valid pdf body")
    assert response.status_code == 422
    assert response.json()["code"] == "corrupt_pdf"
    assert uploaded_files(tmp_path) == []


def test_upload_rejects_corrupt_image(upload, forbid_ai, png_bytes):
    response = upload(filename="cut.png", content=png_bytes[:40])
    assert response.status_code == 422
    assert "image" in response.json()["detail"]
    assert response.json()["code"] == "corrupt_image"


def test_upload_rejects_a_truncated_jpeg_that_passes_verify(upload, forbid_ai, tmp_path):
    """A cut-off JPEG passes PIL's structural verify(); upload must still reject it (422) instead
    of storing it and failing later in the worker."""
    import io
    import random

    from PIL import Image

    rng = random.Random(7)
    image = Image.new("RGB", (400, 300))
    image.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(400 * 300)])
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=90)
    data = buffer.getvalue()
    response = upload(filename="cut.jpg", content=data[: len(data) // 2])
    assert response.status_code == 422
    assert response.json()["code"] == "corrupt_image"
    assert uploaded_files(tmp_path) == []


@pytest.mark.parametrize("fmt, filename", [("JPEG", "sheet.jpeg"), ("WEBP", "sheet.webp"), ("PNG", "sheet")])
def test_upload_accepts_jpeg_webp_and_png(upload, fake_ai, client, fmt, filename):
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (120, 80), "white").save(buffer, fmt)
    response = upload(filename=filename, content=buffer.getvalue())
    assert response.status_code == 202, response.text
    assert client.get(f"/api/results/{response.json()['id']}").status_code == 200


def test_upload_accepts_multi_page_pdf(upload, fake_ai, make_pdf, client):
    response = upload(filename="sheet.pdf", content=make_pdf(3))
    assert response.status_code == 202
    sub = response.json()
    assert sub["original_filename"] == "sheet.pdf"
    log = client.get(f"/api/results/{sub['id']}").json()["processing_log"]
    assert "3 pages" in log[0]["message"]


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda r: "{not json", "not valid JSON"),
        (lambda r: json.dumps([1, 2, 3]), "JSON object"),
        (lambda r: json.dumps({**r, "questions": []}), "questions"),
        (lambda r: json.dumps({**r, "questions": [r["questions"][0], r["questions"][0]]}), "unique"),
        (lambda r: json.dumps({**r, "questions": [{**r["questions"][0], "max_marks": 0}]}), "max_marks"),
        (lambda r: json.dumps({**r, "questions": [{**r["questions"][0], "effort_hours": -1}]}), "effort_hours"),
        (lambda r: json.dumps({**r, "questions": [{**r["questions"][0], "topic": " "}]}), "topic"),
        (lambda r: json.dumps({**r, "questions": [{**r["questions"][0], "question": 0}]}), "question"),
        (lambda r: json.dumps({**r, "questions": [{k: v for k, v in r["questions"][0].items()
                                                    if k != "expected_answer"}]}), "expected_answer"),
        (lambda r: json.dumps({**r, "questions": [{k: v for k, v in r["questions"][0].items()
                                                    if k != "grading_criteria"}]}), "grading_criteria"),
    ],
)
def test_upload_rejects_invalid_rubric_json(upload, forbid_ai, tmp_path, mutate, expected):
    response = upload(rubric_json=mutate(genetics_rubric()))
    assert response.status_code == 422
    assert expected in response.json()["detail"]
    assert response.json()["code"] == "invalid_rubric"
    assert uploaded_files(tmp_path) == []  # rubric validated before the upload is saved


def test_upload_rejects_unknown_rubric_id(upload, forbid_ai):
    response = upload(rubric_id="999")
    assert response.status_code == 422
    assert "999" in response.json()["detail"]
    assert response.json()["code"] == "unknown_rubric"
    assert upload(rubric_id="abc").status_code == 422


def test_upload_with_custom_rubric_json_creates_a_new_rubric(upload, fake_ai, client):
    custom = {
        "name": "Physics - Kinematics",
        "subject": "physics",
        "questions": [
            {"question": 2, "topic": "Projectile Motion", "subject": "physics", "max_marks": 3,
             "expected_answer": "R = u^2 sin 2θ / g", "grading_criteria": ["formula", "substitution"],
             "effort_hours": 2},
            {"question": 1, "topic": "Equations of Motion", "subject": "Physics", "max_marks": 2,
             "prompt": "Derive v = u + at", "expected_answer": "a = dv/dt ...",
             "grading_criteria": ["derivation"], "effort_hours": 1.5},
        ],
    }
    response = upload(rubric_json=json.dumps(custom))
    assert response.status_code == 202, response.text
    sub = response.json()
    assert sub["total_marks"] == 5

    rubrics = client.get("/api/rubrics").json()
    created = next(r for r in rubrics if r["id"] == sub["rubric_id"])
    assert created["version"] == "custom-1"
    assert created["status"] == "AUTHOR_DRAFT" and len(created["rubric_hash"]) == 64
    assert created["name"] == "Physics - Kinematics"
    assert [q["question"] for q in created["content"]["questions"]] == [1, 2]
    assert {q["subject"] for q in created["content"]["questions"]} == {"Physics"}

    result = client.get(f"/api/results/{sub['id']}")
    assert result.status_code == 200
    assert result.json()["rubric"]["version"] == "custom-1"
    assert result.json()["total_marks"] == 5


def test_upload_with_explicit_rubric_id(upload, fake_ai, client):
    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    response = upload(rubric_id=str(rubric_id))
    assert response.status_code == 202
    assert response.json()["rubric_id"] == rubric_id


def test_upload_returns_202_submission_without_file_paths(upload, fake_ai, tmp_path):
    response = upload(filename=r"C:\Users\teacher\scans\Aarav sheet.png")
    assert response.status_code == 202
    sub = response.json()
    assert set(sub) == SUBMISSION_KEYS
    assert sub["status"] == "PENDING"
    assert sub["current_step"] == "Queued"
    assert sub["original_filename"] == "Aarav sheet.png"
    assert sub["is_demo"] is False
    assert sub["total_score"] is None
    assert sub["total_marks"] == 20
    assert sub["created_at"].endswith(("Z", "+00:00"))
    assert "uploads" not in response.text and "file_path" not in response.text
    stored = uploaded_files(tmp_path)
    assert len(stored) == 1 and stored[0].name.endswith("_Aarav_sheet.png")


# --------------------------------------------------------------------------- #
# Submissions & results
# --------------------------------------------------------------------------- #
def test_submissions_are_newest_first(upload, fake_ai, client):
    first = upload(student_name="First Student").json()
    second = upload(student_name="Second Student").json()
    listing = client.get("/api/submissions").json()
    assert [s["id"] for s in listing] == [second["id"], first["id"]]
    assert all(set(s) == SUBMISSION_KEYS for s in listing)
    assert listing[0]["status"] == "COMPLETED"
    assert listing[0]["total_score"] == 14


def test_results_404_for_unknown_submission(client):
    response = client.get("/api/results/424242")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


def test_results_202_for_pending_submission(client, db_session):
    from database import StudentSubmission

    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    batch_id = client.get("/api/health").json()["batch"]["id"]
    sub = StudentSubmission(
        student_name="Queued Student", original_filename="q.png", mime_type="image/png", status="PENDING",
        current_step="Queued", processing_log=[], batch_id=batch_id, rubric_id=rubric_id,
    )
    db_session.add(sub)
    db_session.commit()

    response = client.get(f"/api/results/{sub.id}")
    assert response.status_code == 202
    body = response.json()
    assert set(body) == {"status", "detail", "submission", "processing_log"}
    assert body["processing_log"] == []
    assert body["status"] == "PENDING"
    assert body["detail"]
    assert set(body["submission"]) == SUBMISSION_KEYS


# --------------------------------------------------------------------------- #
# Cohort
# --------------------------------------------------------------------------- #
def test_cohort_without_data(client):
    response = client.get("/api/cohort")
    assert response.status_code == 200
    cohort = response.json()
    assert set(cohort) == COHORT_KEYS
    assert cohort["institution"]["name"] == "Instit-42"
    assert cohort["batch"]["name"] == "NEET-A"
    assert cohort["total_submissions"] == cohort["completed"] == 0
    assert cohort["average_score"] is None and cohort["average_mastery"] is None
    assert cohort["total_marks"] == 20
    assert cohort["topic_mastery"] == [] and cohort["top_priorities"] == []
    assert [b["label"] for b in cohort["score_distribution"]] == DISTRIBUTION_LABELS
    assert all(b["count"] == 0 for b in cohort["score_distribution"])
    assert cohort["is_demo"] is False and cohort["demo_count"] == 0 and cohort["real_count"] == 0


def test_cohort_with_live_results(upload, fake_ai, client):
    import ai

    assert upload(student_name="Student One").status_code == 202
    assert upload(student_name="Student Two").status_code == 202
    assert upload(student_name="Blurry Student", filename="blurry_scan.png").status_code == 202
    fake_ai.ocr_error = ai.AIServiceError("Provider timed out.")
    assert upload(student_name="Failed Student").status_code == 202

    cohort = client.get("/api/cohort").json()
    assert cohort["total_submissions"] == 4
    assert cohort["completed"] == 2
    assert cohort["human_review"] == 1
    assert cohort["failed"] == 1
    assert cohort["processing"] == 0
    assert cohort["average_score"] == 14
    assert cohort["average_mastery"] == 70
    assert cohort["total_marks"] == 20
    assert len(cohort["topic_mastery"]) == 5
    assert {"topic", "mastery"} == set(cohort["topic_mastery"][0])
    counts = {b["label"]: b["count"] for b in cohort["score_distribution"]}
    assert counts["60-80%"] == 2 and sum(counts.values()) == 2
    priorities = cohort["top_priorities"]
    assert 0 < len(priorities) <= 5
    assert all(set(p) == PRIORITY_KEYS for p in priorities)
    assert [p["roi"] for p in priorities] == sorted((p["roi"] for p in priorities), reverse=True)
    assert all(p["mastery"] < 90 for p in priorities)  # mastered topics excluded
    top = priorities[0]
    assert top["roi"] == pytest.approx(top["weightage"] * top["gain_potential"] / top["effort_hours"], abs=0.01)
    assert cohort["is_demo"] is False and cohort["real_count"] == 4 and cohort["demo_count"] == 0


# --------------------------------------------------------------------------- #
# CORS & error handling
# --------------------------------------------------------------------------- #
def test_cors_allows_the_next_frontend(client):
    response = client.options(
        "/api/upload",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


@pytest.mark.parametrize(
    ("origin", "allowed"),
    [
        ("http://localhost:3001", True),  # start.bat falls back to 3001+ when 3000 is taken
        ("http://127.0.0.1:3005", True),
        ("http://localhost.evil.example", False),
        ("http://evil.example", False),
        ("http://localhost:3000.evil.example", False),
    ],
)
def test_cors_accepts_only_loopback_dev_origins(client, origin, allowed):
    response = client.get("/api/health", headers={"Origin": origin})
    assert response.status_code == 200
    assert (response.headers.get("access-control-allow-origin") == origin) is allowed


def test_unhandled_errors_return_json_500_with_cors(client, monkeypatch):
    import main

    def boom(_db):
        raise RuntimeError("database on fire")

    monkeypatch.setattr(main, "_context", boom)
    response = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error - see the backend logs."}
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "database on fire" not in response.text


# --------------------------------------------------------------------------- #
# Contract v2 (WP0): health settings, upload extras + error codes, filters, demo sets
# --------------------------------------------------------------------------- #
def test_health_reports_ocr_adapter_targets_and_upload_limits(client):
    body = client.get("/api/health").json()
    assert "stand-in for Google Vision DOCUMENT_TEXT_DETECTION" in body["ocr_adapter"]
    assert body["ocr_adapter"].startswith("anthropic vision (")
    assert body["ocr_cache_enabled"] is False  # conftest sets OCR_CACHE=0
    assert body["cost_target_inr"] == 5 and body["latency_target_seconds"] == 300
    assert body["batch_target_seconds"] == 1800
    assert body["whatsapp_mode"] == "blocked"
    assert body["max_upload_mb"] == 20
    assert body["accepted_upload_types"] == ["pdf", "jpeg", "png", "webp", "docx"]


def test_ocr_threshold_defaults_to_the_brd_value(isolated_env, monkeypatch):
    import config

    monkeypatch.delenv("OCR_CONFIDENCE_THRESHOLD", raising=False)
    assert config.get_settings().ocr_confidence_threshold == 0.70
    assert config.get_settings().preprocess_contrast == 1.4
    assert config.get_settings().default_exam_date == "2027-05-02"
    monkeypatch.setenv("OCR_CACHE", "off")
    assert config.get_settings().ocr_cache_enabled is False
    monkeypatch.setenv("OCR_CACHE", "1")
    assert config.get_settings().ocr_cache_enabled is True
    monkeypatch.setenv("VISION_MAX_EDGE_PX", "99999")
    assert config.get_settings().vision_max_edge_px == 2576
    monkeypatch.setenv("WHATSAPP_MODE", "send-for-real")
    assert config.get_settings().whatsapp_mode == "blocked"


def test_upload_records_custody_hash_and_intake_fields(upload, fake_ai, client, png_bytes):
    import hashlib

    response = upload(roll_no=" ab-12 ", language_hints="en, HI", intake_batch_id="batch-7f3c")
    assert response.status_code == 202, response.text
    sub = response.json()
    assert sub["file_sha256"] == hashlib.sha256(png_bytes).hexdigest()
    assert sub["file_size"] == len(png_bytes) and sub["page_count"] == 1
    assert sub["language_hints"] == ["en", "hi"]
    assert sub["student_ref"] == "AB-12"
    assert sub["intake_batch_id"] == "batch-7f3c"
    assert sub["attempts"] == 0 and sub["max_attempts"] == 3
    assert sub["urgency"] is None and sub["release_status"] is None  # not completed yet

    listed = client.get("/api/submissions", params={"intake_batch_id": "batch-7f3c"}).json()
    assert [s["id"] for s in listed] == [sub["id"]]
    assert client.get("/api/submissions", params={"intake_batch_id": "other"}).json() == []
    done = listed[0]
    assert done["status"] == "COMPLETED"
    assert done["urgency"] == "on_track" and done["percentage"] == 70  # 14/20; only one topic below 40%
    assert done["release_status"] == "PROVISIONAL"
    log = client.get(f"/api/results/{sub['id']}").json()["processing_log"]
    assert sub["file_sha256"][:12] in log[0]["message"]


def test_student_ref_defaults_to_a_name_slug(upload, fake_ai):
    sub = upload(student_name="  Diya   Reddy ").json()
    assert sub["student_ref"] == "diya-reddy"
    assert sub["language_hints"] == ["en"] and sub["intake_batch_id"] is None


@pytest.mark.parametrize(
    "form, code",
    [
        ({"language_hints": "en,fr"}, "invalid_language"),
        ({"batch_id": "999"}, "unknown_batch"),
        ({"batch_id": "abc"}, "unknown_batch"),
        ({"intake_batch_id": "bad id!"}, "invalid_intake_batch"),
        ({"intake_batch_id": "x" * 65}, "invalid_intake_batch"),
        ({"roll_no": "<script>"}, "invalid_roll_no"),
    ],
)
def test_upload_rejects_invalid_intake_fields_before_saving(upload, forbid_ai, tmp_path, form, code):
    response = upload(**form)
    assert response.status_code == 422
    assert response.json()["code"] == code
    assert set(response.json()) == {"detail", "code"}
    assert uploaded_files(tmp_path) == []


def test_upload_into_an_explicit_batch(upload, fake_ai, client, db_session):
    from database import Batch

    institution_id = client.get("/api/health").json()["institution"]["id"]
    other = Batch(name="NEET-B", exam_type="Mock-08", institution_id=institution_id, exam="NEET",
                  exam_date="2027-05-09")
    db_session.add(other)
    db_session.commit()
    sub = upload(batch_id=str(other.id)).json()
    assert sub["batch_id"] == other.id
    assert [s["id"] for s in client.get("/api/submissions", params={"batch_id": other.id}).json()] == [sub["id"]]

    cohort = client.get("/api/cohort", params={"batch_id": other.id}).json()
    assert cohort["batch"]["name"] == "NEET-B"
    assert cohort["batch"]["exam_date"] == "2027-05-09" and cohort["batch"]["exam_date_assumed"] is False
    assert cohort["total_submissions"] == 1 and cohort["filters"]["batch_id"] == other.id


def test_demo_seed_splits_genetics_urgency_5_3_4_and_filters_submissions(client, forbid_ai):
    assert client.post("/api/demo/seed").json()["created"] == 13
    counts = {}
    for urgency in ("on_track", "needs_attention", "at_risk"):
        rows = client.get("/api/submissions", params={"urgency": urgency}).json()
        assert all(r["urgency"] == urgency and r["status"] == "COMPLETED" for r in rows)
        counts[urgency] = len(rows)
    assert counts == {"on_track": 5, "needs_attention": 3, "at_risk": 4}
    assert client.get("/api/submissions", params={"urgency": "doomed"}).status_code == 422
    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    assert len(client.get("/api/submissions", params={"rubric_id": rubric_id}).json()) == 13
    assert client.get("/api/submissions", params={"rubric_id": rubric_id + 99}).json() == []
    assert forbid_ai == []


def test_cohort_filters_and_extras_on_the_demo_cohort(client):
    client.post("/api/demo/seed")
    cohort = client.get("/api/cohort").json()
    assert cohort["urgency_counts"] == {"on_track": 5, "needs_attention": 3, "at_risk": 4}
    assert [r["rank"] for r in cohort["ranking"]] == list(range(1, 13))
    pcts = [r["pct"] for r in cohort["ranking"]]
    assert pcts == sorted(pcts, reverse=True)
    assert len(cohort["at_risk"]) == 4 and all(r["reasons"] for r in cohort["at_risk"])
    assert cohort["filters"] == {"batch_id": None, "rubric_id": None, "urgency": None, "topic": None}
    assert len(cohort["rubric_versions"]) == 1 and cohort["mixed_rubrics"] is False
    assert cohort["excluded"] == {"review": ["Aditya Kulkarni"], "failed": [], "processing": []}
    import seed

    released = len(getattr(seed, "DEMO_RELEASED", ()))  # WP3: demo faculty sign-offs
    assert cohort["release_counts"] == {"provisional": 12 - released, "released": released}
    assert cohort["operations"]["target_inr"] == 5 and cohort["operations"]["dlq_count"] == 0

    at_risk = client.get("/api/cohort", params={"urgency": "at_risk"}).json()
    assert at_risk["completed"] == 4 and at_risk["human_review"] == 1
    assert at_risk["total_submissions"] == 5
    assert at_risk["urgency_counts"] == {"on_track": 0, "needs_attention": 0, "at_risk": 4}
    assert at_risk["filters"]["urgency"] == "at_risk"
    assert at_risk["average_score"] < cohort["average_score"]

    topic = cohort["topic_mastery"][0]["topic"]
    by_topic = client.get("/api/cohort", params={"topic": topic}).json()
    assert 0 < by_topic["completed"] <= 12 and by_topic["filters"]["topic"] == topic

    missing = client.get("/api/cohort", params={"batch_id": 999})
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_batch"


def test_demo_seed_set_parameter(client):
    mixed = client.post("/api/demo/seed", params={"set": "mixed"}).json()["created"]  # WP3's NEET mixed demo
    assert mixed >= 0
    assert client.post("/api/demo/seed", params={"set": "mixed"}).json()["created"] == 0  # idempotent
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 13
    assert client.post("/api/demo/seed", params={"set": "genetics"}).json()["created"] == 0
    assert client.post("/api/demo/seed", params={"set": "everything"}).status_code == 422


def test_demo_result_carries_contract_extras(client):
    client.post("/api/demo/seed")
    sub = next(s for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED")
    result = client.get(f"/api/results/{sub['id']}").json()
    assert result["urgency"] in ("on_track", "needs_attention", "at_risk") and result["urgency_reasons"]
    assert result["percentage"] == pytest.approx(result["total_score"] / result["total_marks"] * 100, abs=0.1)
    assert result["study_plan"]["strategy_mode"] in ("broad", "focused", "revision", "consolidation")
    assert result["extraction"]["total_questions"] == 5 and result["extraction"]["mapped"] == 5
    assert "stand-in" in result["extraction"]["ocr_adapter"]
    assert result["release"] == {"status": "PROVISIONAL", "reviewed_by": None, "reviewed_at": None, "note": None}
    assert result["report_meta"]["run_id"].startswith("RUN_") and result["report_meta"]["run_id"].endswith(
        f"_IST_SUB{sub['id']:04d}"
    )
    assert result["report_meta"]["timezone"] == "Asia/Kolkata" and result["report_meta"]["is_demo"] is True
    assert result["custody"] is None  # demo rows have no source scan
    assert result["cost"]["synthetic"] is True and result["cost"]["usd_inr"] == 85
    assert result["scoring_controls"]["parity"] is True
    assert result["outcome_counts"]["total_questions"] == 5
    assert all(q["outcome"] in ("FULL", "PARTIAL", "ZERO", "BLANK") for q in result["question_evaluations"])
    assert result["rubric"]["status"] == "AUTHOR_DRAFT" and len(result["rubric"]["rubric_hash"]) == 64


def test_reevaluation_estimate_counts_students_and_cost(client, upload, fake_ai):
    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    client.post("/api/demo/seed")
    estimate = client.get(f"/api/rubrics/{rubric_id}/reevaluation-estimate").json()
    assert estimate["students"] == 12 and estimate["demo_students"] == 12 and estimate["live_students"] == 0
    assert estimate["estimated_cost_inr"] == 0 and estimate["ocr_calls"] == 0 and estimate["evaluation_calls"] == 0

    upload(student_name="Live Student")
    estimate = client.get(f"/api/rubrics/{rubric_id}/reevaluation-estimate").json()
    assert estimate["students"] == 13 and estimate["live_students"] == 1 and estimate["evaluation_calls"] == 1
    assert estimate["estimated_cost_inr"] > 0 and "OCR reused" in estimate["basis"]
    missing = client.get("/api/rubrics/999/reevaluation-estimate")
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_rubric"
