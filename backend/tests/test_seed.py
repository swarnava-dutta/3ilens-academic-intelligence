"""Seed tests: idempotent base seed, the Genetics demo cohort and the NEET mixed demo set (no AI calls)."""
from __future__ import annotations

import pytest
from sqlalchemy import func, select


def count(session, model) -> int:
    return session.scalar(select(func.count()).select_from(model))


def test_seed_base_is_idempotent(isolated_env):
    import database
    import seed
    from database import Batch, Institution, Rubric

    database.init_db()
    with database.SessionLocal() as session:
        first = seed.seed_base(session)
        second = seed.seed_base(session)
        assert [obj.id for obj in first] == [obj.id for obj in second]
        assert count(session, Institution) == count(session, Batch) == count(session, Rubric) == 1
        institution, batch, rubric = second
        assert institution.name == "Instit-42"
        assert (batch.name, batch.exam_type) == ("NEET-A", "Mock-07")
        assert (rubric.name, rubric.version, rubric.total_marks) == ("Biology - Genetics", "v1", 20)
        assert len(rubric.content["questions"]) == 5


def test_seed_demo_cohort_is_idempotent_and_never_calls_ai(isolated_env, forbid_ai):
    import database
    import seed
    from database import EvaluationResult, StudentSubmission

    database.init_db()
    with database.SessionLocal() as session:
        created = seed.seed_demo_cohort(session)
        assert created == len(seed.DEMO_STUDENTS) + 1
        assert seed.seed_demo_cohort(session) == 0
        subs = session.scalars(select(StudentSubmission)).all()
        assert len(subs) == created
        assert all(s.is_demo for s in subs)
        statuses = [s.status for s in subs]
        assert statuses.count("COMPLETED") == len(seed.DEMO_STUDENTS)
        assert statuses.count("HUMAN_REVIEW_REQUIRED") == 1
        assert count(session, EvaluationResult) == len(seed.DEMO_STUDENTS)
        names = {s.student_name for s in subs}
        assert len(names) == created  # unique, realistic names
    assert forbid_ai == []


def test_demo_cohort_uses_the_insights_engine_with_varied_performance(isolated_env):
    import database
    import seed
    from database import EvaluationResult

    database.init_db()
    with database.SessionLocal() as session:
        seed.seed_demo_cohort(session)
        results = session.scalars(select(EvaluationResult)).all()
        percentages = sorted(r.total_score / r.total_marks * 100 for r in results)
        assert percentages[0] < 40 and percentages[-1] > 85  # weak to strong
        for r in results:
            assert r.total_marks == 20
            assert sum(q["estimated_marks"] for q in r.question_evaluations) == pytest.approx(r.total_score)
            assert len(r.topic_mastery) == 5
            assert len(r.roi_recommendations) <= 5
            assert r.strengths_gaps["strengths"] and r.strengths_gaps["gaps"]


def test_demo_seed_endpoint_and_cohort(client, forbid_ai):
    import seed

    first = client.post("/api/demo/seed")
    assert first.status_code == 200
    body = first.json()
    assert set(body) == {"message", "created"}
    assert body["created"] == len(seed.DEMO_STUDENTS) + 1
    again = client.post("/api/demo/seed").json()
    assert again["created"] == 0 and again["message"]

    cohort = client.get("/api/cohort").json()
    assert cohort["is_demo"] is True
    assert cohort["demo_count"] == body["created"] and cohort["real_count"] == 0
    assert cohort["completed"] == len(seed.DEMO_STUDENTS)
    assert cohort["human_review"] == 1
    assert cohort["average_score"] is not None and 0 < cohort["average_score"] < 20
    assert cohort["average_mastery"] is not None
    assert len(cohort["topic_mastery"]) == 5
    assert sum(b["count"] for b in cohort["score_distribution"]) == len(seed.DEMO_STUDENTS)
    assert sum(1 for b in cohort["score_distribution"] if b["count"]) >= 3  # a spread, not a spike
    priorities = cohort["top_priorities"]
    assert 0 < len(priorities) <= 5
    assert [p["roi"] for p in priorities] == sorted((p["roi"] for p in priorities), reverse=True)

    submissions = client.get("/api/submissions").json()
    assert all(s["is_demo"] for s in submissions)
    completed = next(s for s in submissions if s["status"] == "COMPLETED")
    result = client.get(f"/api/results/{completed['id']}")
    assert result.status_code == 200
    assert result.json()["submission"]["is_demo"] is True
    assert result.json()["processing_log"]
    review = next(s for s in submissions if s["status"] == "HUMAN_REVIEW_REQUIRED")
    assert review["ocr_confidence"] == 0.65
    assert client.get(f"/api/results/{review['id']}").status_code == 202
    assert forbid_ai == []


