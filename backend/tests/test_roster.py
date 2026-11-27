"""Students roster (GET /api/students/roster): one row per student (student_ref + is_demo), the
latest graded paper in scope, the change since the previous paper, urgency with its reasons, exam
technique, logged actions and the scope summary every /students number is read from."""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime

import pytest

import sittings
from tests.test_contract import check, check_interface

URGENCIES = ("on_track", "needs_attention", "at_risk")


def _seed(client) -> None:
    assert client.post("/api/demo/seed", params={"set": "all"}).status_code == 200
    assert client.post("/api/demo/seed", params={"set": "insights"}).status_code == 200


def _roster(client, **params) -> dict:
    response = client.get("/api/students/roster", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "StudentRoster")
    return body


def _row(body: dict, ref: str, demo: bool = True) -> dict:
    return next(r for r in body["rows"] if r["student_ref"] == ref and r["is_demo"] is demo)


def _when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


@pytest.fixture
def seeded(demo_data, client):
    _seed(client)
    return client


def test_one_row_per_student_and_a_consistent_summary(seeded):
    client = seeded
    body = _roster(client)
    rows, summary = body["rows"], body["summary"]
    keys = [(r["student_ref"], r["is_demo"]) for r in rows]
    assert len(keys) == len(set(keys))
    cards = client.get("/api/students").json()
    assert set(keys) == {(c["student_ref"], c["is_demo"]) for c in cards}
    assert summary["students"] == len(rows) == 31 and summary["sheets"] == len(cards) == 52

    graded = [r for r in rows if r["latest"]]
    assert summary["graded"] == len(graded) == 30 and summary["ungraded"] == 1
    counts = Counter(r["latest"]["urgency"] for r in graded)
    assert summary["urgency_counts"] == {u: counts[u] for u in URGENCIES}
    assert sum(summary["urgency_counts"].values()) == summary["graded"]
    assert summary["urgency_counts"] == {"on_track": 10, "needs_attention": 10, "at_risk": 10}
    owner = client.get("/api/owner/dashboard").json()
    assert owner["totals"]["students"] == summary["students"]
    assert owner["urgency_counts"] == summary["urgency_counts"]

    # The held sheet's student is listed once, without a graded paper, after every graded row.
    held = next(r for r in rows if r["latest"] is None)
    assert held["student_name"] == "Aditya Kulkarni" and held["pending"]["status"] == "HUMAN_REVIEW_REQUIRED"
    assert rows[-1] is held and summary["held"] == 1
    assert summary["demo_students"] == 31 and summary["real_students"] == 0
    released = sum(1 for r in graded if r["latest"]["release_status"] == "RELEASED")
    assert summary["released_latest"] == released and summary["provisional_latest"] == len(graded) - released


