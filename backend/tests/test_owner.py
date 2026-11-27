"""Institute-owner dashboard (BRD FR-5.9): contract shape and aggregates on the genetics + mixed
demo seeds, the single-pass definitions (latest result per student by upload time, main sittings,
same-student progress), faculty identity from free-text names, signals, spend, scoping and guards."""
from __future__ import annotations

from datetime import timedelta

import pytest

from tests.test_contract import check_interface

URL = "/api/owner/dashboard"
LEVELS = ("on_track", "needs_attention", "at_risk")


@pytest.fixture
def seeded(demo_data, client):
    assert client.post("/api/demo/seed", params={"set": "all"}).json()["created"] == 27


@pytest.fixture
def insights(seeded, client):
    """Adds NEET-C (sample): Mock 09 (12) -> oral sample (1) -> Mock 10 (12) plus logged interventions."""
    assert client.post("/api/demo/seed", params={"set": "insights"}).json()["created"] > 0


def batch_named(body: dict, name: str) -> dict:
    return next(b for b in body["batches"] if b["batch"]["name"] == name)


def r1(value: float) -> float:
    from owner import r1 as owner_r1

    return owner_r1(value)


def add_sheet(db, *, batch_name: str, student: str, pct: float, rubric_name: str = "Single paper (test)",
              topics: dict[str, float] | None = None, days_ago: float = 0.0, status: str | None = None):
    """A completed sheet on its own one-question rubric (score = pct of 4 marks)."""
    from database import Batch, EvaluationResult, Rubric, StudentSubmission, SubmissionStatus, utcnow
    from hashing import student_ref_for

    batch = db.query(Batch).filter(Batch.name == batch_name).one()
    rubric = db.query(Rubric).filter(Rubric.name == rubric_name).first()
    if rubric is None:
        rubric = Rubric(name=rubric_name, version="v1", content={"questions": []}, total_marks=4.0)
        db.add(rubric)
        db.flush()
    rows = [
        {"topic": t, "subject": "Biology", "score": 4 * m / 100, "max_marks": 4.0, "mastery": float(m)}
        for t, m in (topics or {"Ecology": pct}).items()
    ]
    created = utcnow() - timedelta(days=days_ago)
    sub = StudentSubmission(
        student_name=student, file_path="", original_filename=f"{student}.pdf", mime_type="application/pdf",
        status=status or SubmissionStatus.COMPLETED, batch_id=batch.id, rubric_id=rubric.id, created_at=created,
        is_demo=True, student_ref=student_ref_for(student),
    )
    if sub.status == SubmissionStatus.COMPLETED:
        sub.result = EvaluationResult(
            total_score=4 * pct / 100, total_marks=4.0, overall_mastery=pct, topic_mastery=rows,
            roi_recommendations=[], strengths_gaps={"strengths": [], "gaps": []}, question_evaluations=[],
            rubric_id=rubric.id, created_at=created,
        )
    db.add(sub)
    db.commit()
    return sub


# --------------------------------------------------------------------------- #
# Contract and totals
# --------------------------------------------------------------------------- #
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
    assert totals["students"] == 19 and totals["students_graded"] == 18 and 0 < totals["average_pct"] < 100
    assert sum(body["urgency_counts"].values()) == 18  # the latest result of every graded student
    assert sum(totals["sheet_urgency_counts"].values()) == 26  # every completed sheet
    assert body["is_demo"] is True and body["demo_count"] == 27 and body["real_count"] == 0
    assert body["role_note"].startswith("Owner view - no login in this PoC.")
    assert body["interventions"] == {
        "records": 0, "measured": 0, "uplift": None, "calibration_factor": None, "pending": 0, "calibration_n": 0,
        "is_demo": False,
    }
    weakest = body["weakest_topics"]
    assert [t["topic"] for t in weakest] == [g["topic"] for g in body["topic_gaps"][:5]]
    assert [t["mastery"] for t in weakest] == sorted(t["mastery"] for t in weakest)
    assert body["operations"]["dlq_count"] == 0 and body["operations"]["target_inr"] == 5
    assert body["period"]["first"] <= body["period"]["last"]


