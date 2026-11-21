"""analytics.py: urgency rule, result extras (narrative, controls, study plan) on new and OLD rows,
cohort extras, and the WP1 analytics endpoints (plan / weightage / exams / batch patch)."""
from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import analytics  # noqa: E402
from database import EvaluationResult, StudentSubmission, SubmissionStatus, ist_today  # noqa: E402
from tests.test_contract import check_interface  # noqa: E402

# V5 spec sample students: (score %, mastery over the 10 sample topics, expected urgency).
V5_TOPICS = [
    "Genetics", "Human Physiology", "Cell Biology", "Organic Chemistry", "Ecology",
    "Electrostatics", "Plant Physiology", "Mechanics", "Thermodynamics", "Chemical Bonding",
]
V5_STUDENTS = {
    "A01": (85.0, [62, 80, 76, 68, 88, 54, 72, 84, 66, 78], "on_track"),
    "A02": (66.4, [44, 66, 58, 46, 76, 39, 62, 70, 52, 61], "needs_attention"),
    "A03": (53.3, [29, 55, 38, 34, 66, 25, 46, 60, 40, 48], "at_risk"),
    "A04": (77.5, [64, 84, 83, 72, 78, 57, 79, 80, 74, 76], "on_track"),
    "B01": (62.6, [52, 68, 49, 43, 70, 48, 58, 74, 46, 56], "needs_attention"),
    "B02": (47.4, [31, 43, 32, 29, 55, 22, 39, 48, 34, 37], "at_risk"),
}


@pytest.fixture
def seeded(client, db_session):
    assert client.post("/api/demo/seed").status_code == 200
    subs = db_session.query(StudentSubmission).order_by(StudentSubmission.id).all()
    completed = [s for s in subs if s.status == SubmissionStatus.COMPLETED]
    review = [s for s in subs if s.status == SubmissionStatus.HUMAN_REVIEW_REQUIRED]
    return SimpleNamespace(client=client, db=db_session, completed=completed, review=review)


# --------------------------------------------------------------------------- #
# Urgency rule
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("student", sorted(V5_STUDENTS))
def test_classify_urgency_reproduces_the_v5_sample_students(student):
    pct, mastery, expected = V5_STUDENTS[student]
    topics = [{"topic": name, "mastery": m} for name, m in zip(V5_TOPICS, mastery)]
    urgency, reasons = analytics.classify_urgency(pct, topics)
    assert urgency == expected
    assert reasons and f"{pct:g}%" in reasons[0]


def test_low_topics_move_one_level_worse_and_cap_at_at_risk():
    two_low = [{"topic": "A", "mastery": 30}, {"topic": "B", "mastery": 39.9}]
    assert analytics.classify_urgency(75, two_low)[0] == "needs_attention"
    assert analytics.classify_urgency(60, two_low)[0] == "at_risk"
    assert analytics.classify_urgency(40, two_low)[0] == "at_risk"
    urgency, reasons = analytics.classify_urgency(75, two_low[:1])
    assert urgency == "on_track" and "1 topic below 40%" in reasons[-1]


def test_seeded_genetics_demo_splits_5_3_4(seeded):
    cohort = seeded.client.get("/api/cohort").json()
    assert cohort["urgency_counts"] == {"on_track": 5, "needs_attention": 3, "at_risk": 4}
    counts = {"on_track": 0, "needs_attention": 0, "at_risk": 0}
    for sub in seeded.completed:
        counts[analytics.result_urgency(sub.result)[0]] += 1
    assert counts == cohort["urgency_counts"]