def test_latest_previous_delta_and_spark_follow_history(seeded):
    client = seeded
    body = _roster(client)
    for row in body["rows"]:
        if not row["latest"]:
            continue
        history = client.get(f"/api/students/{row['student_ref']}/history", params={"demo": row["is_demo"]}).json()
        check(history, "HistoryEntry[]", "history")
        papers = [h for h in history if h["input_kind"] != "voice"]
        assert papers[-1]["submission_id"] == row["latest"]["submission_id"]
        assert papers[-1]["pct"] == row["latest"]["pct"] == row["spark"][-1]["pct"]
        assert [p["submission_id"] for p in row["spark"]] == [h["submission_id"] for h in papers[-6:]]
        assert row["papers_count"] == len(papers)
        if len(papers) >= 2:
            assert row["previous"]["submission_id"] == papers[-2]["submission_id"]
            assert row["delta_pct"] == round(papers[-1]["pct"] - papers[-2]["pct"], 1)
            # Only a comparable pair (same test, or two full papers over the same subjects) is a trend.
            same_test = papers[-1]["rubric_id"] == papers[-2]["rubric_id"]
            full = min(papers[-1]["outcome_counts"]["total_questions"], papers[-2]["outcome_counts"]["total_questions"]) >= 10
            expected_comparable = same_test or (full and set(papers[-1]["subjects"]) == set(papers[-2]["subjects"]))
            assert row["previous"]["comparable"] is expected_comparable
            assert row["previous"]["questions"] == papers[-2]["outcome_counts"]["total_questions"]
            if expected_comparable:
                d = row["delta_pct"]
                assert row["trend"] == ("improving" if d >= 5 else ("slipping" if d <= -5 else "steady"))
            else:
                assert row["trend"] is None
        else:
            assert row["previous"] is None and row["delta_pct"] is None and row["trend"] is None
        result = client.get(f"/api/results/{row['latest']['submission_id']}").json()
        assert result["percentage"] == row["latest"]["pct"]
        assert result["urgency"] == row["latest"]["urgency"]
        assert result["urgency_reasons"] == row["latest"]["urgency_reasons"]
        assert [(s["subject"], s["score"], s["max_marks"], s["pct"]) for s in row["subjects"]] == [
            (s["subject"], s["score"], s["max_marks"], s["pct"]) for s in result["subject_rollup"]
        ]
        assert row["latest"]["questions"] == len(result["question_evaluations"])
    summary = body["summary"]
    trends = Counter(r["trend"] for r in body["rows"] if r["trend"])
    assert (summary["improving"], summary["slipping"], summary["steady"]) == (
        trends["improving"], trends["slipping"], trends["steady"],
    )
    assert summary["with_trend"] == sum(trends.values()) == 12 and summary["improving"] == 6
    different = [r for r in body["rows"] if r["previous"] and not r["previous"]["comparable"]]
    assert summary["different_test"] == len(different) == 4
    # A 5-question chapter test against a 12-question mixed mock is context, never "up 8.3".
    riya = _row(body, "riya-das")
    assert riya["previous"]["short_name"] == "Mock 08" and riya["delta_pct"] == 8.3 and riya["trend"] is None
    assert "up" not in riya["priority"]["reason"]


def test_comparable_papers_rule():
    import roster

    assert roster.short_test_name("NEET MCQ Practice - Mock 09 (sample)") == "Mock 09"
    assert roster.short_test_name("Biology - Genetics") == "Biology - Genetics"
    assert roster.subject_level("Physics", "Physics") and roster.subject_level("botany", "")
    assert not roster.subject_level("Electrostatics", "Physics")


def test_an_oral_check_is_graded_but_never_previous(seeded):
    client = seeded
    tanvi = _row(_roster(client), "tanvi-shah")
    assert tanvi["latest"]["test_name"] == "NEET MCQ Practice - Mock 10 (sample)"
    assert tanvi["previous"]["test_name"] == "NEET MCQ Practice - Mock 09 (sample)"
    assert tanvi["delta_pct"] == 4.8 and tanvi["trend"] == "steady"
    assert all("Oral" not in p["test_name"] for p in tanvi["spark"])
    history = client.get("/api/students/tanvi-shah/history", params={"demo": True}).json()
    voice = [h for h in history if h["input_kind"] == "voice"]
    assert len(voice) == 1 and voice[0]["rubric_name"].startswith("Oral answer")
    assert all(h["rubric_id"] for h in history)
    # The oral rubric as the scope: the graded oral answer is the latest sheet (as on the cohort
    # page); the paper before it is a different, short test, so there is no trend.
    oral = _roster(client, rubric_id=voice[0]["rubric_id"])
    assert [r["student_ref"] for r in oral["rows"]] == ["tanvi-shah"]
    row = oral["rows"][0]
    assert row["latest"]["submission_id"] == voice[0]["submission_id"] and oral["summary"]["graded"] == 1
    assert row["previous"]["short_name"] == "Mock 09" and row["previous"]["comparable"] is False
    assert row["trend"] is None and oral["summary"]["different_test"] == 1


def test_urgency_reasons_explain_a_level_moved_by_weak_topics(seeded):
    client = seeded
    kunal = _row(_roster(client), "kunal-desai")
    assert kunal["latest"]["pct"] == 80.2 and kunal["latest"]["urgency"] == "needs_attention"
    assert kunal["latest"]["urgency_reasons"][-1] == (
        "2 topics below 40%: Organic Chemistry (25%), Electrostatics (16.7%) - moved one level worse."
    )
    assert kunal["very_weak_count"] == 2
    card = next(c for c in client.get("/api/students").json() if c["submission_id"] == kunal["latest"]["submission_id"])
    assert card["urgency_reasons"] == kunal["latest"]["urgency_reasons"] and card["input_kind"] == "document"


