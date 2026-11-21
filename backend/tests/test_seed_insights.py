"""The set=insights sample dataset (W2-3): idempotency, labels, name collisions, the pinned
pattern sets, the intervention effectiveness ordering, scoring and contract checks."""
from __future__ import annotations

from datetime import timedelta

import pytest

import analytics
import seed_insights
from database import Batch, InterventionRecord, Rubric, StudentSubmission
from tests.test_contract import check_interface

HIGH_RISK = {"Kunal Desai", "Karan Malhotra", "Pooja Venkat", "Rahul Bansal"}
FATIGUED = {"Tanvi Shah", "Karan Malhotra", "Nikhil Sood"}
MEMORISERS = {"Farhan Qureshi", "Lavanya Pillai", "Rahul Bansal"}


@pytest.fixture
def seeded(client, db_session):
    assert client.post("/api/demo/seed", params={"set": "insights"}).json()["created"] == 25
    batch = db_session.query(Batch).filter(Batch.name == seed_insights.BATCH_NAME).one()
    subs = db_session.query(StudentSubmission).filter(StudentSubmission.batch_id == batch.id).all()
    mock09 = {s.student_name: s for s in subs if s.original_filename.endswith("_mock09.pdf")}
    mock10 = {s.student_name: s for s in subs if s.original_filename.endswith("_mock10.pdf")}
    voice = next(s for s in subs if s.input_kind == "voice")
    return batch, mock09, mock10, voice


def test_created_25_then_0_all_demo_and_labelled(client, db_session, seeded):
    batch, mock09, mock10, voice = seeded
    assert client.post("/api/demo/seed", params={"set": "insights"}).json()["created"] == 0
    assert len(mock09) == len(mock10) == 12
    assert batch.faculty_lead == seed_insights.FACULTY and batch.exam_type == "Mock-09/10"
    neet_a = db_session.query(Batch).filter(Batch.name == "NEET-A").one()
    assert neet_a.faculty_lead == "Dr. A. Rao (demo)"
    subs = [*mock09.values(), *mock10.values(), voice]
    for sub in subs:
        assert sub.is_demo is True and sub.original_filename.startswith("sample_") and sub.file_path == ""
        assert sub.processing_log[0]["message"] == seed_insights.NOTE
        assert sub.rubric.name.endswith("(sample)") and sub.rubric.status == "FACULTY_APPROVED"
    records = db_session.query(InterventionRecord).all()
    assert len(records) == 24
    assert all(r.is_demo and r.applied_by == seed_insights.FACULTY and r.source == "faculty" for r in records)
    assert all(r.baseline_mastery is not None and r.predicted_gain_pct is not None for r in records)
    released = [s for s in mock09.values() if s.result.release_status == "RELEASED"]
    assert len(released) == 6 and all(s.result.reviewed_by == seed_insights.FACULTY for s in released)
    for s in released:
        assert timedelta(hours=6) <= s.result.reviewed_at - s.created_at <= timedelta(hours=30)
    assert len({r.rubric_hash for r in db_session.query(Rubric).filter(Rubric.name.like("%(sample)")).all()}) == 3


def test_set_all_is_unchanged_and_names_never_collide(client, monkeypatch):
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27
    assert seed_insights.name_collisions() == []
    assert len(seed_insights.STUDENTS) == 12
    assert client.post("/api/demo/seed", params={"set": "insights"}).json()["created"] == 25
    batches = {b["name"]: b for b in client.get("/api/whatif/options").json()["batches"]}
    assert batches["NEET-B"]["faculty_lead"] == "Mr. S. Iyer (sample)"
    monkeypatch.setitem(seed_insights.STUDENTS, "Ananya Iyer", {"base": 0.5, "blank": 0.5})
    assert seed_insights.name_collisions() == ["Ananya Iyer"]


def test_name_collision_aborts_the_seed(client, monkeypatch):
    monkeypatch.setitem(seed_insights.STUDENTS, "Student A01", {"base": 0.5, "blank": 0.5})
    with pytest.raises(RuntimeError, match="collide"):
        import database

        with database.SessionLocal() as session:
            seed_insights.seed_insights_demo(session)


def test_pinned_mock09_patterns(client, seeded):
    _batch, mock09, mock10, _voice = seeded
    high, fatigued, memorisers = set(), set(), set()
    profiles = {}
    for name, sub in mock09.items():
        result = client.get(f"/api/results/{sub.id}").json()
        p = result["patterns"]
        profiles[name] = p
        if p["negative_marking"]["risk"] == "high":
            high.add(name)
        if p["fatigue"]["flagged"]:
            fatigued.add(name)
            assert p["fatigue"]["cohort_size"] == 12 and p["fatigue"]["adjusted_drop_pts"] is not None
        if sum(c["classification"] == "memorisation" for c in p["transfer"]["concepts"]) >= 3:
            memorisers.add(name)
    assert high == HIGH_RISK
    assert fatigued == FATIGUED
    assert memorisers == MEMORISERS

    vikram = profiles["Vikram Chauhan"]
    assert sum(c["classification"] == "foundational_gap" for c in vikram["transfer"]["concepts"]) >= 4
    assert vikram["negative_marking"]["risk"] == "low" and vikram["negative_marking"]["blank"] >= 8
    for name in ("Aditi Rao", "Sneha Kulkarni"):
        assert analytics.result_urgency(mock09[name].result)[0] == "on_track"
        assert analytics.result_urgency(mock10[name].result)[0] == "on_track"
    avg = lambda subs: sum(analytics.percentage(s.result) for s in subs.values()) / len(subs)  # noqa: E731
    assert avg(mock10) > avg(mock09)