def test_cohort_and_owner_counts_reconcile(client, insights):
    body = client.get(URL).json()
    cohort = client.get("/api/cohort").json()
    assert body["totals"]["completed"] == cohort["completed"]
    # Both count students (each one's latest sheet), never sheets: 3 sittings of a student are one.
    assert body["urgency_counts"] == cohort["urgency_counts"]
    assert sum(cohort["urgency_counts"].values()) == body["totals"]["students_graded"] < cohort["completed"]
    assert sum(body["totals"]["sheet_urgency_counts"].values()) == cohort["completed"]
    release = body["release"]
    assert release["sheets_provisional"] + release["sheets_released"] == body["totals"]["completed"]


# --------------------------------------------------------------------------- #
# Batches: one partition of the latest results
# --------------------------------------------------------------------------- #
def test_batch_figures_add_up_to_the_institution(client, insights):
    body = client.get(URL).json()
    check_interface(body, "OwnerDashboard")
    batches, totals = body["batches"], body["totals"]
    assert sum(b["students_graded"] for b in batches) == totals["students_graded"]
    for level in LEVELS:
        assert sum(b["urgency_counts"][level] for b in batches) == body["urgency_counts"][level]
    assert sum(body["urgency_counts"].values()) == totals["students_graded"]
    weighted = sum(b["average_pct"] * b["students_graded"] for b in batches if b["students_graded"])
    assert totals["average_pct"] == pytest.approx(weighted / totals["students_graded"], abs=0.06)
    assert len(body["at_risk_students"]) == body["urgency_counts"]["at_risk"]
    assert sum(b["at_risk_unactioned"] for b in batches) == sum(1 for s in body["at_risk_students"] if not s["actioned"])
    leads = [f for f in body["faculty"] if f["batches"]]
    assert sum(f["students_graded"] for f in leads) == totals["students_graded"]
    assert sum(f["awaiting_release"] for f in leads) == body["release"]["students_awaiting"]


def test_batch_summaries(client, seeded):
    body = client.get(URL).json()
    neet_a, neet_b = batch_named(body, "NEET-A"), batch_named(body, "NEET-B")
    assert neet_a["latest_test"]["name"] == "Biology - Genetics" and neet_a["latest_test_date"]
    assert neet_a["latest_test_students"] == 12 and neet_a["latest_test_main"] is True
    # Mock 08 (12 mixed questions) -> Genetics (5 Biology questions): re-tested, but the papers are
    # not comparable (sittings.comparable), so there is no change, only a count.
    progress = neet_a["progress"]
    assert progress["students"] == 0 and progress["not_comparable"] == 4
    assert neet_a["previous_average_pct"] is None and neet_a["trend_delta_pct"] is None
    assert neet_a["previous_test"]["test_name"] == "NEET Mixed - Mock 08" and neet_a["previous_test"]["shared_students"] == 4
    assert sum(neet_a["urgency_counts"].values()) == neet_a["students_graded"]
    assert neet_a["review_backlog"] == 1 and neet_a["released"] == 2 and neet_a["top_gap_topic"]
    assert neet_a["top_gap_students"] >= 3
    assert neet_a["is_demo"] is True and neet_a["cost_inr"] == 0 and neet_a["demo_count"] == 25
    assert neet_b["latest_test"]["name"] == "NEET Mixed - Mock 08" and neet_b["students"] == 2
    assert neet_b["latest_test_main"] is False  # a 2-student sitting is a fallback, not a main test
    assert neet_b["previous_average_pct"] is None and neet_b["trend_delta_pct"] is None
    assert neet_b["progress"]["students"] == 0


def test_a_later_single_student_sitting_is_not_the_main_test(client, seeded, db_session):
    before = batch_named(client.get(URL).json(), "NEET-A")
    add_sheet(db_session, batch_name="NEET-A", student="Late Imported Paper", pct=5.0)
    body = client.get(URL).json()
    neet_a = batch_named(body, "NEET-A")
    assert neet_a["latest_test"]["name"] == "Biology - Genetics"
    assert neet_a["newer_small_sitting"]["test_name"] == "Single paper (test)"
    assert neet_a["newer_small_sitting"]["students"] == 1
    assert neet_a["trend_delta_pct"] == before["trend_delta_pct"] and neet_a["progress"] == before["progress"]
    assert neet_a["students_graded"] == before["students_graded"] + 1
    point = next(p for p in body["trend"] if p["test_name"] == "Single paper (test)")
    assert point["main"] is False and point["students"] == 1


