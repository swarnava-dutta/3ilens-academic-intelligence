"""POST /api/results/{id}/consistency-check (FR-3.5): one re-grade with purpose 'consistency',
compared per question with the stored marks; tolerance +/-2 marks. ai.run_evaluation is
monkeypatched - no network."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import ai  # noqa: E402
from ai_schemas import EvaluationOutput, ModelUsage, OcrAnswer, OcrResult, QuestionGrade  # noqa: E402
from config import get_settings  # noqa: E402
from database import ModelInvocation, StudentSubmission, SubmissionStatus  # noqa: E402
from tests.test_contract import check_interface  # noqa: E402

TEST_KEY = "sk-ant-test-consistency-0000"


@pytest.fixture
def seeded(client, db_session):
    assert client.post("/api/demo/seed").status_code == 200
    subs = db_session.query(StudentSubmission).order_by(StudentSubmission.id).all()
    completed = next(s for s in subs if s.status == SubmissionStatus.COMPLETED and s.result.total_score < 15)
    review = next(s for s in subs if s.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED)
    return completed, review


class FakeRegrade:
    """Stands in for ai.run_evaluation: stored marks plus per-question offsets."""

    def __init__(self, sub: StudentSubmission, offsets: dict[int, float] | None = None, error: Exception | None = None):
        self.stored = {q["question"]: q["estimated_marks"] for q in sub.result.question_evaluations}
        self.offsets = offsets or {}
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def __call__(self, answers, rubric_content, **kwargs):
        self.calls.append({"answers": answers, "rubric": rubric_content, **kwargs})
        usage = ModelUsage(purpose=kwargs.get("purpose", "evaluation"), provider="anthropic",
                           model_requested="claude-sonnet-5-5", model_served="claude-sonnet-5-5",
                           request_id="req_consistency_1", input_tokens=300, output_tokens=700,
                           cache_read_input_tokens=2100, latency_ms=900,
                           status="error" if self.error else "ok",
                           error_code=getattr(self.error, "code", None))
        kwargs["on_usage"](usage)
        if self.error:
            raise self.error
        return EvaluationOutput(
            evaluations=[
                QuestionGrade(question=n, estimated_marks=marks + self.offsets.get(n, 0.0), evidence="e",
                              strengths=[], gaps=[])
                for n, marks in self.stored.items()
            ],
            overall_strengths=[], overall_gaps=[],
        )


def _run(client, monkeypatch, sub, fake):
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    monkeypatch.setattr(ai, "run_evaluation", fake)
    return client.post(f"/api/results/{sub.id}/consistency-check")


def test_regrade_within_tolerance(client, db_session, monkeypatch, seeded):
    sub, _review = seeded
    fake = FakeRegrade(sub, offsets={1: 0.5, 3: 0.4})  # +0.5 and +0.4 -> rounded to the 0.5 grid
    response = _run(client, monkeypatch, sub, fake)
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "ConsistencyCheck")
    assert body["submission_id"] == sub.id and body["runs"] == 1 and body["tolerance"] == 2
    assert body["within_tolerance"] is True
    deltas = {d["question"]: d for d in body["deltas"]}
    assert [d["question"] for d in body["deltas"]] == [1, 2, 3, 4, 5]
    assert deltas[1]["delta"] == pytest.approx(min(0.5, 4 - deltas[1]["original"]))
    assert body["total_original"] == sub.result.total_score
    assert body["max_abs_delta_total"] == pytest.approx(abs(body["total_regrade"] - body["total_original"]))

    (call,) = fake.calls
    assert call["purpose"] == "consistency"
    # Demo rows have no OCR artifact: the stored student answers are re-graded.
    stored = {q["question"]: q["student_answer"] for q in sub.result.question_evaluations if q["student_answer"]}
    assert {a.question: a.answer for a in call["answers"]} == stored

    artifact = json.loads((get_settings().artifact_dir / str(sub.id) / "consistency.json").read_text(encoding="utf-8"))
    assert artifact["within_tolerance"] is True and artifact["transcript_source"] == "stored answers"
    db_session.expire_all()
    log = db_session.get(StudentSubmission, sub.id).processing_log
    assert log[-1]["step"] == "Consistency check"
    assert log[-1]["message"].startswith(f"Re-grade delta {body['max_abs_delta_total']:g} marks")
    assert "within +/-2" in log[-1]["message"]
    (row,) = db_session.query(ModelInvocation).filter_by(submission_id=sub.id).all()
    assert row.purpose == "consistency" and row.cache_read_input_tokens == 2100 and row.status == "ok"


def test_regrade_outside_tolerance(client, db_session, monkeypatch, seeded):
    sub, _review = seeded
    fake = FakeRegrade(sub, offsets={n: 1.0 for n in range(1, 6)})  # up to +5 marks
    body = _run(client, monkeypatch, sub, fake).json()
    assert body["max_abs_delta_total"] > 2 and body["within_tolerance"] is False
    db_session.expire_all()
    assert "outside +/-2" in db_session.get(StudentSubmission, sub.id).processing_log[-1]["message"]


def test_regrade_uses_the_reviewed_transcript_first(client, monkeypatch, seeded):
    sub, _review = seeded
    folder = get_settings().artifact_dir / str(sub.id)
    folder.mkdir(parents=True, exist_ok=True)
    raw = OcrResult(answers=[OcrAnswer(question=1, answer="raw OCR", confidence=0.9)], overall_confidence=0.9,
                    provider="anthropic", model="m")
    reviewed = OcrResult(answers=[OcrAnswer(question=1, answer="faculty corrected", confidence=1.0, source="faculty")],
                         overall_confidence=1.0, provider="anthropic", model="m")
    (folder / "ocr.json").write_text(raw.model_dump_json(), encoding="utf-8")
    fake = FakeRegrade(sub)
    assert _run(client, monkeypatch, sub, fake).status_code == 200
    assert [a.answer for a in fake.calls[-1]["answers"]] == ["raw OCR"]
    (folder / "ocr_reviewed.json").write_text(reviewed.model_dump_json(), encoding="utf-8")
    assert _run(client, monkeypatch, sub, fake).status_code == 200
    assert [a.answer for a in fake.calls[-1]["answers"]] == ["faculty corrected"]


def test_without_a_key_is_503(client, monkeypatch, seeded):
    sub, _review = seeded

    def forbidden(*_args, **_kwargs):
        raise AssertionError("no AI call expected")

    monkeypatch.setattr(ai, "run_evaluation", forbidden)
    response = client.post(f"/api/results/{sub.id}/consistency-check")
    assert response.status_code == 503 and response.json()["code"] == "ai_not_configured"


def test_not_completed_is_409_and_unknown_is_404(client, monkeypatch, seeded):
    _sub, review = seeded
    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    response = client.post(f"/api/results/{review.id}/consistency-check")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    response = client.post("/api/results/99999/consistency-check")
    assert response.status_code == 404 and response.json()["code"] == "not_found"


def test_ai_failure_is_502_and_the_failed_call_is_recorded(client, db_session, monkeypatch, seeded):
    sub, _review = seeded
    fake = FakeRegrade(sub, error=ai.AIServiceError("Claude rate limit", transient=True, code="rate_limited"))
    response = _run(client, monkeypatch, sub, fake)
    assert response.status_code == 502 and response.json()["code"] == "rate_limited"
    (row,) = db_session.query(ModelInvocation).filter_by(submission_id=sub.id).all()
    assert row.status == "error" and row.error_code == "rate_limited"
    assert not (get_settings().artifact_dir / str(sub.id) / "consistency.json").exists()


def test_mcq_regrade_keeps_the_deterministic_marks(upload, fake_ai, client, monkeypatch):
    """MCQs are scored from the transcript (+4/-1/0), never from the re-grade: no false delta."""
    from tests.test_contract_v3 import MCQ_LETTERS, MCQ_RUBRIC

    def letters_ocr(pages, rubric_content, **kwargs):
        fake_ai.calls["ocr"] += 1
        answers = [OcrAnswer(question=n, answer=f"({letter.lower()})", confidence=0.95)
                   for n, letter in MCQ_LETTERS.items()]
        return OcrResult(answers=answers, overall_confidence=0.95, provider="anthropic", model="fake-vision-model")

    monkeypatch.setattr(ai, "run_ocr", letters_ocr)
    queued = upload(student_name="MCQ Consistency", rubric_json=json.dumps(MCQ_RUBRIC))
    assert queued.status_code == 202, queued.text
    sub_id = queued.json()["id"]
    assert client.get(f"/api/results/{sub_id}").json()["total_score"] == 3

    def regrade(answers, rubric_content, **kwargs):  # an all-MCQ paper makes no grading call
        return EvaluationOutput(evaluations=[], overall_strengths=[], overall_gaps=[])

    monkeypatch.setenv("ANTHROPIC_API_KEY", TEST_KEY)
    monkeypatch.setattr(ai, "run_evaluation", regrade)
    body = client.post(f"/api/results/{sub_id}/consistency-check").json()
    assert [(d["question"], d["original"], d["regrade"], d["delta"]) for d in body["deltas"]] == [
        (1, 4.0, 4.0, 0.0), (2, -1.0, -1.0, 0.0), (3, 0.0, 0.0, 0.0),
    ]
    assert body["total_regrade"] == body["total_original"] == 3 and body["within_tolerance"] is True
