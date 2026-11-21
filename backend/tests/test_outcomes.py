"""Intervention log and outcome learning (FR-4.13): POST validation, captured baseline and
prediction, follow-up statuses, delete, Result.interventions, observational effectiveness and
the calibration factor (only from n >= 5)."""
from __future__ import annotations

from datetime import timedelta

import pytest

import outcomes
from database import InterventionRecord, SubmissionStatus, utcnow
from tests.test_contract import check_interface
from tests.test_whatif import add_result


def _post(client, submission_id: int, topic: str = "Human Physiology", **extra):
    body = {"submission_id": submission_id, "topic": topic, "kind": "study_focus", "action": "Drill set",
            "applied_by": "Ms. Test", "hours": 5, **extra}
    return client.post("/api/interventions", json=body)


def _applied(days_ago: float) -> str:
    return (utcnow() - timedelta(days=days_ago)).isoformat()


def test_post_validates_and_captures_baseline_and_prediction(client, db_session):
    sub = add_result(db_session, "Out Base", {"Human Physiology": 50, "Ecology": 60}, days_ago=10)
    review = add_result(db_session, "Out Review", {}, status=SubmissionStatus.HUMAN_REVIEW_REQUIRED)

    assert _post(client, 99999).json()["code"] == "unknown_submission"
    assert _post(client, 99999).status_code == 404
    blocked = _post(client, review.id)
    assert blocked.status_code == 409 and blocked.json()["code"] == "invalid_state"
    unknown = _post(client, sub.id, topic="Astrophysics")
    assert unknown.status_code == 422 and unknown.json()["code"] == "unknown_topic"
    future = _post(client, sub.id, applied_at=(utcnow() + timedelta(days=2)).isoformat())
    assert future.status_code == 422 and future.json()["code"] == "invalid_applied_at"
    assert _post(client, sub.id, kind="bribe").status_code == 422
    assert _post(client, sub.id, compliance=1.5).status_code == 422

    created = _post(client, sub.id, topic="  human   physiology ", compliance=0.8, applied_at=_applied(8))
    assert created.status_code == 201, created.text
    body = created.json()
    check_interface(body, "InterventionRecord")
    assert body["topic"] == "Human Physiology"  # canonical name from the result
    assert body["baseline_mastery"] == 50 and body["predicted_gain_pct"] == 25.0  # 35 x 5/7 (from_mid 7 h)
    assert body["student_ref"] == sub.student_ref and body["batch_id"] == sub.batch_id and body["is_demo"] is False
    assert body["outcome_status"] == "pending" and body["outcome"] is None
    # hours default to INTERVENTION_DEFAULT_HOURS (3): Ecology 60% -> 25 x 3/3 (from_mid 3 h).
    default = _post(client, sub.id, topic="Ecology", hours=None).json()
    assert default["hours"] == 3.0 and default["predicted_gain_pct"] == 25.0


@pytest.mark.parametrize(("later", "status", "change"), [(70, "improved", 20.0), (52, "flat", 2.0), (40, "declined", -10.0)])
def test_follow_up_status_thresholds_and_roi_accuracy(client, db_session, later, status, change):
    base = add_result(db_session, "Out Follow", {"Human Physiology": 50, "Ecology": 60}, days_ago=10)
    record = _post(client, base.id, applied_at=_applied(8)).json()
    follow = add_result(db_session, "Out Follow", {"Human Physiology": later, "Ecology": 60}, days_ago=2)
    [row] = client.get("/api/interventions", params={"student_ref": base.student_ref}).json()
    assert row["id"] == record["id"] and row["outcome_status"] == status
    outcome = row["outcome"]
    assert outcome["follow_up_submission_id"] == follow.id and outcome["mastery_change"] == change
    assert outcome["baseline_mastery"] == 50 and outcome["follow_up_mastery"] == later
    assert outcome["roi_accuracy"] == round(max(0.0, min(3.0, change / 25.0)), 2)
    assert outcome["follow_up_test"] == "Biology - Genetics v1"
    assert outcome["score_change_pct"] == pytest.approx((later + 60) / 2 - 55, abs=0.1)


