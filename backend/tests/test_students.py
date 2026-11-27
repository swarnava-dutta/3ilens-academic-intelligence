"""Student cards, longitudinal history and dashboard filter options (FR-5.5, FR-5.6, FR-5.8)."""
from __future__ import annotations

from tests.test_contract import check, check_interface

URGENCIES = ("on_track", "needs_attention", "at_risk")


def test_student_cards_for_every_submission(demo_data, client):
    client.post("/api/demo/seed")
    cards = client.get("/api/students").json()
    check(cards, "StudentCard[]", "cards")
    assert len(cards) == 13
    created = [c["created_at"] for c in cards]
    assert created == sorted(created, reverse=True)  # newest first

    completed = [c for c in cards if c["status"] == "COMPLETED"]
    assert len(completed) == 12
    for card in completed:
        assert card["score"] is not None and card["percentage"] is not None and card["urgency"] in URGENCIES
        assert 1 <= len(card["strengths"]) <= 2 and 1 <= len(card["gaps"]) <= 2
        assert 2 <= len(card["nudges"]) <= 3
        assert len(card["topic_mastery"]) == 5 and all(0 <= p["mastery"] <= 100 for p in card["topic_mastery"])
        assert len(card["top_focus"]) <= 3
        assert card["release_status"] in ("PROVISIONAL", "RELEASED") and card["is_demo"] is True
        assert card["test"]["name"] == "Biology - Genetics" and card["batch"]["name"] == "NEET-A"
    weak = next(c for c in completed if c["student_name"] == "Priya Banerjee")
    assert weak["top_focus"] and weak["top_focus"][0]["rank"] == 1
    released = sorted(c["student_name"] for c in completed if c["release_status"] == "RELEASED")
    assert released == ["Aarav Sharma", "Ananya Iyer"]

    review = next(c for c in cards if c["status"] == "HUMAN_REVIEW_REQUIRED")
    assert review["student_name"] == "Aditya Kulkarni"
    assert review["score"] is None and review["percentage"] is None and review["urgency"] is None
    assert review["strengths"] == [] and review["nudges"] == [] and review["top_focus"] == []
    assert review["release_status"] is None and review["total_marks"] == 20


def test_student_card_filters(demo_data, client):
    client.post("/api/demo/seed")
    for urgency, expected in (("on_track", 5), ("needs_attention", 3), ("at_risk", 4)):
        cards = client.get("/api/students", params={"urgency": urgency}).json()
        assert len(cards) == expected and all(c["urgency"] == urgency for c in cards)
    assert client.get("/api/students", params={"urgency": "doomed"}).status_code == 422

    rubric_id = client.get("/api/rubrics").json()[0]["id"]
    batch_id = client.get("/api/health").json()["batch"]["id"]
    assert len(client.get("/api/students", params={"rubric_id": rubric_id}).json()) == 13
    assert len(client.get("/api/students", params={"batch_id": batch_id}).json()) == 13
    assert client.get("/api/students", params={"rubric_id": rubric_id + 99}).json() == []
    assert client.get("/api/students", params={"batch_id": batch_id + 99}).json() == []

    topic = "Molecular Basis of Inheritance"
    by_topic = client.get("/api/students", params={"topic": topic}).json()
    assert by_topic and all(c["status"] == "COMPLETED" for c in by_topic)
    weak = [c for c in by_topic
            if next(p["mastery"] for p in c["topic_mastery"] if p["topic"] == topic) < 60]
    assert weak and "Ananya Iyer" not in {c["student_name"] for c in weak}
    cohort = client.get("/api/cohort", params={"topic": topic}).json()
    assert len(by_topic) == cohort["completed"]  # same rule as the cohort topic filter


