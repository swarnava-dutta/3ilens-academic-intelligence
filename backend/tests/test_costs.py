"""Cost and trace (acceptance 14.3: cost per student < Rs 5, every LLM call traced, latency per
sheet). The fake AI layer reports fixed token counts on claude-sonnet-5-5 through on_usage."""
from __future__ import annotations

import pytest

from tests.conftest import FAKE_EVALUATION_TOKENS, FAKE_OCR_TOKENS

# claude-sonnet-5-5: $2 / MTok input, $10 / MTok output (costing.PRICING_USD_PER_MTOK).
OCR_USD = (FAKE_OCR_TOKENS[0] * 2 + FAKE_OCR_TOKENS[1] * 10) / 1_000_000  # 0.0054
EVAL_USD = (FAKE_EVALUATION_TOKENS[0] * 2 + FAKE_EVALUATION_TOKENS[1] * 10) / 1_000_000  # 0.013


def completed(client, upload) -> dict:
    sub = upload().json()
    response = client.get(f"/api/results/{sub['id']}")
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# costing
# --------------------------------------------------------------------------- #
def test_price_table_and_prefix_matching(isolated_env):
    import costing
    from ai_schemas import ModelUsage

    usage = ModelUsage(purpose="ocr", provider="anthropic", model_requested="x", input_tokens=1_000_000,
                       output_tokens=1_000_000, cache_creation_input_tokens=1_000_000,
                       cache_read_input_tokens=1_000_000)
    assert costing.cost_usd("claude-sonnet-5-5", usage) == pytest.approx(2 + 10 + 2.5 + 0.1)
    assert costing.cost_usd("claude-sonnet-5-5-20261101", usage) == pytest.approx(14.6)  # dated snapshot
    assert costing.cost_usd("claude-sonnet-5", usage) == pytest.approx(2 + 10 + 2.5 + 0.2)
    assert costing.cost_usd("claude-opus-5-5", usage) == pytest.approx(4 + 20 + 5 + 0.2)
    # OpenAI: no cache-write premium; cached input billed at the cached-input rate.
    assert costing.cost_usd("gpt-4o", usage) == pytest.approx(2.5 + 10 + 0 + 1.25)
    assert costing.cost_usd("gpt-4o-mini-2024-07-18", usage) == pytest.approx(0.15 + 0.6 + 0 + 0.075)
    assert costing.cost_usd("mystery-model", usage) is None
    assert costing.cost_usd(None, usage) is None
    assert costing.to_inr(1.0) == 85 and costing.to_inr(None) is None
    assert costing.format_inr(1.844) == "Rs 1.84" and "unknown" in costing.format_inr(None)


def test_pricing_and_exchange_rate_are_configurable(isolated_env, monkeypatch):
    import costing
    from ai_schemas import ModelUsage

    usage = ModelUsage(purpose="evaluation", provider="anthropic", model_requested="x", input_tokens=1_000_000)
    monkeypatch.setenv("LLM_PRICING_JSON", '{"claude-sonnet-5-5": {"input": 3}, "local-model": {"input": 1}}')
    assert costing.cost_usd("claude-sonnet-5-5", usage) == pytest.approx(3)
    assert costing.cost_usd("local-model", usage) == pytest.approx(1)
    monkeypatch.setenv("USD_INR", "90")
    assert costing.to_inr(2.0) == 180


# --------------------------------------------------------------------------- #
# Per-sheet cost, trace and latency
# --------------------------------------------------------------------------- #
def test_every_call_is_traced_with_tokens_and_cost(upload, fake_ai, client):
    result = completed(client, upload)
    invocations = client.get(f"/api/submissions/{result['submission']['id']}/invocations").json()
    assert [(i["purpose"], i["status"]) for i in invocations] == [("ocr", "ok"), ("evaluation", "ok")]
    ocr, evaluation = invocations
    assert (ocr["input_tokens"], ocr["output_tokens"]) == FAKE_OCR_TOKENS
    assert ocr["request_id"] == "req_fake_ocr_1" and ocr["image_count"] == 1 and ocr["latency_ms"] == 1500
    assert ocr["model_requested"] == "claude-sonnet-5-5" and ocr["fell_back"] is False
    assert ocr["cost_usd"] == pytest.approx(OCR_USD) and ocr["cost_inr"] == pytest.approx(OCR_USD * 85, abs=1e-4)
    assert evaluation["cost_inr"] == pytest.approx(EVAL_USD * 85, abs=1e-4)
    assert client.get("/api/submissions/987654/invocations").status_code == 404


