"""Owner what-if engine (FR-4.14): the linear effort-response math, scope (latest result per
student), errors, calibration and the options endpoint. Deterministic - no AI."""
from __future__ import annotations

from datetime import timedelta

import pytest

import whatif
from database import Batch, EvaluationResult, Rubric, StudentSubmission, SubmissionStatus, utcnow
from hashing import student_ref_for
from tests.test_contract import check_interface

SUBJECTS = {
    "Human Physiology": "Biology", "Ecology": "Biology", "Mechanics": "Physics", "Organic Chemistry": "Chemistry",
    "Genetics": "Biology", "Quantum Gravity": "Physics",
}


def add_result(
    db,
    name: str,
    topics: dict[str, float],
    *,
    days_ago: float = 0,
    batch_id: int | None = None,
    status: str = SubmissionStatus.COMPLETED,
    is_demo: bool = False,
) -> StudentSubmission:
    """A completed submission whose result has one 4-mark question per topic at the given mastery."""
    rubric = db.query(Rubric).order_by(Rubric.id).first()
    batch = db.get(Batch, batch_id) if batch_id else db.query(Batch).order_by(Batch.id).first()
    rows = []
    for topic, mastery in topics.items():
        score = 4.0 * mastery / 100
        rows.append({"topic": topic, "subject": SUBJECTS.get(topic, "Biology"), "score": score, "max_marks": 4.0,
                     "mastery": float(mastery), "weightage": 0.05, "effort_hours": 3.0, "chapter": None,
                     "questions": [], "n": 1, "full": 0, "partial": 1, "zero": 0, "blank": 0})
    total = 4.0 * len(rows)
    score = sum(r["score"] for r in rows)
    created = utcnow() - timedelta(days=days_ago)
    sub = StudentSubmission(
        student_name=name, file_path="", original_filename=f"{name}.pdf", mime_type="application/pdf",
        status=status, batch_id=batch.id, rubric_id=rubric.id, created_at=created, is_demo=is_demo,
        student_ref=student_ref_for(name),
    )
    if status == SubmissionStatus.COMPLETED:
        sub.result = EvaluationResult(
            total_score=score, total_marks=total, overall_mastery=round(score / total * 100, 1), topic_mastery=rows,
            roi_recommendations=[], strengths_gaps={"strengths": [], "gaps": []}, question_evaluations=[],
            rubric_id=rubric.id, created_at=created,
        )
    db.add(sub)
    db.commit()
    return sub


def _run(client, scenarios, **scope):
    return client.post("/api/whatif", json={"scenarios": scenarios, **scope})


# --------------------------------------------------------------------------- #
# Math
# --------------------------------------------------------------------------- #
def test_effort_bands_prediction_and_exam_marks():
    # Human Physiology: from_low 10.5 / from_mid 7 / from_high 3.5, avg 26 marks (illustrative matrix).
    assert whatif.hours_to_target("Human Physiology", "Biology", None, 30, None) == 10.5
    assert whatif.hours_to_target("Human Physiology", "Biology", None, 50, None) == 7.0
    assert whatif.hours_to_target("Human Physiology", "Biology", None, 70, None) == 3.5
    assert whatif.hours_to_target("Quantum Gravity", "Physics", None, 50, 4.0) == 4.0
    assert whatif.hours_to_target("Quantum Gravity", "Physics", None, 50, None) is None
    assert whatif.predicted_gain_pct(50, 5, 7) == 25.0
    assert whatif.predicted_gain_pct(50, 20, 7) == 35.0  # capped at the 85% target
    assert whatif.predicted_gain_pct(55, 3, None) == 15.0  # 6 h fallback
    assert whatif.predicted_gain_pct(50, 5, 7, 0.5) == 12.5
    assert whatif.predicted_gain_pct(90, 5, 7) == 0.0
    assert whatif.exam_marks_for("Human Physiology", "Biology", None, 0.05) == 26.0
    assert whatif.exam_marks_for("Quantum Gravity", "Physics", None, 0.05) == 36.0  # 0.05 x 720


def test_one_student_at_50_percent_gains_25_points(client, db_session):
    sub = add_result(db_session, "Whatif One", {"Human Physiology": 50})
    response = _run(client, [{"topic": "human physiology", "extra_hours": 5}])
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "WhatIfResult")
    [scenario] = body["scenarios"]
    assert scenario["topic"] == "Human Physiology" and scenario["chapter"] == "Human Physiology"
    assert scenario["hours_to_target"] == 7.0 and scenario["students_assessed"] == 1
    [row] = scenario["students"]
    assert row["submission_id"] == sub.id and row["mastery_before"] == 50 and row["mastery_after"] == 75
    assert row["exam_marks_gain"] == pytest.approx(26 * 0.25)
    impact = scenario["impact"]
    assert impact["exam_marks_avg"] == pytest.approx(6.5)
    assert impact["exam_marks_low"] == pytest.approx(6.5 * 0.3) and impact["exam_marks_high"] == pytest.approx(6.5 * 1.7)
    assert impact["test_pct_points_avg"] == pytest.approx(25.0) and impact["exam_scale_max"] == 720
    assert body["baseline_avg_pct"] == 50 and body["projected_avg_pct"] == 75
    assert body["combined"]["exam_marks_avg"] == pytest.approx(6.5)
    assert body["calibrated"] is False and body["calibration_factor"] == 1.0
    assert body["label"].startswith("Illustrative - linear effort-response model")
    assert 5 <= len(body["assumptions"]) <= 6
    assert scenario["headline"].startswith("+5 h of Human Physiology for every student in this scope -> about +6.5 NEET marks")


