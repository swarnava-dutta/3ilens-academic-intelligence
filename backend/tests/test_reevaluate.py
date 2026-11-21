"""Re-evaluation without OCR (BRD FR-5.7, acceptance 14.1 'rubric edit regenerates insights and
reports without repeating OCR'): rubric versions, archived results, demo synthetic re-grades."""
from __future__ import annotations

import pytest

from tests.test_api import genetics_rubric


@pytest.fixture
def ai_ready(monkeypatch):
    import ai

    monkeypatch.setattr(ai, "ai_readiness", lambda: (True, []))


def v2_content(*, add_q6: bool = False, drop_q5: bool = False, q1_marks: float | None = None) -> dict:
    rubric = genetics_rubric()
    questions = [dict(q) for q in rubric["questions"]]
    if q1_marks is not None:
        questions[0]["max_marks"] = q1_marks
    if drop_q5:
        questions = [q for q in questions if q["question"] != 5]
    if add_q6:
        questions.append({
            "question": 6, "topic": "Linkage & Recombination", "subject": "Biology", "max_marks": 4,
            "prompt": "Define linkage.", "expected_answer": "Genes on the same chromosome inherited together.",
            "grading_criteria": ["definition"], "effort_hours": 3,
        })
    return {**rubric, "questions": questions}


def new_version(client, rubric_id: int, content: dict, *, reprocess: bool = False, note: str = "Edited marks"):
    response = client.post(f"/api/rubrics/{rubric_id}/versions",
                           json={"content": content, "change_note": note, "reprocess": reprocess})
    assert response.status_code == 201, response.text
    return response.json()


def genetics_id(client) -> int:
    return client.get("/api/rubrics").json()[0]["id"]


def test_rubric_version_is_created_with_compatibility(client):
    parent = genetics_id(client)
    body = new_version(client, parent, v2_content(add_q6=True, drop_q5=True, q1_marks=5))
    rubric = body["rubric"]
    assert rubric["version"] == "v2" and rubric["parent_id"] == parent and rubric["change_note"] == "Edited marks"
    assert rubric["status"] == "AUTHOR_DRAFT" and rubric["total_marks"] == 21 and len(rubric["rubric_hash"]) == 64
    assert body["compatibility"] == {"reusable": False, "added": [6], "removed": [5], "changed": [1]}
    assert body["queued_submission_ids"] == []
    third = new_version(client, rubric["id"], v2_content(add_q6=True, drop_q5=True, q1_marks=2))
    assert third["rubric"]["version"] == "v3" and third["rubric"]["parent_id"] == rubric["id"]
    assert third["compatibility"] == {"reusable": True, "added": [], "removed": [], "changed": [1]}
    missing = client.post("/api/rubrics/999/versions", json={"content": v2_content(), "reprocess": False})
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_rubric"


def test_live_reevaluation_reuses_ocr_and_archives_the_old_result(upload, fake_ai, client, ai_ready):
    sub = upload().json()
    v2 = new_version(client, genetics_id(client), v2_content(add_q6=True, q1_marks=2))["rubric"]
    assert fake_ai.calls == {"preprocess": 1, "ocr": 1, "evaluation": 1}

    response = client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric_id": v2["id"]})
    assert response.status_code == 202, response.text
    assert response.json()["rubric_id"] == v2["id"]

    result = client.get(f"/api/results/{sub['id']}").json()
    assert fake_ai.calls == {"preprocess": 1, "ocr": 1, "evaluation": 2}  # zero new OCR calls
    assert result["rubric"]["version"] == "v2" and result["submission"]["status"] == "COMPLETED"
    assert result["total_marks"] == 22 and result["total_score"] == 12  # Q1 capped at 2; Q6 not in the OCR
    assert [q["question"] for q in result["question_evaluations"]] == [1, 2, 3, 4, 5, 6]
    assert result["question_evaluations"][5]["outcome"] == "BLANK"
    versions = result["versions"]
    assert [(v["version"], v["rubric_version"], v["current"]) for v in versions] == [(1, "v1", False), (2, "v2", True)]
    assert versions[0]["total_score"] == 14 and versions[0]["superseded_at"]
    log = [e["message"] for e in result["processing_log"]]
    assert "Q6 is new in v2 - not in the stored OCR; re-scan needed to grade it." in log
    assert "Re-evaluated with rubric v2 (v1: 14/20 -> v2: 12/22); OCR reused - no vision call." in log
    assert any(m.startswith("OCR reused - no vision call, Rs 0.00") for m in log)
    # This run only paid for grading.
    assert result["cost"]["ocr_inr"] == 0 and result["cost"]["evaluation_inr"] > 0
    assert result["cost"]["calls"] == 1