def test_result_cost_matches_the_hand_computed_price(upload, fake_ai, client):
    result = completed(client, upload)
    expected = (OCR_USD + EVAL_USD) * 85  # Rs 1.564
    cost = result["cost"]
    assert cost["llm_cost_inr"] == pytest.approx(expected, abs=1e-3)
    assert cost["ocr_inr"] == pytest.approx(OCR_USD * 85, abs=1e-3)
    assert cost["evaluation_inr"] == pytest.approx(EVAL_USD * 85, abs=1e-3)
    assert cost["other_inr"] == 0 and cost["calls"] == 2 and cost["synthetic"] is False
    assert cost["within_target"] is True and cost["target_inr"] == 5 and cost["usd_inr"] == 85
    assert result["submission"]["llm_cost_inr"] == pytest.approx(expected, abs=1e-3)
    log = [e["message"] for e in result["processing_log"]]
    assert any(m.startswith("AI call 1 (OCR): 1,200 in / 300 out tokens, cache read 0 = Rs 0.46 "
                            "(request req_fake_ocr_1; ") for m in log)
    assert any(m.startswith("AI call 2 (evaluation): 2,500 in / 800 out tokens, cache read 0 = Rs ") for m in log)
    assert any("LLM cost Rs 1.56 vs the Rs 5.00 target (2 AI calls)" in m for m in log)


def test_exchange_rate_applies_to_new_calls(upload, fake_ai, client, monkeypatch):
    monkeypatch.setenv("USD_INR", "90")
    result = completed(client, upload)
    assert result["cost"]["llm_cost_inr"] == pytest.approx((OCR_USD + EVAL_USD) * 90, abs=1e-3)
    assert result["cost"]["usd_inr"] == 90


def test_unknown_model_cost_is_reported_as_unknown(upload, fake_ai, client, monkeypatch):
    import tests.conftest as conftest

    monkeypatch.setattr(conftest, "FAKE_USAGE_MODEL", "mystery-model-9")
    result = completed(client, upload)
    assert result["cost"]["llm_cost_inr"] is None and result["cost"]["within_target"] is None
    log = [e["message"] for e in result["processing_log"]]
    assert any("cost unknown (model not in the price table)" in m for m in log)


def test_latency_and_stages_are_reported(upload, fake_ai, client):
    result = completed(client, upload)
    latency = result["latency"]
    assert latency["seconds"] is not None and latency["seconds"] >= 0
    assert latency["within_target"] is True and latency["target_seconds"] == 300
    steps = {stage["step"] for stage in latency["stages"]}
    assert {"Custody", "Pre-processing", "OCR & Parse", "Rubric Evaluation"} <= steps
    submission = result["submission"]
    assert submission["started_at"] and submission["completed_at"]
    assert submission["completed_at"] >= submission["started_at"]


def test_stage_durations_ignore_entries_logged_after_completion(upload, fake_ai, client, db_session):
    """Faculty sign-off / delivery lines come after the run: they are not pipeline stages, even
    when written within seconds of completion, and must not stretch the Persistence stage."""
    from datetime import timedelta

    from database import StudentSubmission, utc_iso

    sid = completed(client, upload)["submission"]["id"]
    assert client.post(f"/api/results/{sid}/release", json={"reviewer_name": "Dr. Rao"}).status_code == 200
    row = db_session.get(StudentSubmission, sid)
    later = utc_iso(row.completed_at + timedelta(hours=3))
    row.processing_log = [*row.processing_log, {"step": "Delivery", "message": "Simulated.", "timestamp": later},
                          {"step": "Persistence", "message": "Late line.", "timestamp": later}]
    db_session.commit()
    stages = {s["step"]: s["seconds"] for s in client.get(f"/api/results/{sid}").json()["latency"]["stages"]}
    assert "Faculty sign-off" not in stages and "Delivery" not in stages
    assert {"Custody", "Pre-processing", "OCR & Parse", "Rubric Evaluation", "Persistence"} <= set(stages)
    assert stages["Persistence"] < 60  # the 3 h gap to the late lines is not counted


