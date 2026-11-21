"""Institute-owner dashboard (BRD FR-5.9): contract shape and aggregates on the genetics + mixed
demo seeds, faculty identity from free-text names, trend sittings, scoping and guards."""
from __future__ import annotations

import pytest

from tests.test_contract import check_interface

URL = "/api/owner/dashboard"


@pytest.fixture
def seeded(client):
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27


def batch_named(body: dict, name: str) -> dict:
    return next(b for b in body["batches"] if b["batch"]["name"] == name)


def test_dashboard_contract_and_totals(client, seeded):
    response = client.get(URL)
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "OwnerDashboard")
    assert body["institution"]["name"] == "Instit-42" and [i["name"] for i in body["institutions"]] == ["Instit-42"]
    totals = body["totals"]
    assert (totals["submissions"], totals["completed"], totals["human_review"], totals["failed"]) == (27, 26, 1, 0)
    assert totals["processing"] == 0 and totals["batches"] == 2 and totals["tests"] == 2
    assert (totals["released"], totals["provisional"]) == (2, 24)
    assert totals["students"] == 19 and 0 < totals["average_pct"] < 100
    assert sum(body["urgency_counts"].values()) == 18  # the latest result of every graded student
    assert body["is_demo"] is True and body["demo_count"] == 27 and body["real_count"] == 0
    assert body["role_note"].startswith("Owner view - no login in this PoC.")
    assert body["interventions"] == {"records": 0, "measured": 0, "uplift": None, "calibration_factor": None}
    weakest = body["weakest_topics"]
    assert len(weakest) == 5 and [t["mastery"] for t in weakest] == sorted(t["mastery"] for t in weakest)
    assert body["operations"]["dlq_count"] == 0 and body["operations"]["target_inr"] == 5


def test_batch_summaries(client, seeded):
    body = client.get(URL).json()
    neet_a, neet_b = batch_named(body, "NEET-A"), batch_named(body, "NEET-B")
    assert neet_a["latest_test"]["name"] == "Biology - Genetics" and neet_a["latest_test_date"]
    assert neet_a["previous_average_pct"] is not None
    assert neet_a["trend_delta_pct"] == pytest.approx(neet_a["average_pct"] - neet_a["previous_average_pct"], abs=0.11)
    assert sum(neet_a["urgency_counts"].values()) == 12  # the 12 graded Genetics sheets
    assert neet_a["review_backlog"] == 1 and neet_a["released"] == 2 and neet_a["top_gap_topic"]
    assert neet_a["is_demo"] is True and neet_a["cost_inr"] == 0
    assert neet_b["latest_test"]["name"] == "NEET Mixed - Mock 08" and neet_b["students"] == 2
    assert neet_b["previous_average_pct"] is None and neet_b["trend_delta_pct"] is None


def test_faculty_come_from_reviewers_and_batch_leads(client, seeded):
    body = client.get(URL).json()
    rao = next(f for f in body["faculty"] if f["name"] == "Dr. A. Rao (demo)")
    assert rao["reports_released"] == 2 and rao["batches"] == [] and rao["avg_release_hours"] is not None
    assert body["totals"]["faculty"] == len(body["faculty"])

    neet_a, neet_b = batch_named(body, "NEET-A")["batch"], batch_named(body, "NEET-B")["batch"]
    # Same person, different spacing / case: one faculty row, first spelling kept.
    assert client.patch(f"/api/batches/{neet_a['id']}", json={"faculty_lead": "dr. a.  rao (DEMO)"}).status_code == 200
    assert client.patch(f"/api/batches/{neet_b['id']}", json={"faculty_lead": "Mr. S. Iyer (sample)"}).status_code == 200
    faculty = {f["name"]: f for f in client.get(URL).json()["faculty"]}
    assert len([n for n in faculty if n.casefold().startswith("dr. a. rao")]) == 1
    rao = next(f for n, f in faculty.items() if n.casefold().startswith("dr. a. rao"))
    assert rao["batches"] == ["NEET-A"] and rao["students"] == 17 and rao["reports_released"] == 2
    assert rao["average_pct"] is not None
    iyer = faculty["Mr. S. Iyer (sample)"]
    assert iyer["batches"] == ["NEET-B"] and iyer["students"] == 2 and iyer["reports_released"] == 0
    assert iyer["avg_release_hours"] is None