def test_archived_versions_are_stored(upload, fake_ai, client, ai_ready, db_session):
    from database import EvaluationVersion

    sub = upload().json()
    client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric_id": None})
    rows = db_session.query(EvaluationVersion).filter_by(submission_id=sub["id"]).all()
    assert len(rows) == 1
    archived = rows[0]
    assert archived.version == 1 and archived.rubric_version == "v1" and archived.total_score == 14
    assert archived.payload["total_score"] == 14 and archived.superseded_by_rubric_id == sub["rubric_id"]
    result = client.get(f"/api/results/{sub['id']}").json()
    assert [v["version"] for v in result["versions"]] == [1, 2]
    assert fake_ai.calls["ocr"] == 1


def test_removed_questions_are_dropped_from_the_stored_answers(upload, fake_ai, client, ai_ready):
    sub = upload().json()
    v2 = new_version(client, genetics_id(client), v2_content(drop_q5=True))["rubric"]
    client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric_id": v2["id"]})
    result = client.get(f"/api/results/{sub['id']}").json()
    assert [q["question"] for q in result["question_evaluations"]] == [1, 2, 3, 4]
    assert result["total_marks"] == 16 and result["total_score"] == 12
    assert "Q5 not in rubric v2 - stored answer(s) ignored." in [e["message"] for e in result["processing_log"]]
    assert fake_ai.calls["ocr"] == 1


def test_bulk_reprocess_regrades_every_completed_sheet_without_ocr(upload, fake_ai, client, ai_ready, monkeypatch):
    monkeypatch.setenv("WORKER_CONCURRENCY", "1")  # FakeAI's call counters are not thread-safe
    client.post("/api/demo/seed")
    live = [upload(student_name=f"Live {n}").json()["id"] for n in range(2)]
    parent = genetics_id(client)
    estimate = client.get(f"/api/rubrics/{parent}/reevaluation-estimate").json()
    assert estimate["students"] == 14 and estimate["evaluation_calls"] == 2 and estimate["ocr_calls"] == 0

    body = new_version(client, parent, v2_content(q1_marks=5), reprocess=True)
    assert len(body["queued_submission_ids"]) == 14 and set(live) <= set(body["queued_submission_ids"])
    assert fake_ai.calls["ocr"] == 2 and fake_ai.calls["evaluation"] == 4  # 2 uploads + 2 re-grades
    listing = client.get("/api/submissions", params={"rubric_id": body["rubric"]["id"]}).json()
    assert len(listing) == 14 and all(s["status"] == "COMPLETED" for s in listing)
    assert client.get("/api/submissions", params={"rubric_id": parent}).json()[0]["status"] == "HUMAN_REVIEW_REQUIRED"