def test_students_at_target_gain_nothing_and_combined_sums_scenarios(client, db_session):
    add_result(db_session, "Whatif High", {"Human Physiology": 90, "Ecology": 40})
    add_result(db_session, "Whatif Mid", {"Human Physiology": 50})
    body = _run(client, [{"topic": "Human Physiology", "extra_hours": 5}, {"topic": "Ecology", "extra_hours": 3}]).json()
    physiology, ecology = body["scenarios"]
    assert physiology["students_assessed"] == 2 and physiology["students_at_target"] == 1
    high = next(s for s in physiology["students"] if s["student_name"] == "Whatif High")
    assert high["exam_marks_gain"] == 0 and high["mastery_after"] == 90
    assert ecology["students_assessed"] == 1
    # Ecology at 40%: from_mid 3 h -> 45 pts x 3/3 = 45; 13 exam marks x 0.45 = 5.85.
    assert ecology["students"][0]["exam_marks_gain"] == pytest.approx(5.85)
    # Combined: Whatif High 0 + 5.85, Whatif Mid 6.5 -> mean 6.175 over the two assessed students.
    assert body["combined"]["exam_marks_avg"] == pytest.approx((5.85 + 6.5) / 2, abs=0.01)
    assert body["students_considered"] == 2


def test_students_at_target_before_and_after_the_extra_hours(client, db_session):
    add_result(db_session, "Whatif Top", {"Human Physiology": 90})
    add_result(db_session, "Whatif Gap", {"Human Physiology": 50})  # from_mid 7 h to reach 85%
    short = _run(client, [{"topic": "Human Physiology", "extra_hours": 5}]).json()["scenarios"][0]
    assert (short["students_at_target"], short["students_at_target_after"]) == (1, 1)
    full = _run(client, [{"topic": "Human Physiology", "extra_hours": 7}]).json()["scenarios"][0]
    assert (full["students_at_target"], full["students_at_target_after"]) == (1, 2)
    # The count agrees with the per-student table.
    assert full["students_at_target_after"] == sum(1 for s in full["students"] if s["mastery_after"] >= 85)


def test_means_round_half_up_like_the_owner_page():
    assert whatif.r1(56.25) == 56.3 and whatif.r1(71.25) == 71.3 and whatif.r1(41.04) == 41.0


def test_latest_result_per_student_is_the_baseline(client, db_session):
    add_result(db_session, "Whatif Repeat", {"Human Physiology": 20}, days_ago=10)
    add_result(db_session, "Whatif Repeat", {"Human Physiology": 50}, days_ago=1)
    body = _run(client, [{"topic": "Human Physiology", "extra_hours": 5}]).json()
    assert body["students_considered"] == 1
    assert body["scenarios"][0]["students"][0]["mastery_before"] == 50


def test_errors_unknown_topic_empty_scope_and_unknown_batch(client, db_session):
    add_result(db_session, "Whatif Err", {"Human Physiology": 50})
    unknown = _run(client, [{"topic": "Astrophysics", "extra_hours": 5}])
    assert unknown.status_code == 422 and unknown.json()["code"] == "unknown_topic"
    assert unknown.json()["detail"] == "No student in this scope was assessed on Astrophysics"
    empty = _run(client, [{"topic": "Human Physiology", "extra_hours": 5}], rubric_id=9999)
    assert empty.status_code == 422 and empty.json()["code"] == "no_results"
    missing = _run(client, [{"topic": "Human Physiology", "extra_hours": 5}], batch_id=9999)
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_batch"
    assert _run(client, [{"topic": "Human Physiology", "extra_hours": 0.1}]).status_code == 422
    assert client.post("/api/whatif", json={"scenarios": []}).status_code == 422


def test_use_calibration_without_a_factor_stays_uncalibrated(client, db_session):
    add_result(db_session, "Whatif Cal", {"Human Physiology": 50})
    body = _run(client, [{"topic": "Human Physiology", "extra_hours": 5}], use_calibration=True).json()
    assert body["calibrated"] is False and body["calibration_factor"] == 1.0
    assert "scaled by" not in body["label"]
    assert any("No calibration applied" in a for a in body["assumptions"])


def test_options_list_batches_and_weakest_topics_first(client, db_session):
    add_result(db_session, "Opt A", {"Human Physiology": 50, "Ecology": 80})
    add_result(db_session, "Opt B", {"Human Physiology": 30, "Mechanics": 60})
    response = client.get("/api/whatif/options")
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "WhatIfOptions")
    assert [b["name"] for b in body["batches"]] == ["NEET-A"]
    assert [t["topic"] for t in body["topics"]] == ["Human Physiology", "Mechanics", "Ecology"]
    physiology = body["topics"][0]
    assert physiology["students"] == 2 and physiology["mean_mastery"] == 40
    assert physiology["hours_to_target"] == pytest.approx((10.5 + 7) / 2, abs=0.06)  # median, 1 dp
    assert body["calibration_factor"] is None
    assert client.get("/api/whatif/options", params={"batch_id": 9999}).json()["code"] == "unknown_batch"