def test_filters_narrow_rows_only(seeded):
    client = seeded
    full = _roster(client)
    at_risk = _roster(client, urgency="at_risk")
    assert at_risk["summary"] == full["summary"] and at_risk["topics"] == full["topics"]
    assert len(at_risk["rows"]) == full["summary"]["urgency_counts"]["at_risk"]
    assert all(r["latest"]["urgency"] == "at_risk" for r in at_risk["rows"])

    for topic in full["topics"][:4]:
        narrowed = _roster(client, topic=topic["topic"])
        assert narrowed["summary"] == full["summary"]
        assert len(narrowed["rows"]) == topic["below_60"]
        assert {(r["student_ref"], r["is_demo"]) for r in narrowed["rows"]} == {
            (s["student_ref"], s["is_demo"]) for s in topic["students_below"]
        }
    assert client.get("/api/students/roster", params={"urgency": "doomed"}).status_code == 422


def test_topic_denominators_are_latest_papers(seeded):
    body = _roster(seeded)
    latest_rows = [r for r in body["rows"] if r["latest"]]
    for topic in body["topics"]:
        masteries = [t["mastery"] for r in latest_rows for t in r["topics"] if t["topic"] == topic["topic"]]
        if not masteries:
            continue  # a negative-marking topic name with no mastery entry
        assert topic["tested"] == len(masteries)
        assert topic["below_60"] == sum(1 for m in masteries if m < 60) == len(topic["students_below"])
        assert topic["mean_mastery"] == round(sum(masteries) / len(masteries), 1)
    order = [(-t["below_60"], t["mean_mastery"], t["topic"].casefold()) for t in body["topics"]]
    assert order == sorted(order)
    total = body["summary"]["negative_marking"]["marks_lost_total"]
    assert round(sum(t["marks_lost"] for t in body["topics"]), 2) == total
    assert total == round(sum(r["negative_marking"]["marks_lost"] for r in latest_rows if r["negative_marking"]), 2)


def test_negative_marking_brief_matches_the_report(seeded):
    client = seeded
    body = _roster(client)
    profiled = [r for r in body["rows"] if r["latest"] and r["negative_marking"]]
    assert len(profiled) == body["summary"]["negative_marking"]["profiled"] == 12
    for row in profiled:
        brief = row["negative_marking"]
        report = client.get(f"/api/results/{row['latest']['submission_id']}").json()["patterns"]["negative_marking"]
        for key in ("scheme", "break_even", "attempted", "correct", "wrong", "blank", "accuracy", "marks_lost", "risk",
                    "recommendation"):
            assert brief[key] == report[key], key
        assert brief["items"] == brief["attempted"] + brief["blank"]
        # The flag is the report's own attempts insight, word for word.
        result = client.get(f"/api/results/{row['latest']['submission_id']}").json()
        attempts = next(i for i in result["key_insights"] if i["id"] == "attempts")
        assert brief["headline"] == attempts["headline"]
        if attempts["tone"] == "good":
            assert brief["verdict"] == "ok"
        else:
            assert brief["verdict"] == ("guessing" if attempts["evidence"]["filter"] == "wrong" else "skipping")
        assert brief["under_attempting"] == (brief["verdict"] == "skipping")
        risky = [t["topic"] for t in report["topics"] if t["risk"] in ("medium", "high")]
        assert brief["risky_topics"] == risky
    guessing = {r["student_ref"] for r in profiled if r["negative_marking"]["verdict"] == "guessing"}
    under = {r["student_ref"] for r in profiled if r["negative_marking"]["verdict"] == "skipping"}
    nm = body["summary"]["negative_marking"]
    assert (nm["guessing_risk"], nm["under_attempting"], nm["flagged"]) == (len(guessing), len(under), len(guessing | under))
    assert nm["risky_topic_students"] == sum(1 for r in profiled if r["negative_marking"]["risky_topics"])
    # Half-up like every 1-dp figure (sittings.r1): 39 / 12 = 3.25 -> 3.3, as the owner page shows it.
    assert nm["marks_lost_per_paper"] == sittings.r1(nm["marks_lost_total"] / nm["profiled"])
    # Students whose report says the attempt strategy works are never flagged.
    for ref in ("lavanya-pillai", "nikhil-sood", "kunal-desai"):
        assert _row(body, ref)["negative_marking"]["verdict"] == "ok"
    for ref in ("tanvi-shah", "aditi-rao"):
        assert _row(body, ref)["negative_marking"]["verdict"] == "skipping"