def test_regrading_an_old_sheet_changes_nothing_but_release(client, insights, forbid_ai):
    """A re-grade dates a new result version now, but every page orders sheets by when they were sat
    (sittings.order), so an old test never becomes a student's latest - on the owner, cohort or
    students page."""
    def pages() -> tuple[dict, dict, list, dict]:
        return (
            client.get(URL).json(),
            client.get("/api/cohort", params={"per_student": "true"}).json(),
            client.get("/api/cohort/sittings").json(),
            client.get("/api/students/roster").json(),
        )

    before, cohort_before, sittings_before, roster_before = pages()
    neet_c = batch_named(before, "NEET-C (sample)")
    mock09 = next(r for r in client.get("/api/submissions").json()
                  if r["batch_id"] == neet_c["batch"]["id"] and r["total_marks"] == 104)
    response = client.post(f"/api/submissions/{mock09['id']}/reevaluate", json={})
    assert response.status_code == 202 and response.json()["status"] == "COMPLETED"
    after, cohort_after, sittings_after, roster_after = pages()
    assert forbid_ai == []
    assert after["totals"]["average_pct"] == before["totals"]["average_pct"]
    assert after["urgency_counts"] == before["urgency_counts"]
    assert after["progress"] == before["progress"]
    assert [p["date"] for p in after["trend"]] == [p["date"] for p in before["trend"]]
    for old, new in zip(before["batches"], after["batches"]):
        assert new["latest_test"] == old["latest_test"] and new["average_pct"] == old["average_pct"]
        assert new["latest_test_date"] == old["latest_test_date"]

    def latest_ids(rows: list[dict]) -> set[int]:
        return {r["submission_id"] for r in rows}

    assert mock09["id"] not in latest_ids(cohort_after["students_view"])
    assert latest_ids(cohort_after["students_view"]) == latest_ids(cohort_before["students_view"])
    assert cohort_after["urgency_counts"] == cohort_before["urgency_counts"] == after["urgency_counts"]
    assert [(s["batch_id"], s["test_id"], s["date"]) for s in sittings_after] == [
        (s["batch_id"], s["test_id"], s["date"]) for s in sittings_before
    ]
    assert latest_ids([r["latest"] for r in roster_after["rows"] if r["latest"]]) == latest_ids(
        [r["latest"] for r in roster_before["rows"] if r["latest"]]
    )


def test_owner_progress_is_the_cohort_pages_paired_change(client, insights):
    """Same students, same numbers: a batch's owner progress is the cohort page's paired change for
    the batch's latest whole-class test (each student against the sheet they sat before; only
    comparable pairs count: sittings.progress, half-up 1 dp, up 5+ / down 5+ / steady)."""
    body = client.get(URL).json()
    compared = 0
    for row in body["batches"]:
        progress = row["progress"]
        if not progress["students"] and not progress["not_comparable"]:
            continue
        cohort = client.get("/api/cohort", params={
            "per_student": "true", "batch_id": row["batch"]["id"], "test_id": row["latest_test"]["id"],
        }).json()
        paired = cohort["paired_change"]
        assert cohort["previous"]["test_name"] == row["previous_test"]["test_name"]
        assert row["previous_test"]["shared_students"] == len(paired["rows"])
        assert paired["paired"] == progress["students"]
        fields = ("mean_before", "mean_after", "mean_change", "improved", "declined", "steady", "not_comparable")
        assert {k: paired[k] for k in fields} == {k: progress[k] for k in fields}
        assert progress["improved"] + progress["declined"] + progress["steady"] == progress["students"]
        assert progress["not_comparable"] == sum(1 for r in paired["rows"] if not r["comparable"])
        changes = sorted((r["change"] for r in paired["rows"] if r["comparable"]), reverse=True)
        assert changes == sorted((m["change"] for m in body["progress_students"]
                                  if m["batch_id"] == row["batch"]["id"]), reverse=True)
        assert progress["improved"] == sum(1 for c in changes if c >= 5)
        assert progress["declined"] == sum(1 for c in changes if c <= -5)
        compared += 1
    assert compared == 2  # NEET-A (Mock 08 -> Genetics, not comparable) and NEET-C (Mock 09 -> Mock 10)