# --------------------------------------------------------------------------- #
# Roll-ups
# --------------------------------------------------------------------------- #
def test_ops_costs_grouping(upload, fake_ai, client):
    completed(client, upload)
    completed(client, upload)
    per_sheet = (OCR_USD + EVAL_USD) * 85

    by_purpose = client.get("/api/ops/costs").json()
    assert by_purpose["group_by"] == "purpose"
    groups = {g["key"]: g for g in by_purpose["groups"]}
    assert set(groups) == {"ocr", "evaluation"}
    assert groups["ocr"]["calls"] == 2 and groups["ocr"]["input_tokens"] == 2 * FAKE_OCR_TOKENS[0]
    assert groups["evaluation"]["cost_inr"] == pytest.approx(2 * EVAL_USD * 85, abs=1e-3)
    assert by_purpose["groups"][0]["key"] == "evaluation"  # most expensive first
    assert by_purpose["total_cost_inr"] == pytest.approx(2 * per_sheet, abs=1e-3)
    assert by_purpose["calls"] == 4 and by_purpose["students"] == 2
    assert by_purpose["avg_cost_per_student_inr"] == pytest.approx(per_sheet, abs=0.01)
    assert by_purpose["ocr_cache_hits"] == 0 and by_purpose["target_inr"] == 5 and by_purpose["usd_inr"] == 85

    keys = {
        group_by: [g["key"] for g in client.get("/api/ops/costs", params={"group_by": group_by}).json()["groups"]]
        for group_by in ("model", "batch", "institution")
    }
    assert keys == {"model": ["claude-sonnet-5-5"], "batch": ["NEET-A"], "institution": ["Instit-42"]}
    assert client.get("/api/ops/costs", params={"group_by": "student"}).status_code == 422


def test_ops_costs_counts_cache_hits(upload, fake_ai, client, monkeypatch):
    monkeypatch.setenv("OCR_CACHE", "1")
    completed(client, upload)
    completed(client, upload)
    body = client.get("/api/ops/costs").json()
    assert body["ocr_cache_hits"] == 1 and body["calls"] == 3
    assert {g["key"]: g["calls"] for g in body["groups"]} == {"evaluation": 2, "ocr": 1}


def test_empty_ops_costs(client):
    body = client.get("/api/ops/costs").json()
    assert body["groups"] == [] and body["total_cost_inr"] == 0 and body["avg_cost_per_student_inr"] is None


def test_cohort_operations_summarise_live_sheets(upload, fake_ai, client):
    completed(client, upload)
    operations = client.get("/api/cohort").json()["operations"]
    assert operations["calls"] == 2
    assert operations["total_cost_inr"] == pytest.approx((OCR_USD + EVAL_USD) * 85, abs=0.01)
    assert operations["avg_cost_per_student_inr"] == pytest.approx((OCR_USD + EVAL_USD) * 85, abs=0.01)
    assert operations["avg_latency_seconds"] is not None and operations["over_latency_target"] == 0
    assert operations["mean_ocr_confidence"] == pytest.approx(0.93)


def test_cost_per_student_ignores_rows_graded_before_cost_tracking(upload, fake_ai, client, db_session):
    """A completed live row with no traced calls (graded by an older build) must not dilute the
    average cost per student, in the cohort operations or in /api/ops/costs."""
    traced = completed(client, upload)
    legacy = completed(client, upload)
    from sqlalchemy import delete

    from database import ModelInvocation

    db_session.execute(delete(ModelInvocation).where(ModelInvocation.submission_id == legacy["submission"]["id"]))
    db_session.commit()
    per_sheet = (OCR_USD + EVAL_USD) * 85
    operations = client.get("/api/cohort").json()["operations"]
    assert operations["calls"] == 2 and traced["submission"]["id"] != legacy["submission"]["id"]
    assert operations["avg_cost_per_student_inr"] == pytest.approx(per_sheet, abs=0.01)
    body = client.get("/api/ops/costs").json()
    assert body["students"] == 1
    assert body["avg_cost_per_student_inr"] == pytest.approx(per_sheet, abs=0.01)


def test_intake_batch_progress(upload, fake_ai, client):
    import ai

    for name in ("One", "Two"):
        upload(student_name=name, intake_batch_id="folder-01")
    upload(student_name="Blurry", filename="blurry_x.png", intake_batch_id="folder-01")
    fake_ai.ocr_error = ai.AIServiceError("Refused.", code="refusal")
    upload(student_name="Failed", intake_batch_id="folder-01")
    body = client.get("/api/intake-batches/folder-01").json()
    assert (body["total"], body["completed"], body["human_review"], body["failed"], body["processing"]) == (4, 2, 1, 1, 0)
    assert body["started_at"] and body["elapsed_seconds"] >= 0 and body["eta_seconds"] == 0
    assert body["target_seconds"] == 1800
    missing = client.get("/api/intake-batches/nope")
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_intake_batch"
    assert client.get("/api/intake-batches/bad id!").status_code == 404