def test_bonus_identity_on_a_negatively_marked_paper(upload, client, fake_ai, monkeypatch, ai_ready):
    """correct x 4 - wrong x 1 + bonus questions x 4 == total_score (the NEET 2016 identity)."""
    import ai
    from ai_schemas import OcrAnswer, OcrResult
    from tests.test_mcq_bonus import RUBRIC

    letters = {1: "c", 2: "3", 3: "c", 5: "d", 6: "a"}  # Q1 wrong, Q4 / Q5 bonus

    def letters_ocr(pages, rubric_content, **kwargs):
        answers = [OcrAnswer(question=n, answer=f"({a})", confidence=0.95) for n, a in letters.items()]
        return OcrResult(answers=answers, overall_confidence=0.95, provider="anthropic", model="fake-vision-model")

    monkeypatch.setattr(ai, "run_ocr", letters_ocr)
    queued = upload(student_name="Bonus Student", rubric_json=json.dumps(RUBRIC))
    assert queued.status_code == 202, queued.text
    body = _roster(client)
    row = _row(body, "bonus-student", demo=False)
    brief = row["negative_marking"]
    assert (brief["correct"], brief["wrong"], brief["blank"], brief["items"]) == (3, 1, 0, 4)
    assert brief["correct"] * 4 - brief["wrong"] * 1 + 2 * 4 == row["latest"]["score"] == 19
    assert sum(s["score"] for s in row["subjects"]) == row["latest"]["score"]
    assert body["summary"]["real_students"] == 1 and body["summary"]["demo_students"] == 0


def test_actions_since_latest_and_priority_tiers(seeded):
    client = seeded
    body = _roster(client)
    for row in body["rows"]:
        records = [r for r in client.get("/api/interventions", params={"student_ref": row["student_ref"]}).json()
                   if r["is_demo"] == row["is_demo"]]
        assert row["actions"]["count"] == len(records)
        if row["latest"]:
            since = sum(1 for r in records if _when(r["applied_at"]) >= _when(row["latest"]["date"]))
            assert row["actions"]["since_latest"] == since
        if records:
            last = row["actions"]["last"]
            assert last["id"] == records[0]["id"] and last["outcome_status"] == records[0]["outcome_status"]
            change = records[0]["outcome"]["mastery_change"] if records[0]["outcome"] else None
            assert last["mastery_change"] == change
    summary = body["summary"]
    at_risk = [r for r in body["rows"] if r["latest"] and r["latest"]["urgency"] == "at_risk"]
    assert summary["at_risk_without_action"] == sum(1 for r in at_risk if r["actions"]["since_latest"] == 0) == 9
    vikram = _row(body, "vikram-chauhan")
    assert vikram["actions"]["since_latest"] >= 1 and vikram["priority"]["tier"] == 4
    assert _row(body, "aarav-sharma")["actions"] == {"count": 0, "since_latest": 0, "last": None}

    tiers = [r["priority"]["tier"] for r in body["rows"] if r["priority"]["tier"] is not None]
    assert tiers == sorted(tiers) and summary["flagged"] == len(tiers) == 10
    flagged = [r for r in body["rows"] if r["priority"]["tier"] == 1]
    assert [r["latest"]["pct"] for r in flagged] == sorted(r["latest"]["pct"] for r in flagged)
    assert [r["student_name"] for r in body["rows"][:3]] == ["Priya Banerjee", "Rohan Joshi", "Student B02"]
    assert body["rows"][0]["priority"]["reason"].startswith("Biology - Genetics · ")
    assert body["rows"][0]["priority"]["reason"].endswith(" · 5-Q test · no action yet")
    pooja = _row(body, "pooja-venkat")
    assert pooja["priority"]["reason"].startswith("Mock 10 · ") and pooja["priority"]["reason"].endswith("up 10.0 pts")

    # Logging an action moves the student from tier 1 to tier 4 and updates the summary.
    priya = body["rows"][0]
    weakest = priya["topics"][0]["topic"]
    created = client.post("/api/interventions", json={
        "submission_id": priya["latest"]["submission_id"], "topic": weakest, "kind": "study_focus",
        "action": "Two worked examples and 5 unseen questions", "applied_by": "Ms. Test",
    })
    assert created.status_code == 201, created.text
    after = _roster(client)
    priya_after = _row(after, priya["student_ref"])
    assert priya_after["actions"]["since_latest"] == 1 and priya_after["priority"]["tier"] == 4
    assert priya_after["actions"]["last"]["topic"] == weakest
    assert after["summary"]["at_risk_without_action"] == 8
    logged = next(t for t in after["topics"] if t["topic"] == weakest)
    before = next(t for t in body["topics"] if t["topic"] == weakest)
    assert logged["actions_logged"] == before["actions_logged"] + 1