def test_owner_cohort_and_students_pages_count_progress_alike(client, insights):
    """One pairing and one comparability rule (sittings.pairs / sittings.comparable): the students
    page's trends, the cohort page's all-batches view and the owner's progress give the same counts."""
    owner = client.get(URL).json()["progress"]
    roster = client.get("/api/students/roster").json()["summary"]
    cohort = client.get("/api/cohort", params={"per_student": "true"}).json()["paired_change"]
    assert (owner["improved"], owner["steady"], owner["declined"], owner["not_comparable"]) == (6, 6, 0, 4)
    assert (roster["improving"], roster["steady"], roster["slipping"], roster["different_test"]) == (6, 6, 0, 4)
    assert (cohort["improved"], cohort["steady"], cohort["declined"], cohort["not_comparable"]) == (6, 6, 0, 4)
    assert cohort["mean_change"] == owner["mean_change"]


def test_a_retake_of_the_same_test_is_progress_everywhere(client, seeded, db_session):
    """A retake is comparable even on a one-question test: the owner, cohort and students pages
    all count it."""
    for name, (old, new) in {"Retake A": (40, 50), "Retake B": (50, 60), "Retake C": (70, 72)}.items():
        add_sheet(db_session, batch_name="NEET-B", student=name, pct=old, rubric_name="Retaken paper", days_ago=10)
        add_sheet(db_session, batch_name="NEET-B", student=name, pct=new, rubric_name="Retaken paper", days_ago=1)
    neet_b = batch_named(client.get(URL).json(), "NEET-B")
    assert neet_b["latest_test"]["name"] == "Retaken paper" and neet_b["previous_test"] is None
    progress = neet_b["progress"]
    assert (progress["students"], progress["improved"], progress["steady"], progress["not_comparable"]) == (3, 2, 1, 0)
    assert progress["mean_change"] == 7.4  # 53.3% -> 60.7%
    cohort = client.get("/api/cohort", params={
        "per_student": "true", "batch_id": neet_b["batch"]["id"], "test_id": neet_b["latest_test"]["id"],
    }).json()["paired_change"]
    assert (cohort["paired"], cohort["improved"], cohort["steady"], cohort["mean_change"]) == (3, 2, 1, 7.4)
    rows = client.get("/api/students/roster", params={"batch_id": neet_b["batch"]["id"]}).json()["rows"]
    trends = {r["student_name"]: r["trend"] for r in rows if r["student_name"].startswith("Retake")}
    assert trends == {"Retake A": "improving", "Retake B": "improving", "Retake C": "steady"}


# --------------------------------------------------------------------------- #
# Progress, at-risk follow-through, release
# --------------------------------------------------------------------------- #
def test_progress_change_is_after_minus_before_exactly(client, insights):
    body = client.get(URL).json()
    rows = [body["progress"]] + [b["progress"] for b in body["batches"]]
    for row in rows:
        if row["students"]:
            assert row["mean_change"] == r1(row["mean_after"] - row["mean_before"])
    assert body["progress"]["students"] == sum(b["progress"]["students"] for b in body["batches"])
    neet_c = batch_named(body, "NEET-C (sample)")
    assert neet_c["progress"]["students"] == 12  # Mock 09 -> Mock 10; the 1-student oral sitting is skipped
    assert neet_c["latest_test"]["name"] == "NEET MCQ Practice - Mock 10 (sample)"
    assert neet_c["previous_test"]["test_name"] == "NEET MCQ Practice - Mock 09 (sample)"
    for student in body["progress_students"]:
        assert student["change"] == r1(student["after_pct"] - student["before_pct"])
    assert [s["change"] for s in body["progress_students"]] == sorted((s["change"] for s in body["progress_students"]), reverse=True)