def test_demo_and_live_records_are_counted_separately(client, upload, fake_ai):
    client.post("/api/demo/seed")
    assert upload(student_name="Live Student").status_code == 202
    cohort = client.get("/api/cohort").json()
    assert cohort["real_count"] == 1
    assert cohort["demo_count"] == cohort["total_submissions"] - 1
    assert client.get("/api/submissions").json()[0]["is_demo"] is False  # live upload is newest


def test_seed_cli(isolated_env, capsys):
    import seed

    assert seed.main([]) == 0
    assert "Base seed OK" in capsys.readouterr().out
    assert seed.main(["--demo"]) == 0
    assert "created" in capsys.readouterr().out
    assert seed.main(["--demo"]) == 0
    assert "already present" in capsys.readouterr().out


# --------------------------------------------------------------------------- #
# Genetics demo extras (confusions, demo sign-off) and the NEET mixed set
# --------------------------------------------------------------------------- #
PAYLOAD_EFFORT = {
    "Genetics": 6, "Human Physiology": 7, "Cell Biology": 5, "Organic Chemistry": 7, "Ecology": 3,
    "Electrostatics": 7, "Plant Physiology": 5, "Mechanics": 8, "Thermodynamics": 6, "Chemical Bonding": 5,
}
PAYLOAD_SUBJECT = {
    "Genetics": "Biology", "Human Physiology": "Biology", "Cell Biology": "Biology", "Organic Chemistry": "Chemistry",
    "Ecology": "Biology", "Electrostatics": "Physics", "Plant Physiology": "Biology", "Mechanics": "Physics",
    "Thermodynamics": "Physics", "Chemical Bonding": "Chemistry",
}


def test_genetics_demo_carries_confusions_and_two_demo_sign_offs(isolated_env, forbid_ai):
    import analytics
    import database
    import seed
    from database import StudentSubmission

    database.init_db()
    with database.SessionLocal() as session:
        assert seed.seed_demo_cohort(session) == 13
        subs = session.scalars(select(StudentSubmission).where(StudentSubmission.status == "COMPLETED")).all()
        pairs = {
            tuple(sorted((c["concept_a"], c["concept_b"])))
            for s in subs for c in (s.result.confusions or [])
        }
        assert pairs == {
            ("Back cross", "Test cross"),
            ("Codominance", "Incomplete dominance"),
            ("Griffith transformation experiment", "Meselson-Stahl experiment"),
        }
        priya = next(s for s in subs if s.student_name == "Priya Banerjee")
        assert {c["question"] for c in priya.result.confusions} == {2, 3}
        released = {s.student_name: s.result for s in subs if s.result.release_status == "RELEASED"}
        assert set(released) == {"Ananya Iyer", "Aarav Sharma"}
        assert all(r.reviewed_by == "Dr. A. Rao (demo)" and r.reviewed_at for r in released.values())
        assert all(s.student_ref == s.student_name.lower().replace(" ", "-") for s in subs)
        assert all(q["source_pages"] for s in subs for q in s.result.question_evaluations)
        counts = {u: 0 for u in ("on_track", "needs_attention", "at_risk")}
        for s in subs:
            counts[analytics.result_urgency(s.result)[0]] += 1
        assert counts == {"on_track": 5, "needs_attention": 3, "at_risk": 4}
    assert forbid_ai == []


def test_mixed_rubric_file_covers_the_ten_payload_topics():
    import seed
    from schemas import RubricContentIn

    content = RubricContentIn.model_validate(seed.load_mixed_rubric())
    assert content.name == "NEET Mixed - Mock 08" and content.subject == "Mixed"
    assert len(content.questions) == 12 and content.total_marks == 48
    assert all(q.max_marks == 4 for q in content.questions)
    topics = [q.topic for q in content.questions]
    assert list(dict.fromkeys(topics)) == list(seed.MIXED_TOPICS)
    assert topics.count("Genetics") == topics.count("Mechanics") == 2
    for q in content.questions:
        assert q.chapter == q.topic and q.subject == PAYLOAD_SUBJECT[q.topic]
        assert q.effort_hours == PAYLOAD_EFFORT[q.topic]
        assert len(q.grading_criteria) == 4 and all(c.startswith("1 mark:") for c in q.grading_criteria)
        assert q.prompt and q.expected_answer