def test_days_to_exam_and_strategy_modes():
    assert [analytics.strategy_mode_for(d) for d in (None, 0, 6, 7, 29, 30, 89, 90, 400)] == [
        None, "consolidation", "consolidation", "revision", "revision", "focused", "focused", "broad", "broad",
    ]
    today = ist_today()
    batch = SimpleNamespace(exam_date=(today + timedelta(days=45)).isoformat())
    assert analytics.days_to_exam(batch, today=today) == 45
    assert analytics.days_to_exam(SimpleNamespace(exam_date=(today - timedelta(days=1)).isoformat())) is None
    assert analytics.exam_date_for(SimpleNamespace(exam_date=None)) == ("2027-05-02", True)


# --------------------------------------------------------------------------- #
# Result extras on a seeded demo row
# --------------------------------------------------------------------------- #
def _weakest(seeded) -> StudentSubmission:
    return min(seeded.completed, key=lambda s: s.result.total_score)


def test_result_for_a_demo_row_carries_the_narrative_and_the_plan(seeded):
    sub = _weakest(seeded)
    body = seeded.client.get(f"/api/results/{sub.id}").json()
    check_interface(body, "Result")

    score = f"{sub.result.total_score:g}/{sub.result.total_marks:g}"
    summary = body["executive_summary"]
    assert len(summary) == 3
    assert summary[0].startswith("5 of 5 rubric questions transcribed and mapped; mean OCR confidence ")
    assert summary[1].startswith(f"Draft result {score} (")
    assert "Strongest topic:" in summary[1] and "weakest topic:" in summary[1]
    assert summary[2].startswith("Highest-value actions: P1 ")
    assert summary[2].endswith("All prescriptions are provisional pending teacher review.")
    assert score in " ".join(summary)

    assert 2 <= len(body["teaching_nudges"]) <= 3
    counts = body["outcome_counts"]
    assert counts["total_questions"] == 5
    assert counts["full"] + counts["partial"] + counts["zero"] + counts["blank"] == 5
    (rollup,) = body["subject_rollup"]
    assert rollup["subject"] == "Biology" and rollup["questions"] == 5
    assert rollup["score"] == body["total_score"] and rollup["max_marks"] == body["total_marks"]

    controls = body["scoring_controls"]
    assert controls["parity"] is True and controls["llm_total_used"] is False
    assert controls["item_sum"] == controls["reported_total"] == body["total_score"]
    assert controls["marking_rule"] == analytics.MARKING_RULE
    assert body["roi_basis"]["forecast_status"] == "UNAVAILABLE" and body["roi_basis"]["calibrated"] is False

    plan = body["study_plan"]
    assert len(plan["focus"]) == 5 and len(plan["weekly_calendar"]) == 7 and len(plan["roadmap"]) == 4
    assert all(t["quadrant"] for t in plan["topics"])
    assert plan["weekly_calendar"][-1]["blocks"][0]["activity"] == "checkpoint"

    priorities = body["roi_recommendations"]
    assert priorities, "a weak student has ROI priorities"
    for p in priorities:
        assert p["calibrated"] is False and p["projected_gain_marks"] is not None
        assert p["gain_low"] <= p["projected_gain_marks"] <= p["gain_high"]
        assert p["trigger_questions"] and p["intervention"]["check_criterion"].startswith(">=4/5")
        assert p["qualitative_rank"] in range(1, len(priorities) + 1)
        assert "Illustrative matrix:" in p["rationale"]
    ranks = [t["priority_rank"] for t in body["topic_mastery"] if t["priority_rank"] is not None]
    assert sorted(ranks) == list(range(1, len(priorities) + 1))


def test_plan_endpoint_changes_mode_and_actions_with_days(seeded):
    sub = _weakest(seeded)
    far = seeded.client.get(f"/api/results/{sub.id}/plan", params={"days_to_exam": 120}).json()
    near = seeded.client.get(f"/api/results/{sub.id}/plan", params={"days_to_exam": 5, "study_hours": 10}).json()
    check_interface(far, "StudyPlan")
    check_interface(near, "StudyPlan")
    assert (far["strategy_mode"], near["strategy_mode"]) == ("broad", "consolidation")
    assert [t["action"] for t in far["focus"]] != [t["action"] for t in near["focus"]]
    assert near["study_hours"] == 10 and near["days_to_exam"] == 5