def test_progress_names_the_sittings_its_pairs_come_from(client, insights):
    body = client.get(URL).json()
    neet_c = batch_named(body, "NEET-C (sample)")
    progress = neet_c["progress"]
    [before] = progress["before_sittings"]
    [after] = progress["after_sittings"]
    assert before["test_name"] == "NEET MCQ Practice - Mock 09 (sample)" and before["students"] == 12
    assert after["test_name"] == "NEET MCQ Practice - Mock 10 (sample)" and after["students"] == 12
    # One source sitting each side: its mean is the progress mean itself.
    assert before["average_pct"] == progress["mean_before"] and after["average_pct"] == progress["mean_after"]
    for row in [body["progress"]] + [b["progress"] for b in body["batches"]]:
        assert sum(s["students"] for s in row["before_sittings"]) == row["students"]
        assert sum(s["students"] for s in row["after_sittings"]) == row["students"]
    # The previous whole-class sitting says how many of its students also sat the main test.
    assert neet_c["previous_test"]["shared_students"] == 12


def test_previous_sitting_of_other_students_shares_nobody(client, seeded, db_session):
    for name in ("Other A", "Other B", "Other C"):
        add_sheet(db_session, batch_name="NEET-B", student=name, pct=50, rubric_name="Old paper", days_ago=20)
    for name in ("New A", "New B", "New C"):
        add_sheet(db_session, batch_name="NEET-B", student=name, pct=60, rubric_name="New paper", days_ago=1)
    neet_b = batch_named(client.get(URL).json(), "NEET-B")
    assert neet_b["latest_test"]["name"] == "New paper"
    assert neet_b["previous_test"]["test_name"] == "Old paper" and neet_b["previous_test"]["shared_students"] == 0
    assert neet_b["progress"]["students"] == 0 and neet_b["progress"]["before_sittings"] == []


def test_operations_scope_counts_live_and_sample_sheets(client, seeded):
    body = client.get(URL).json()
    scope = body["operations_scope"]
    completed = body["totals"]["completed"]
    assert 0 <= scope["confidence_sample_sheets"] <= scope["confidence_sheets"] <= completed
    assert scope["live_confidence_sheets"] == scope["confidence_sheets"] - scope["confidence_sample_sheets"]
    assert (scope["live_confidence"] is None) == (scope["live_confidence_sheets"] == 0)
    assert scope["latency_sheets"] <= body["real_count"]


def test_previous_average_matches_the_same_students_mock09(demo_data, client, insights):
    neet_c = batch_named(client.get(URL).json(), "NEET-C (sample)")
    mock09 = [r for r in client.get("/api/submissions").json()
              if r["batch_id"] == neet_c["batch"]["id"] and r["total_marks"] == 104]
    assert len(mock09) == 12
    expected = sum(r["percentage"] for r in mock09) / len(mock09)
    assert neet_c["previous_average_pct"] == pytest.approx(expected, abs=0.06)
    assert neet_c["trend_delta_pct"] > 0


def test_at_risk_actioned_honours_submission_and_applied_at(client, seeded, db_session):
    from database import InterventionRecord, utcnow

    body = client.get(URL).json()
    at_risk = body["at_risk_students"]
    assert len(at_risk) >= 3 and not any(s["actioned"] for s in at_risk)
    first, second, third = at_risk[:3]

    def record(student: dict, *, submission_id: int, applied_at):
        db_session.add(InterventionRecord(
            institution_id=body["institution"]["id"], batch_id=student["batch_id"], submission_id=submission_id,
            student_ref=student["student_ref"], student_name=student["student_name"], topic="Genetics",
            kind="study_focus", action="Revise", applied_by="Dr. Test", applied_at=applied_at,
        ))

    old = utcnow() - timedelta(days=90)
    record(first, submission_id=first["submission_id"], applied_at=old)  # on the latest sheet itself
    record(second, submission_id=first["submission_id"], applied_at=utcnow())  # after the latest result
    record(third, submission_id=first["submission_id"], applied_at=old)  # an older action: does not count
    db_session.commit()
    after = {s["submission_id"]: s for s in client.get(URL).json()["at_risk_students"]}
    assert after[first["submission_id"]]["actioned"] is True
    assert after[second["submission_id"]]["actioned"] is True
    assert after[third["submission_id"]]["actioned"] is False
    assert after[third["submission_id"]]["last_action_at"] is not None