def test_not_assessed_pending_and_delete(client, db_session):
    base = add_result(db_session, "Out Pending", {"Human Physiology": 50, "Ecology": 60}, days_ago=10)
    record = _post(client, base.id, applied_at=_applied(8)).json()
    assert record["outcome_status"] == "pending"
    add_result(db_session, "Out Pending", {"Ecology": 70}, days_ago=2)  # later test without the topic
    [row] = client.get("/api/interventions", params={"submission_id": base.id}).json()
    assert row["outcome_status"] == "not_assessed" and row["outcome"] is None

    assert client.delete(f"/api/interventions/{record['id']}").status_code == 204
    assert client.get("/api/interventions").json() == []
    gone = client.delete(f"/api/interventions/{record['id']}")
    assert gone.status_code == 404 and gone.json()["code"] == "unknown_intervention"


def test_list_filters_and_newest_first(client, db_session):
    a = add_result(db_session, "Out List A", {"Human Physiology": 50}, days_ago=10)
    b = add_result(db_session, "Out List B", {"Human Physiology": 40}, days_ago=10)
    first = _post(client, a.id, applied_at=_applied(9)).json()
    second = _post(client, b.id, applied_at=_applied(3)).json()
    assert [r["id"] for r in client.get("/api/interventions").json()] == [second["id"], first["id"]]
    assert [r["id"] for r in client.get("/api/interventions", params={"submission_id": a.id}).json()] == [first["id"]]
    assert len(client.get("/api/interventions", params={"batch_id": a.batch_id, "institution_id": 1}).json()) == 2
    assert client.get("/api/interventions", params={"batch_id": 9999}).json() == []


def test_result_lists_the_students_interventions(client):
    client.post("/api/demo/seed")
    subs = {s["student_name"]: s["id"] for s in client.get("/api/submissions").json() if s["status"] == "COMPLETED"}
    sub_id = subs["Ananya Iyer"]
    created = _post(client, sub_id, topic="Molecular Basis of Inheritance", hours=2)
    assert created.status_code == 201, created.text
    assert created.json()["is_demo"] is True
    result = client.get(f"/api/results/{sub_id}").json()
    check_interface(result, "Result")
    assert [r["id"] for r in result["interventions"]] == [created.json()["id"]]
    assert result["interventions"][0]["outcome_status"] == "pending"


def _effect_fixture(client, db_session):
    """2 students x 3 topics. S1 treats Human Physiology (+20), S2 treats Ecology (+15). Untreated
    topics: S1 Ecology +5, Mechanics 0; S2 Human Physiology +5, Mechanics -6 -> control mean +1."""
    s1 = add_result(db_session, "Eff One", {"Human Physiology": 40, "Ecology": 50, "Mechanics": 60}, days_ago=10)
    s2 = add_result(db_session, "Eff Two", {"Human Physiology": 30, "Ecology": 30, "Mechanics": 50}, days_ago=10)
    assert _post(client, s1.id, applied_at=_applied(8)).status_code == 201
    assert _post(client, s2.id, topic="Ecology", kind="nudge", applied_at=_applied(8)).status_code == 201
    add_result(db_session, "Eff One", {"Human Physiology": 60, "Ecology": 55, "Mechanics": 60}, days_ago=2)
    add_result(db_session, "Eff Two", {"Human Physiology": 35, "Ecology": 45, "Mechanics": 44}, days_ago=2)
    return s1, s2