def test_plan_endpoint_validation_and_state(seeded):
    client = seeded.client
    sub = seeded.completed[0]
    assert client.get(f"/api/results/{sub.id}/plan", params={"days_to_exam": 401}).status_code == 422
    assert client.get(f"/api/results/{sub.id}/plan", params={"study_hours": 0}).status_code == 422
    review = seeded.review[0]
    response = client.get(f"/api/results/{review.id}/plan")
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    missing = client.get("/api/results/99999/plan")
    assert missing.status_code == 404 and missing.json()["code"] == "not_found"


# --------------------------------------------------------------------------- #
# Old rows (stored before contract v2) still get every extra
# --------------------------------------------------------------------------- #
LEGACY_QE_KEYS = ("question", "topic", "estimated_marks", "max_marks", "evidence", "strengths", "gaps",
                  "student_answer", "confidence")
LEGACY_TOPIC_KEYS = ("topic", "subject", "score", "max_marks", "mastery", "weightage", "effort_hours")
LEGACY_PRIORITY_KEYS = ("topic", "subject", "roi", "weightage", "gain_potential", "effort_hours", "rationale", "mastery")


def _strip_to_legacy(result: EvaluationResult) -> None:
    result.question_evaluations = [{k: q[k] for k in LEGACY_QE_KEYS} for q in result.question_evaluations]
    result.topic_mastery = [{k: t[k] for k in LEGACY_TOPIC_KEYS} for t in result.topic_mastery]
    result.roi_recommendations = [{k: p[k] for k in LEGACY_PRIORITY_KEYS} for p in result.roi_recommendations]
    result.summary = None
    result.teaching_nudges = None
    result.confusions = None
    result.rubric_hash = None


def test_result_extras_work_on_a_row_without_the_new_keys(seeded):
    sub = _weakest(seeded)
    _strip_to_legacy(sub.result)
    seeded.db.commit()

    extras = analytics.result_extras(
        seeded.db, sub=sub, result=sub.result, rubric=sub.rubric, batch=sub.batch, institution=sub.batch.institution
    )
    assert set(extras) == {
        "urgency", "urgency_reasons", "percentage", "summary", "executive_summary", "teaching_nudges", "confusions",
        "outcome_counts", "subject_rollup", "scoring_controls", "roi_basis", "study_plan", "topic_mastery",
        "roi_recommendations", "question_evaluations",
    }
    assert extras["summary"] is None and extras["confusions"] == []
    assert len(extras["executive_summary"]) == 3
    assert 2 <= len(extras["teaching_nudges"]) <= 3
    assert all(n["source"] == "template" for n in extras["teaching_nudges"])
    for q in extras["question_evaluations"]:
        assert q["outcome"] in ("FULL", "PARTIAL", "ZERO", "BLANK")
        assert q["source_pages"] == [] and q["uncertain_words"] == [] and q["corrected_by_faculty"] is False
    for t in extras["topic_mastery"]:
        assert t["n"] == len(t["questions"]) == t["full"] + t["partial"] + t["zero"] + t["blank"]
    for p in extras["roi_recommendations"]:
        assert p["trigger_questions"] and p["intervention"]["source"] == "template"

    body = seeded.client.get(f"/api/results/{sub.id}").json()
    check_interface(body, "Result")
    assert body["summary"] is None and len(body["study_plan"]["focus"]) == 5