def test_demo_rows_are_regraded_synthetically_without_ai(client, forbid_ai):
    client.post("/api/demo/seed")
    demo = next(s for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED")
    before = client.get(f"/api/results/{demo['id']}").json()
    v2 = new_version(client, genetics_id(client), v2_content(add_q6=True))["rubric"]

    response = client.post(f"/api/submissions/{demo['id']}/reevaluate", json={"rubric_id": v2["id"]})
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "COMPLETED"  # synthetic: done immediately
    after = client.get(f"/api/results/{demo['id']}").json()
    assert forbid_ai == []
    assert after["rubric"]["version"] == "v2" and after["total_marks"] == 24
    assert after["total_score"] == before["total_score"]  # carried-over grades; new Q6 scores 0
    q6 = after["question_evaluations"][5]
    assert q6["question"] == 6 and q6["estimated_marks"] == 0
    assert "Not graded - new in this rubric version (demo)" in q6["gaps"]
    assert [(v["version"], v["current"]) for v in after["versions"]] == [(1, False), (2, True)]
    log = [e["message"] for e in after["processing_log"]]
    assert any("Synthetic demo re-run - no AI call" in m for m in log)
    assert any(m.startswith("Re-evaluated with rubric v2 (v1: ") for m in log)
    assert after["cost"]["synthetic"] is True


def test_demo_marks_are_clamped_to_the_new_maximum(client, forbid_ai):
    client.post("/api/demo/seed")
    demo = next(s for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED")
    v2 = new_version(client, genetics_id(client), v2_content(q1_marks=1))["rubric"]
    client.post(f"/api/submissions/{demo['id']}/reevaluate", json={"rubric_id": v2["id"]})
    q1 = client.get(f"/api/results/{demo['id']}").json()["question_evaluations"][0]
    assert q1["max_marks"] == 1 and q1["estimated_marks"] <= 1


def test_reevaluate_validation(upload, fake_ai, client, ai_ready):
    import ai

    fake_ai.answer_confidence = 0.55
    held = upload().json()
    response = client.post(f"/api/submissions/{held['id']}/reevaluate", json={"rubric_id": None})
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    fake_ai.answer_confidence = 0.93
    done = upload().json()
    unknown = client.post(f"/api/submissions/{done['id']}/reevaluate", json={"rubric_id": 999})
    assert unknown.status_code == 422 and unknown.json()["code"] == "unknown_rubric"
    assert client.post("/api/submissions/987654/reevaluate", json={}).status_code == 404
    # No body at all = the current rubric.
    assert client.post(f"/api/submissions/{done['id']}/reevaluate").status_code == 202


def test_live_reevaluation_needs_a_configured_ai(upload, fake_ai, client):
    sub = upload().json()
    response = client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric_id": None})
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"
    assert client.get(f"/api/results/{sub['id']}").status_code == 200  # untouched
    bulk = client.post(f"/api/rubrics/{sub['rubric_id']}/versions",
                       json={"content": v2_content(), "reprocess": True})
    assert bulk.status_code == 503 and len(client.get("/api/rubrics").json()) == 1  # nothing created


def test_failed_reevaluation_can_be_retried_without_ocr(upload, fake_ai, client, ai_ready):
    import ai

    sub = upload().json()
    fake_ai.evaluation_error = ai.AIServiceError("Grading refused.", code="refusal")
    client.post(f"/api/submissions/{sub['id']}/reevaluate", json={"rubric_id": None})
    assert client.get(f"/api/results/{sub['id']}").json()["status"] == "FAILED"
    fake_ai.evaluation_error = None
    assert client.post(f"/api/submissions/{sub['id']}/retry").status_code == 202
    result = client.get(f"/api/results/{sub['id']}").json()
    assert result["submission"]["status"] == "COMPLETED" and fake_ai.calls["ocr"] == 1
    assert [v["version"] for v in result["versions"]] == [1, 2]


def test_bulk_runs_are_parallel_but_bounded(isolated_env, monkeypatch):
    """process_many grades WORKER_CONCURRENCY sheets at a time (one BackgroundTask per bulk re-run)."""
    import threading
    import time

    import pipeline

    monkeypatch.setenv("WORKER_CONCURRENCY", "3")
    lock = threading.Lock()
    state = {"running": 0, "peak": 0, "done": []}

    def fake_process(submission_id, *, mode="full", reason=None):
        with lock:
            state["running"] += 1
            state["peak"] = max(state["peak"], state["running"])
        time.sleep(0.1)
        with lock:
            state["running"] -= 1
            state["done"].append((submission_id, mode, reason))

    monkeypatch.setattr(pipeline, "process_submission", fake_process)
    pipeline.process_many([1, 2, 3, 4, 5, 3], mode="evaluation_only", reason="reevaluate")
    assert sorted(state["done"]) == [(n, "evaluation_only", "reevaluate") for n in range(1, 6)]
    assert 1 < state["peak"] <= 3


def test_concurrent_bulk_reevaluation_completes_every_sheet(upload, fake_ai, client, ai_ready, monkeypatch):
    """Real pipeline runs on 4 worker threads against SQLite (only the fake's counters are locked)."""
    import threading

    import ai

    lock = threading.Lock()
    grade = fake_ai.run_evaluation

    def locked_grade(*args, **kwargs):
        with lock:
            return grade(*args, **kwargs)

    live = [upload(student_name=f"Student {n}").json()["id"] for n in range(6)]
    monkeypatch.setattr(ai, "run_evaluation", locked_grade)
    monkeypatch.setenv("WORKER_CONCURRENCY", "4")
    body = new_version(client, genetics_id(client), v2_content(q1_marks=2), reprocess=True)
    assert sorted(body["queued_submission_ids"]) == sorted(live)
    rows = client.get("/api/submissions").json()
    assert all(r["status"] == "COMPLETED" and r["rubric_id"] == body["rubric"]["id"] for r in rows)
    assert all(r["total_score"] == 12 for r in rows)
    assert fake_ai.calls["ocr"] == 6 and fake_ai.calls["evaluation"] == 12


def test_version_endpoints_list_and_serve_archived_snapshots(client, forbid_ai):
    client.post("/api/demo/seed")
    demo = next(s for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED")
    only = client.get(f"/api/results/{demo['id']}/versions").json()
    assert [(v["version"], v["current"]) for v in only] == [(1, True)]
    before = client.get(f"/api/results/{demo['id']}").json()
    v2 = new_version(client, genetics_id(client), v2_content(add_q6=True))["rubric"]
    client.post(f"/api/submissions/{demo['id']}/reevaluate", json={"rubric_id": v2["id"]})

    rows = client.get(f"/api/results/{demo['id']}/versions").json()
    assert [(v["version"], v["rubric_version"], v["current"]) for v in rows] == [(1, "v1", False), (2, "v2", True)]
    old = client.get(f"/api/results/{demo['id']}/versions/1").json()
    assert old["superseded"] is True and old["superseded_by"] == 2
    assert [(v["version"], v["current"]) for v in old["versions"]] == [(1, False), (2, True)]
    assert old["total_marks"] == before["total_marks"] and old["rubric"]["version"] == "v1"
    current = client.get(f"/api/results/{demo['id']}/versions/2").json()
    assert current["superseded"] is False and current["total_marks"] == 24
    missing = client.get(f"/api/results/{demo['id']}/versions/9")
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_version"
    assert client.get("/api/results/99999/versions").status_code == 404


def test_institutions_and_health_defaults(client):
    assert client.get("/api/health").json()["intervention_default_hours"] == 3.0
    institutions = client.get("/api/institutions").json()
    assert institutions and set(institutions[0]) == {"id", "name"}