def test_release_counts_per_student_and_per_sheet(client, seeded):
    body = client.get(URL).json()
    release = body["release"]
    assert release["students_graded"] == body["totals"]["students_graded"] == 18
    assert release["students_awaiting"] == sum(b["awaiting_release"] for b in body["batches"])
    assert release["students_awaiting"] == sum(row["awaiting"] for row in release["by_batch"])
    assert (release["sheets_provisional"], release["sheets_released"]) == (24, 2)
    assert release["oldest_days"] is not None and release["oldest_test"]
    target = next(s for s in body["at_risk_students"])
    assert client.post(f"/api/results/{target['submission_id']}/release",
                       json={"reviewer_name": "Dr. A. Rao"}).status_code == 200
    after = client.get(URL).json()["release"]
    assert after["students_awaiting"] == release["students_awaiting"] - 1
    assert after["sheets_released"] == release["sheets_released"] + 1


# --------------------------------------------------------------------------- #
# Topics, exam behaviour, same paper
# --------------------------------------------------------------------------- #
def test_topic_gaps_skip_small_and_subject_only_topics(client, seeded, db_session):
    for i, pct in enumerate((10.0, 20.0, 30.0)):
        add_sheet(db_session, batch_name="NEET-B", student=f"Subject Key {i}", pct=pct, days_ago=40,
                  topics={"Physics": pct, "Rare Topic": pct} if i == 0 else {"Physics": pct})
    body = client.get(URL).json()
    gaps, hidden = body["topic_gaps"], {h["topic"]: h for h in body["topic_gaps_hidden"]}
    assert gaps and all(g["students"] >= 3 for g in gaps)
    assert not any(g["topic"].casefold() in {"physics", "chemistry", "biology"} for g in gaps)
    assert hidden["Physics"]["reason"] == "subject_only" and hidden["Physics"]["students"] == 3
    assert hidden["Rare Topic"] == {"topic": "Rare Topic", "students": 1, "reason": "few_students"}
    assert [g["mastery"] for g in gaps] == sorted(g["mastery"] for g in gaps)
    for gap in gaps:
        assert gap["below_40"] <= gap["students"] and len(gap["batches"]) == len(gap["batch_ids"])


def test_exam_behaviour_matches_the_report_profiles(client, insights):
    body = client.get(URL).json()
    behaviour = body["exam_behaviour"]
    neet_c = batch_named(body, "NEET-C (sample)")
    row = next(r for r in behaviour["by_batch"] if r["batch_id"] == neet_c["batch"]["id"])
    latest_ids = {
        r["id"] for r in client.get("/api/submissions").json()
        if r["batch_id"] == neet_c["batch"]["id"] and r["total_marks"] == 96
    }
    wrong = lost = blank = 0
    for sid in latest_ids:
        profile = client.get(f"/api/results/{sid}").json()["patterns"]["negative_marking"]
        wrong, lost, blank = wrong + profile["wrong"], lost + profile["marks_lost"], blank + profile["blank"]
    assert row["students"] == len(latest_ids) == 12
    assert (row["wrong"], row["blank"]) == (wrong, blank) and row["marks_lost"] == pytest.approx(lost)
    assert row["mcqs"] == row["attempted"] + row["blank"] and row["attempted"] == row["correct"] + row["wrong"]
    assert row["marks_lost_per_student"] == r1(lost / 12)
    assert row["previous"]["test"] == "NEET MCQ Practice - Mock 09 (sample)" and row["previous"]["students"] == 12
    assert row["previous"]["current_marks_lost_per_student"] == row["marks_lost_per_student"]
    overall = behaviour["overall"]
    assert overall["students"] == sum(r["students"] for r in behaviour["by_batch"])
    assert overall["wrong"] == sum(r["wrong"] for r in behaviour["by_batch"])