def test_stored_ai_narrative_is_passed_through(seeded):
    sub = _weakest(seeded)
    sub.result.summary = "  Weak on   DNA replication. "
    sub.result.teaching_nudges = [
        {"priority": "high", "label": "Contrast DNA models", "text": "Q3: draw the 15N bands.",
         "topic": "Molecular Basis of Inheritance", "question_refs": [3], "source": "ai"},
        {"priority": "urgent", "label": "Second nudge", "text": "Q2 recap."},
    ]
    sub.result.confusions = [{"concept_a": "Griffith", "concept_b": "Meselson-Stahl", "question": 3}]
    seeded.db.commit()
    body = seeded.client.get(f"/api/results/{sub.id}").json()
    assert body["summary"] == "Weak on DNA replication."
    assert [n["label"] for n in body["teaching_nudges"]] == ["Contrast DNA models", "Second nudge"]
    assert body["teaching_nudges"][1]["priority"] == "medium" and body["teaching_nudges"][1]["source"] == "ai"
    assert body["confusions"] == [
        {"concept_a": "Griffith", "concept_b": "Meselson-Stahl", "question": 3, "evidence": ""}
    ]


# --------------------------------------------------------------------------- #
# Cohort extras
# --------------------------------------------------------------------------- #
def test_cohort_extras_on_the_seeded_demo(seeded):
    cohort = seeded.client.get("/api/cohort").json()
    check_interface(cohort, "Cohort")
    ranking = cohort["ranking"]
    assert len(ranking) == 12 and [r["rank"] for r in ranking] == list(range(1, 13))
    assert [r["pct"] for r in ranking] == sorted((r["pct"] for r in ranking), reverse=True)
    assert len(cohort["at_risk"]) == 4
    for row in cohort["at_risk"]:
        assert row["reasons"] and row["top_gap"]
    errors = cohort["common_errors"]
    assert 1 <= len(errors) <= 8
    for error in errors:
        assert error["count"] >= 2 and error["denominator"] == 12 and len(error["students"]) == error["count"]
    assert [e["count"] for e in errors] == sorted((e["count"] for e in errors), reverse=True)
    interventions = cohort["interventions"]
    assert interventions and interventions[0]["action"].startswith("10-min re-teach + 5 unseen questions for ")
    assert all(i["students_count"] >= 1 and i["rationale"] for i in interventions)


def _pair(sub_id: int, name: str, gaps: dict[int, list[str]], confusions=None, pct: float = 50.0):
    sub = StudentSubmission(id=sub_id, student_name=name, student_ref=name.lower())
    questions = [
        {"question": n, "topic": f"Topic {n}", "estimated_marks": 1, "max_marks": 4, "student_answer": "x",
         "confidence": 0.9, "gaps": g, "strengths": []}
        for n, g in gaps.items()
    ]
    result = EvaluationResult(
        total_score=pct / 10, total_marks=10.0, overall_mastery=pct, question_evaluations=questions,
        topic_mastery=[{"topic": f"Topic {n}", "subject": "Biology", "mastery": 25.0} for n in gaps],
        roi_recommendations=[], confusions=confusions or [],
    )
    return sub, result


def test_common_errors_group_normalised_text_and_confusions_are_order_insensitive():
    pairs = [
        _pair(1, "Asha", {1: ["Named Griffith instead of Meselson-Stahl"], 2: ["Only once"]},
              [{"concept_a": "Incomplete dominance", "concept_b": "Codominance", "question": 2}]),
        _pair(2, "Bala", {1: ["  named griffith   INSTEAD of Meselson-Stahl "]},
              [{"concept_a": "codominance", "concept_b": "incomplete  dominance", "question": 2}]),
        _pair(3, "Chitra", {1: ["Named Griffith instead of Meselson-Stahl"], 3: ["Only once"]}),
    ]
    extras = analytics.cohort_extras(pairs=pairs, rubrics={}, batch=None)
    (error,) = extras["common_errors"]  # "Only once" appears on different questions -> not grouped
    assert error["question"] == 1 and error["count"] == 3 and error["denominator"] == 3
    assert error["students"] == ["Asha", "Bala", "Chitra"]
    (cluster,) = extras["confusion_clusters"]
    assert cluster["count"] == 2 and cluster["students"] == ["Asha", "Bala"]
    assert extras["urgency_counts"] == {"on_track": 0, "needs_attention": 0, "at_risk": 3}
    assert any(i["topic"] == "Incomplete dominance vs Codominance" for i in extras["interventions"])