def test_effectiveness_uplift_is_treated_minus_control(client, db_session):
    _effect_fixture(client, db_session)
    response = client.get("/api/interventions/effectiveness")
    assert response.status_code == 200, response.text
    eff = response.json()
    check_interface(eff, "InterventionEffectiveness")
    assert (eff["records"], eff["measured"], eff["pending"]) == (2, 2, 0)
    assert eff["mean_change_treated"] == 17.5 and eff["mean_change_control"] == 1.0 and eff["uplift"] == 16.5
    kinds = {r["key"]: r for r in eff["by_kind"]}
    assert kinds["study_focus"]["mean_change"] == 20 and kinds["study_focus"]["uplift"] == 19
    assert kinds["nudge"]["mean_change"] == 15 and kinds["nudge"]["improved_share"] == 1.0
    assert [r["key"] for r in eff["by_kind"]] == ["study_focus", "nudge"]
    [inst] = eff["by_institution"]
    assert inst["institution_name"] == "Instit-42" and inst["records"] == 2 and inst["measured"] == 2
    assert inst["calibration_factor"] is None and inst["calibration_n"] == 2  # needs n >= 5
    assert eff["is_demo"] is False and "not assumed to cause" in eff["caveat"] and "Sample data" not in eff["caveat"]
    scoped = client.get("/api/interventions/effectiveness", params={"batch_id": 9999}).json()
    assert scoped["records"] == 0 and scoped["uplift"] is None


def test_calibration_factor_appears_only_from_five_measured_records(client, db_session):
    def measured_record(name: str) -> None:
        base = add_result(db_session, name, {"Human Physiology": 50}, days_ago=10)
        assert _post(client, base.id, applied_at=_applied(8)).status_code == 201  # predicted 25
        add_result(db_session, name, {"Human Physiology": 70}, days_ago=2)  # realised +20

    for i in range(4):
        measured_record(f"Cal {i}")
    inst = client.get("/api/interventions/effectiveness").json()["by_institution"][0]
    assert inst["calibration_factor"] is None and inst["calibration_n"] == 4
    measured_record("Cal 4")
    inst = client.get("/api/interventions/effectiveness").json()["by_institution"][0]
    assert inst["calibration_n"] == 5 and inst["calibration_factor"] == 0.8  # 5 x 20 / (5 x 25)

    # The owner's what-if applies it only when asked.
    body = client.post("/api/whatif", json={"scenarios": [{"topic": "Human Physiology", "extra_hours": 5}],
                                            "use_calibration": True}).json()
    assert body["calibrated"] is True and body["calibration_factor"] == 0.8
    assert body["label"].endswith("; scaled by the calibration factor 0.8 (n=5)")
    # 50% after the follow-ups (latest = 70%): 15 pts gap x 5/3.5 capped at 1 x 0.8 = 12.
    assert body["scenarios"][0]["students"][0]["mastery_after"] == pytest.approx(82.0)
    plain = client.post("/api/whatif", json={"scenarios": [{"topic": "Human Physiology", "extra_hours": 5}]}).json()
    assert plain["calibrated"] is False


def test_calibration_factor_is_clamped():
    class Rec:
        def __init__(self, predicted):
            self.predicted_gain_pct = predicted

    high = [(Rec(1.0), {"mastery_change": 30.0})] * 5
    low = [(Rec(30.0), {"mastery_change": -5.0})] * 5
    assert outcomes.calibration_factor(high) == (2.0, 5)
    assert outcomes.calibration_factor(low) == (0.25, 5)
    assert outcomes.calibration_factor(high[:4]) == (None, 4)


def test_effectiveness_without_a_session_is_the_empty_shape():
    eff = outcomes.effectiveness(None, institution_id=1)
    assert eff["records"] == 0 and eff["institution_id"] == 1 and eff["by_kind"] == []


def test_build_record_captures_demo_flag(client, db_session):
    sub = add_result(db_session, "Out Demo", {"Mechanics": 30}, days_ago=5, is_demo=True)
    row = outcomes.build_record(sub, topic="mechanics", kind="nudge", action="x", applied_by="y", hours=4)
    assert isinstance(row, InterventionRecord) and row.is_demo is True and row.topic == "Mechanics"
    assert row.predicted_gain_pct == pytest.approx(55 * 4 / 12, abs=0.05)  # from_low 12 h