def test_same_paper_compares_the_newest_sitting_of_each_batch(client, seeded):
    body = client.get(URL).json()
    paper = next(p for p in body["same_paper"] if p["test_name"] == "NEET Mixed - Mock 08")
    rows = {r["batch_name"]: r for r in paper["rows"]}
    assert set(rows) == {"NEET-A", "NEET-B"} and rows["NEET-B"]["students"] == 2
    newest_a = [p for p in body["trend"] if p["batch_name"] == "NEET-A" and p["test_name"] == "NEET Mixed - Mock 08"][-1]
    assert rows["NEET-A"]["avg_pct"] == newest_a["average_pct"] and rows["NEET-A"]["students"] == newest_a["students"]


# --------------------------------------------------------------------------- #
# Spend, signals
# --------------------------------------------------------------------------- #
def test_spend_counts_calls_without_an_institution(client, seeded, db_session):
    from database import ModelInvocation

    institution_id = client.get(URL).json()["institution"]["id"]
    for purpose, cost, inst in (("rubric_parse", 3.25, None), ("rubric_parse", 1.5, None), ("llm_drill", 0.75, None),
                                ("rubric_parse", 2.0, institution_id)):
        db_session.add(ModelInvocation(institution_id=inst, purpose=purpose, provider="anthropic",
                                       model_requested="test", cost_inr=cost))
    db_session.commit()
    spend = client.get(URL).json()["spend"]
    assert spend["unlinked_inr"] == 5.5
    assert {p["purpose"]: p["cost_inr"] for p in spend["unlinked_by_purpose"]} == {"rubric_parse": 4.75, "llm_drill": 0.75}
    assert spend["unlinked_by_purpose"][0]["label"] == "answer-key drafting"
    assert spend["institution_other_inr"] == 2.0 and spend["grading_inr"] == 0
    assert spend["total_inr"] == 7.5 and spend["per_graded_sheet_inr"] is None


def test_signals_are_deterministic_and_reconcile(client, insights):
    first = client.get(URL).json()
    second = client.get(URL).json()
    assert [s["key"] for s in first["signals"]] == [s["key"] for s in second["signals"]]
    order = {"act": 0, "check": 1, "good": 2, "info": 3}
    ranks = [order[s["severity"]] for s in first["signals"]]
    assert ranks == sorted(ranks)
    signals = {s["key"]: s for s in first["signals"]}
    unactioned = [s for s in first["at_risk_students"] if not s["actioned"]]
    s1 = signals["at_risk_unactioned"]
    assert s1["severity"] == "act" and s1["count"] == len(unactioned)
    assert s1["title"].startswith(f"{len(unactioned)} of {first['urgency_counts']['at_risk']} at-risk students")
    s2 = signals["release_backlog"]
    assert s2["count"] == first["release"]["students_awaiting"]
    assert f"of {first['totals']['students_graded']} students" in s2["title"]
    held = signals["held"]
    assert held["count"] == first["totals"]["human_review"] == 1 and held["href"].startswith("/report/")
    assert held["detail"].endswith("· ticks hard to read")
    gap = signals["topic_gap"]
    top = next(g for g in first["topic_gaps"] if g["mastery"] < 50)
    assert gap["count"] == top["students"] and top["topic"] in gap["title"]