def test_scoring_uses_the_real_engine(client, seeded):
    _batch, mock09, mock10, _voice = seeded
    marks = [q["estimated_marks"] for s in mock09.values() for q in s.result.question_evaluations]
    assert -1 in marks
    for sub in [*mock09.values(), *mock10.values()]:
        total = sum(q["estimated_marks"] for q in sub.result.question_evaluations)
        assert sub.result.total_score == pytest.approx(total)
    q25 = [q for s in mock09.values() for q in s.result.question_evaluations if q["question"] == 25]
    assert any((q["marking_note"] or "").startswith("Required step") and q["marking_note"].endswith("not met -> 0")
               for q in q25)
    q26 = {q["estimated_marks"] for s in mock09.values() for q in s.result.question_evaluations if q["question"] == 26}
    assert q26 <= {0, 4}
    karan = client.get(f"/api/results/{mock09['Karan Malhotra'].id}").json()
    check_interface(karan, "Result")
    assert "+4/-1" in karan["scoring_controls"]["marking_rule"]
    multi = next(q for q in karan["question_evaluations"] if q["question"] == 16)
    assert multi["selected_option"] == "MULTI" and multi["penalty"] == 1


def test_effectiveness_on_neet_c(client, seeded):
    batch, _mock09, _mock10, _voice = seeded
    eff = client.get("/api/interventions/effectiveness", params={"batch_id": batch.id}).json()
    check_interface(eff, "InterventionEffectiveness")
    assert (eff["records"], eff["measured"], eff["pending"]) == (24, 22, 2)
    assert eff["uplift"] >= 8 and eff["is_demo"] is True and eff["caveat"].endswith("Sample data.")
    kinds = {r["key"]: r["mean_change"] for r in eff["by_kind"]}
    assert kinds["study_focus"] > kinds["nudge"] > kinds["class_intervention"]
    [inst] = eff["by_institution"]
    assert inst["calibration_factor"] is not None and 0.25 <= inst["calibration_factor"] <= 2.0
    whatif = client.post("/api/whatif", json={
        "batch_id": batch.id, "scenarios": [{"topic": "Organic Chemistry", "extra_hours": 5}], "use_calibration": True,
    }).json()
    check_interface(whatif, "WhatIfResult")
    assert whatif["calibrated"] is True and whatif["is_demo"] is True
    assert "sample-data calibration factor" in whatif["label"]
    assert whatif["scenarios"][0]["headline"].startswith(
        "+5 h of Organic Chemistry for every student in NEET-C (sample) -> about +"
    )
    assert whatif["scenarios"][0]["headline"].endswith("on NEET MCQ Practice - Mock 10 (sample)")


def test_voice_sample_row(client, seeded):
    _batch, _mock09, _mock10, voice = seeded
    result = client.get(f"/api/results/{voice.id}").json()
    check_interface(result, "Result")
    assert result["submission"]["input_kind"] == "voice"
    assert result["submission"]["detected_languages"] == ["hi", "en"]
    assert result["voice"]["audio_url"] is None and result["voice"]["synthetic"] is True
    assert (result["total_score"], result["total_marks"]) == (3, 4)
    [q1] = result["question_evaluations"]
    assert q1["student_answer"].startswith("Synthetic sample transcript:")
    assert [a["awarded"] for a in q1["marking_breakdown"]] == [1, 1, 1, 0]
    assert client.get(f"/api/submissions/{voice.id}/audio").json()["code"] == "no_audio"


def test_cohort_for_neet_c_passes_the_contract(client, seeded):
    batch, _mock09, _mock10, _voice = seeded
    cohort = client.get("/api/cohort", params={"batch_id": batch.id}).json()
    check_interface(cohort, "Cohort")
    patterns = cohort["patterns"]
    names = {s["student_name"] for s in patterns["negative_marking"]["students"]}
    assert HIGH_RISK <= names
    assert FATIGUED <= {s["student_name"] for s in patterns["fatigue"]["students"]}
    assert {c["concept"] for c in patterns["transfer"]["concepts"]} >= {"Genetics", "Organic Chemistry", "Mechanics"}
    options = client.get("/api/whatif/options", params={"batch_id": batch.id}).json()
    check_interface(options, "WhatIfOptions")
    assert len(options["topics"]) == 8 and options["calibration_factor"] is not None