def test_mixed_demo_set_is_idempotent_and_never_creates_an_ai_client(isolated_env, no_network_clients, forbid_ai):
    import database
    import seed
    from database import Batch, Rubric, StudentSubmission

    database.init_db()
    with database.SessionLocal() as session:
        assert seed.seed_demo_extended(session) == 6 + 8
        assert seed.seed_demo_extended(session) == 0
        subs = session.scalars(select(StudentSubmission)).all()
        assert len(subs) == 14 and all(s.is_demo and s.status == "COMPLETED" for s in subs)

        batch_b = session.scalar(select(Batch).where(Batch.name == "NEET-B"))
        assert (batch_b.exam_type, batch_b.exam, batch_b.exam_date) == ("Mock-08", "NEET", None)
        rubric = session.scalar(select(Rubric).where(Rubric.name == "NEET Mixed - Mock 08"))
        assert (rubric.version, rubric.status, rubric.total_marks) == ("v1", "FACULTY_APPROVED", 48)
        assert rubric.rubric_hash and len(rubric.rubric_hash) == 64

        learners = {s.student_name: s for s in subs if s.student_name.startswith("Student ")}
        assert sorted(learners) == [f"Student {i}" for i in ("A01", "A02", "A03", "A04", "B01", "B02")]
        assert {n for n, s in learners.items() if s.batch_id == batch_b.id} == {"Student B01", "Student B02"}

        history = [s for s in subs if not s.student_name.startswith("Student ")]
        assert sorted({s.student_name for s in history}) == sorted(seed.HISTORY_STUDENTS)
        assert sorted(s.original_filename for s in history if s.student_name == "Aarav Sharma") == [
            "aarav_sharma_neet_mixed_mock05.pdf", "aarav_sharma_neet_mixed_mock06.pdf",
        ]
        now = database.utcnow()
        ages = sorted(round((now - s.created_at).total_seconds() / 86400) for s in history)
        assert ages == [16, 16, 16, 16, 30, 30, 30, 30]
        assert all(s.student_ref == seed.student_ref_for(s.student_name) for s in subs)
        assert all(1.5 < (now - s.created_at).total_seconds() / 86400 < 2.5 for s in learners.values())
    assert no_network_clients == [] and forbid_ai == []


def test_mixed_learners_reproduce_the_payload_urgency_labels(isolated_env):
    import analytics
    import database
    import seed
    from database import StudentSubmission

    database.init_db()
    with database.SessionLocal() as session:
        seed.seed_demo_extended(session)
        for learner, _batch, _levels, urgency, strengths, gaps, _nudges in seed.MIXED_LEARNERS:
            name = f"Student {learner}"
            sub = session.scalar(select(StudentSubmission).where(StudentSubmission.student_name == name))
            result = sub.result
            assert analytics.result_urgency(result)[0] == urgency, learner
            assert result.total_marks == 48 and len(result.topic_mastery) == 10
            assert result.strengths_gaps["strengths"][:2] == strengths
            assert result.strengths_gaps["gaps"][: len(gaps)] == gaps
            assert all(q["student_answer"].startswith("Synthetic demo transcription")
                       for q in result.question_evaluations if q["student_answer"])
            assert all(e["evidence"].startswith("Synthetic demo grading") for e in result.question_evaluations)
            assert 2 <= len(result.teaching_nudges) <= 3
            assert sum(q["estimated_marks"] for q in result.question_evaluations) == pytest.approx(result.total_score)


def test_demo_sets_combine_in_any_order(isolated_env):
    import database
    import seed

    database.init_db()
    with database.SessionLocal() as session:
        assert seed.seed_demo_set(session, "mixed") == 14
        # The history rows reuse Genetics demo names; the Genetics cohort must still be complete.
        assert seed.seed_demo_set(session, "genetics") == 13
        assert seed.seed_demo_set(session, "all") == 0
        with pytest.raises(ValueError):
            seed.seed_demo_set(session, "everything")


def test_demo_seed_endpoint_all_sets(client, forbid_ai):
    from tests.test_contract import check_interface

    body = client.post("/api/demo/seed", params={"set": "all"}).json()
    check_interface(body, "DemoSeedResult")
    assert body["created"] == 27
    assert client.post("/api/demo/seed", params={"set": "mixed"}).json()["created"] == 0
    assert client.post("/api/demo/seed").json()["created"] == 0
    subs = client.get("/api/submissions").json()
    assert len(subs) == 27 and all(s["is_demo"] for s in subs)
    assert forbid_ai == []