def test_mixed_demo_cards_filters_and_history(demo_data, client):
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27

    filters = client.get("/api/filters").json()
    check_interface(filters, "DashboardFilters")
    assert [b["name"] for b in filters["batches"]] == ["NEET-A", "NEET-B"]
    assert all(b["exam"] == "NEET" and b["days_to_exam"] is not None for b in filters["batches"])
    tests = {t["name"]: t for t in filters["tests"]}
    assert set(tests) == {"Biology - Genetics", "NEET Mixed - Mock 08"}
    neet_a, neet_b = (b["id"] for b in filters["batches"])
    assert tests["Biology - Genetics"]["batch_ids"] == [neet_a]
    assert tests["NEET Mixed - Mock 08"]["batch_ids"] == [neet_a, neet_b]
    assert tests["NEET Mixed - Mock 08"]["status"] == "FACULTY_APPROVED"
    assert filters["urgencies"] == list(URGENCIES)
    assert {"Genetics", "Mechanics", "Electrostatics", "Mendelian Inheritance"} <= set(filters["topics"])

    b_cards = client.get("/api/students", params={"batch_id": neet_b}).json()
    check(b_cards, "StudentCard[]", "b_cards")
    assert sorted(c["student_name"] for c in b_cards) == ["Student B01", "Student B02"]
    mixed = client.get("/api/students", params={"rubric_id": tests["NEET Mixed - Mock 08"]["rubric_id"]}).json()
    assert len(mixed) == 6 + 8
    learner = next(c for c in mixed if c["student_name"] == "Student A03")
    assert learner["urgency"] == "at_risk" and len(learner["topic_mastery"]) == 10
    assert learner["strengths"] == ["Ecology fact recall", "Cell structure basics"]

    at_risk = client.get("/api/students", params={"urgency": "at_risk"}).json()
    assert at_risk and all(c["urgency"] == "at_risk" for c in at_risk)

    history = client.get("/api/students/aarav-sharma/history").json()
    check(history, "HistoryEntry[]", "history")
    assert len(history) == 3
    dates = [h["date"] for h in history]
    assert dates == sorted(dates)
    assert [h["rubric_name"] for h in history] == ["NEET Mixed - Mock 08", "NEET Mixed - Mock 08", "Biology - Genetics"]
    assert [h["current"] for h in history] == [False, False, True]
    assert history[0]["subjects"] == ["Biology", "Chemistry", "Physics"]
    assert history[2]["subjects"] == ["Biology"] and history[2]["score"] == 18
    assert all(h["outcome_counts"]["total_questions"] in (5, 12) for h in history)

    # The same history is embedded in the Result, with this report marked current.
    genetics = history[2]["submission_id"]
    result = client.get(f"/api/results/{genetics}").json()
    assert [h["submission_id"] for h in result["history"]] == [h["submission_id"] for h in history]
    assert [h["current"] for h in result["history"]] == [False, False, True]
    earlier = client.get(f"/api/results/{history[0]['submission_id']}").json()
    assert [h["current"] for h in earlier["history"]] == [True, False, False]

    assert client.get("/api/students/nobody-here/history").json() == []
    assert len(client.get("/api/students/student-b01/history").json()) == 1


def test_filters_on_an_empty_database(client):
    filters = client.get("/api/filters").json()
    check_interface(filters, "DashboardFilters")
    assert len(filters["batches"]) == 1 and filters["tests"] == [] and filters["topics"] == []
    assert client.get("/api/students").json() == []


def test_history_never_mixes_a_real_student_with_the_demo_namesake(demo_data, client, upload, fake_ai):
    client.post("/api/demo/seed", params={"set": "all"})
    live = upload(student_name="Aarav Sharma").json()  # same name-derived ref as the demo student
    assert client.get(f"/api/results/{live['id']}").status_code == 200

    real = client.get("/api/students/aarav-sharma/history").json()
    assert [h["submission_id"] for h in real] == [live["id"]] and real[0]["current"] is True
    demo = client.get("/api/students/aarav-sharma/history", params={"demo": True}).json()
    assert len(demo) == 3 and live["id"] not in [h["submission_id"] for h in demo]
    assert client.get("/api/students/aarav-sharma/history", params={"demo": False}).json() == real

    live_result = client.get(f"/api/results/{live['id']}").json()
    assert [h["submission_id"] for h in live_result["history"]] == [live["id"]]
    demo_result = client.get(f"/api/results/{demo[-1]['submission_id']}").json()
    assert len(demo_result["history"]) == 3


def test_live_upload_card_and_history_use_the_roll_number(client, upload, fake_ai):
    first = upload(student_name="Isha Verma", roll_no="neet-a-017").json()
    second = upload(student_name="Isha  Verma", roll_no="NEET-A-017").json()
    cards = client.get("/api/students").json()
    assert {c["student_ref"] for c in cards} == {"NEET-A-017"}
    assert all(c["is_demo"] is False and c["status"] == "COMPLETED" for c in cards)
    history = client.get("/api/students/NEET-A-017/history").json()
    assert [h["submission_id"] for h in history] == [first["id"], second["id"]]