def test_faculty_come_from_reviewers_and_batch_leads(client, seeded):
    body = client.get(URL).json()
    rao = next(f for f in body["faculty"] if f["name"] == "Dr. A. Rao (demo)")
    assert rao["reports_released"] == 2 and rao["batches"] == [] and rao["avg_release_hours"] is not None
    assert rao["median_release_hours"] is not None
    assert body["totals"]["faculty"] == len(body["faculty"])

    neet_a, neet_b = batch_named(body, "NEET-A")["batch"], batch_named(body, "NEET-B")["batch"]
    # Same person, different spacing / case: one faculty row, first spelling kept.
    assert client.patch(f"/api/batches/{neet_a['id']}", json={"faculty_lead": "dr. a.  rao (DEMO)"}).status_code == 200
    assert client.patch(f"/api/batches/{neet_b['id']}", json={"faculty_lead": "Mr. S. Iyer (sample)"}).status_code == 200
    body = client.get(URL).json()
    faculty = {f["name"]: f for f in body["faculty"]}
    assert len([n for n in faculty if n.casefold().startswith("dr. a. rao")]) == 1
    rao = next(f for n, f in faculty.items() if n.casefold().startswith("dr. a. rao"))
    assert rao["batches"] == ["NEET-A"] and rao["students"] == 17 and rao["reports_released"] == 2
    a_row = batch_named(body, "NEET-A")
    assert rao["average_pct"] == a_row["average_pct"] and rao["students_graded"] == a_row["students_graded"]
    assert rao["at_risk"] == a_row["urgency_counts"]["at_risk"] and rao["awaiting_release"] == a_row["awaiting_release"]
    assert rao["progress_change"] == a_row["trend_delta_pct"]
    iyer = faculty["Mr. S. Iyer (sample)"]
    assert iyer["batches"] == ["NEET-B"] and iyer["students"] == 2 and iyer["reports_released"] == 0
    assert iyer["avg_release_hours"] is None and iyer["progress_change"] is None


def test_faculty_follow_through_counts_measured_actions(client, insights):
    body = client.get(URL).json()
    menon = next(f for f in body["faculty"] if f["interventions_logged"])
    assert menon["actions_measured"] == body["interventions"]["measured"]
    assert 0 <= menon["actions_improved"] <= menon["actions_measured"]
    assert body["interventions"]["calibration_n"] <= body["interventions"]["measured"]


def test_trend_has_one_point_per_sitting(client, seeded):
    trend = client.get(URL).json()["trend"]
    assert [p["date"] for p in trend] == sorted(p["date"] for p in trend)
    neet_a = [p for p in trend if p["batch_name"] == "NEET-A"]
    # One sitting per batch + test (sittings.py): Mock 08 (12 sheets of 8 students - 4 of them sat it
    # twice, 30 and 16 days ago - each counted once), then the Genetics test.
    assert [p["test_name"] for p in neet_a] == ["NEET Mixed - Mock 08", "Biology - Genetics"]
    assert [p["students"] for p in neet_a] == [8, 12]
    assert all(p["main"] for p in neet_a) and all(p["max_marks"] for p in neet_a)
    neet_b = [p for p in trend if p["batch_name"] == "NEET-B"]
    assert len(neet_b) == 1 and neet_b[0]["main"] is False


def test_live_rows_count_cost_and_reviews(client, upload, fake_ai, ai_ready):
    fake_ai.answer_confidence = 0.55
    held = upload(student_name="Meera Pillai").json()
    fake_ai.answer_confidence = 0.93
    assert client.post(f"/api/submissions/{held['id']}/review",
                       json={"reviewer": "Ms. Kavya Nair", "action": "approve"}).status_code == 202
    done = upload(student_name="Rahul Verma").json()
    assert client.post(f"/api/results/{done['id']}/release", json={"reviewer_name": "Ms.  Kavya Nair"}).status_code == 200
    body = client.get(URL).json()
    check_interface(body, "OwnerDashboard")
    assert body["is_demo"] is False and body["real_count"] == 2 and body["totals"]["completed"] == 2
    assert batch_named(body, "NEET-A")["cost_inr"] > 0 and body["operations"]["calls"] >= 3
    spend = body["spend"]
    assert spend["grading_inr"] == pytest.approx(body["operations"]["total_cost_inr"], abs=0.011)
    assert spend["live_graded_sheets"] == 2 and spend["per_graded_sheet_inr"] is not None
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
    assert body["signals"] == [] and body["progress"]["students"] == 0 and body["exam_behaviour"]["overall"] is None
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


def test_a_failing_exam_profile_never_breaks_the_dashboard(client, insights, monkeypatch):
    import patterns

    def boom(*_args, **_kwargs):
        raise RuntimeError("profile bug")

    monkeypatch.setattr(patterns, "negative_marking_profile", boom)
    response = client.get(URL)
    assert response.status_code == 200
    assert response.json()["exam_behaviour"]["overall"] is None