def test_trend_has_one_point_per_sitting(client, seeded):
    trend = client.get(URL).json()["trend"]
    assert [p["date"] for p in trend] == sorted(p["date"] for p in trend)
    neet_a = [p for p in trend if p["batch_name"] == "NEET-A"]
    # Mock-05 and Mock-06 (30 and 16 days ago), the Mock-08 learners, then the Genetics Mock-07 test.
    assert [p["test_name"] for p in neet_a] == ["NEET Mixed - Mock 08"] * 3 + ["Biology - Genetics"]
    assert [p["students"] for p in neet_a] == [4, 4, 4, 12]
    assert [p["batch_name"] for p in trend].count("NEET-B") == 1


def test_live_rows_count_cost_and_reviews(client, upload, fake_ai, monkeypatch):
    import ai

    monkeypatch.setattr(ai, "ai_readiness", lambda: (True, []))
    fake_ai.answer_confidence = 0.55
    held = upload(student_name="Meera Pillai").json()
    fake_ai.answer_confidence = 0.93
    assert client.post(f"/api/submissions/{held['id']}/review",
                       json={"reviewer": "Ms. Kavya Nair", "action": "approve"}).status_code == 202
    done = upload(student_name="Rahul Verma").json()
    assert client.post(f"/api/results/{done['id']}/release", json={"reviewer_name": "Ms.  Kavya Nair"}).status_code == 200
    body = client.get(URL).json()
    assert body["is_demo"] is False and body["real_count"] == 2 and body["totals"]["completed"] == 2
    assert batch_named(body, "NEET-A")["cost_inr"] > 0 and body["operations"]["calls"] >= 3
    nair = next(f for f in body["faculty"] if f["name"] == "Ms. Kavya Nair")
    assert nair["ocr_reviews"] == 1 and nair["reports_released"] == 1 and nair["avg_release_hours"] >= 0


def test_institution_scoping_and_unknown_institution(client, seeded, db_session):
    from database import Institution

    other = Institution(name="Second Institute (test)")
    db_session.add(other)
    db_session.commit()
    body = client.get(URL, params={"institution_id": other.id}).json()
    check_interface(body, "OwnerDashboard")
    assert body["institution"]["name"] == "Second Institute (test)" and len(body["institutions"]) == 2
    assert body["totals"]["submissions"] == 0 and body["batches"] == [] and body["trend"] == []
    assert body["totals"]["average_pct"] is None and body["is_demo"] is False
    missing = client.get(URL, params={"institution_id": 999})
    assert missing.status_code == 404 and missing.json()["code"] == "unknown_institution"


def test_a_failing_intervention_summary_never_breaks_the_dashboard(client, seeded, monkeypatch):
    import outcomes

    def boom(*_args, **_kwargs):
        raise RuntimeError("extension hook bug")

    monkeypatch.setattr(outcomes, "effectiveness", boom)
    response = client.get(URL)
    assert response.status_code == 200
    assert response.json()["interventions"]["records"] == 0


def test_trend_delta_skips_a_small_check_between_two_mocks(client, seeded):
    """NEET-C (sample): Mock 09 (12) -> oral sample (1) -> Mock 10 (12). The delta compares the mocks."""
    assert client.post("/api/demo/seed", params={"set": "insights"}).json()["created"] > 0
    neet_c = batch_named(client.get(URL).json(), "NEET-C (sample)")
    assert neet_c["latest_test"]["name"] == "NEET MCQ Practice - Mock 10 (sample)"
    mock09 = [r for r in client.get("/api/submissions").json()
              if r["batch_id"] == neet_c["batch"]["id"] and r["total_marks"] == 104]
    assert len(mock09) == 12
    expected = sum(r["percentage"] for r in mock09) / len(mock09)
    assert neet_c["previous_average_pct"] == pytest.approx(expected, abs=0.11)
    assert neet_c["trend_delta_pct"] > 0