def test_scope_by_batch_test_and_demo(seeded):
    client = seeded
    full = _roster(client)
    owner = client.get("/api/owner/dashboard").json()
    for batch in owner["batches"]:
        scoped = _roster(client, batch_id=batch["batch"]["id"])
        assert scoped["summary"]["students"] == batch["students"]
        assert all(r["batch"]["id"] == batch["batch"]["id"] for r in scoped["rows"])
        assert scoped["scope"] == {"batch_id": batch["batch"]["id"], "rubric_id": None, "demo": None}
    assert sum(_roster(client, batch_id=b["batch"]["id"])["summary"]["students"] for b in owner["batches"]) == len(
        full["rows"]
    )
    assert _roster(client, demo=False)["rows"] == []
    assert _roster(client, demo=True)["summary"] == full["summary"]

    # With a test as the scope, latest is that test's sheet and previous may be another test.
    mock09 = next(t for t in client.get("/api/filters").json()["tests"] if t["name"].startswith("NEET MCQ Practice - Mock 09"))
    scoped = _roster(client, rubric_id=mock09["rubric_id"])
    assert scoped["rows"] and all(r["latest"]["test_id"] == mock09["rubric_id"] for r in scoped["rows"])
    assert all(r["spark"][-1]["submission_id"] == r["latest"]["submission_id"] for r in scoped["rows"])


def test_empty_database_returns_zeros(client):
    body = _roster(client)
    assert body["rows"] == [] and body["topics"] == []
    summary = body["summary"]
    assert summary["students"] == summary["graded"] == summary["sheets"] == 0
    assert summary["urgency_counts"] == {"on_track": 0, "needs_attention": 0, "at_risk": 0}
    assert summary["negative_marking"] == {
        "profiled": 0, "guessing_risk": 0, "under_attempting": 0, "flagged": 0, "marks_lost_total": 0,
        "marks_lost_per_paper": 0, "risky_topic_students": 0,
    }
    assert summary["waiting_students"] == summary["different_test"] == summary["newer_outside"] == 0


def test_waiting_sheets_add_up_and_newer_papers_outside_a_test_filter(seeded):
    client = seeded
    body = _roster(client)
    summary = body["summary"]
    waiting = [r for r in body["rows"] if r["waiting"]]
    assert summary["waiting_students"] == len(waiting) == 1
    assert sum(len(r["waiting"]) for r in body["rows"]) == summary["held"] + summary["failed"] + summary["processing"]
    assert all(r["newer"] is None for r in body["rows"]) and summary["newer_outside"] == 0

    # Scoped to Mock 09, the row is the Mock 09 paper and says a newer graded paper exists.
    mock09 = next(t for t in client.get("/api/filters").json()["tests"] if t["name"].startswith("NEET MCQ Practice - Mock 09"))
    scoped = _roster(client, rubric_id=mock09["rubric_id"])
    kunal = _row(scoped, "kunal-desai")
    assert kunal["latest"]["short_name"] == "Mock 09"
    assert kunal["newer"]["short_name"] == "Mock 10" and kunal["newer"]["pct"] == 80.2
    assert scoped["summary"]["newer_outside"] == sum(1 for r in scoped["rows"] if r["newer"])
    assert scoped["summary"]["with_trend"] == 0