# --------------------------------------------------------------------------- #
# Weightage, exams, batch patch
# --------------------------------------------------------------------------- #
def test_weightage_and_exams_endpoints(client):
    matrix = client.get("/api/weightage").json()
    check_interface(matrix, "WeightageMatrix")
    assert matrix["exam"] == "NEET" and matrix["illustrative"] is True and matrix["confidence"] == 0.3
    assert matrix["version"] == "neet-matrix-illustrative-2026.11" and matrix["total_marks"] == 720
    names = {c["chapter"]: c for c in matrix["chapters"]}
    payload_topics = {"Genetics": 24, "Human Physiology": 26, "Cell Biology": 18, "Organic Chemistry": 23,
                      "Ecology": 13, "Electrostatics": 21, "Plant Physiology": 17, "Mechanics": 25,
                      "Thermodynamics": 12, "Chemical Bonding": 17}
    for name, marks in payload_topics.items():
        assert names[name]["avg_marks"] == marks
    genetics_parts = ["Mendelian Inheritance", "Incomplete Dominance & Codominance", "Molecular Basis of Inheritance",
                      "Sex-linked Inheritance", "Chromosomal Disorders"]
    assert sum(names[n]["avg_marks"] for n in genetics_parts) == 24
    assert len({names[n]["avg_marks"] for n in genetics_parts}) >= 4  # the seeded topics no longer tie
    missing = client.get("/api/weightage", params={"exam": "JEE Main"})
    assert missing.status_code == 404 and missing.json()["code"] == "exam_not_available"

    exams = client.get("/api/exams").json()
    for exam in exams:
        check_interface(exam, "ExamOption")
    assert [e["exam"] for e in exams if e["enabled"]] == ["NEET"]
    assert {e["exam"] for e in exams} == {"NEET", "JEE Main", "JEE Advanced", "CAT", "UPSC"}
    assert all(e["note"] == "Matrix not loaded in this PoC" for e in exams if not e["enabled"])


def test_batch_patch_sets_and_resets_the_exam_date(client):
    batch = client.get("/api/health").json()["batch"]
    assert batch["exam_date_assumed"] is True
    date_45 = (ist_today() + timedelta(days=45)).isoformat()
    response = client.patch(f"/api/batches/{batch['id']}", json={"exam_date": date_45})
    assert response.status_code == 200, response.text
    body = response.json()
    check_interface(body, "Batch")
    assert body["exam_date"] == date_45 and body["exam_date_assumed"] is False
    assert body["days_to_exam"] == 45 and body["strategy_mode"] == "focused"
    assert client.get("/api/health").json()["batch"]["exam_date"] == date_45

    reset = client.patch(f"/api/batches/{batch['id']}", json={"exam_date": None}).json()
    assert reset["exam_date"] == "2027-05-02" and reset["exam_date_assumed"] is True
    # Omitting exam_date leaves it unchanged.
    assert client.patch(f"/api/batches/{batch['id']}", json={"exam": "neet"}).json()["exam"] == "NEET"

    for bad in ("2027-13-01", "next May", "2027-5-2", (ist_today() - timedelta(days=1)).isoformat()):
        response = client.patch(f"/api/batches/{batch['id']}", json={"exam_date": bad})
        assert response.status_code == 422 and response.json()["code"] == "invalid_date", bad
    response = client.patch(f"/api/batches/{batch['id']}", json={"exam": "JEE Main"})
    assert response.status_code == 422 and response.json()["code"] == "exam_not_available"
    response = client.patch("/api/batches/999", json={"exam_date": None})
    assert response.status_code == 404 and response.json()["code"] == "unknown_batch"
